// tools/modules/antigravity-attacher.mjs
// Antigravity Session Attacher & Live Hook Streamer for Chums
// Connects Chums characters to Antigravity sessions and streams live tool executions.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const DEFAULT_DB_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db')
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity')
const CONFIG_PATH = path.join(os.homedir(), '.chums', 'config.json')

let cachedChumsConfig = null
function getChumsConfig() {
  if (cachedChumsConfig) return cachedChumsConfig
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      cachedChumsConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    }
  } catch {
    cachedChumsConfig = {}
  }
  return cachedChumsConfig || {}
}

/**
 * Clean path basename helper handling both / and \
 */
function cleanBasename(filePath) {
  if (!filePath) return 'file'
  const clean = String(filePath).replace(/^["']|["']$/g, '').trim().replace(/\\/g, '/')
  return path.posix.basename(clean) || 'file'
}

/**
 * Projects a raw Antigravity tool call into a sanitized hook payload.
 * Private reasoning and large outputs are redacted.
 */
export function projectToolCall(rawName, rawArgs = {}) {
  const norm = String(rawName || '').toLowerCase()
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}

  if (norm === 'read_file' || norm === 'view_file') {
    const rawPath = args.Path || args.path || args.file_path || ''
    const base = cleanBasename(rawPath)
    return {
      tool: 'Read',
      rawTool: rawName,
      description: `Read ${base}`,
      input: { file: base, file_path: base }
    }
  }

  if (norm === 'edit_file') {
    const rawPath = args.Path || args.path || args.file_path || ''
    const base = cleanBasename(rawPath)
    return {
      tool: 'Edit',
      rawTool: rawName,
      description: `Edit ${base}`,
      input: { file: base, file_path: base }
    }
  }

  if (norm === 'write_file') {
    const rawPath = args.Path || args.path || args.file_path || ''
    const base = cleanBasename(rawPath)
    return {
      tool: 'Write',
      rawTool: rawName,
      description: `Write ${base}`,
      input: { file: base, file_path: base }
    }
  }

  if (norm === 'run_command' || norm === 'bash') {
    const rawCmd = args.CommandLine || args.command || args.cmd || ''
    const cleanCmd = String(rawCmd).replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim()
    const slice = cleanCmd.slice(0, 40)
    return {
      tool: 'Bash',
      rawTool: rawName,
      description: `Bash ${slice}`,
      input: { command: slice }
    }
  }

  if (norm === 'search_web') {
    const query = String(args.query || '').slice(0, 30)
    return {
      tool: 'WebSearch',
      rawTool: rawName,
      description: `WebSearch ${query}`,
      input: { query }
    }
  }

  const clean = String(rawName || 'tool').slice(0, 30)
  return {
    tool: clean,
    rawTool: rawName,
    description: clean,
    input: {}
  }
}

/**
 * Generates a stable tool call ID for deduplication: step_index + tool_name + args_hash
 */
export function makeToolCallId(stepIndex, toolName, args) {
  const normArgs = JSON.stringify(args || {})
  const hash = crypto.createHash('sha256').update(normArgs).digest('hex').slice(0, 12)
  return `${stepIndex ?? 0}:${toolName ?? ''}:${hash}`
}

/**
 * Query conversation_summaries table in read-only mode (URI file:... ?mode=ro).
 */
export async function listRecentConversations(limit = 5, customDbPath = null) {
  const dbPath = customDbPath || process.env.ANTIGRAVITY_DB_PATH || DEFAULT_DB_PATH
  if (!fs.existsSync(dbPath)) {
    return []
  }

  // 1. Try node:sqlite if available (Node >= 22.12)
  try {
    const { DatabaseSync } = await import('node:sqlite')
    if (DatabaseSync) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const stmt = db.prepare(
        'SELECT conversation_id, title, preview, last_modified_time, step_count FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?'
      )
      const rows = stmt.all(limit)
      db.close()
      return rows
    }
  } catch {}

  // 2. Try better-sqlite3 if available
  try {
    const Database = (await import('better-sqlite3')).default
    if (Database) {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true })
      const rows = db.prepare(
        'SELECT conversation_id, title, preview, last_modified_time, step_count FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?'
      ).all(limit)
      db.close()
      return rows
    }
  } catch {}

  // 3. Fallback to Python standard library sqlite3 with read-only URI
  const normPath = path.resolve(dbPath).replace(/\\/g, '/')
  const uri = normPath.startsWith('file:') ? normPath : `file:${normPath}?mode=ro`

  const pyScript = [
    'import sqlite3, json, sys',
    'uri = sys.argv[1]',
    'limit = int(sys.argv[2])',
    'conn = sqlite3.connect(uri, uri=True)',
    'cur = conn.cursor()',
    'cur.execute("SELECT conversation_id, title, preview, last_modified_time, step_count FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?", (limit,))',
    'cols = [d[0] for d in cur.description]',
    'rows = [dict(zip(cols, row)) for row in cur.fetchall()]',
    'conn.close()',
    'print(json.dumps(rows))'
  ].join('\n')

  const proc = spawnSync('python', ['-c', pyScript, uri, String(limit)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  })

  if (proc.error) throw proc.error
  if (proc.status !== 0) {
    throw new Error(proc.stderr || `python sqlite exited with code ${proc.status}`)
  }

  return JSON.parse(proc.stdout)
}

