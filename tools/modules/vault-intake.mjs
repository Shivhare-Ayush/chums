import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// In-memory idempotency cache
const memoryCache = new Map()

// Default cache persistence file
const DEFAULT_CACHE_FILE = path.join(os.homedir(), '.chums', 'vault-intake-idempotency.json')

/**
 * Load idempotency cache from disk if available
 */
export function loadIdempotencyCache(cacheFile = DEFAULT_CACHE_FILE) {
  try {
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      for (const [k, v] of Object.entries(data)) {
        memoryCache.set(k, v)
      }
    }
  } catch (e) {
    // Non-fatal fallback
  }
}

/**
 * Save record to in-memory cache and persist to disk
 */
export function saveIdempotencyRecord(intakeId, record, cacheFile = DEFAULT_CACHE_FILE) {
  memoryCache.set(intakeId, record)
  try {
    const dir = path.dirname(cacheFile)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const obj = Object.fromEntries(memoryCache)
    fs.writeFileSync(cacheFile, JSON.stringify(obj, null, 2), 'utf8')
  } catch (e) {
    // Non-fatal disk write error
  }
}

/**
 * Clear in-memory cache (primarily for tests)
 */
export function clearIdempotencyCache() {
  memoryCache.clear()
}

/**
 * Resolve the canonical Obsidian vault root directory
 */
export function getVaultPath(customPath = null) {
  if (customPath && fs.existsSync(customPath)) {
    return path.resolve(customPath)
  }
  if (process.env.OBSIDIAN_VAULT_PATH && fs.existsSync(process.env.OBSIDIAN_VAULT_PATH)) {
    return path.resolve(process.env.OBSIDIAN_VAULT_PATH)
  }
  if (process.env.VAULT_PATH && fs.existsSync(process.env.VAULT_PATH)) {
    return path.resolve(process.env.VAULT_PATH)
  }
  const defaultPath = path.join(os.homedir(), 'OneDrive - The University of Texas at Dallas', 'Obsidian')
  if (fs.existsSync(defaultPath)) {
    return defaultPath
  }
  if (fs.existsSync(path.join(process.cwd(), 'Food Log.md'))) {
    return process.cwd()
  }
  return defaultPath
}

/**
 * Compute or retrieve a unique deterministic intake ID for idempotency deduplication
 */
export function getOrComputeIntakeId({ text = '', files = [], sessionId = '', device = '', intakeId = null }) {
  if (intakeId) return String(intakeId)
  const normText = String(text || '').trim().toLowerCase()
  const fileList = (Array.isArray(files) ? files : [files]).filter(Boolean).map(f => String(f)).sort()
  const payload = [sessionId || '', device || '', normText, fileList.join('|')].join('::')
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

/**
 * Sanitize a filename preserving extension
 */
export function sanitizeFileName(name) {
  const ext = path.extname(name) || '.jpg'
  const stem = path.basename(name, ext)
  const cleanStem = stem
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[-_.]+/, '')
    .replace(/[-_.]+$/, '')
    .slice(-60) || 'upload'
  const cleanExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg'
  return `${cleanStem}${cleanExt}`
}

/**
 * Resolve uploaded file path from ~/.chums/uploads, ~/.chums/files, or direct path
 */
export function resolveUploadedFile(filePath, customSearchDirs = []) {
  if (!filePath) return null
  const strPath = String(filePath).trim()

  // 1. Direct path check
  if (fs.existsSync(strPath) && fs.statSync(strPath).isFile()) {
    return path.resolve(strPath)
  }

  // 2. Search configured directories
  const searchDirs = [
    ...customSearchDirs,
    path.join(os.homedir(), '.chums', 'uploads'),
    path.join(os.homedir(), '.chums', 'files'),
    path.join(os.homedir(), '.chums')
  ]

  const baseName = path.basename(strPath)

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue

    // Direct match inside dir
    const directCandidate = path.join(dir, baseName)
    if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).isFile()) {
      return directCandidate
    }

    // Suffix match (e.g. hub prefixes timestamps like 1792460470276-65deeb-photo-1.jpg)
    try {
      const filesInDir = fs.readdirSync(dir)
      const exact = filesInDir.find(f => f === baseName)
      if (exact) return path.join(dir, exact)

      const suffixMatch = filesInDir.find(f => f.endsWith(`-${baseName}`) || f.endsWith(`_${baseName}`))
      if (suffixMatch) return path.join(dir, suffixMatch)
    } catch {}
  }

  return null
}

/**
 * Extract clean description from casual user intake message
 */
