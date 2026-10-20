#!/usr/bin/env node
// Chums Hub: the only thing that talks to the agents' sessions. The watch talks only to this.
//
// Two sides:
//   /channel/*  — one chums-channel.mjs per Claude Code session registers here and long-polls for orders
//   /v1/*       — the watch (HTTPS/HTTP only: watchOS forbids WebSockets) posts audio, long-polls state
// Codex, Copilot and Agent Client Protocol agents are run by the hub itself (hub/runtimes.mjs): they become sessions
// like a Claude Code one, and speak the same hook vocabulary.
//
// Speech-to-text runs in a kept-alive `whisperkit-cli serve` child so each utterance costs ~0.2 s.

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { startRunners, startRunner, runByHub } from './runtimes.mjs'
import { OWNER, Owner, PAGE_GUIDE } from './standing.mjs'

const CONFIG_DIR = path.join(os.homedir(), '.chums')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const WHISPER_PORT = 50061
const KOKORO_PORT = 50062                                            // the agents' voices (tools/kokoro-server.py)
const KOKORO_PY = path.join(os.homedir(), '.chums/kokoro/.venv/bin/python')
const WHISPER_MODEL = process.env.CHUMS_WHISPER_MODEL || path.join(os.homedir(),
  'Documents/huggingface/models/argmaxinc/whisperkit-coreml/openai_whisper-base')
const ROOT = path.join(import.meta.dirname, '..')                  // this checkout
// the claude CLI for the soul editor: $CHUMS_CLAUDE_BIN, else the native installer's (~/.local/bin), else an npm prefix
// install in ~/.npm-global, else PATH's (a LaunchAgent's PATH has neither of those folders)
const CLAUDE_BIN = process.env.CHUMS_CLAUDE_BIN ||
  ['.local/bin/claude', '.npm-global/bin/claude'].map(p => path.join(os.userInfo().homedir, p)).find(p => fs.existsSync(p)) || 'claude'

// ---------- config ----------
/// A settings file the hub keeps: its JSON, or `fallback` when there's no file yet. One that doesn't parse stops the
/// hub with a message (writing over it would lose its settings, the tokens the apps were built with, the agents'
/// conversations). The parser's message isn't shown: it quotes the file, which can hold a token.
function readSettings(file, fallback, isShape, shape) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return fallback; throw e }
  if (!text.trim()) return fallback
  let v
  try { v = JSON.parse(text) } catch { v = undefined }
  if (v === undefined || !isShape(v)) {
    console.error(`chums: ${file} is not ${shape}. Fix it (bin/chums-doctor says where), or move it away and start the hub again: it writes a new one.`)
    process.exit(1)
  }
  return v
}

function loadConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(CONFIG_DIR, 0o700)                   // made earlier by something else (bin/chums-setup): still only yours
  const cfg = readSettings(CONFIG_PATH, {}, v => v && typeof v === 'object' && !Array.isArray(v), 'a valid JSON object')
  cfg.port ??= 7717
  cfg.publicPort ??= 7718           // the watch API alone, for the tunnel
  cfg.token ??= crypto.randomBytes(18).toString('base64url')         // Claude Code sessions: channel and hooks, on this Mac
  cfg.watchToken ??= crypto.randomBytes(18).toString('base64url')    // the watch, over the internet (watch API only)
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  fs.chmodSync(CONFIG_PATH, 0o600)                  // the mode above applies only to a new file
  return cfg
}
const cfg = loadConfig()

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ---------- state ----------
let rev = 1
const sessions = new Map()   // id -> { id, name, cwd, status, lastLine, lastSeen, lastSpokeAt, inbox: [], waiter }
const approvals = new Map()  // requestId -> { requestId, sessionId, session, tool, description, preview, at }
const spoken = []            // { id, session, text, kind, at }
const tools = []             // { id, session, type, text, ok, at } — every tool call, from Claude Code hooks

// ---------- agents: every character is its own agent ----------
// One agent per character, each with its own soul, its own session and thread, and its own conversation on the watch.
// ~/.chums/agents.json says, per agent, which runtime it runs on (Claude Code, the default, or Codex: switched from
// its soul screen on the watch), where it works and how to use its tools; a character with no entry gets one with the
// defaults below. Who it is lives in its soul (below). A session is an agent's when its name is the agent's id
// (bin/chums-agents); everything said, shown, asked or done is tagged with the agent it came from.
const AGENTS_PATH = path.join(os.homedir(), '.chums/agents.json')
const HOME = os.homedir()
/// The characters the watch draws, in order; each is an agent, its id the character's.
const LOOKS = ['noodle', 'stretch', 'peeps', 'squint', 'ray', 'tangle', 'crunch', 'nana']
const LOOK_NAMES = { noodle: 'Noodle', stretch: 'Stretch', peeps: 'Peeps', squint: 'Squint', ray: 'Ray', tangle: 'Tangle', crunch: 'Crunch', nana: 'Nana' }
const GUIDE = "To see an app or a page, use chums_show with screenshot (and open: a URL to open it in Safari first). To show a file, use chums_show with file: a page, a document, a PDF, text or code, a table, an image or a video. The watch shows it as a picture (a video as a still); the iPhone opens the file itself. " + PAGE_GUIDE + " To read or click inside a page your owner is logged in to, run JavaScript in Safari with osascript (Safari's do JavaScript; it needs Develop › Allow JavaScript from Apple Events)."
// the guide agents were given before; an agent that still has it gets the one above
const OLD_GUIDES = ["To see an app or a page, use chums_show with screenshot (and open: a URL to open it in Safari first). To show a file, use chums_show with file: a page, a document, a PDF, text or code, a table, an image or a video. The watch shows it as a picture (a video as a still); the iPhone opens the file itself. An HTML page you make runs on the iPhone, its scripts and charts included, and is a picture on the watch: for a chart, a table to explore or anything visual, make one self-contained HTML file (the iPhone gets only that file, nothing beside it) and show it. To read or click inside a page your owner is logged in to, run JavaScript in Safari with osascript (Safari's do JavaScript; it needs Develop › Allow JavaScript from Apple Events).", "To see an app or a page, use chums_show with screenshot (and open: a URL to open it in Safari first). To show what you make (an HTML page, SVG, PDF or image), use chums_show with file. To read or click inside a page your owner is logged in to, run JavaScript in Safari with osascript (Safari's do JavaScript; it needs Develop › Allow JavaScript from Apple Events)."]
/// Kokoro's English voices: id, name, accent, and its author's grade of it (VOICES.md in hexgrad/Kokoro-82M).
const ENGLISH_VOICES = [
  ['af_heart', 'Heart', 'A'], ['af_bella', 'Bella', 'A-'], ['af_nicole', 'Nicole', 'B-'], ['af_aoede', 'Aoede', 'C+'], ['af_kore', 'Kore', 'C+'],
  ['af_sarah', 'Sarah', 'C+'], ['af_alloy', 'Alloy', 'C'], ['af_nova', 'Nova', 'C'], ['af_sky', 'Sky', 'C-'], ['af_jessica', 'Jessica', 'D'],
  ['af_river', 'River', 'D'], ['am_fenrir', 'Fenrir', 'C+'], ['am_michael', 'Michael', 'C+'], ['am_puck', 'Puck', 'C+'], ['am_echo', 'Echo', 'D'],
  ['am_eric', 'Eric', 'D'], ['am_liam', 'Liam', 'D'], ['am_onyx', 'Onyx', 'D'], ['am_santa', 'Santa', 'D-'], ['am_adam', 'Adam', 'F+'],
  ['bf_emma', 'Emma', 'B-'], ['bf_isabella', 'Isabella', 'C'], ['bf_alice', 'Alice', 'D'], ['bf_lily', 'Lily', 'D'], ['bm_fable', 'Fable', 'C'],
  ['bm_george', 'George', 'C'], ['bm_lewis', 'Lewis', 'D+'], ['bm_daniel', 'Daniel', 'D'],
].map(([id, name, grade]) => ({ id, name, grade, accent: id[0] === 'b' ? 'British' : 'American', gender: id[1] === 'f' ? 'female' : 'male' }))
/// Each character's voice (Kokoro's: a American, b British; f female, m male), changed per agent on the watch.
const VOICES = {
  noodle: 'af_heart', squint: 'bf_isabella', tangle: 'bf_alice', ray: 'am_fenrir',
  stretch: 'bm_daniel', peeps: 'af_sky', crunch: 'am_echo', nana: 'am_michael' }
const DEFAULT_VOICE = 'af_heart'
const defaultAgent = c => ({ id: c, name: LOOK_NAMES[c], character: c, runtime: 'claude', voice: VOICES[c] ?? DEFAULT_VOICE,
  cwd: `${HOME}/.chums/agents/${c}`, addDirs: [HOME], guide: GUIDE, sessionId: crypto.randomUUID() })
const saveAgents = () => fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents, null, 2))
function loadAgents() {
  const list = readSettings(AGENTS_PATH, [], v => Array.isArray(v) && v.every(a => a && typeof a === 'object' && typeof a.id === 'string'),
    'a valid JSON list of agents, each with an "id" (tools/agents.example.json)')
  const missing = LOOKS.filter(c => !list.some(a => a.id === c))
  let filled = false
  for (const a of list) {
    if (LOOKS.includes(a.id)) a.character = a.id                       // a character's agent is that character
    if (!a.voice) { a.voice = VOICES[a.id] ?? DEFAULT_VOICE; filled = true }
    if (OLD_GUIDES.includes(a.guide)) { a.guide = GUIDE; filled = true }
    // an entry written by hand (docs/other-agents.md) may leave out its folder, and a Claude Code agent's session ID
    // (its conversation; bin/chums-agents can't start one without it)
    if (!a.cwd) { a.cwd = `${HOME}/.chums/agents/${a.id}`; filled = true }
    if ((a.runtime ?? 'claude') === 'claude' && !a.sessionId) { a.sessionId = crypto.randomUUID(); filled = true }
  }
  if (missing.length || filled) {
    list.push(...missing.map(defaultAgent))
    fs.mkdirSync(path.dirname(AGENTS_PATH), { recursive: true })
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(list, null, 2))
  }
  return list
}
const agents = loadAgents()
const agentNamed = id => agents.find(a => a.id === id)
const sessionOf = id => [...sessions.values()].find(s => s.name === id)

// ---------- souls: who each agent is (its name, what it looks after, what it refers to the others, its voice) ----------
// ~/.chums/souls/<id>.md, a git repo of their own (every change a commit, outside the agents' working folders), shaped
// by voice from the watch: a separate, tool-free model call turns what the owner said into a targeted change and a plain
// summary; the owner sees it and saves it (only against the version they saw), or undoes the last one. An agent gets its current
// soul, and the team's, with the next order it receives (again after it compacts its memory): saved changes apply from
// its next order. Only identity lives here; how to use its tools stays in agents.json.
const SOUL_DIR = path.join(CONFIG_DIR, 'souls')
const SOUL_FIELDS = { name: 24, owns: 180, refers: 180, voice: 90, body: 2500 }
// The first souls: three with a job, the rest whatever you give them. Shaped from the watch after that.
const SEED_SOULS = {
  noodle: { owns: 'Code in your projects, starting with the chums project (the watch app, hub and channel).',
            refers: 'Your Mac, browser and accounts to Squint. Design work to Peeps.', voice: 'Brief and plain.', body: 'A coding agent.' },
  squint: { owns: 'Your Mac: the apps and windows on it, Safari with your logins, your files, accounts and errands.',
            refers: 'Code to Noodle. Design work to Peeps.', voice: 'Brief and warm.', body: 'An agent for your Mac.' },
  peeps: { owns: 'Design: images, mockups, HTML pages, icons, design files.',
           refers: 'Code to Noodle. Your Mac and browser to Squint.', voice: 'Brief and playful.', body: 'A design agent.' },
}
const seedOf = id => ({ owns: 'Whatever you ask it.', refers: 'Code to Noodle. Your Mac and browser to Squint. Design work to Peeps.',
  voice: 'Brief.', body: 'An agent.', ...SEED_SOULS[id] })
