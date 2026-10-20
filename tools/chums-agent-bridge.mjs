#!/usr/bin/env node
// Chums <-> Windows Agent Daemon Bridge
// Connects Chums iPhone & Apple Watch clients to the local agent-daemon-rs on Windows.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

// Agents to register and bridge
const AGENTS = [
  { id: 'peeps', name: 'peeps', role: 'Design & Companion' },
  { id: 'noodle', name: 'noodle', role: 'Code & Spawner' },
  { id: 'squint', name: 'squint', role: 'System & Diffs' },
  { id: 'stretch', name: 'stretch', role: 'General Tasks' }
]

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), '[Bridge]', ...args)

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
  const text = (item.said || item.text || '').toLowerCase().trim()
  const sessionId = agent.sessionId
  log(`Order for ${agent.name}: "${text}" (from: ${item.device || 'unknown'})`)

  // 1. Spawning agent
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

  // 2. Review spec
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

  // 3. Inspect diffs
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

  // 4. Status / health / ping
  if (text.includes('status') || text.includes('health') || text.includes('ping') || text.includes('how are you')) {
    const health = await getDaemonHealth()
    if (health && health.status === 'online') {
      await replyAgent(sessionId, `All systems online. Daemon RAM ${health.ram_mb} megabytes. Ready for orders.`)
    } else {
      await replyAgent(sessionId, 'Daemon offline or unreachable on Windows port 8765.')
    }
    return
  }

  // 5. Friendly conversational replies
  if (text.includes('hello') || text.includes('hey') || text.includes('hi') || text.includes('who are you')) {
    if (agent.name === 'peeps') {
      await replyAgent(sessionId, `Hey Ayush! Peeps is online and connected to your PC. Ready to spawn agents or design.`)
    } else if (agent.name === 'noodle') {
      await replyAgent(sessionId, `Hey Ayush! Noodle is ready. Tell me to spawn an agent whenever you want.`)
    } else {
      await replyAgent(sessionId, `Hey Ayush! ${agent.name} is online on Windows.`)
    }
    return
  }

  // 6. Default response for other messages
  await replyAgent(sessionId, `Received: "${item.said || item.text}". Say "spawn agent" or "status" to test controls.`)
}

async function runAgentWorker(agent) {
  const sessionId = `${agent.id}-bridge-session`
  agent.sessionId = sessionId

  while (true) {
    try {
      // 1. Register
      const regRes = await fetch(`${HUB_URL}/channel/register`, {
        method: 'POST',
        headers: AUTH_HEADER,
        body: JSON.stringify({
          sessionId,
          name: agent.name,
          cwd: os.homedir()
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
          break // break to outer loop to re-register
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

log(`Starting Chums Agent Bridge for ${AGENTS.length} agents...`)
log(`Connecting to Hub at ${HUB_URL} and Daemon at ${DAEMON_URL}`)

// Start workers for all agents in parallel
for (const agent of AGENTS) {
  runAgentWorker(agent)
}