/**
 * Session Attacher & Streamer state machine
 */
export class AntigravityAttacher {
  constructor(options = {}) {
    this.dataDir = options.dataDir || process.env.ANTIGRAVITY_DATA_DIR || DEFAULT_DATA_DIR
    this.dbPath = options.dbPath || process.env.ANTIGRAVITY_DB_PATH || DEFAULT_DB_PATH
    this.attachments = new Map() // characterName -> attachmentRecord
    this.generationCounter = 0
  }

  _getCharName(character) {
    if (!character) throw new Error('Character name is required')
    return typeof character === 'object' && character.name ? character.name : String(character)
  }

  getStatus(character) {
    const charName = this._getCharName(character)
    const rec = this.attachments.get(charName)
    if (!rec) {
      return {
        character: charName,
        state: 'detached',
        conversationId: null,
        generation: 0,
        currentOffset: 0,
        seenToolCallsCount: 0,
        lastTool: null,
        lastEventTime: null
      }
    }
    return {
      character: charName,
      state: rec.state,
      conversationId: rec.conversationId,
      generation: rec.generation,
      currentOffset: rec.byteOffset,
      seenToolCallsCount: rec.seenToolCallIds ? rec.seenToolCallIds.size : 0,
      lastTool: rec.lastTool,
      lastEventTime: rec.lastEventTime
    }
  }

  async detachSession(character) {
    const charName = this._getCharName(character)
    const rec = this.attachments.get(charName)
    if (!rec) return { ok: true, state: 'detached' }

    // Invalidate generation to prevent pending callbacks from acting
    rec.generation = ++this.generationCounter
    rec.state = 'detached'

    if (rec.watcher) {
      try { rec.watcher.close() } catch {}
      rec.watcher = null
    }
    if (rec.pollTimer) {
      clearInterval(rec.pollTimer)
      rec.pollTimer = null
    }

    // Emit Stop hook to hub
    await this._postHook(rec, {
      name: charName,
      cwd: rec.hubConfig.cwd || process.cwd(),
      event: 'Stop'
    })

    this.attachments.delete(charName)
    return { ok: true, state: 'detached' }
  }

  async attachSession(character, conversationId, hubConfig = {}) {
    const charName = this._getCharName(character)
    if (!conversationId) throw new Error('conversationId is required')

    // If currently attached, detach first
    if (this.attachments.has(charName)) {
      await this.detachSession(charName)
    }

    const generation = ++this.generationCounter

    // 1. resolving state
    const record = {
      character: charName,
      conversationId,
      state: 'resolving',
      generation,
      byteOffset: 0,
      trailingBuffer: Buffer.alloc(0),
      seenToolCallIds: new Set(),
      lastTool: null,
      lastEventTime: null,
      watcher: null,
      pollTimer: null,
      hubConfig: {
        ...getChumsConfig(),
        ...hubConfig
      }
    }
    this.attachments.set(charName, record)

    // Locate transcript file
    const transcriptPath = hubConfig.transcriptPath || path.join(
      this.dataDir,
      'brain',
      conversationId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    )
    record.transcriptPath = transcriptPath

    const fileExists = fs.existsSync(transcriptPath)
    if (!fileExists) {
      // Check if conversation exists in DB
      let inDb = false
      try {
        const summaries = await listRecentConversations(100, this.dbPath)
        inDb = summaries.some(s => s.conversation_id === conversationId)
      } catch {}

      if (!inDb) {
        record.state = 'failed'
        throw new Error(`Conversation not found on disk or database: ${conversationId}`)
      }
      // In DB but transcript file not yet created
      record.state = 'stale'
      return this.getStatus(charName)
    }

    // 2. attaching state
    record.state = 'attaching'

    // Determine if live or historical
    let isLive = true
    if (hubConfig.mode === 'historical') {
      isLive = false
    } else if (hubConfig.mode === 'live') {
      isLive = true
    } else {
      try {
        const stat = fs.statSync(transcriptPath)
        const ageMs = Date.now() - stat.mtimeMs
        isLive = ageMs < 10 * 60 * 1000 // modified within 10 minutes
      } catch {
        isLive = false
      }
    }

    record.state = isLive ? 'attached_live' : 'attached_historical'

    // Initial read of existing data
    await this._readNewBytes(record)

    // If attached_live, start file watcher and polling timer
    if (record.state === 'attached_live') {
      this._startWatcher(record)
    }

    return this.getStatus(charName)
  }

  _startWatcher(record) {
    const pollInterval = record.hubConfig.pollIntervalMs || 500

    // Periodic poll for guaranteed reconciliation across filesystem nuances
    record.pollTimer = setInterval(async () => {
      if (this.attachments.get(record.character)?.generation !== record.generation) return
      try {
        await this._readNewBytes(record)
      } catch (err) {
        record.state = 'stale'
      }
    }, pollInterval)

    // File system notification trigger for instant updates
    try {
      record.watcher = fs.watch(record.transcriptPath, async () => {
        if (this.attachments.get(record.character)?.generation !== record.generation) return
        try {
          await this._readNewBytes(record)
        } catch {}
      })
    } catch {}
  }

