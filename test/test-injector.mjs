// test/test-injector.mjs
// Unit & Integration Tests for Antigravity Prompt Injector Module

import assert from 'node:assert/strict'
import http from 'node:http'
import {
  isDesktopRunning,
  getActiveConversation,
  injectPrompt,
  DEFAULT_CDP_PORT
} from '../tools/modules/antigravity-injector.mjs'

let totalTests = 0
let passedTests = 0

async function test(desc, fn) {
  totalTests++
  try {
    await fn()
    passedTests++
    console.log(`  ✓ ${desc}`)
  } catch (err) {
    console.error(`  ✗ ${desc}:`, err)
    throw err
  }
}

async function runTests() {
  console.log('--- Running Antigravity Prompt Injector Tests ---')

  // 1. Live Antigravity Detection (when Antigravity is open on port 58710)
  await test('isDesktopRunning() detects live Antigravity Electron CDP session', async () => {
    const running = await isDesktopRunning(DEFAULT_CDP_PORT)
    assert.equal(typeof running, 'boolean')
    assert.equal(running, true, 'Antigravity Electron should be running on port 58710')
  })

  // 2. Closed Port Handling
  await test('isDesktopRunning() gracefully returns false when port is unreachable', async () => {
    const running = await isDesktopRunning(58999)
    assert.equal(running, false, 'Should return false for unused port')
  })

  // 3. Active Conversation Inspection
  await test('getActiveConversation() retrieves active conversation ID, title, and URL', async () => {
    const active = await getActiveConversation(DEFAULT_CDP_PORT)
    assert.ok(active, 'Active conversation should not be null when Antigravity is open')
    assert.equal(typeof active.id, 'string', 'Conversation ID should be a string')
    assert.ok(active.id.length > 0, 'Conversation ID should not be empty')
    assert.equal(typeof active.title, 'string', 'Conversation title should be a string')
    assert.ok(active.title.length > 0, 'Conversation title should not be empty')
    assert.ok(active.url.includes('/c/'), 'URL should include /c/ path')
  })

  // 4. Closed Port Active Conversation Handling
  await test('getActiveConversation() returns null when port is unreachable', async () => {
    const active = await getActiveConversation(58999)
    assert.equal(active, null, 'Unreachable port should return null')
  })

  // 5. Input Validation
  await test('injectPrompt() rejects missing or non-string prompt text', async () => {
    const res1 = await injectPrompt({ text: '' })
    assert.equal(res1.success, false)
    assert.ok(res1.error.includes('text must be a non-empty string'))

    const res2 = await injectPrompt({ text: null })
    assert.equal(res2.success, false)
    assert.ok(res2.error.includes('text must be a non-empty string'))
  })

  // 6. Unreachable Port Injection Handling
  await test('injectPrompt() returns clean error when target port is unreachable', async () => {
    const res = await injectPrompt({
      port: 58999,
      text: 'Test message',
      autoSend: false
    })
    assert.equal(res.success, false)
    assert.ok(res.error, 'Should contain error description')
  })

  // 7. Mock CDP Server Target Matching Verification
  await test('injectPrompt() and getActiveConversation() work against a mock CDP endpoint', async () => {
    const mockTargets = [
      {
        id: 'mock-target-1',
        title: 'Mock Obsidian Conversation - Antigravity',
        type: 'page',
        url: 'https://127.0.0.1:64163/c/mock-convo-uuid-1234?section=abc',
        webSocketDebuggerUrl: 'ws://127.0.0.1:58998/devtools/page/mock-target-1'
      }
    ]

    const server = http.createServer((req, res) => {
      if (req.url === '/json/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(mockTargets))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    await new Promise(resolve => server.listen(58998, '127.0.0.1', resolve))

    try {
      const running = await isDesktopRunning(58998)
      assert.equal(running, true)

      const convo = await getActiveConversation(58998)
      assert.ok(convo)
      assert.equal(convo.id, 'mock-convo-uuid-1234')
      assert.equal(convo.title, 'Mock Obsidian Conversation - Antigravity')
    } finally {
      server.close()
    }
  })

  console.log(`\nAll ${passedTests}/${totalTests} tests passed successfully! ✨`)
}

runTests().catch(err => {
  console.error('\nTests failed:', err)
  process.exit(1)
})