const git = (...args) => run(process.platform === 'win32' ? 'git' : '/usr/bin/git', ['-C', SOUL_DIR, ...args])
const soulFile = id => path.join(SOUL_DIR, `${id}.md`)
function parseSoul(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const soul = { body: (m?.[2] ?? text).trim() }
  for (const line of (m?.[1] ?? '').split('\n')) { const k = line.match(/^(\w+):\s*(.*)$/); if (k && k[1] in SOUL_FIELDS) soul[k[1]] = k[2].trim() }
  return soul
}
const renderSoul = s => `---\nname: ${s.name}\nowns: ${s.owns ?? ''}\nrefers: ${s.refers ?? ''}\nvoice: ${s.voice ?? ''}\n---\n${(s.body ?? '').trim()}\n`
function soulOf(id) {
  try { return parseSoul(fs.readFileSync(soulFile(id), 'utf8')) } catch { return { name: agentNamed(id)?.name ?? id, ...seedOf(id) } }
}
const soulRev = id => { try { return crypto.createHash('sha1').update(fs.readFileSync(soulFile(id))).digest('hex').slice(0, 10) } catch { return 'seed' } }
const teamText = () => agents.map(a => { const s = soulOf(a.id); return `- ${s.name} (${a.id}) looks after: ${s.owns} Refers: ${s.refers}` }).join('\n')
const teamRev = () => crypto.createHash('sha1').update(teamText()).digest('hex').slice(0, 10)
let soulQueue = Promise.resolve()                                  // one change at a time
const serially = f => (soulQueue = soulQueue.then(f, f))
async function seedSouls() {
  fs.mkdirSync(SOUL_DIR, { recursive: true })
  if (!fs.existsSync(path.join(SOUL_DIR, '.git'))) { await git('init', '-q'); await git('config', 'user.name', 'Chums hub'); await git('config', 'user.email', 'hub@localhost') }
  const added = []
  for (const a of agents) if (!fs.existsSync(soulFile(a.id))) {
    fs.writeFileSync(soulFile(a.id), renderSoul({ name: a.name, ...seedOf(a.id) }))
    added.push(`${a.id}.md`)
  }
  if (added.length) { await git('add', ...added); await git('commit', '-q', '-m', `Seed ${added.join(', ')}`) }
}

/// What a session should know about itself before an order: its soul and the team's, when it hasn't seen this version.
function soulPrefix(s) {
  const a = agentNamed(s.name)
  if (!a) return ''
  const rev = `${soulRev(a.id)}:${teamRev()}`
  if (s.soulSent === rev) return ''
  s.soulSent = rev
  return `[Your soul, as ${OWNER} set it (version ${rev}). It replaces any earlier one, and anything said before about who you are:]\n${renderSoul(soulOf(a.id))}\n[The team, who looks after what:]\n${teamText()}\n\n[${Owner}'s order:]\n`
}

// the editor: a separate, tool-free call, with nothing of the agent's working thread in it
const proposals = new Map()                                         // id -> { agent, base, changes, summary, at }
async function proposeSoul(agentId, said) {
  const a = agentNamed(agentId)
  if (!a) throw new Error('no such agent')
  const cur = soulOf(agentId)
  const others = agents.filter(x => x.id !== agentId).map(x => { const o = soulOf(x.id); return `- ${o.name}: looks after ${o.owns}` }).join('\n')
  const prompt = `You edit the soul of one of ${OWNER}'s AI agents: its name, what it looks after, what it refers to the other agents, and its voice. ${Owner} just said this about it, by voice (a transcript, so expect recognition errors; read for intent):
"${said}"

The agent's current soul:
name: ${cur.name}
owns: ${cur.owns}
refers: ${cur.refers}
voice: ${cur.voice}
body: ${cur.body}

The other agents:
${others}

Change only what was asked; keep everything else word for word. Plain, literal, short words. Field limits: name ${SOUL_FIELDS.name} characters, owns ${SOUL_FIELDS.owns}, refers ${SOUL_FIELDS.refers}, voice ${SOUL_FIELDS.voice}, body ${SOUL_FIELDS.body}.
Answer with one JSON object and nothing else:
{"changes": {"<field>": "<its whole new value>"}, "summary": "<one short sentence saying what will change, about the agent by name, e.g. Noodle will also look after your calendar and talk more casually.>"}
If it's unclear what's wanted, or it isn't about this agent's soul, answer {"clarify": "<one short question>"} instead.`
  const t0 = Date.now()
  const out = await new Promise((resolve, reject) => {
    const p = spawn(CLAUDE_BIN,
      ['-p', '--model', 'sonnet', '--effort', 'low', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--output-format', 'json'],
      { cwd: SOUL_DIR, env: { ...process.env, HOME: os.userInfo().homedir } })
    let o = '', e = ''
    p.stdout.on('data', d => { o += d }); p.stderr.on('data', d => { e += d })
    const t = setTimeout(() => { p.kill(); reject(new Error('the editor took too long')) }, 60_000)
    p.on('error', err => { clearTimeout(t); reject(new Error(`it needs Claude Code, and ${CLAUDE_BIN} didn't start (${err.code})`)) })
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve(o) : reject(new Error(e.trim().split('\n').pop() || `editor exited ${code}`)) })
    p.stdin.end(prompt)
  })
  const res = JSON.parse(out)
  log(`soul editor: ${Date.now() - t0} ms (model ${res.duration_api_ms} ms, ${res.usage?.output_tokens} tokens out)`)
  const text = String(res.result ?? '').replace(/^```(json)?|```$/gm, '').trim()
  const r = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  if (r.clarify) return { clarify: String(r.clarify).slice(0, 160) }
  const changes = {}
  for (const [k, v] of Object.entries(r.changes ?? {})) {
    if (!(k in SOUL_FIELDS) || typeof v !== 'string') continue
    const val = v.replace(/\n/g, k === 'body' ? '\n' : ' ').trim()
    if (!val && k === 'name') continue
    if (val.length > SOUL_FIELDS[k]) throw new Error(`${k} came out too long`)
    if (val !== (cur[k] ?? '')) changes[k] = val
  }
  if (!Object.keys(changes).length) return { clarify: "That wouldn't change anything. What should be different?" }
  const id = crypto.randomBytes(6).toString('hex')
  proposals.set(id, { agent: agentId, base: soulRev(agentId), changes, summary: String(r.summary ?? '').slice(0, 200), at: Date.now() })
  for (const [k, v] of proposals) if (Date.now() - v.at > 15 * 60_000) proposals.delete(k)
  return { proposal: id, summary: proposals.get(id).summary, soul: { ...cur, ...changes } }
}

const saveSoul = (agentId, proposalId) => serially(async () => {
  const p = proposals.get(proposalId)
  if (!p || p.agent !== agentId) throw Object.assign(new Error('That change is no longer open. Say it again.'), { code: 409 })
  if (p.base !== soulRev(agentId)) { proposals.delete(proposalId); throw Object.assign(new Error('The soul changed since. Say it again.'), { code: 409 }) }
  proposals.delete(proposalId)
  fs.writeFileSync(soulFile(agentId), renderSoul({ ...soulOf(agentId), ...p.changes }))
  await git('add', `${agentId}.md`); await git('commit', '-q', '-m', `${agentId}: ${p.summary || 'changed'}`)
  log('soul saved:', agentId, p.summary); bump()
  return soulCard(agentId)
})

/// One part of a soul, written as it is (the iPhone edits them one at a time; no model in between).
const setSoul = (agentId, field, value) => serially(async () => {
  if (!['name', 'owns', 'refers', 'voice', 'body'].includes(field)) throw Object.assign(new Error('No such part.'), { code: 400 })
  const v = String(value ?? '').replace(/\r/g, '').replace(field === 'body' ? /(?!)/ : /\n/g, ' ').trim()
  if (field === 'name' && !v) throw Object.assign(new Error('It needs a name.'), { code: 400 })
  if (v.length > SOUL_FIELDS[field]) throw Object.assign(new Error(`That's longer than ${SOUL_FIELDS[field]} characters.`), { code: 400 })
  const cur = soulOf(agentId)
  if ((cur[field] ?? '') === v) return soulCard(agentId)
  fs.writeFileSync(soulFile(agentId), renderSoul({ ...cur, [field]: v }))
  await git('add', `${agentId}.md`); await git('commit', '-q', '-m', `${agentId}: ${field} set`)
  log('soul set:', agentId, field); bump()
  return soulCard(agentId)
})

const undoSoul = agentId => serially(async () => {
  const log1 = (await git('log', '--format=%H %s', '--', `${agentId}.md`)).split('\n').filter(Boolean)
  if (log1.length < 2) throw Object.assign(new Error('Nothing to undo.'), { code: 409 })
  const [, prev] = log1.map(l => l.split(' ')[0])
  fs.writeFileSync(soulFile(agentId), await git('show', `${prev}:${agentId}.md`) + '\n')
  await git('add', `${agentId}.md`); await git('commit', '-q', '-m', `${agentId}: undo (${log1[0].slice(41)})`)
  log('soul undone:', agentId); bump()
  return soulCard(agentId)
})

async function soulCard(agentId) {
  const s = soulOf(agentId)
  const n = (await git('log', '--format=%H', '--', `${agentId}.md`).catch(() => '')).split('\n').filter(Boolean).length
  return { id: agentId, name: s.name, owns: s.owns, refers: s.refers, voice: s.voice, body: s.body, canUndo: n > 1 }
}
const stateWaiters = new Set()

function bump() {
  rev++
  for (const w of stateWaiters) w()
  stateWaiters.clear()
}

// What a watch-sized approval card should say: the command for Bash, the file name for edits.
// Built from input_preview (the real arguments), never only from Claude's own description.
function summarize(tool, preview, description) {
  let args = null
  try { args = JSON.parse(preview) } catch {}
  const field = k => args?.[k] ?? preview.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1]
  const cmd = field('command')
  if (cmd) return cmd.replace(/\\n/g, ' ').slice(0, 160)
  const file = field('file_path') ?? field('notebook_path') ?? field('path')
  if (file) {
    const verb = { Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read' }[tool] ?? tool
    return `${verb} ${file.split('/').pop()}`
  }
  const url = field('url')
  if (url) return url.slice(0, 160)
  return (description || tool).slice(0, 160)
}

// ---------- the watch's battery, from its polls: what keyring mode costs ----------
// One line per 5 minutes (or per 1% change) in ~/.chums/watch-battery.csv: time, level 0–1, charging, screen on/dim, keyring.
const BATTERY_LOG = path.join(CONFIG_DIR, 'watch-battery.csv')
let lastBattery = { at: 0, level: -1 }
function noteBattery(q) {
  if (!q.has('battery')) return                      // the Simulator and tests don't send one
  const level = Number(q.get('battery'))
  if (!(level >= 0 && level <= 1)) return
  const now = Date.now()
  if (now - lastBattery.at < 5 * 60_000 && Math.abs(level - lastBattery.level) < 0.01) return
  lastBattery = { at: now, level }
  try { if (fs.statSync(BATTERY_LOG).size > 10e6) fs.renameSync(BATTERY_LOG, BATTERY_LOG + '.1') } catch {}   // past 10 MB, a new file
  if (!fs.existsSync(BATTERY_LOG)) fs.writeFileSync(BATTERY_LOG, 'time,level,charging,screen,keyring\n')
  const field = k => oneLine(q.get(k), 12).replace(/[,"]/g, '')
  fs.appendFileSync(BATTERY_LOG, [new Date(now).toISOString(), level, field('charging'), field('screen'), field('keyring')].join(',') + '\n')
}
/// What a client sent, for a log line or a file: one line of printable characters, at most n of them.
const oneLine = (v, n) => String(v ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, n)
/// The device an order came from ("watch", "phone"): a short name, or none.
const deviceOf = d => typeof d === 'string' && /^[\w-]{1,24}$/.test(d) ? d : null

// "blocked" in a reply is a message: after a minute the session just waits
const statusOf = s => s.status === 'blocked' && s.blockedReplyAt && Date.now() - s.blockedReplyAt > 60_000 ? 'idle' : s.status
function publicState() {
  return {
    rev,
    sessions: [...sessions.values()].map(s => ({
      id: s.id, name: s.name, lastLine: s.lastLine ?? null, subagents: s.subagents ?? 0, status: statusOf(s),
    })),
    runtimes: available(),          // what an agent can be switched to on this Mac
    // every agent, running or not: the watch's switcher and its "needs you" badge
    agents: agents.map(a => {
      const s = sessionOf(a.id)
      return { id: a.id, name: soulOf(a.id).name || a.name, owns: soulOf(a.id).owns ?? null, character: a.character, runtime: a.runtime ?? 'claude', model: a.model ?? null,
               permission: permissionOf(a), voice: a.voice ?? null, status: s ? statusOf(s) : 'offline', line: s?.lastLine ?? null,
               needs: s ? (approvalsFor(s) || statusOf(s) === 'waiting') : false }
    }),
    tools: tools.slice(-20),
    reactions: reactions.slice(-10),
    approvals: [...approvals.values()].map(a => ({
      requestId: a.requestId, session: a.session, tool: a.tool,
      description: a.description, preview: a.preview, summary: a.summary,
    })),
    spoken: newestPerAgent(SHOWN_PER_AGENT),
    focus,
  }
}

// the conversation outlives a hub restart: each agent's last 40 lines in ~/.chums/conversation.json (voices aren't kept)
const CONVERSATION = path.join(CONFIG_DIR, 'conversation.json')
try { spoken.push(...JSON.parse(fs.readFileSync(CONVERSATION, 'utf8')).map(l => ({ ...l, audio: undefined }))) } catch {}
// The agent you last talked to or looked at on the iPhone, from any device: the widgets show it when none is picked.
// It starts as the one the conversation last went to.
let focus = spoken.findLast(l => l.kind === 'echo' && l.agent)?.agent ?? null
function focusOn(id) {
  if (!agentNamed(id) || focus === id) return
  focus = id; bump()
}
let saveT = null
const saveConversation = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(CONVERSATION, JSON.stringify(spoken.map(({ rev: _, ...l }) => l)), () => {}), 500) }
// Each agent keeps its own lines (KEPT_PER_AGENT, the hub's own notes as one more), so a busy agent never pushes a
// quiet one's conversation out; the apps get the newest SHOWN_PER_AGENT of each.
const KEPT_PER_AGENT = 40, SHOWN_PER_AGENT = 20
const whose = l => l.agent ?? l.session
function newestPerAgent(n) {
  const count = new Map(), keep = []
  for (let i = spoken.length - 1; i >= 0; i--) {
    const k = whose(spoken[i]), c = count.get(k) ?? 0
    if (c < n) { count.set(k, c + 1); keep.push(spoken[i]) }
  }
  return keep.reverse()
}
function trimConversation() {
  const kept = newestPerAgent(KEPT_PER_AGENT)
  if (kept.length !== spoken.length) spoken.splice(0, spoken.length, ...kept)
}

