#!/usr/bin/env node
// Chums <-> Windows Agent Daemon & Multi-Node Fleet Bridge
// Connects Chums iPhone & Apple Watch clients to local Antigravity sessions, Vault, and Agent Daemons.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import { isVaultIntent, handleVaultIntake } from './modules/vault-intake.mjs'
import {
  listRecentConversations,
  attachSession,
  detachSession,
  getStatus as getAttacherStatus
} from './modules/antigravity-attacher.mjs'

const execAsync = promisify(exec)

const CONFIG_PATH = path.join(os.homedir(), '.chums', 'config.json')
let cfg
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
} catch (e) {
  console.error('[Bridge] Failed to read ~/.chums/config.json:', e.message)
  process.exit(1)
}

const HUB_URL = `http://127.0.0.1:${cfg.port || 7717}`
const DAEMON_URL = 'http://127.0.0.1:8765'
const AUTH_HEADER = {
  authorization: `Bearer ${cfg.token}`,
  'content-type': 'application/json'
}

// Load Fleet Configuration
const FLEET_PATH = path.join(os.homedir(), '.chums', 'fleet.json')
function loadFleet() {
  try {
    if (fs.existsSync(FLEET_PATH)) {
      return JSON.parse(fs.readFileSync(FLEET_PATH, 'utf8'))
    }
  } catch {}
  return {
    version: 1,
    currentNode: 'laptop',
    nodes: {
      laptop: { name: 'Ayush Laptop (Windows)', status: 'online' }
    }
  }
}

// Agents to register and bridge
const AGENTS = [
  { id: 'peeps', name: 'peeps', role: 'Vault & Personal OS Intake' },
  { id: 'noodle', name: 'noodle', role: 'Coding Agent & Tool Streaming' },
  { id: 'squint', name: 'squint', role: 'System & Desktop Ops' },
  { id: 'stretch', name: 'stretch', role: 'Autonomous Background Tasks' }
]

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), '[Bridge]', ...args)

// Store conversation listings per agent for "attach to 1" resolution
const lastListedConversations = new Map() // agentName -> [ { id, title } ]

async function emitHook(event, toolName, input = {}, result = null) {
  try {
    await fetch(`${HUB_URL}/hook`, {
      method: 'POST',
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: 'squint',
        cwd: process.cwd(),
        event,
        tool: toolName,
        input,
        result
      })
    })
  } catch {}
}

