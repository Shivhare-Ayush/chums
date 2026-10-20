import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_PATH = path.join(os.homedir(), '.chums', 'config.json')
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
const HUB_URL = `http://127.0.0.1:${cfg.publicPort || 7718}`
const TOKEN = cfg.watchToken || 'cV8mqWlqWHLpSavJotAOW5FS'

async function sendOrder(agent, text) {
  console.log(`\n➡️  Sending order to ${agent}: "${text}"`)
  const res = await fetch(`${HUB_URL}/v1/say`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      agent,
      text,
      device: 'phone'
    })
  })
  const data = await res.json()
  console.log(`⬅️  Hub routed:`, data)
  return data
}

async function run() {
  console.log('🧪 Starting End-to-End Chums Bridge Integration Test...')

  // 1. Status
  await sendOrder('peeps', 'status')
  await new Promise(r => setTimeout(r, 2000))

  // 2. List recent work
  await sendOrder('noodle', 'list recent work')
  await new Promise(r => setTimeout(r, 2000))

  // 3. Fleet query
  await sendOrder('stretch', 'fleet')
  await new Promise(r => setTimeout(r, 2000))

  // 4. Shell execution
  await sendOrder('squint', 'run echo "Hello from Chums iPhone client"')
  await new Promise(r => setTimeout(r, 2000))

  console.log('\n✅ Integration test sequence dispatched!')
}

run().catch(console.error)