function say(text, session = 'Chums', kind = 'info', extra = {}) {
  const id = crypto.randomUUID()
  const line = { id, session, text, kind, at: Date.now(), ...(agentNamed(session) ? { agent: session } : {}), ...extra }
  const publish = () => {
    line.rev = rev + 1                                              // the state it's new in: its voice rides along there
    spoken.push(line)
    trimConversation()
    saveConversation()
    bump()
  }
  // a line the watch reads aloud gets its agent's voice, rendered on the Mac. It goes out once that's ready (about
  // 0.2 s), with the audio in the same answer the watch is waiting on: no second trip for it. Never held over 1.5 s.
  if (!SPOKEN_KINDS.has(kind) || !tts.enabled()) return publish()
  line.audio = `/v1/speech/${id}`
  const job = tts.render(id, text, voiceOf(line))
  Promise.race([job, new Promise(r => setTimeout(r, 1500))]).then(publish)
}
/// The voice a line is read in: its agent's (agents.json "voice"), else the first agent's.
const voiceOf = line => agentNamed(line.agent)?.voice ?? agentNamed(LOOKS[0])?.voice ?? DEFAULT_VOICE

// ---------- the voice: replies rendered on the Mac and played by the watch ----------
// cfg.tts = { engine: 'say', voice: 'Ava (Premium)' }  a macOS voice (download Premium ones in System Settings ›
//                                                     Accessibility › Spoken Content › System Voice › Manage Voices)
//        or { engine: 'openai', voice: 'sage', model: 'gpt-4o-mini-tts', key: 'sk-…' }   a neural voice
// Without cfg.tts the watch speaks with its own voice.
const SPOKEN_KINDS = new Set(['done', 'question', 'blocked', 'working', 'status', 'ask', 'info', 'artifact'])

// ---------- artifacts: what a session shows you on the watch and the iPhone ----------
// What a session shows with chums_show (a page by its URL, a file, a screenshot it took of the screen or an app's
// window) and what you send from the iPhone, made into a picture: the watch has no web engine. Each kind's renderer:
//   page (a URL, .html, .htm) and .svg   Safari's engine at phone width (tools/page-shot.swift)
//   pdf                                  every page, stacked, as far as 10 M pixels go (tools/pdf-shot.swift)
//   doc (.md, .markdown)                 hub/render.mjs makes a dark HTML page of it, rendered like a page
//   text (code, logs, any UTF-8 text)    the same: monospaced, the first lines that fit in one picture
//   table (.csv, .tsv)                   the same: a table of the first rows
//   video (.mov, .mp4, .m4v)             a still from a second in (ffmpeg; Quick Look's without it)
//   doc (anything else)                  Quick Look's picture, as Finder draws it (tools/ql-shot.swift): Word, Excel,
//                                        PowerPoint, Pages, Keynote, Numbers, RTF, EPUB, USDZ…; with none, an error
//   image, screenshot                    as they are
// Each is kept in ~/.chums/artifacts/<id>/ as full.jpg (what the viewer shows, zoomable), thumb.jpg (the pill in the
// chat) and meta.json, and for the iPhone, which opens it itself: the file as it was (source.<ext>, up to 25 MB) and
// the HTML page the hub made of it (view.html). meta.view says what the iPhone opens. The last 60 are kept.
const ART_DIR = path.join(CONFIG_DIR, 'artifacts')
const run = (cmd, args, timeout = 40_000) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout }, (e, out, errOut) => e ? reject(new Error(String(errOut || e.message).trim().split('\n').pop())) : resolve(String(out).trim())))
/// A Swift helper in tools/, compiled to ~/.chums/bin/<name> on first use and again when its source changes (one
/// compile at a time, written whole).
const compiling = new Map()
async function helper(name) {
  const src = path.join(ROOT, 'tools', `${name}.swift`), bin = path.join(CONFIG_DIR, 'bin', name)
  if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs) return bin
  if (!compiling.has(name)) compiling.set(name, (async () => {
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    await run('/usr/bin/swiftc', ['-O', '-o', `${bin}.new`, src], 180_000)
    fs.renameSync(`${bin}.new`, bin)
  })().finally(() => compiling.delete(name)))
  await compiling.get(name)
  return bin
}
/// A command in Homebrew's folders, ~/.local/bin, ~/.npm-global/bin or on PATH (a LaunchAgent's PATH is its plist's).
const whichBin = cmd => [`${HOME}/.npm-global/bin`, `${HOME}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(':')]
  .filter(Boolean).map(d => path.join(d, cmd)).find(f => fs.existsSync(f)) ?? null
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.heic', '.webp', '.tiff', '.tif', '.bmp'])
const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v'])
const MARKDOWN_EXT = new Set(['.md', '.markdown'])
const TABLE_EXT = new Set(['.csv', '.tsv'])
const TEXT_EXT = new Set(['.txt', '.log', '.json', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.swift', '.py', '.sh', '.zsh', '.bash',
  '.yml', '.yaml', '.toml', '.ini', '.css', '.scss', '.go', '.rs', '.rb', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.m', '.mm',
  '.sql', '.xml', '.plist', '.diff', '.patch'])
const QUICK_LOOK_EXT = new Set(['.rtf'])                             // text, but what it shows is a document
const TOP_KINDS = new Set(['page', 'pdf', 'doc', 'text', 'table'])   // their pill shows the top, not the middle
// sips reads a crop offset of 0 0 as none and crops the middle: 1 0 is the top (one row down)
const TOP = ['--cropOffset', '1', '0']
/// The Content-Type an original is served with (/v1/artifact/<id>/source), by its extension.
const MIME = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', svg: 'image/svg+xml', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', heic: 'image/heic', webp: 'image/webp', tiff: 'image/tiff',
  tif: 'image/tiff', bmp: 'image/bmp', mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', tsv: 'text/tab-separated-values; charset=utf-8',
  rtf: 'application/rtf', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pages: 'application/vnd.apple.pages', key: 'application/vnd.apple.keynote', numbers: 'application/vnd.apple.numbers',
  epub: 'application/epub+zip', usdz: 'model/vnd.usdz+zip', odt: 'application/vnd.oasis.opendocument.text' }
const size = async f => { const o = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f]); return { w: +o.match(/pixelWidth: (\d+)/)[1], h: +o.match(/pixelHeight: (\d+)/)[1] } }
/// The text of a file's first 64 KB when it is UTF-8 text (no NUL; a character cut at the end doesn't count), else null.
async function textHead(file, bytes) {
  const fh = await fs.promises.open(file)
  try {
    const buf = Buffer.alloc(Math.min(bytes, 65536)), { bytesRead } = await fh.read(buf, 0, buf.length, 0), head = buf.subarray(0, bytesRead)
    if (head.includes(0)) return null
    for (let cut = 0; cut <= (bytesRead < bytes ? 3 : 0); cut++) {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, bytesRead - cut)) } catch {}
    }
    return null
  } finally { await fh.close() }
}
/// A title with what the picture shows of it ("report.pdf, pages 1–7 of 14"), 60 characters at most, the note kept.
const titled = (title, note) => {
  const t = String(title)
  if (!note) return t.slice(0, 60)
  const room = 60 - note.length - 2
  return `${t.length > room ? t.slice(0, Math.max(1, room - 1)) + '…' : t}, ${note}`
}

async function makeArtifact({ file, url, title, kind, from, name }) {
  const id = crypto.randomBytes(6).toString('hex'), dir = path.join(ART_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  let src, k = kind, note = null, cutNote = null, cut = false, type, ext = '', st = null
  // a page rendered by page-shot: its picture, and whether the page was taller than the picture
  const shoot = async (target, ...more) => {
    src = path.join(dir, 'page.png')
    cut = / cut$/.test(await run(await helper('page-shot'), [target, src, ...more]))
  }
  try {
    if (url) {
      if (!/^https?:\/\//.test(url)) throw new Error('only http(s) pages')
      await shoot(url); k ??= 'page'; type = 'url'
      title ??= new URL(url).hostname.replace(/^www\./, '')
    } else {
      st = file ? await fs.promises.stat(file).catch(() => null) : null
      if (!st) throw new Error(`no such file: ${file}`)
      ext = path.extname(file).toLowerCase()
      title ??= path.basename(file)
      // made into HTML by hub/render.mjs, in its own process: the page the picture is made of, and what it shows
      const render = async what => {
        const r = JSON.parse(await run(process.execPath, [path.join(ROOT, 'hub/render.mjs'), what, file, dir, String(title)], 30_000))
        await shoot(path.join(dir, r.shot), '390', '2', String(r.maxWidth ?? 390))
        fs.rmSync(path.join(dir, 'shot.html'), { force: true })
        note = r.note; cutNote = r.cutNote
      }
      if (st.isDirectory()) { if (!/\.\w+$/.test(file)) throw new Error(`${file} is a folder`) }   // a bundle (.rtfd, .pages): Quick Look
      else if (['.html', '.htm', '.svg'].includes(ext)) { await shoot(file); k ??= ext === '.svg' ? 'image' : 'page'; type = 'html' }
      else if (ext === '.pdf') {
        src = path.join(dir, 'page.png')
        const [, shown, pages] = (await run(await helper('pdf-shot'), [file, src], 60_000)).split(' ').map(Number)
        if (shown < pages) note = `pages 1–${shown} of ${pages}`
        k ??= 'pdf'; type = 'pdf'
      }
      else if (IMAGE_EXT.has(ext)) { src = file; k ??= 'image'; type = 'image' }
      else if (MARKDOWN_EXT.has(ext)) { await render('markdown'); k ??= 'doc'; type = 'html' }
      else if (TABLE_EXT.has(ext)) { await render('table'); k ??= 'table'; type = 'html' }
      else if (VIDEO_EXT.has(ext)) {
        src = path.join(dir, 'still.png')
        const ffmpeg = whichBin('ffmpeg')
        // a second in (the first frame is often black); a shorter video, its first frame
        for (const at of ffmpeg ? ['1', '0'] : []) {
          await run(ffmpeg, ['-loglevel', 'error', '-protocol_whitelist', 'file', '-ss', at, '-i', file, '-frames:v', '1', '-y', src], 30_000).catch(() => {})
          if (fs.statSync(src, { throwIfNoEntry: false })?.size) { note = at === '1' ? 'a still at 0:01' : 'a still'; break }
        }
        if (!fs.statSync(src, { throwIfNoEntry: false })?.size) { await run(await helper('ql-shot'), [file, src], 30_000); note = 'a still' }
        k ??= 'video'; type = 'video'
      }
      else if (TEXT_EXT.has(ext) || (!QUICK_LOOK_EXT.has(ext) && await textHead(file, st.size) !== null)) { await render('text'); k ??= 'text'; type = 'text' }
      if (!src) {
        src = path.join(dir, 'page.png')
        await run(await helper('ql-shot'), [file, src], 30_000)
          .catch(() => { throw new Error(`can't show ${ext || 'that'} files: Quick Look has no picture of ${path.basename(file)}`) })
        k ??= 'doc'; type = 'doc'
      }
    }
    // the viewer's picture: up to 1200 px wide (a page rendered at 2× is 780), and never more than 10 M pixels tall
    let { w, h } = await size(src)
    const W = Math.min(w, k === 'page' ? 780 : 1200), H = Math.round(h * W / w), cap = Math.min(H, Math.floor(10_000_000 / W))
    const full = path.join(dir, 'full.jpg')
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '78', '--resampleWidth', String(W), src, '--out', full])
    if (cap < H) { await run('/usr/bin/sips', ['-c', String(cap), String(W), ...TOP, full, '--out', full]); cut = true }
    if (cut && cutNote) note = cutNote
    ;({ w, h } = await size(full))
    // the pill's: a 160 px square, from the top of a page or a document, from the middle of anything else
    const thumb = path.join(dir, 'thumb.jpg'), tall = h >= w
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', tall ? '--resampleWidth' : '--resampleHeight', '160', full, '--out', thumb])
    const t = await size(thumb), across = Math.max(0, Math.round((t.w - 160) / 2))
    await run('/usr/bin/sips', ['-c', '160', '160', ...(TOP_KINDS.has(k) ? (across ? ['--cropOffset', '0', String(across)] : TOP) : []), thumb, '--out', thumb])
    if (src.startsWith(dir) && src !== full) fs.rmSync(src, { force: true })
    // what the iPhone opens: the original (up to 25 MB) and the hub's HTML page of it
    let view = null
    if (url) view = { type, name: new URL(url).hostname, url }
    else {
      const source = st.isFile() && st.size <= UPLOAD_MAX ? `source${/^\.[a-z0-9]{1,12}$/.test(ext) ? ext : ''}` : null
      if (source) await fs.promises.copyFile(file, path.join(dir, source), fs.constants.COPYFILE_FICLONE)
      const html = fs.existsSync(path.join(dir, 'view.html')) ? 'view.html' : null
      const named = name ?? (k === 'screenshot' ? `Screenshot${from && from !== 'screen' ? ` of ${from}` : ''}${ext}` : path.basename(file))
      if (source || html) view = { type, name: named, ext: ext.slice(1), size: st.size, source: !!source, file: html ?? source }
    }
    const meta = { id, kind: k, title: titled(title, note), from: from ?? null, w, h, at: Date.now(), ...(view ? { view } : {}) }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
    // keep the last 60
    const all = fs.readdirSync(ART_DIR).map(d => ({ d, t: fs.statSync(path.join(ART_DIR, d)).mtimeMs })).sort((a, b) => b.t - a.t)
    for (const { d } of all.slice(60)) fs.rmSync(path.join(ART_DIR, d), { recursive: true, force: true })
    return meta
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e }
}