async function callDaemonAction(action) {
  try {
    const res = await fetch(`${DAEMON_URL}/api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action })
    })
    return await res.json()
  } catch (e) {
    return { status: 'error', error: e.message }
  }
}

async function getDaemonHealth() {
  try {
    const res = await fetch(`${DAEMON_URL}/api/health`)
    return await res.json()
  } catch (e) {
    return null
  }
}

async function replyAgent(sessionId, text, status = 'done') {
  try {
    await fetch(`${HUB_URL}/channel/reply`, {
      method: 'POST',
      headers: AUTH_HEADER,
      body: JSON.stringify({ sessionId, text, status })
    })
    log(`Reply sent (${sessionId}): "${text}"`)
  } catch (e) {
    log(`Failed to reply (${sessionId}):`, e.message)
  }
}

async function handleOrder(agent, item) {
  const rawText = item.said || item.text || ''
  const text = rawText.toLowerCase().trim()
  const sessionId = agent.sessionId
  const files = item.files || (item.file ? [item.file] : [])
  log(`Order for ${agent.name}: "${rawText}" (from: ${item.device || 'unknown'}, files: ${files.length})`)

  // 1. VAULT INTAKE: Food log, workout log, and photo attachments
  if (isVaultIntent(rawText, files)) {
    log(`[Vault] Processing intake for ${agent.name}...`)
    try {
      const res = await handleVaultIntake({
        text: rawText,
        files,
        sessionId,
        device: item.device || 'phone'
      })
      if (res.handled) {
        await replyAgent(sessionId, res.reply)
        return
      }
    } catch (e) {
      log(`[Vault] Ingestion error:`, e.message)
      await replyAgent(sessionId, `Vault ingestion error: ${e.message}`)
      return
    }
  }

  // 2. CONVERSATION NAVIGATION: "list convos", "list recent work", "past work"
  if (
    text.includes('list convo') ||
    text.includes('recent work') ||
    text.includes('list work') ||
    text.includes('past work') ||
    text.includes('history')
  ) {
    try {
      const convos = await listRecentConversations(5)
      if (!convos.length) {
        await replyAgent(sessionId, 'No recent Antigravity conversations found in history.')
        return
      }
      lastListedConversations.set(agent.name, convos)
      const lines = convos.map((c, i) => `${i + 1}. ${c.title || 'Untitled'} (${c.step_count} steps)`)
      const reply = `Recent work:\n${lines.join('\n')}\nSay "attach to <number>" to mirror.`
      await replyAgent(sessionId, reply)
    } catch (e) {
      await replyAgent(sessionId, `Failed to load conversations: ${e.message}`)
    }
    return
  }

  // 3. SESSION ATTACHING: "attach to 1", "attach to <id>", "mirror active"
  if (text.startsWith('attach') || text.includes('attach to') || text.includes('mirror active')) {
    let targetId = null
    let targetTitle = null

    // Check if user said "attach to 1", "attach to 2", etc.
    const numMatch = text.match(/\b(1|2|3|4|5)\b/)
    const cached = lastListedConversations.get(agent.name) || []
    if (numMatch && cached.length) {
      const idx = parseInt(numMatch[1], 10) - 1
      if (cached[idx]) {
        targetId = cached[idx].conversation_id || cached[idx].id
        targetTitle = cached[idx].title
      }
    }

    // Default to the most recent active conversation if none specified
    if (!targetId) {
      const recents = await listRecentConversations(1)
      if (recents.length) {
        targetId = recents[0].conversation_id || recents[0].id
        targetTitle = recents[0].title
      }
    }

    if (!targetId) {
      await replyAgent(sessionId, 'Could not resolve conversation to attach to. Say "list convos" first.')
      return
    }

    const attached = attachSession(agent.name, targetId, {
      hubUrl: HUB_URL,
      hubToken: cfg.token
    })

    if (attached) {
      await replyAgent(sessionId, `Attached ${agent.name} to "${targetTitle || targetId.slice(0, 8)}". Streaming live tool events.`)
    } else {
      await replyAgent(sessionId, `Failed to attach to conversation ${targetId.slice(0, 8)}.`)
    }
    return
  }

  // 4. DETACH SESSION: "detach", "stop mirror"
  if (text.includes('detach') || text.includes('stop mirror') || text.includes('disconnect session')) {
    detachSession(agent.name)
    await replyAgent(sessionId, `${agent.name} is now detached and idle.`)
    return
  }

  // 5. SHELL / CLI EXECUTION: "run <cmd>", "exec <cmd>", "bash <cmd>"
  if (text.startsWith('run ') || text.startsWith('exec ') || text.startsWith('bash ')) {
    const cmd = rawText.replace(/^(run|exec|bash)\s+/i, '').trim()
    log(`[Shell] Executing command on behalf of ${agent.name}: "${cmd}"`)

    await emitHook('PreToolUse', 'bash', { command: cmd })
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: process.cwd(),
        timeout: 30000,
        maxBuffer: 1024 * 1024
      })
      await emitHook('PostToolUse', 'bash', { command: cmd }, 'success')
      await emitHook('Stop', 'bash')

      const out = (stdout || stderr || 'Command completed with no output.').trim()
      const summary = out.length > 200 ? out.slice(0, 195) + '...' : out
      await replyAgent(sessionId, summary)
    } catch (e) {
      await emitHook('PostToolUse', 'bash', { command: cmd }, `error: ${e.message}`)
      await emitHook('Stop', 'bash')
      await replyAgent(sessionId, `Command failed: ${e.message.slice(0, 150)}`)
    }
    return
  }

  // 6. MULTI-NODE FLEET QUERY / OVERRIDE: "fleet", "nodes", "on desktop ..."
  if (text === 'fleet' || text === 'nodes' || text.includes('list nodes')) {
    const fleet = loadFleet()
    const nodeList = Object.entries(fleet.nodes)
      .map(([id, n]) => `${n.name || id} (${n.status || 'unknown'})`)
      .join(', ')
    await replyAgent(sessionId, `Fleet nodes: ${nodeList}. Current node: ${fleet.currentNode || 'laptop'}.`)
    return
  }

  if (text.includes('on desktop') || text.includes('on cloud') || text.includes('on homelab')) {
    const target = text.includes('on desktop') ? 'desktop' : text.includes('on cloud') ? 'cloud' : 'homelab'
    const fleet = loadFleet()
    const node = fleet.nodes?.[target]
    if (!node || node.status !== 'online') {
      await replyAgent(sessionId, `${target.toUpperCase()} node is currently offline on Tailscale. Running on laptop instead.`)
    } else {
      await replyAgent(sessionId, `Routing order to ${node.name || target} across Tailscale.`)
      // Forwarding hook can be expanded when peer daemons are deployed
      return
    }
  }

  // 7. DESKTOP / DAEMON CONTROLS
  if (text.includes('spawn') || text.includes('new agent') || text.includes('open agent')) {
    log(`Triggering spawn_agent via daemon...`)
    const result = await callDaemonAction('spawn_agent')
    if (result.status === 'executed') {
      await replyAgent(sessionId, 'Spawned agent console on your Windows desktop!')
    } else {
      await replyAgent(sessionId, `Could not spawn agent: ${result.error || result.status || 'unknown'}`)
    }
    return
  }

  if (text.includes('spec') || text.includes('review')) {
    log(`Triggering review_spec via daemon...`)
    const result = await callDaemonAction('review_spec')
    if (result.status === 'executed') {
      await replyAgent(sessionId, 'Opened spec review on your PC.')
    } else {
      await replyAgent(sessionId, `Spec review action: ${result.status}`)
    }
    return
  }

  if (text.includes('diff') || text.includes('inspect')) {
    log(`Triggering inspect_diffs via daemon...`)
    const result = await callDaemonAction('inspect_diffs')
    if (result.status === 'executed') {
      await replyAgent(sessionId, 'Diff inspection launched.')
    } else {
      await replyAgent(sessionId, `Inspect diffs action: ${result.status}`)
    }
    return
  }

  // 8. STATUS / HEALTH / PING
  if (text.includes('status') || text.includes('health') || text.includes('ping') || text.includes('how are you')) {
    const attacherStatus = getAttacherStatus(agent.name)
    const health = await getDaemonHealth()

    let reply = ''
    if (attacherStatus.attached) {
      reply = `${agent.name} is attached to ${attacherStatus.conversationId.slice(0, 8)} (${attacherStatus.state}, step ${attacherStatus.stepIndex}). `
    } else {
      reply = `${agent.name} is idle on laptop. `
    }

    if (health && health.status === 'online') {
      reply += `Daemon RAM ${health.ram_mb} MB.`
    }
    await replyAgent(sessionId, reply.trim())
    return
  }

  // 9. FRIENDLY GREETINGS
  if (text.includes('hello') || text.includes('hey') || text.includes('hi') || text.includes('who are you')) {
    if (agent.name === 'peeps') {
      await replyAgent(sessionId, `Hey Ayush! Peeps is online. Send meal photos or workouts to log, or say "status".`)
    } else if (agent.name === 'noodle') {
      await replyAgent(sessionId, `Hey Ayush! Noodle is online. Say "list convos" to attach to an active coding session.`)
    } else {
      await replyAgent(sessionId, `Hey Ayush! ${agent.name} is online and ready for orders on your PC.`)
    }
    return
  }

  // 10. DEFAULT ECHO & HELP
  await replyAgent(
    sessionId,
    `Received: "${rawText}". Options: "add to food log [photo]", "list convos", "attach to 1", "run <cmd>", or "status".`
  )
}

async function runAgentWorker(agent) {
  const sessionId = `${agent.id}-bridge-session`
  agent.sessionId = sessionId

  while (true) {
    try {
      // 1. Register with Hub
      const regRes = await fetch(`${HUB_URL}/channel/register`, {
        method: 'POST',
        headers: AUTH_HEADER,
        body: JSON.stringify({
          sessionId,
          name: agent.name,
          cwd: process.cwd()
        })
      })

      if (!regRes.ok) {
        log(`Failed to register ${agent.name}: HTTP ${regRes.status}. Retrying in 3s...`)
        await new Promise(r => setTimeout(r, 3000))
        continue
      }

      log(`Registered agent ${agent.name} (${sessionId}) -> status: idle`)

      // 2. Poll loop
      let ack = []
      while (true) {
        const query = ack.length ? `?sessionId=${sessionId}&ack=${ack.join(',')}` : `?sessionId=${sessionId}`
        const pollRes = await fetch(`${HUB_URL}/channel/next${query}`, {
          method: 'GET',
          headers: AUTH_HEADER
        })

        if (!pollRes.ok) {
          log(`Poll failed for ${agent.name}: HTTP ${pollRes.status}`)
          await new Promise(r => setTimeout(r, 2000))
          break // re-register
        }

        const data = await pollRes.json()
        const items = data.items || []
        ack = items.map(it => it.id).filter(Boolean)

        for (const item of items) {
          if (item.type === 'order') {
            await handleOrder(agent, item)
          }
        }
      }
    } catch (e) {
      log(`Error in worker for ${agent.name}:`, e.message)
      await new Promise(r => setTimeout(r, 2500))
    }
  }
}

log(`Starting Chums Multi-Node Agent Bridge for ${AGENTS.length} agents...`)
log(`Connecting to Hub at ${HUB_URL} and Daemon at ${DAEMON_URL}`)

// Start workers for all agents in parallel
for (const agent of AGENTS) {
  runAgentWorker(agent)
}