export function extractDescription(text, defaultDesc = 'Intake log') {
  if (!text) return defaultDesc
  let desc = String(text).trim()
  // Strip common command preambles
  desc = desc.replace(/^(please\s+)?(add|put|log|record)\s+(this\s+)?(to\s+)?(my\s+)?(food\s*log|workout\s*log|log)\s*(for|:)?\s*/i, '')
  desc = desc.trim()
  if (!desc) return defaultDesc
  return desc.charAt(0).toUpperCase() + desc.slice(1)
}

/**
 * Format local YYYY-MM-DD
 */
export function getLocalDateString(d = new Date()) {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Format local HH:MM
 */
export function getLocalTimeString(d = new Date()) {
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * Append entry to a Markdown log under ## YYYY-MM-DD
 */
export function appendToMarkdownLog(content, targetDate, entryText) {
  const dateHeader = `## ${targetDate}`
  const dateIdx = content.indexOf(dateHeader)

  if (dateIdx === -1) {
    // Heading doesn't exist yet; append at end of file
    const trimmed = content.trimEnd()
    return `${trimmed}\n\n${dateHeader}\n\n${entryText}\n`
  }

  // Heading exists. Find end of this section (next ## heading or EOF)
  const afterHeader = dateIdx + dateHeader.length
  const nextHeaderMatch = content.slice(afterHeader).search(/\n##\s+/)

  if (nextHeaderMatch === -1) {
    // Last section in the file
    const trimmed = content.trimEnd()
    return `${trimmed}\n\n${entryText}\n`
  }

  // Insert before the next ## section
  const insertPos = afterHeader + nextHeaderMatch
  const before = content.slice(0, insertPos).trimEnd()
  const after = content.slice(insertPos).trimStart()
  return `${before}\n\n${entryText}\n\n${after}\n`
}

/**
 * Check if incoming text and files indicate vault intake intent
 */
export function isVaultIntent(text = '', files = []) {
  const str = String(text || '').trim().toLowerCase()
  const fileList = Array.isArray(files) ? files : (files ? [files] : [])
  const hasFiles = fileList.length > 0

  // Non-vault commands that should be handled by other bridges (agent spawning, git, shell)
  const nonVaultPattern = /\b(run|bash|cmd|spawn|new agent|open agent|review|spec|goal|diff|diffs|inspect|git|reload|topbar|zebar|exec|terminal|status|ping|health|hello|hey|hi|list|attach|detach|fleet|nodes|echo)\b/i
  if (nonVaultPattern.test(str)) {
    return false
  }

  // Food keywords
  const foodPattern = /\b(food(\s*log)?|meal|breakfast|lunch|dinner|snack|ate|eat|eating|just had|nutrition|shake|protein|calories|drank|coffee|water|recipe|restaurant|pizza|tacos?|salad|rice|eggs?|bacon|chicken|bread|cookie|burger)\b/i

  // Workout keywords and muscle groups
  const workoutPattern = /\b(workout(\s*log)?|gym|lift|lifted|lifting|ran|run|running|jog|jogging|walk|walking|steps|pickleball|exercise|bench\s*press|squat|deadlift|curls|pushups?|pullups?|cardio|weights|training|tri|bis?|biceps?|triceps?|shoulders?|back\s+(and\s+)?(tri|bi)|chest|forearms?|delts?|abs|leg\s*day|pull\s*ups?|lat\s*pull|deadlifts?|preacher)\b/i

  // General vault logging verbs
  const logPattern = /\b(log|intake|add to log|save to vault|save note)\b/i

  // Match food or workout intent
  if (foodPattern.test(str) || workoutPattern.test(str)) {
    return true
  }

  // Match general logging if not conflicting with agent commands
  if (logPattern.test(str) && !nonVaultPattern.test(str)) {
    return true
  }

  // Attached files without non-vault commands indicate media intake
  if (hasFiles && (!str || !nonVaultPattern.test(str))) {
    return true
  }

  return false
}

/**
 * Handle vault intake for food logs, workout logs, and media attachments
 *
 * @param {Object} params
 * @param {string} params.text - User utterance or order description
 * @param {Array<string>} [params.files] - Uploaded files from Hub
 * @param {string} [params.sessionId] - Active session ID
 * @param {string} [params.device] - Calling device (e.g. iphone, watch)
 * @param {string} [params.intakeId] - Optional explicit intake idempotency ID
 * @param {string} [params.vaultPath] - Optional override for vault root directory
 * @param {string} [params.cacheFile] - Optional override for idempotency cache file
 * @param {Array<string>} [params.searchDirs] - Optional extra dirs to search for uploads
 * @returns {Promise<{ handled: boolean, reply: string }>}
 */
export async function handleVaultIntake({
  text = '',
  files = [],
  sessionId = '',
  device = '',
  intakeId = null,
  vaultPath = null,
  cacheFile = DEFAULT_CACHE_FILE,
  searchDirs = []
} = {}) {
  try {
    loadIdempotencyCache(cacheFile)

    const effectiveId = getOrComputeIntakeId({ text, files, sessionId, device, intakeId })

    // 1. Idempotency Check
    if (memoryCache.has(effectiveId)) {
      const cached = memoryCache.get(effectiveId)
      return { handled: true, reply: cached.reply || 'Already logged to vault.' }
    }

    // 2. Intent Check
    const fileList = Array.isArray(files) ? files : (files ? [files] : [])
    if (!isVaultIntent(text, fileList)) {
      return { handled: false, reply: 'Not recognized as a vault intake request.' }
    }

    // 3. Vault Path Verification
    const resolvedVaultPath = getVaultPath(vaultPath)
    if (!fs.existsSync(resolvedVaultPath)) {
      return { handled: false, reply: `Vault root directory not found: ${resolvedVaultPath}` }
    }

    // 4. Determine Target Log (Food Log vs Workout Log)
    const strText = String(text || '').trim().toLowerCase()
    const workoutPattern = /\b(workout(\s*log)?|gym|lift|lifted|lifting|ran|run|running|jog|jogging|walk|walking|steps|pickleball|exercise|bench\s*press|squat|deadlift|curls|pushups?|pullups?|cardio|weights|training|tri|bis?|biceps?|triceps?|shoulders?|back\s+(and\s+)?(tri|bi)|chest|forearms?|delts?|abs|leg\s*day|pull\s*ups?|lat\s*pull|deadlifts?|preacher)\b/i
    const foodPattern = /\b(food(\s*log)?|meal|breakfast|lunch|dinner|snack|ate|eat|eating|just had|nutrition|shake|protein|calories|drank|coffee|water|recipe|restaurant|pizza|tacos?|salad|rice|eggs?|bacon|chicken|bread|cookie|burger)\b/i

    let targetFile = 'Food Log.md'
    let logType = 'Food Log'
    if (workoutPattern.test(strText) && !foodPattern.test(strText)) {
      targetFile = 'Workout Log.md'
      logType = 'Workout Log'
    }

    // 5. Process & Stage Attached Files to Inbox/Assets/<epoch>_<sanitized>.<ext>
    const assetsDir = path.join(resolvedVaultPath, 'Inbox', 'Assets')
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true })
    }

    const savedAssetNames = []
    for (const fileItem of fileList) {
      const resolved = resolveUploadedFile(fileItem, searchDirs)
      if (resolved && fs.existsSync(resolved)) {
        const epoch = Date.now()
        const sanitized = sanitizeFileName(path.basename(resolved))
        const targetAssetName = `${epoch}_${sanitized}`
        const targetAssetPath = path.join(assetsDir, targetAssetName)

        fs.copyFileSync(resolved, targetAssetPath)
        savedAssetNames.push(targetAssetName)
      }
    }

    // 6. Build Log Entry
    const now = new Date()
    const dateStr = getLocalDateString(now)
    const timeStr = getLocalTimeString(now)
    const defaultDesc = logType === 'Food Log' ? 'Meal intake' : 'Workout session'
    const desc = extractDescription(text, defaultDesc)

    let entryText = `### ${timeStr} ${desc}`
    for (const assetName of savedAssetNames) {
      entryText += `\n![[Inbox/Assets/${assetName}]]`
    }

    // 7. Append Entry to Target Log File
    const targetFilePath = path.join(resolvedVaultPath, targetFile)
    let currentContent = ''
    if (fs.existsSync(targetFilePath)) {
      currentContent = fs.readFileSync(targetFilePath, 'utf8')
    } else {
      currentContent = `# ${targetFile.replace('.md', '')}\n\nAppend-only.\n`
    }

    const updatedContent = appendToMarkdownLog(currentContent, dateStr, entryText)
    fs.writeFileSync(targetFilePath, updatedContent, 'utf8')

    // 8. Construct Friendly Response
    let reply = ''
    if (savedAssetNames.length > 0) {
      reply = `Logged to ${targetFile}: "${desc}" with ${savedAssetNames.length} photo${savedAssetNames.length > 1 ? 's' : ''} saved to Inbox/Assets.`
    } else {
      reply = `Logged to ${targetFile}: "${desc}".`
    }

    // 9. Persist Idempotency Record
    saveIdempotencyRecord(effectiveId, {
      handled: true,
      reply,
      targetFile,
      date: dateStr,
      savedAssetNames,
      timestamp: Date.now()
    }, cacheFile)

    return { handled: true, reply }
  } catch (error) {
    return {
      handled: false,
      reply: `Failed to process vault intake: ${error.message}`
    }
  }
}