  async _readNewBytes(record) {
    if (!record) return
    if (record.isReading) {
      record.pendingRead = true
      return
    }
    record.isReading = true
    try {
      await this._doReadNewBytes(record)
    } finally {
      record.isReading = false
      if (record.pendingRead && this.attachments.get(record.character)?.generation === record.generation) {
        record.pendingRead = false
        await this._readNewBytes(record)
      }
    }
  }

  async _doReadNewBytes(record) {
    const myGen = record.generation
    if (this.attachments.get(record.character)?.generation !== myGen) return

    let stat
    try {
      stat = await fs.promises.stat(record.transcriptPath)
    } catch (err) {
      record.state = 'stale'
      return
    }

    // Truncation detection
    if (stat.size < record.byteOffset) {
      record.byteOffset = 0
      record.trailingBuffer = Buffer.alloc(0)
    }

    const bytesToRead = stat.size - record.byteOffset
    if (bytesToRead <= 0 && record.trailingBuffer.length === 0) {
      return
    }

    if (bytesToRead > 0) {
      const fd = await fs.promises.open(record.transcriptPath, 'r')
      try {
        const chunk = Buffer.alloc(bytesToRead)
        const { bytesRead } = await fd.read(chunk, 0, bytesToRead, record.byteOffset)
        if (bytesRead > 0) {
          record.byteOffset += bytesRead
          const combined = Buffer.concat([record.trailingBuffer, chunk.subarray(0, bytesRead)])
          const lastNewline = combined.lastIndexOf(0x0A) // \n

          if (lastNewline === -1) {
            // Incomplete line buffered
            record.trailingBuffer = combined
            return
          }

          const completeChunk = combined.subarray(0, lastNewline)
          record.trailingBuffer = combined.subarray(lastNewline + 1)

          const lines = completeChunk.toString('utf8').split(/\r?\n/)
          for (const line of lines) {
            if (this.attachments.get(record.character)?.generation !== myGen) return
            if (!line.trim()) continue
            await this._handleTranscriptLine(record, line)
          }
        }
      } finally {
        await fd.close()
      }
    }
  }

  async _handleTranscriptLine(record, line) {
    let step
    try {
      step = JSON.parse(line)
    } catch {
      // Corrupt or malformed line: skip past under documented policy
      return
    }

    if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      for (const rawTool of step.tool_calls) {
        if (!rawTool || !rawTool.name) continue
        const toolId = makeToolCallId(step.step_index, rawTool.name, rawTool.args)
        if (record.seenToolCallIds.has(toolId)) continue
        record.seenToolCallIds.add(toolId)

        const projected = projectToolCall(rawTool.name, rawTool.args)
        record.lastTool = projected
        record.lastEventTime = Date.now()

        // 1. PreToolUse
        await this._postHook(record, {
          name: record.character,
          cwd: record.hubConfig.cwd || process.cwd(),
          event: 'PreToolUse',
          tool: projected.tool,
          input: projected.input
        })

        // 2. PostToolUse
        await this._postHook(record, {
          name: record.character,
          cwd: record.hubConfig.cwd || process.cwd(),
          event: 'PostToolUse',
          tool: projected.tool,
          result: 'done'
        })
      }
    }

    // Stop event on terminal step or conversation end
    if (step.status === 'DONE' && (step.type === 'USER_INPUT' || step.type === 'STOP')) {
      await this._postHook(record, {
        name: record.character,
        cwd: record.hubConfig.cwd || process.cwd(),
        event: 'Stop'
      })
    }
  }

  async _postHook(record, payload) {
    // If hook callback provided in config (useful for testing and in-process bridges)
    if (typeof record.hubConfig.onHook === 'function') {
      try {
        record.hubConfig.onHook(payload)
      } catch {}
    }

    const port = record.hubConfig.port || 7717
    const hubUrl = record.hubConfig.hubUrl || `http://127.0.0.1:${port}`
    const token = record.hubConfig.token
    const headers = { 'content-type': 'application/json' }
    if (token) headers['authorization'] = `Bearer ${token}`

    if (record.hubConfig.mockNetwork) {
      return true
    }

    try {
      const res = await fetch(`${hubUrl}/hook`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      })
      return res.ok
    } catch (err) {
      // Hub may be offline; attacher continues tailing without crashing
      return false
    }
  }
}

// Global default singleton instance
const defaultAttacher = new AntigravityAttacher()

export function attachSession(character, conversationId, hubConfig) {
  return defaultAttacher.attachSession(character, conversationId, hubConfig)
}

export function detachSession(character) {
  return defaultAttacher.detachSession(character)
}

export function getStatus(character) {
  return defaultAttacher.getStatus(character)
}

export default {
  AntigravityAttacher,
  listRecentConversations,
  attachSession,
  detachSession,
  getStatus,
  projectToolCall,
  makeToolCallId
}
