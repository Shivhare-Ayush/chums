// test/test-attacher.mjs
// Unit tests for Antigravity Session Attacher & Live Hook Streamer

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  AntigravityAttacher,
  listRecentConversations,
  projectToolCall,
  makeToolCallId
} from '../tools/modules/antigravity-attacher.mjs'

let totalTests = 0
let passedTests = 0

function test(desc, fn) {
  totalTests++
  try {
    const res = fn()
    if (res && typeof res.then === 'function') {
      return res.then(() => {
        passedTests++
        console.log(`  ✓ ${desc}`)
      }).catch(err => {
        console.error(`  ✗ ${desc}:`, err)
        throw err
      })
    }
    passedTests++
    console.log(`  ✓ ${desc}`)
  } catch (err) {
    console.error(`  ✗ ${desc}:`, err)
    throw err
  }
}

async function runTests() {
  console.log('--- Running Antigravity Attacher Unit Tests ---')

  // 1. Tool Call Projection & Redaction Tests
  test('projectToolCall redacts and sanitizes read_file and view_file', () => {
    const p1 = projectToolCall('read_file', { Path: 'C:\\Users\\veks9\\Documents\\SecretNote.md' })
    assert.equal(p1.tool, 'Read')
    assert.equal(p1.description, 'Read SecretNote.md')
    assert.equal(p1.input.file, 'SecretNote.md')

    const p2 = projectToolCall('view_file', { file_path: '/usr/local/bin/run.sh' })
    assert.equal(p2.tool, 'Read')
    assert.equal(p2.description, 'Read run.sh')
    assert.equal(p2.input.file, 'run.sh')
  })

  test('projectToolCall redacts and sanitizes edit_file and write_file', () => {
    const p1 = projectToolCall('edit_file', { Path: 'C:/repos/chums/hub/hub.mjs', replacement: 'private' })
    assert.equal(p1.tool, 'Edit')
    assert.equal(p1.description, 'Edit hub.mjs')
    assert.equal(p1.input.file, 'hub.mjs')
    assert.equal(p1.input.replacement, undefined, 'Private replacement content should not leak')

    const p2 = projectToolCall('write_file', { Path: 'docs/SPEC.md' })
    assert.equal(p2.tool, 'Write')
    assert.equal(p2.description, 'Write SPEC.md')
    assert.equal(p2.input.file, 'SPEC.md')
  })

  test('projectToolCall truncates run_command / Bash to 40 characters', () => {
    const cmd = 'git status --porcelain -uall && npm run test:all --verbose'
    const p = projectToolCall('run_command', { CommandLine: cmd })
    assert.equal(p.tool, 'Bash')
    assert.equal(p.description, `Bash ${cmd.slice(0, 40)}`)
    assert.equal(p.input.command, cmd.slice(0, 40))
  })

  test('makeToolCallId generates stable, unique IDs with SHA-256 args hash', () => {
    const id1 = makeToolCallId(4, 'run_command', { CommandLine: 'npm test' })
    const id2 = makeToolCallId(4, 'run_command', { CommandLine: 'npm test' })
    const id3 = makeToolCallId(5, 'run_command', { CommandLine: 'npm test' })
    const id4 = makeToolCallId(4, 'run_command', { CommandLine: 'npm test --watch' })

    assert.equal(id1, id2, 'Same step and args must produce identical ID')
    assert.notEqual(id1, id3, 'Different step index must produce different ID')
    assert.notEqual(id1, id4, 'Different args must produce different ID')
  })

  // 2. SQLite Concurrency: Query conversation_summaries in read-only mode
  await test('listRecentConversations queries conversation_summaries.db in read-only mode', async () => {
    const defaultDb = path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db')
    if (fs.existsSync(defaultDb)) {
      const rows = await listRecentConversations(3, defaultDb)
      assert.ok(Array.isArray(rows), 'Should return an array')
      assert.ok(rows.length > 0, 'Should find at least 1 recent conversation')
      assert.ok(rows.length <= 3, 'Should respect limit of 3')
      const first = rows[0]
      assert.ok(first.conversation_id, 'Should have conversation_id')
      assert.ok('title' in first, 'Should have title field')
      assert.ok('preview' in first, 'Should have preview field')
      assert.ok('last_modified_time' in first, 'Should have last_modified_time field')
      assert.ok('step_count' in first, 'Should have step_count field')
    } else {
      console.log('    (Skipping live DB check as file is absent)')
    }
  })

  // 3. Transcript Tailing & Incomplete Byte Buffering
  await test('Transcript Tailing buffers incomplete trailing bytes and emits hooks on complete lines', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chums-attacher-test-'))
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl')
    fs.writeFileSync(transcriptPath, '', 'utf8')

    const capturedHooks = []
    const attacher = new AntigravityAttacher({ dataDir: tmpDir })

    const convoId = 'test-convo-tailer'
    const status = await attacher.attachSession('noodle', convoId, {
      transcriptPath,
      mode: 'live',
      mockNetwork: true,
      onHook: (payload) => capturedHooks.push(payload)
    })

    assert.equal(status.state, 'attached_live')
    assert.equal(status.character, 'noodle')
    assert.equal(status.conversationId, convoId)

    // Write incomplete byte chunk (no trailing newline)
    const partial1 = '{"step_index": 1, "source": "MODEL", "status": "DONE", "tool_calls": [{"name": "read_file", "args": {"Path": "test.txt"}}'
    fs.appendFileSync(transcriptPath, partial1, 'utf8')

    // Force read pass
    await attacher._readNewBytes(attacher.attachments.get('noodle'))
    assert.equal(capturedHooks.length, 0, 'Incomplete line must NOT emit any tool hooks')

    // Complete the line with closing brace and newline
    const partial2 = ']}\n'
    fs.appendFileSync(transcriptPath, partial2, 'utf8')

    await attacher._readNewBytes(attacher.attachments.get('noodle'))
    assert.equal(capturedHooks.length, 2, 'Should emit PreToolUse and PostToolUse on complete line')
    assert.equal(capturedHooks[0].event, 'PreToolUse')
    assert.equal(capturedHooks[0].tool, 'Read')
    assert.equal(capturedHooks[0].input.file, 'test.txt')
    assert.equal(capturedHooks[1].event, 'PostToolUse')
    assert.equal(capturedHooks[1].tool, 'Read')
    assert.equal(capturedHooks[1].result, 'done')

    // Write duplicate step line: deduplication must prevent duplicate hook emission
    fs.appendFileSync(transcriptPath, '{"step_index": 1, "source": "MODEL", "status": "DONE", "tool_calls": [{"name": "read_file", "args": {"Path": "test.txt"}}]}\n', 'utf8')
    await attacher._readNewBytes(attacher.attachments.get('noodle'))
    assert.equal(capturedHooks.length, 2, 'Duplicate tool call must NOT be emitted again')

    // Clean up
    await attacher.detachSession('noodle')
    await new Promise(r => setTimeout(r, 100))
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
  })

  // 4. Attachment State Machine & Generation Token Switch Protection
  await test('Attachment State Machine transitions: detached -> attaching -> attached_live -> detached', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chums-sm-test-'))
    const transcript1 = path.join(tmpDir, 'transcript1.jsonl')
    fs.writeFileSync(transcript1, '{"step_index":0,"status":"DONE"}\n', 'utf8')

    const attacher = new AntigravityAttacher({ dataDir: tmpDir })
    assert.equal(attacher.getStatus('peeps').state, 'detached')

    const s1 = await attacher.attachSession('peeps', 'convo-1', {
      transcriptPath: transcript1,
      mode: 'live',
      mockNetwork: true
    })
    assert.equal(s1.state, 'attached_live')
    assert.equal(s1.conversationId, 'convo-1')
    const initialGen = s1.generation

    // Detach
    const s2 = await attacher.detachSession('peeps')
    assert.equal(s2.state, 'detached')
    assert.equal(attacher.getStatus('peeps').state, 'detached')

    // Generation must have incremented
    assert.ok(attacher.generationCounter > initialGen)

    await new Promise(r => setTimeout(r, 100))
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
  })

  await test('Generation token revokes stale watcher callbacks across character switches', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chums-gen-test-'))
    const tA = path.join(tmpDir, 'A.jsonl')
    const tB = path.join(tmpDir, 'B.jsonl')
    fs.writeFileSync(tA, '', 'utf8')
    fs.writeFileSync(tB, '', 'utf8')

    const hooks = []
    const attacher = new AntigravityAttacher({ dataDir: tmpDir })

    // Attach to session A
    await attacher.attachSession('squint', 'session-A', {
      transcriptPath: tA,
      mode: 'live',
      mockNetwork: true,
      onHook: (h) => hooks.push({ session: 'A', ...h })
    })

    const recordA = attacher.attachments.get('squint')
    const genA = recordA.generation

    // Switch character 'squint' to session B
    await attacher.attachSession('squint', 'session-B', {
      transcriptPath: tB,
      mode: 'live',
      mockNetwork: true,
      onHook: (h) => hooks.push({ session: 'B', ...h })
    })

    const recordB = attacher.attachments.get('squint')
    assert.notEqual(recordB.generation, genA, 'Generation token must be new')

    // Attempt to invoke read on old recordA: must be dropped immediately by generation check
    const toolHooksBefore = hooks.filter(h => h.session === 'A' && (h.event === 'PreToolUse' || h.event === 'PostToolUse')).length
    fs.appendFileSync(tA, '{"step_index": 10, "tool_calls": [{"name": "run_command", "args": {"CommandLine": "ls"}}]}\n')
    await attacher._readNewBytes(recordA)
    const toolHooksAfter = hooks.filter(h => h.session === 'A' && (h.event === 'PreToolUse' || h.event === 'PostToolUse')).length

    assert.equal(
      toolHooksAfter,
      toolHooksBefore,
      'Old session A callback must NOT emit any tool hooks after generation switch'
    )

    await attacher.detachSession('squint')
    await new Promise(r => setTimeout(r, 100))
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
  })

  // 5. Hub Hook Ingestion over HTTP
  await test('Hub Hook Ingestion posts PreToolUse, PostToolUse, and Stop with Authorization header', async () => {
    const receivedRequests = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        receivedRequests.push({
          url: req.url,
          method: req.method,
          auth: req.headers.authorization,
          contentType: req.headers['content-type'],
          body: JSON.parse(body)
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const serverPort = server.address().port

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chums-http-test-'))
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl')
    fs.writeFileSync(transcriptPath, '', 'utf8')

    const attacher = new AntigravityAttacher({ dataDir: tmpDir })
    await attacher.attachSession('stretch', 'session-http', {
      transcriptPath,
      hubUrl: `http://127.0.0.1:${serverPort}`,
      token: 'secret-auth-token-123',
      mode: 'live'
    })

    // Append a run_command step
    fs.appendFileSync(
      transcriptPath,
      '{"step_index": 5, "tool_calls": [{"name": "run_command", "args": {"CommandLine": "npm test --runInBand"}}]}\n'
    )

    await attacher._readNewBytes(attacher.attachments.get('stretch'))

    // Detach to trigger Stop hook
    await attacher.detachSession('stretch')

    // Close server
    await new Promise(resolve => server.close(resolve))
    await new Promise(r => setTimeout(r, 100))
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}

    // Verify received requests
    assert.ok(receivedRequests.length >= 3, `Expected at least 3 hook posts, got ${receivedRequests.length}`)

    // 1. PreToolUse
    const preHook = receivedRequests.find(r => r.body.event === 'PreToolUse')
    assert.ok(preHook, 'Must receive PreToolUse')
    assert.equal(preHook.url, '/hook')
    assert.equal(preHook.method, 'POST')
    assert.equal(preHook.auth, 'Bearer secret-auth-token-123')
    assert.equal(preHook.body.name, 'stretch')
    assert.equal(preHook.body.tool, 'Bash')
    assert.equal(preHook.body.input.command, 'npm test --runInBand')

    // 2. PostToolUse
    const postHook = receivedRequests.find(r => r.body.event === 'PostToolUse')
    assert.ok(postHook, 'Must receive PostToolUse')
    assert.equal(postHook.body.tool, 'Bash')
    assert.equal(postHook.body.result, 'done')

    // 3. Stop
    const stopHook = receivedRequests.find(r => r.body.event === 'Stop')
    assert.ok(stopHook, 'Must receive Stop')
    assert.equal(stopHook.body.name, 'stretch')
  })

  console.log(`\nAll ${passedTests}/${totalTests} tests passed successfully! ✨`)
}

runTests().catch(err => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