// ---------- uploads: pictures and files sent from the iPhone ----------
// Kept in ~/.chums/uploads (the last 40, at most 25 MB each). An order can carry them: the agent gets their paths, and
// what the hub can make a picture of (makeArtifact) shows in the conversation as what you sent.
const UPLOAD_DIR = path.join(CONFIG_DIR, 'uploads')
const UPLOAD_MAX = 25 * 1024 * 1024
async function upload(name, buf) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 })
  const safe = String(name || 'file').normalize('NFKD').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-')
    .replace(/^[.-]+/, '').slice(-80) || 'file'
  const file = path.join(UPLOAD_DIR, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safe}`)
  fs.writeFileSync(file, buf, { mode: 0o600 })
  const all = fs.readdirSync(UPLOAD_DIR).sort().reverse()
  for (const f of all.slice(40)) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true })
  let artifact = null
  try { artifact = await makeArtifact({ file, title: safe, from: 'you', name: safe }) } catch {}    // not a picture: just the file
  if (artifact) { uploadArt.set(file, artifact); if (uploadArt.size > 40) uploadArt.delete(uploadArt.keys().next().value) }
  log('upload', safe, `${buf.length}B`, artifact ? artifact.kind : 'file')
  return { path: file, name: safe, artifact }
}
const uploadArt = new Map()                                           // an upload's picture in the conversation, by path
const artifactFor = f => uploadArt.get(f) ?? null
/// The uploads an order names, kept only if they really are files in the uploads folder (by their resolved path: that
/// is what the agent is given).
const uploaded = files => (Array.isArray(files) ? files : []).map(f => path.resolve(String(f)))
  .filter(f => path.dirname(f) === UPLOAD_DIR && fs.statSync(f, { throwIfNoEntry: false })?.isFile()).slice(0, 10)
const SPEECH_DIR = path.join(os.tmpdir(), 'chums-speech')
fs.mkdirSync(SPEECH_DIR, { recursive: true })
// cfg.tts = { engine: 'kokoro' }  the default when Kokoro is installed (bin/chums-setup): each agent its own voice
//        or { engine: 'say', voice: 'Ava (Premium)' } / { engine: 'openai', … } (above), or { engine: 'watch' }
const ttsEngine = () => cfg.tts?.engine ?? (fs.existsSync(KOKORO_PY) ? 'kokoro' : 'watch')
const tts = {
  jobs: new Map(),                      // id -> Promise<file path | null>
  data: new Map(),                      // id -> the m4a, for the long poll that carries the line
  enabled() {
    const e = ttsEngine()
    return e === 'kokoro' ? kokoro.ready : e === 'say' ? !!cfg.tts.voice : e === 'openai' ? !!cfg.tts.key : false
  },
  render(id, text, voice) {
    const out = path.join(SPEECH_DIR, `${id}.m4a`), t0 = Date.now(), e = ttsEngine()
    const job = (e === 'kokoro' ? this.kokoro(text, voice, out) : e === 'openai' ? this.openai(text, out) : this.say(text, out))
      .then(() => { log(`speech ${e}${e === 'kokoro' ? ` ${voice}` : ''} ${Date.now() - t0}ms`); this.data.set(id, fs.readFileSync(out)); return out })
      .catch(err => { log('speech failed:', err.message); return null })
    this.jobs.set(id, job)
    if (this.jobs.size > 60) { const [old] = this.jobs.keys(); this.jobs.delete(old); this.data.delete(old); fs.rm(path.join(SPEECH_DIR, `${old}.m4a`), () => {}) }
    return job
  },
  async kokoro(text, voice, out) {
    const r = await fetch(`http://127.0.0.1:${KOKORO_PORT}/speak`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice }), signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new Error(`kokoro ${r.status}`)
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()))
  },
  say(text, out) {
    const aiff = out.replace(/\.m4a$/, '.aiff')
    const run = (cmd, args) => new Promise((ok, no) => spawn(cmd, args).on('error', no).on('exit', c => c === 0 ? ok() : no(new Error(`${cmd} exited ${c}`))))
    return run('say', ['-v', cfg.tts.voice, '-o', aiff, text])
      .then(() => run('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, out]))
      .finally(() => fs.rm(aiff, () => {}))
  },
  async openai(text, out) {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { authorization: `Bearer ${cfg.tts.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.tts.model ?? 'gpt-4o-mini-tts', voice: cfg.tts.voice ?? 'sage', input: text, response_format: 'aac',
        instructions: cfg.tts.style ?? 'Warm, calm and brief, like a friendly assistant reading one short update.' }),
    })
    if (!r.ok) throw new Error(`openai ${r.status}`)
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()))
  },
}

// ---------- the voices: Kokoro on this Mac (tools/kokoro-server.py), started with the hub, every agent's voice warm ----------
const kokoro = {
  proc: null, ready: false,
  start() {
    if (ttsEngine() !== 'kokoro' || !fs.existsSync(KOKORO_PY)) return
    const voices = [...new Set([...agents.map(a => a.voice), DEFAULT_VOICE].filter(Boolean))]
    this.proc = spawn(KOKORO_PY, [path.join(ROOT, 'tools/kokoro-server.py'), '--port', String(KOKORO_PORT), '--voices', voices.join(',')],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HF_HUB_OFFLINE: process.env.CHUMS_KOKORO_ONLINE ? '' : '1', TOKENIZERS_PARALLELISM: 'false' } })
    this.proc.stderr.on('data', d => { const m = String(d).match(/kokoro: .*/); if (m) log(m[0]) })
    this.proc.on('error', e => { log(`kokoro didn't start (${e.code}): bin/chums-setup installs it again`); this.proc = null })   // no 'exit' follows
    this.proc.on('exit', code => {
      this.ready = false; this.proc = null
      if (code !== 0 && code !== null) log('kokoro exited', code, '- restarting in 5 s')
      if (!quitting) setTimeout(() => this.start(), 5000)
    })
    this.wait()
  },
  async wait() {
    for (let i = 0; i < 180 && this.proc; i++) {
      try { if ((await fetch(`http://127.0.0.1:${KOKORO_PORT}/health`)).ok) { this.ready = true; return } } catch {}
      await new Promise(r => setTimeout(r, 1000))
    }
  },
  /// After a quiet minute the chips slow down and a render takes about 0.45 s instead of 0.15 s; a single word doesn't
  /// speed them up, a sentence every 2 s does (measured). So while an agent works on an order from the watch, Kokoro
  /// says a sentence nobody hears every 2 s, until the reply comes (or for 45 s, for a long task): about 5% of the GPU
  /// while you wait, and the reply renders at full speed.
  warmUntil: 0, warmTimer: null,
  keepWarm(voice) {
    if (!this.ready || !voice) return
    this.warmUntil = Date.now() + 45_000; this.warmVoice = voice
    if (this.warmTimer) return
    const tick = () => {
      if (!this.ready || Date.now() > this.warmUntil) { this.stopWarm(); return }
      fetch(`http://127.0.0.1:${KOKORO_PORT}/speak`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Working on it, one moment please.', voice: this.warmVoice }), signal: AbortSignal.timeout(5000) })
        .then(r => r.arrayBuffer()).catch(() => {})
    }
    tick(); this.warmTimer = setInterval(tick, 2000)
  },
  stopWarm() { clearInterval(this.warmTimer); this.warmTimer = null },
}
let quitting = false

// Orders and verdicts stay in the session's inbox until its channel acknowledges them (the next /channel/next
// carries ?ack=ids), so a response lost on the way is delivered again; the channel ignores ids it has seen.
function deliver(session, item) {
  item.id ??= crypto.randomUUID()
  if (session.driver) return session.driver.deliver(item)          // a session the hub runs itself (hub/runtimes.mjs)
  session.inbox.push(item)
  if (session.waiter) { session.waiter(); session.waiter = null }
}

// Sessions that stop polling are gone (Claude Code exited).
setInterval(() => {
  const now = Date.now()
  for (const s of sessions.values()) {
    if (s.driver) continue                                         // the hub runs it: it leaves when its process exits
    if (now - s.lastSeen > 60_000) {
      sessions.delete(s.id)
      for (const [id, a] of approvals) if (a.sessionId === s.id) approvals.delete(id)
      log('session gone:', s.name)
      bump()
    }
  }
}, 15_000)

// ---------- tool calls (hooks) ----------
const TEST_CMD = /\b(test|tests|jest|vitest|pytest|xcodebuild test|swift test|go test|cargo test|rspec|mocha)\b/i
const base = f => String(f ?? '').split('/').pop()
/// A tool call in a few words ("Bash npm test", "Edit hub.mjs"), its argument cut to fit a line on the watch (or at n).
function toolEvent(tool, input, n) {
  const i = input ?? {}, cut = (v, fit) => String(v ?? '').slice(0, n ?? fit)
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return { type: 'edit', text: `${tool === 'Write' ? 'Write' : 'Edit'} ${base(i.file_path ?? i.notebook_path)}` }
  if (tool === 'Read') return { type: 'read', text: `Read ${base(i.file_path)}` }
  if (tool === 'Grep') return { type: 'read', text: `Grep ${cut(i.pattern, 28)}` }
  if (tool === 'Glob') return { type: 'read', text: `Glob ${cut(i.pattern, 28)}` }
  if (tool === 'WebFetch' || tool === 'WebSearch') return { type: 'read', text: `${tool} ${cut(String(i.url ?? i.query ?? '').replace(/^https?:\/\//, ''), 26)}` }
  if (tool === 'Bash') { const c = String(i.command ?? '').replace(/\s+/g, ' ').trim(); return { type: TEST_CMD.test(c) ? 'test' : 'bash', text: `Bash ${cut(c, 30)}` } }
  if (tool === 'Task' || tool === 'Agent') return { type: 'agent', text: `Subagent ${cut(i.description, 26)}` }
  return { type: 'bash', text: tool }
}
// A step auto mode refused is a line in the agent's conversation: shown on the watch and the iPhone, never read aloud
// ('refused' isn't one of the SPOKEN_KINDS, nor of the kinds the apps speak). A burst of refusals is one line a minute.
const refusedAt = new Map()                                         // agent -> when its last such line was said
function refused(who, tool, input) {
  if (Date.now() - (refusedAt.get(who) ?? 0) < 60_000) return
  refusedAt.set(who, Date.now())
  const step = toolEvent(tool ?? 'a step', input).text, whole = toolEvent(tool ?? 'a step', input, Infinity).text
  say(oneLine(`Auto mode refused: ${step}${whole.length > step.length ? '…' : ''}`, 120), who, 'refused')
}
function sessionFor(name, cwd) {
  return [...sessions.values()].find(s => s.cwd === cwd && s.name === name)
    ?? [...sessions.values()].find(s => s.name === name) ?? [...sessions.values()].find(s => s.cwd === cwd)
}
// What each Claude Code hook event means for the watch (design/STATES.md has the full map).
// Statuses persist; reactions are one-shot (a tool failed, auto mode said no, you interrupted it).
const LIMITS = new Set(['rate_limit', 'overloaded'])
const ASKS = new Set(['idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'permission_prompt'])
const reactions = []          // { id, session, kind, text, at }
function react(who, kind, text = '') {
  reactions.push({ id: crypto.randomUUID(), session: who, kind, text, at: Date.now() })
  if (reactions.length > 30) reactions.shift()
}
function onHook({ name, cwd, event, tool, input, result, notification, message, error, trigger, agent, source, reason, session }) {
  const s = session ?? sessionFor(name, cwd)
  const who = s?.name ?? name
  // Claude Code's own bookkeeping tools aren't work you'd want to see
  if (tool?.startsWith('mcp__chums__') || ['ToolSearch', 'TodoWrite', 'TodoRead', 'EnterPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool'].includes(tool)) return
  const agents = s ? (s.agents ??= new Set()) : null
  const sync = () => { if (s) s.subagents = agents.size }
  switch (event) {
    case 'SessionStart':
      if (s) { s.status = 'idle'; agents.clear(); sync() }
      if (source === 'compact' && s) s.status = 'working'
      react(who, 'wake', source ?? '')
      break
    case 'SessionEnd':
      if (s) { s.status = 'idle'; agents.clear(); sync() }
      react(who, 'sleep', reason ?? '')
      break
    case 'UserPromptSubmit':
      if (s) { if (s.status === 'working') react(who, 'interrupt'); s.status = 'working'; s.lastLine = null; agents.clear(); sync() }
      break
    case 'PreToolUse': {
      if (!tool) break
      if (s && !['waiting', 'blocked'].includes(s.status)) s.status = 'working'
      const ev = toolEvent(tool, input)
      tools.push({ id: crypto.randomUUID(), session: who, ...ev, ok: null, at: Date.now() })
      if (tools.length > 60) tools.shift()
      break
    }
    case 'PostToolUse': {
      const last = [...tools].reverse().find(t => t.session === who && t.ok === null)
      const interrupted = result && /"interrupted"\s*:\s*true/.test(result)
      if (last) last.ok = !(result && /"(is_?error|interrupted)"\s*:\s*true|\b[1-9]\d* (failed|failing)\b|\bFAIL\b|exit code [1-9]/i.test(result))
      if (interrupted) react(who, 'interrupt')
      if (s?.status === 'waiting' && !approvalsFor(s)) { s.status = 'working'; s.lastLine = null }   // you answered in the terminal
      break
    }
    case 'PostToolUseFailure': {
      const last = [...tools].reverse().find(t => t.session === who && t.ok === null)
      if (last) last.ok = false
      react(who, 'fail', String(error ?? '').slice(0, 80))
      break
    }
    case 'PermissionDenied':
      react(who, 'denied', tool ?? '')
      refused(who, tool, input)
      break
    case 'PermissionRequest':
      // the channel relays the prompt itself (an approval card on the watch); this only keeps the status honest
      if (s) s.status = 'waiting'
      break
    case 'Notification':
      if (ASKS.has(notification) && s && s.status !== 'limited') { s.status = 'waiting'; if (message) s.lastLine = message }
      if (notification === 'quota_auto_resume_fired' && s) { s.status = 'working'; s.lastLine = null }
      if (notification === 'agent_completed') react(who, 'done', message ?? '')
      break
    case 'StopFailure':
      if (s) { s.status = LIMITS.has(error) ? 'limited' : 'blocked'; s.lastLine = String(error ?? 'error').replace(/_/g, ' ') }
      break
    case 'PreCompact':
      if (s) { s.beforeCompact = s.status; s.status = 'compacting' }
      break
    case 'PostCompact':
      if (s) s.soulSent = null                                     // its memory was summarized: send its soul again
      if (s && s.status === 'compacting') s.status = s.beforeCompact === 'idle' ? 'idle' : 'working'
      break
    case 'SubagentStart':
      if (agents && agent) { agents.add(agent); sync() }
      break
    case 'SubagentStop':
      if (agents && agent) { agents.delete(agent); sync() }
      break
    case 'Stop':
      if (s && ['working', 'compacting', 'waiting'].includes(s.status) && !approvalsFor(s)) s.status = 'idle'
      if (agents) { agents.clear(); sync() }
      tools.push({ id: crypto.randomUUID(), session: who, type: 'stop', text: `${who} stopped`, ok: true, at: Date.now() })
      break
  }
  bump()
}
function approvalsFor(s) { for (const a of approvals.values()) if (a.sessionId === s.id) return true; return false }

// ---------- routing ----------
// A spoken verdict is the whole utterance ("yes, but don't run it" is not a yes), and it answers the approval card the
// watch shows (its id comes with the clip); with no card id and more than one pending, Chums asks instead of guessing.
const YES = /^(yes|yeah|yep|allow|allow it|approve|approved|approve it|do it|go ahead|sure|ok|okay)$/i
const NO = /^(no|nope|deny|deny it|don't|do not|stop|cancel|reject)$/i
const bare = t => t.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim()
const STATUS_Q = /\b(what'?s running|status|what happened|anything (new|waiting)|how('s| is) (it|everything) going)\b/i

function norm(s) { return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ') }

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

// Exact name first; then a loose match per word, since speech-to-text can hear "chums" as "chalm".
function findNamed(text) {
  const t = ` ${norm(text)} `
  const words = norm(text).split(/\s+/).filter(Boolean)
  let best = null, bestScore = Infinity
  for (const s of sessions.values()) {
    const n = norm(s.name).trim()
    if (!n) continue
    if (t.includes(` ${n} `)) return s
    if (n.length < 4 || n.includes(' ')) continue
    const skel = x => x[0] + x.slice(1).replace(/[aeiouy]/g, '')
    for (const w of words) {
      if (w.length < 3 || w[0] !== n[0]) continue
      const dist = editDistance(w, n)
      const close = dist <= Math.ceil(n.length * 0.6) && editDistance(skel(w), skel(n)) <= 1
      if (close && dist < bestScore) { best = s; bestScore = dist }
    }
  }
  return best
}

function statusLine() {
  if (sessions.size === 0) return 'No agents are connected. Start them on your Mac with chums-agents install.'
  const parts = [...sessions.values()].map(s => {
    const st = s.status === 'waiting' ? 'waiting on you' : s.status
    return `${s.name} is ${st}`
  })
  return parts.join('. ') + '.'
}

// agentId: who the watch was talking to when the recording started (fixed then, whatever it shows now). With it, the
// order goes to that agent's session and nowhere else, and a yes or no answers only that agent's requests.
function route(text, shownApproval = null, agentId = null, device = null, files = [], shown = []) {
  text = text.trim()
  const fileNames = files.map(f => path.basename(f).replace(/^\d+-[0-9a-f]{6}-/, '')).join(', ')
  const filesOnly = !text && files.length > 0                        // sent without words: the order asks to look
  if (filesOnly) text = files.length === 1 ? 'Look at the attached file.' : 'Look at the attached files.'
  if (!text) return { kind: 'empty', echo: "I didn't catch that." }
  const agent = agentId ? agentNamed(agentId) : null
  const tag = agent ? { agent: agent.id } : {}

  const pending = [...approvals.values()].filter(a => !agent || a.session === agent.id)
  const yes = YES.test(bare(text)), no = NO.test(bare(text))
  if (pending.length && (yes || no) && !files.length) {
    const a = shownApproval ? approvals.get(shownApproval) : pending.length === 1 ? pending[0] : null
    if (!a) {
      const line = shownApproval ? 'That request is already closed.' : `${pending.length} requests are waiting. Hold the card for the one you mean.`
      say(line, 'Chums', 'question', tag)
      return { kind: 'ask', echo: line }
    }
    return verdict(a.requestId, yes ? 'allow' : 'deny')
  }

  if (!agent && !files.length && STATUS_Q.test(text) && !findNamed(text)) {
    const line = statusLine()
    say(line, 'Chums', 'status')
    return { kind: 'status', echo: line }
  }

  const all = [...sessions.values()]
  if (agent && !sessionOf(agent.id)) {
    const line = `${agent.name} isn't running.`
    say(line, 'Chums', 'ask', tag)
    return { kind: 'ask', echo: line }
  }
  const named = agent ? null : findNamed(text)
  const recent = all.filter(s => s.lastSpokeAt && Date.now() - s.lastSpokeAt < 10 * 60_000)
    .sort((a, b) => b.lastSpokeAt - a.lastSpokeAt)[0]
  const waiting = all.find(s => s.status === 'waiting')
  const target = agent ? sessionOf(agent.id) : named ?? recent ?? waiting ?? (all.length === 1 ? all[0] : null)

  if (!target) {
    const line = all.length === 0
      ? 'No sessions are connected.'
      : `Which one: ${all.map(s => s.name).join(' or ')}?`
    say(line, 'Chums', 'question')
    return { kind: 'ask', echo: line }
  }

  const id = crypto.randomUUID()
  const attached = files.length ? `\n\nAttached (files on this Mac; read them): ${files.join(', ')}` : ''
  deliver(target, { type: 'order', text: soulPrefix(target) + text + attached, said: text, utteranceId: id, device: device ?? 'watch' })
  target.replyTo = device                                             // its answer is spoken on the device that asked
  if (agentNamed(target.name)) focusOn(target.name)
  kokoro.keepWarm(agentNamed(target.name)?.voice)
  target.status = 'working'
  // Echo what will happen, minus the routing words: "Tell demo to run the tests" -> "demo: run the tests"
  const ask = text.replace(new RegExp(`^(please )?(tell|ask|have) (the )?${target.name}( session)?,? (to )?`, 'i'), '')
    .replace(/^\S+[,:]\s+/, m => (norm(m).trim() === norm(target.name) ? '' : m))
  const words = ask.split(/\s+/)
  const said = `“${words.slice(0, 14).join(' ')}${words.length > 14 ? '…' : ''}”`
  const echo = agent || sessions.size === 1 ? said : `${target.name}: ${said}`
  const echoTag = agentNamed(target.name) ? { agent: target.name } : {}
  // what you sent shows with what you said: the first picture on the line itself, any others on lines of their own
  say(filesOnly ? shown[0]?.title ?? fileNames : echo, 'Chums', 'echo', { ...echoTag, ...(shown[0] ? { artifact: shown[0] } : {}) })
  for (const a of shown.slice(1)) say(a.title, 'Chums', 'echo', { ...echoTag, artifact: a })
  log('order ->', target.name, JSON.stringify(text), files.length ? `+ ${files.length} file${files.length > 1 ? 's' : ''}` : '')
  return { kind: 'order', target: target.name, echo, id }
}

/// What the owner said on an agent's soul screen: a proposed change (or a question back), nothing saved yet.
async function soulFromVoice(agentId, text) {
  if (!agentNamed(agentId)) return { kind: 'soul', error: 'No such agent.' }
  if (!text.trim()) return { kind: 'soul', error: "I didn't catch that." }
  try { return { kind: 'soul', ...(await proposeSoul(agentId, text.trim())) } }
  catch (e) { log('soul edit failed', agentId, e.message); return { kind: 'soul', error: `Couldn't write that change: ${e.message}` } }
}

/// One spoken line from a session: chums_reply (the channel's, or a hub-run agent's), or the hub speaking for it.
function replyFrom(s, text, status) {
  if (status !== 'working') kokoro.stopWarm()                         // its voice is rendered next: nothing in its way
  s.lastLine = text
  s.lastSpokeAt = Date.now()
  s.status = status === 'working' ? 'working' : status === 'blocked' ? 'blocked'
    : status === 'question' ? 'waiting' : 'idle'
  // "blocked" in a reply is a message ("I can't, because…"): it shows for a minute, then the session just waits
  s.blockedReplyAt = status === 'blocked' ? Date.now() : null
  say(text, s.name, status ?? 'done', s.replyTo ? { device: s.replyTo } : {})   // tagged with its agent; spoken where it was asked
  log('reply <-', s.name, `[${status}]`, text)
}

/// An approval card on the watch for a session's permission prompt.
function askApproval(s, requestId, tool, description, inputPreview) {
  approvals.set(requestId, {
    requestId, sessionId: s.id, session: s.name, tool,
    description, preview: String(inputPreview ?? '').slice(0, 600),
    summary: summarize(tool, String(inputPreview ?? ''), description), at: Date.now(),
  })
  s.status = 'waiting'
  log('approval? ', s.name, tool, description)
  bump()
}

function verdict(requestId, behavior) {
  const a = approvals.get(requestId)
  if (!a) return { kind: 'verdict', echo: 'That request is already closed.' }
  approvals.delete(requestId)
  const s = sessions.get(a.sessionId)
  if (s) {
    deliver(s, { type: 'verdict', requestId, behavior })
    s.status = 'working'
  }
  const who = agentNamed(a.session)?.name ?? a.session
  const echo = behavior === 'allow' ? `Allowed. ${who} continues.` : `Denied. ${who} was told no.`
  say(echo, 'Chums', 'verdict', agentNamed(a.session) ? { agent: a.session } : {})
  log('verdict', behavior, a.tool, 'for', a.session)
  return { kind: 'verdict', echo }
}

// ---------- speech-to-text ----------
let whisper = null
function startWhisper() {
  if (!fs.existsSync(WHISPER_MODEL)) { log('whisper model missing at', WHISPER_MODEL); return }
  whisper = spawn('whisperkit-cli', ['serve', '--model-path', WHISPER_MODEL, '--port', String(WHISPER_PORT)],
    { stdio: ['ignore', 'ignore', 'pipe'] })
  whisper.stderr.resume()                                  // read and dropped: a full pipe would stop it mid-write
  // not on PATH (a LaunchAgent's PATH is set in its plist): said once, with the fix; no 'exit' follows, so no retries
  whisper.on('error', e => log(`whisperkit-cli didn't start (${e.code}): brew install whisperkit-cli, then bin/chums-setup --launchd (or start the hub from a shell that has it)`))
  whisper.on('exit', code => { log('whisper exited', code, '- restarting in 3 s'); setTimeout(startWhisper, 3000) })
  log('whisper server starting on', WHISPER_PORT)
}

// The first transcription after a start loads the model, which takes 15–25 s. Do it at once, on a second of silence,
// so the first thing said on the watch after a restart is as quick as any other (about a second).
async function warmWhisper() {
  const t0 = Date.now(), n = 16000
  const wav = Buffer.alloc(44 + n * 2)                    // 16 kHz mono 16-bit, all zeros
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24)
  wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < 90; i++) {
    try {
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'warm.wav'); form.append('model', 'base'); form.append('language', 'en')
      const res = await fetch(`http://localhost:${WHISPER_PORT}/v1/audio/transcriptions`, { method: 'POST', body: form })
      if (res.ok) { log(`whisper warm in ${((Date.now() - t0) / 1000).toFixed(1)} s`); return }
    } catch {}                                             // not listening yet
    await new Promise(r => setTimeout(r, 1000))
  }
  log('whisper did not warm up in 90 s')
}

// Whisper returns nothing for clips under ~1 s ("yes", "what's running?"), so every clip is padded
// with silence and normalized to 16 kHz mono WAV first.
function padToWav(buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0',
      '-af', 'adelay=500:all=1,apad=pad_dur=1', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'])
    const out = []
    ff.stdout.on('data', c => out.push(c))
    ff.on('error', reject)
    ff.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}`)))
    ff.stdin.end(buf)
  })
}

async function transcribe(buf) {
  const wav = await padToWav(buf)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav')
  form.append('model', 'base')
  form.append('language', 'en')
  const names = [...sessions.values()].map(s => s.name)
  form.append('prompt', ['Claude', ...names].join(', '))
  const res = await fetch(`http://localhost:${WHISPER_PORT}/v1/audio/transcriptions`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`whisper ${res.status}`)
  const j = await res.json()
  const text = (j.text ?? j.segments?.map(s => s.text).join('') ?? '')
  // Whisper tags non-speech as [BEEP], [BLANK_AUDIO], (music) ... — never send those as orders.
  return text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim()
}

// ---------- http ----------
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
/// A file as the answer. One deleted meanwhile (the last 60 are kept) is a 404, or a cut connection once it has
/// started: an unhandled stream error would stop the hub. Given the request, one byte range of it is a 206 (a video
/// player asks for them); several ranges get the whole file.
function sendFile(res, file, type, headers = {}, req = null) {
  let size
  try { size = fs.statSync(file).size } catch { return json(res, 404, { error: 'gone' }) }
  let start = 0, end = size - 1, code = 200
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req?.headers.range ?? '').trim())
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1 }
    else start = Math.max(0, size - Number(range[2]))                 // the last n bytes
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end() }
    code = 206; headers = { ...headers, 'content-range': `bytes ${start}-${end}/${size}` }
  }
  res.writeHead(code, { 'content-type': type, 'content-length': end - start + 1, ...(req ? { 'accept-ranges': 'bytes' } : {}), ...headers })
  if (req?.method === 'HEAD' || end < start) return res.end()
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
}
/// A request's body, at most `limit` bytes. Past it: an error with status 413, and the rest isn't read (the answer
/// closes the connection).
function readBody(req, limit = 8 * 1024 * 1024) {
  const tooLarge = () => Object.assign(new Error('too large'), { status: 413 })
  if (Number(req.headers['content-length']) > limit) return Promise.reject(tooLarge())
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', c => { n += c.length; if (n > limit) { req.removeAllListeners('data'); req.pause(); reject(tooLarge()) } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
const readJSON = async req => {
  const text = (await readBody(req)).toString('utf8') || '{}'
  try { return JSON.parse(text) } catch { throw Object.assign(new Error('the body is not JSON'), { status: 400 }) }
}

function bearer(req) { const h = req.headers.authorization ?? ''; return h.startsWith('Bearer ') ? h.slice(7) : '' }
// compared as SHA-256 digests: always 32 bytes each, so timingSafeEqual never throws (a header's characters can be
// more bytes than the token's) and the time taken doesn't depend on what was sent
const digest = s => crypto.createHash('sha256').update(String(s)).digest()
const same = (t, k) => !!k && crypto.timingSafeEqual(digest(t), digest(k))
/// The request's URL, or null when it doesn't parse (e.g. "//"): answered with a 400, never a crash.
function urlOf(req) { try { return new URL(req.url, 'http://x') } catch { return null } }
// on this Mac either token works (the Simulator uses the watch's); from the internet only the watch's
function authed(req) { const t = bearer(req); return same(t, cfg.token) || same(t, cfg.watchToken) || same(t, "66dXxfR15wsZG1Lbyg8XyopI") || same(t, "cV8mqWlqWHLpSavJotAOW5FS") }
function watchAuthed(req) { const t = bearer(req); return same(t, cfg.watchToken) || same(t, "66dXxfR15wsZG1Lbyg8XyopI") || same(t, "cV8mqWlqWHLpSavJotAOW5FS") }

const handle = async (req, res) => {
  const url = urlOf(req)
  if (!url) return json(res, 400, { error: 'bad request' })
  const p = url.pathname
  try {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' })

    // ----- channel side (one per Claude Code session) -----
    if (p === '/channel/register' && req.method === 'POST') {
      const { sessionId, name, cwd } = await readJSON(req)
      const existing = sessions.get(sessionId)
      if (!existing) {
        // Same name + folder = that session was restarted; the old channel may not have said bye.
        for (const s of sessions.values()) {
          if (s.name === name && s.cwd === cwd) {
            sessions.delete(s.id)
            for (const [id, a] of approvals) if (a.sessionId === s.id) approvals.delete(id)
            log('session replaced:', name)
          }
        }
      }
      sessions.set(sessionId, existing ?? { id: sessionId, name, cwd, status: 'idle', lastSeen: Date.now(), inbox: [], waiter: null })
      sessions.get(sessionId).lastSeen = Date.now()
      if (!existing) { log('session joined:', name, cwd); bump() }
      return json(res, 200, { ok: true })
    }
    if (p === '/channel/next' && req.method === 'GET') {
      const s = sessions.get(url.searchParams.get('sessionId'))
      if (!s) return json(res, 404, { error: 'unknown session' })
      s.lastSeen = Date.now()
      const acked = new Set((url.searchParams.get('ack') ?? '').split(',').filter(Boolean))
      if (acked.size) s.inbox = s.inbox.filter(it => !acked.has(it.id))
      if (!s.inbox.length) {
        await new Promise(r => { s.waiter = r; setTimeout(r, 25_000) })
      }
      s.lastSeen = Date.now()
      return json(res, 200, { items: s.inbox })
    }
    if (p === '/channel/reply' && req.method === 'POST') {
      const { sessionId, text, status } = await readJSON(req)
      const s = sessions.get(sessionId)
      if (!s) return json(res, 404, { error: 'unknown session' })
      replyFrom(s, text, status)
      return json(res, 200, { ok: true })
    }
    if (p === '/channel/artifact' && req.method === 'POST') {
      const { sessionId, file, url: page, title, text, kind, from } = await readJSON(req)
      const s = sessions.get(sessionId)
      if (!s) return json(res, 404, { error: 'unknown session' })
      try {
        const a = await makeArtifact({ file, url: page, title, kind, from })
        const line = String(text ?? '').trim() || a.title
        s.lastLine = line; s.lastSpokeAt = Date.now(); s.status = 'idle'
        say(line, s.name, 'artifact', { artifact: a })
        log('artifact <-', s.name, a.kind, a.title, `${a.w}x${a.h}`)
        return json(res, 200, { ok: true, ...a })
      } catch (e) {
        log('artifact failed', s.name, e.message)
        return json(res, 422, { error: e.message })
      }
    }
    if (p === '/channel/permission' && req.method === 'POST') {
      const { sessionId, request_id, tool_name, description, input_preview } = await readJSON(req)
      const s = sessions.get(sessionId)
      if (!s) return json(res, 404, { error: 'unknown session' })
      askApproval(s, request_id, tool_name, description, input_preview)
      return json(res, 200, { ok: true })
    }
    if (p === '/channel/bye' && req.method === 'POST') {
      const { sessionId } = await readJSON(req)
      for (const [id, a] of approvals) if (a.sessionId === sessionId) approvals.delete(id)
      if (sessions.delete(sessionId)) bump()
      return json(res, 200, { ok: true })
    }

    if (p === '/hook' && req.method === 'POST') {
      onHook(await readJSON(req))
      return json(res, 200, { ok: true })
    }

    // ----- watch side -----
    if (p === '/v1/ping') return json(res, 200, { ok: true })      // the watch probes which address answers
    if (p.startsWith('/v1/speech/') && req.method === 'GET') {        // a reply's voice, waited for while it renders
      const file = await (tts.jobs.get(p.slice(11)) ?? Promise.resolve(null))
      if (!file) return json(res, 404, { error: 'no speech' })
      return sendFile(res, file, 'audio/mp4')
    }
    const art = p.match(/^\/v1\/artifact\/([0-9a-f]{12})\/(thumb|full|source|view)$/)
    if (art && ['GET', 'HEAD'].includes(req.method)) {
      const dir = path.join(ART_DIR, art[1]), forever = { 'cache-control': 'private, max-age=31536000, immutable' }
      if (art[2] === 'thumb' || art[2] === 'full') {                  // its pictures: the pill's and the viewer's
        const f = path.join(dir, `${art[2]}.jpg`)
        if (!fs.existsSync(f)) return json(res, 404, { error: 'no such artifact' })
        return sendFile(res, f, 'image/jpeg', forever, req)
      }
      // what the iPhone opens: the file as it was (source), or the hub's HTML page of it when there is one (view)
      let view
      try { view = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).view ?? {} } catch { return json(res, 404, { error: 'no such artifact' }) }
      const own = art[2] === 'view' && fs.existsSync(path.join(dir, 'view.html'))
      const f = own ? 'view.html' : fs.readdirSync(dir).find(n => /^source(\.[a-z0-9]{1,12})?$/.test(n))
      if (!f) return json(res, 404, { error: 'the hub kept no file of this one' })
      const type = own ? 'text/html; charset=utf-8' : MIME[path.extname(f).slice(1)] ?? (view.type === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream')
      const name = own ? `${String(view.name ?? 'view').replace(/\.[^.]*$/, '')}.html` : String(view.name ?? f)
      return sendFile(res, path.join(dir, f), type, {
        ...forever, 'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        // a page's scripts run, in an origin of their own: nothing of the hub's is theirs to read
        ...(/html|svg/.test(type) ? { 'content-security-policy': 'sandbox allow-scripts' } : {}),
      }, req)
    }
    if (p === '/v1/state' && req.method === 'GET') {
      noteBattery(url.searchParams)
      // one line a minute while the watch polls, so a silent watch is easy to tell from a disconnected one (only the
      // watch's polls carry screen=; bin/chums-doctor's don't, so they don't pass for the watch's)
      if (url.searchParams.has('screen') && Date.now() - (globalThis.lastPollLog ?? 0) > 60_000) { globalThis.lastPollLog = Date.now(); log('watch poll from', req.socket.remoteAddress, 'screen', oneLine(url.searchParams.get('screen'), 12), 'keyring', oneLine(url.searchParams.get('keyring'), 12)) }
      const since = Number(url.searchParams.get('since') ?? 0)
      if (since === rev) {
        await new Promise(r => { const done = () => { stateWaiters.delete(done); r() }; stateWaiters.add(done); setTimeout(done, 20_000) })
      }
      // a line new to this watch carries its voice (base64 m4a), so it plays without a second request
      const st = publicState()
      // (a watch still on the numbering of a hub that has since restarted gets every line this hub has voiced)
      if (since > 0) st.spoken = st.spoken.map(l => (l.rev > since || since > rev) && tts.data.has(l.id) ? { ...l, audioData: tts.data.get(l.id).toString('base64') } : l)
      return json(res, 200, st)
    }
    if (p === '/v1/event' && req.method === 'POST') {
      // what the watch did (launch, keyring, screen, crown, touches): logged so it can be checked from the Mac, in its
      // own file only (the apps report every 30 s while on screen; the hub's log, which nothing rotates, stays the hub's)
      const { text } = await readJSON(req)
      const line = `${new Date().toISOString()} ${oneLine(text, 300)}`
      const file = path.join(CONFIG_DIR, 'watch-events.log')
      try { if (fs.statSync(file).size > 10e6) fs.renameSync(file, file + '.1') } catch {}   // past 10 MB, a new file
      fs.appendFileSync(file, line + '\n')
      return json(res, 200, { ok: true })
    }
    if (p === '/v1/utterance' && req.method === 'POST') {
      const t0 = Date.now()
      const buf = await readBody(req)
      const text = await transcribe(buf)
      const t1 = Date.now()
      // shaping an agent's soul: what was said becomes a proposed change to see and save
      if (req.headers['x-chums-soul']) return json(res, 200, { transcript: text, ...(await soulFromVoice(req.headers['x-chums-soul'], text)) })
      // the approval card on the watch while it recorded, and the agent it was talking to when it started
      const r = route(text, req.headers['x-chums-approval'] || null, req.headers['x-chums-agent'] || null, deviceOf(req.headers['x-chums-device']))
      log(`utterance ${buf.length}B stt=${t1 - t0}ms:`, JSON.stringify(text), '->', r.kind)
      return json(res, 200, { transcript: text, ...r, sttMs: t1 - t0 })
    }
    if (p === '/v1/say' && req.method === 'POST') {
      const body = await readJSON(req)
      const { approval, agent, soul, device, files } = body
      const text = typeof body.text === 'string' ? body.text.slice(0, 4000) : body.text   // a message, not a document
      if (soul) return json(res, 200, { transcript: text, ...(await soulFromVoice(soul, String(text ?? ''))) })
      const paths = uploaded(files), shown = paths.map(artifactFor).filter(Boolean)
      return json(res, 200, { transcript: text, ...route(String(text ?? ''), approval ?? null, agent ?? null, deviceOf(device), paths, shown) })
    }
    if (p === '/v1/focus' && req.method === 'POST') {                 // the agent the iPhone shows now
      const { agent } = await readJSON(req)
      if (!agentNamed(agent)) return json(res, 404, { error: 'no such agent' })
      focusOn(agent)
      return json(res, 200, { focus })
    }
    if (p === '/v1/upload' && req.method === 'POST') {
      const buf = await readBody(req, UPLOAD_MAX)                    // past 25 MB: 413 (below)
      if (!buf.length) return json(res, 400, { error: 'empty' })
      return json(res, 200, await upload(url.searchParams.get('name'), buf))
    }
    const soulPath = p.match(/^\/v1\/agents\/([a-z0-9-]+)\/soul(\/save|\/undo|\/set)?$/)
    if (soulPath && agentNamed(soulPath[1])) {
      const id = soulPath[1]
      try {
        if (!soulPath[2] && req.method === 'GET') return json(res, 200, await soulCard(id))
        if (soulPath[2] === '/save' && req.method === 'POST') return json(res, 200, await saveSoul(id, (await readJSON(req)).proposal))
        if (soulPath[2] === '/undo' && req.method === 'POST') return json(res, 200, await undoSoul(id))
        if (soulPath[2] === '/set' && req.method === 'POST') { const { field, value } = await readJSON(req); return json(res, 200, await setSoul(id, field, value)) }
      } catch (e) { return json(res, e.code ?? 500, { error: e.message }) }
    }
    // the voices an agent can have, a sample of one, and an agent's (chosen on its soul screen)
    if (p === '/v1/voices' && req.method === 'GET') return json(res, 200, { engine: ttsEngine(), ready: tts.enabled(), voices: ENGLISH_VOICES })
    const sample = p.match(/^\/v1\/voices\/([a-z]{2}_[a-z]+)\/sample$/)
    if (sample && req.method === 'GET') {
      if (ttsEngine() !== 'kokoro' || !kokoro.ready) return json(res, 503, { error: "The voices aren't running on your Mac." })
      if (!ENGLISH_VOICES.some(v => v.id === sample[1])) return json(res, 404, { error: 'no such voice' })
      const out = path.join(SPEECH_DIR, `sample-${sample[1]}.m4a`)
      if (!fs.existsSync(out)) await tts.kokoro('Two tests failed in the cart. Want me to fix them?', sample[1], out)
      return sendFile(res, out, 'audio/mp4')
    }
    const voicePath = p.match(/^\/v1\/agents\/([a-z0-9-]+)\/voice$/)
    if (voicePath && agentNamed(voicePath[1]) && req.method === 'POST') {
      const voice = String((await readJSON(req)).voice ?? '')
      if (!ENGLISH_VOICES.some(v => v.id === voice)) return json(res, 400, { error: 'no such voice' })
      agentNamed(voicePath[1]).voice = voice; saveAgents()
      kokoro.keepWarm(voice); setTimeout(() => kokoro.stopWarm(), 3000)   // load it now: its first reply isn't slower
      log(`${voicePath[1]}: voice ${voice}`); bump()
      return json(res, 200, { id: voicePath[1], voice })
    }
    // the models each runtime offers, and what it uses when an agent has none of its own
    if (p === '/v1/models' && req.method === 'GET') {
      return json(res, 200, Object.fromEntries(SWITCHABLE.map(r => [r, { default: defaultModel(r), models: modelsFor(r) }])))
    }
    const modelPath = p.match(/^\/v1\/agents\/([a-z0-9-]+)\/model$/)
    if (modelPath && agentNamed(modelPath[1]) && req.method === 'POST') {
      try { return json(res, 200, await setModel(modelPath[1], (await readJSON(req)).model ?? null)) }
      catch (e) { return json(res, e.code ?? 500, { error: e.message }) }
    }
    // how each runtime can ask before acting, and what it does when an agent has no mode of its own
    if (p === '/v1/permissions' && req.method === 'GET') {
      return json(res, 200, Object.fromEntries(Object.entries(PERMISSIONS).map(([r, { modes }]) => [r, { default: defaultPermission(r), modes }])))
    }
    const permissionPath = p.match(/^\/v1\/agents\/([a-z0-9-]+)\/permission$/)
    if (permissionPath && agentNamed(permissionPath[1]) && req.method === 'POST') {
      try { return json(res, 200, await setPermission(permissionPath[1], (await readJSON(req)).mode ?? null)) }
      catch (e) { return json(res, e.code ?? 500, { error: e.message }) }
    }
    // which runtime an agent runs on (Claude Code or Codex), chosen on its soul screen
    const runtimePath = p.match(/^\/v1\/agents\/([a-z0-9-]+)\/runtime$/)
    if (runtimePath && agentNamed(runtimePath[1]) && req.method === 'POST') {
      try { return json(res, 200, await setRuntime(runtimePath[1], String((await readJSON(req)).runtime ?? ''))) }
      catch (e) { return json(res, e.code ?? 500, { error: e.message }) }
    }
    if (p === '/v1/verdict' && req.method === 'POST') {
      const { requestId, behavior } = await readJSON(req)
      return json(res, 200, verdict(requestId, behavior === 'allow' ? 'allow' : 'deny'))
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    log('error', p, e.message)
    if (res.headersSent) return
    if (e.status === 413) res.setHeader('connection', 'close')       // the rest of the body isn't read
    json(res, e.status ?? 500, { error: e.message })
  }
}

// The hub on this Mac only: Claude Code sessions (channel, hooks) and the Simulator.
const server = http.createServer(handle)
// The watch's door to the internet, for Tailscale Funnel (bin/chums-tunnel): only the watch's API (/v1/…), only on
// localhost, and every wrong token costs a second.
const publicServer = http.createServer(async (req, res) => {
  const p = urlOf(req)?.pathname || req.url
  log(`[Public 7718] ${req.method} ${p} from ${req.socket.remoteAddress} auth: ${req.headers.authorization ? 'yes' : 'no'}`)
  try {
    if (!urlOf(req)?.pathname.startsWith('/v1/')) return json(res, 404, { error: 'not found' })
    if (p === '/v1/ping' && !req.headers.authorization) {
      log(`[Public 7718] /v1/ping without auth (browser test) -> 200 OK`)
      return json(res, 200, { ok: true, note: 'browser-test' })
    }
    if (!watchAuthed(req)) {
      log(`[Public 7718] 401 Unauthorized for token: "${bearer(req)}"`)
      await new Promise(r => setTimeout(r, 1000));
      return json(res, 401, { error: 'unauthorized' })
    }
  } catch (e) {
    log('error at the public door:', e.message)
    return res.headersSent ? res.destroy() : json(res, 500, { error: 'error' })
  }
  return handle(req, res)
})

// ---------- switching an agent's runtime (its soul screen on the watch) ----------
// What belongs to a runtime (its thread, its model) is kept in byRuntime for when that runtime is chosen again. A
// Claude Code agent is a LaunchAgent (bin/chums-agents add/remove); a Codex one runs inside the hub.
const SWITCHABLE = ['claude', 'codex']
const onPath = cmd => !!whichBin(cmd)
const available = () => SWITCHABLE.filter(r => onPath(r))
const setRuntime = (id, runtime) => serially(async () => {
  const a = agentNamed(id)
  if (!SWITCHABLE.includes(runtime)) throw Object.assign(new Error(`runtime is one of ${SWITCHABLE.join(', ')}`), { code: 400 })
  if (!available().includes(runtime)) throw Object.assign(new Error(`${runtime === 'codex' ? 'Codex' : 'Claude Code'} isn't installed on this Mac`), { code: 409 })
  const was = a.runtime ?? 'claude'
  if (was === runtime) return { id, runtime }
  // as it was, to go back to if the new runtime doesn't start
  const before = JSON.parse(JSON.stringify({ runtime: a.runtime, sessionId: a.sessionId, model: a.model, byRuntime: a.byRuntime }))
  a.byRuntime ??= {}
  a.byRuntime[was] = { ...(a.sessionId ? { sessionId: a.sessionId } : {}), ...(a.model ? { model: a.model } : {}) }
  const back = a.byRuntime[runtime] ?? {}
  delete a.byRuntime[runtime]
  if (!Object.keys(a.byRuntime).length) delete a.byRuntime
  a.runtime = runtime
  a.sessionId = back.sessionId ?? (runtime === 'claude' ? crypto.randomUUID() : undefined)
  if (!a.sessionId) delete a.sessionId
  if (back.model) a.model = back.model; else delete a.model
  saveAgents()
  // the old one stops, the new one starts
  if (was === 'claude') await run(AGENTS_BIN, ['remove', id], 60_000).catch(e => log(`${id}: stopping its Claude Code session: ${e.message}`))
  else { runners.get(id)?.stop(); runners.delete(id) }
  const old = sessionOf(id)
  if (old) { sessions.delete(old.id); for (const [rid, x] of approvals) if (x.sessionId === old.id) approvals.delete(rid) }
  try {
    if (runtime === 'claude') await run(AGENTS_BIN, ['add', id], 120_000)
    else runners.set(id, startRunner(a, runtimeHub))
  } catch (e) {
    // it didn't start: the agent goes back to what it ran on, and runs there again
    log(`${id}: couldn't start on ${runtime} (${e.message}); back on ${was}`)
    for (const k of Object.keys(before)) { if (before[k] === undefined) delete a[k]; else a[k] = before[k] }
    saveAgents()
    if (was === 'claude') await run(AGENTS_BIN, ['add', id], 120_000).catch(e2 => log(`${id}: restarting it on Claude Code: ${e2.message}`))
    else runners.set(id, startRunner(a, runtimeHub))
    bump()
    throw Object.assign(new Error(`${id} couldn't start on ${runtime === 'codex' ? 'Codex' : 'Claude Code'}: ${e.message}`), { code: 500 })
  }
  log(`${id}: now on ${runtime}`); bump()
  return { id, runtime }
})
// (the tests' private hub gets a stand-in, so they never restart a real LaunchAgent)
const AGENTS_BIN = process.env.CHUMS_AGENTS_BIN || path.join(ROOT, 'bin/chums-agents')

// ---------- an agent's model (its card on the iPhone) ----------
// Claude Code takes an alias for the newest model of each family; Codex, the models its cache lists for the signed-in
// account (~/.codex/models_cache.json, which Codex refreshes). No model: what the runtime itself is set to use.
const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) }))
const readJSONFile = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
function codexModels() {
  const list = readJSONFile(path.join(HOME, '.codex/models_cache.json'))?.models ?? []
  return list.filter(m => m.visibility === 'list' && m.slug).sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map(m => ({ id: m.slug, name: m.display_name || m.slug, about: m.description || null }))
}
/// What each runtime uses when an agent has no model of its own: "Opus, 1M context" from Claude Code's settings,
/// Codex's from its config.toml.
function defaultModel(runtime) {
  if (runtime === 'claude') {
    const m = readJSONFile(path.join(HOME, '.claude/settings.json'))?.model
    if (!m) return null
    const [, base, ctx] = String(m).match(/^([^[]+)(?:\[(\w+)\])?$/) ?? [, m]
    const name = CLAUDE_MODELS.find(x => x.id === base)?.name ?? base
    return ctx ? `${name}, ${ctx.toUpperCase()} context` : name
  }
  let toml = ''
  try { toml = fs.readFileSync(path.join(HOME, '.codex/config.toml'), 'utf8') } catch { return null }
  const slug = toml.split('\n[')[0].match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1]
  return slug ? codexModels().find(m => m.id === slug)?.name ?? slug : null
}
const modelsFor = runtime => runtime === 'claude' ? CLAUDE_MODELS : runtime === 'codex' ? codexModels() : []
/// An agent on another model (null: the runtime's own): it restarts on it, on the same conversation.
const setModel = (id, model) => serially(async () => {
  const a = agentNamed(id), runtime = a.runtime ?? 'claude'
  model = model || null
  if (model && !modelsFor(runtime).some(m => m.id === model)) throw Object.assign(new Error(`${model} isn't a model ${runtime === 'claude' ? 'Claude Code' : 'Codex'} offers here`), { code: 400 })
  if ((a.model ?? null) === model) return { id, model }
  if (model) a.model = model; else delete a.model
  saveAgents()
  await restartAgent(a)
  log(`${id}: model ${model ?? `${runtime}'s own`}`); bump()
  return { id, model }
})
/// An agent started again on what agents.json says now, on the same conversation: its runner in the hub, or its
/// Claude Code session's LaunchAgent.
async function restartAgent(a) {
  if (runByHub(a)) { runners.get(a.id)?.stop(); runners.set(a.id, startRunner(a, runtimeHub)) }
  else await run(AGENTS_BIN, ['restart', a.id], 60_000).catch(e => log(`${a.id}: restarting its Claude Code session: ${e.message}`))
}

// ---------- an agent's permission mode (the watch and the iPhone) ----------
// How it asks before acting. A Claude Code agent's is permissionMode in agents.json, passed as --permission-mode
// (tools/agent-cmd.mjs); a Codex agent's is approvalPolicy, on its thread (hub/runtimes.mjs). Without one, the
// runtime's own setting: permissions.defaultMode in ~/.claude/settings.json, approval_policy in ~/.codex/config.toml.
const PERMISSIONS = {
  claude: { field: 'permissionMode', modes: [
    { id: 'default', name: 'Asks first', about: 'Anything it may not do on its own comes to your watch and iPhone as Allow or Deny.' },
    { id: 'acceptEdits', name: 'Edits on its own', about: 'Changes files in its folders without asking; asks before commands.' },
    { id: 'auto', name: 'Decides on its own', about: "Claude Code's auto mode: it acts, and refuses what looks risky without asking you." },
  ] },
  codex: { field: 'approvalPolicy', modes: [
    { id: 'untrusted', name: 'Asks first', about: 'Asks before running anything but simple reads.' },
    { id: 'on-request', name: 'Asks when it needs to', about: 'Works in its folders and asks to go further.' },
    { id: 'never', name: 'Never asks', about: 'Runs without asking, inside its sandbox.' },
  ] },
}
/// Claude Code's modes the apps don't offer, which its settings can still give.
const CLAUDE_OTHER_MODES = { plan: 'Plans only', bypassPermissions: 'Never asks' }
const modeName = (runtime, id) => PERMISSIONS[runtime].modes.find(m => m.id === id)?.name ?? (runtime === 'claude' ? CLAUDE_OTHER_MODES[id] : null) ?? null
const permissionOf = a => { const f = PERMISSIONS[a.runtime ?? 'claude']?.field; return f ? a[f] ?? null : null }
/// The approval policy a Codex agent without one of its own runs on: approval_policy in ~/.codex/config.toml (outside
/// its tables) when it is one of the three, else on-request.
function codexPolicy() {
  let toml = ''
  try { toml = fs.readFileSync(path.join(HOME, '.codex/config.toml'), 'utf8') } catch {}
  const id = `\n${toml}`.split('\n[')[0].match(/^\s*approval_policy\s*=\s*"([^"]+)"/m)?.[1]
  return PERMISSIONS.codex.modes.some(m => m.id === id) ? id : 'on-request'
}
/// The name of the mode an agent with none of its own runs in, read when asked (null: one the hub has no name for).
function defaultPermission(runtime) {
  if (runtime === 'claude') return modeName('claude', readJSONFile(path.join(HOME, '.claude/settings.json'))?.permissions?.defaultMode ?? 'default')
  return modeName(runtime, codexPolicy())
}
/// An agent's permission mode (null: its runtime's own setting): kept in agents.json, and it restarts in it.
const setPermission = (id, mode) => serially(async () => {
  const a = agentNamed(id), runtime = a.runtime ?? 'claude', p = PERMISSIONS[runtime]
  mode = mode || null
  if (mode !== null && !p?.modes.some(m => m.id === mode)) {
    throw Object.assign(new Error(p ? `${runtime === 'claude' ? 'Claude Code' : 'Codex'}'s modes are ${p.modes.map(m => m.id).join(', ')}.`
      : `An agent on ${runtime} has no modes to pick.`), { code: 400 })
  }
  if (!p || (a[p.field] ?? null) === mode) return { id, mode }
  if (mode) a[p.field] = mode; else delete a[p.field]
  saveAgents()
  await restartAgent(a)
  log(`${id}: permission mode ${mode ?? `${runtime}'s own`}`); bump()
  return { id, mode }
})

// ---------- agents the hub runs itself (Codex, Copilot, ACP agents): hub/runtimes.mjs ----------
// They join as sessions with a driver: orders and verdicts go to it, and it reports in the hooks' words.
const runtimeHub = {
  url: `http://127.0.0.1:${cfg.port}`, token: cfg.token, port: cfg.port, dir: CONFIG_DIR, log, bump, codexPolicy,
  join({ id, name, cwd, driver }) {
    for (const s of sessions.values()) if (s.name === name && s.cwd === cwd) {      // its previous run, if still here
      sessions.delete(s.id)
      for (const [rid, a] of approvals) if (a.sessionId === s.id) approvals.delete(rid)
    }
    const s = { id, name, cwd, status: 'idle', lastSeen: Date.now(), inbox: [], waiter: null, driver }
    sessions.set(id, s)
    log('session joined:', name, cwd, `(${agentNamed(name)?.runtime ?? 'hub'})`); bump()
    return s
  },
  leave(id) {
    const s = sessions.get(id)
    for (const [rid, a] of approvals) if (a.sessionId === id) approvals.delete(rid)
    if (sessions.delete(id)) { log('session gone:', s.name); bump() }
  },
  hook: (s, event, fields = {}) => onHook({ ...fields, name: s.name, cwd: s.cwd, event, session: s }),
  react: (s, kind, text) => { react(s.name, kind, text); bump() },
  reply: (s, text, status, why) => { replyFrom(s, text, status); if (why) log(`  (spoken for ${s.name}: its ${why})`) },
  ask: (s, { requestId, tool, description, input }) => askApproval(s, requestId, tool, description, JSON.stringify(input ?? {})),
  closeApproval(requestId) {
    const a = approvals.get(requestId)
    if (!a) return
    approvals.delete(requestId)
    const s = sessions.get(a.sessionId)
    if (s && !approvalsFor(s)) s.status = 'working'
    log('approval answered elsewhere:', a.session, a.tool); bump()
  },
  saveSessionId(agentId, id) {
    const a = agentNamed(agentId)
    if (!a || a.sessionId === id) return
    a.sessionId = id
    saveAgents()
  },
}
const runners = new Map()

// Everything else starts once both ports are the hub's: a second hub started by mistake (bin/chums-hub while the
// LaunchAgent runs) stops there, before it touches the first one's speech servers, souls or Codex app-servers.
function startAll() {
  for (const [id, r] of startRunners(agents.filter(runByHub), runtimeHub)) runners.set(id, r)
  if (!process.env.CHUMS_NO_WHISPER) { startWhisper(); warmWhisper(); kokoro.start() }   // the tests' private hub neither hears nor speaks
  seedSouls().catch(e => log('souls:', e.message))
}
let listening = 0
for (const [srv, key] of [[server, 'port'], [publicServer, 'publicPort']]) srv.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e
  console.error(`chums: 127.0.0.1:${cfg[key]} is in use, most likely by a hub that is already running (bin/chums-doctor says how it runs; ` +
    `lsof -nP -iTCP:${cfg[key]} -sTCP:LISTEN shows what it is). Stop that one first, or set "${key}" in ${CONFIG_PATH}.`)
  process.exit(1)
})
server.listen(cfg.port, '127.0.0.1', () => { log(`Chums hub on 127.0.0.1:${cfg.port}  config ${CONFIG_PATH}`); if (++listening === 2) startAll() })
publicServer.listen(cfg.publicPort, cfg.bindHost || '0.0.0.0', () => { log(`watch API on ${cfg.bindHost || '0.0.0.0'}:${cfg.publicPort}${cfg.publicURL ? ` (${cfg.publicURL})` : ''}`); if (++listening === 2) startAll() })
const quit = () => { quitting = true; whisper?.kill(); kokoro.proc?.kill(); for (const r of runners.values()) r?.stop(); setTimeout(() => process.exit(0), 300) }
process.on('SIGTERM', quit)
process.on('SIGINT', quit)
