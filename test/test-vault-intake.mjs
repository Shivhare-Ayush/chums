import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isVaultIntent,
  handleVaultIntake,
  clearIdempotencyCache,
  appendToMarkdownLog,
  sanitizeFileName,
  getLocalDateString,
  getLocalTimeString
} from '../tools/modules/vault-intake.mjs'

async function runTests() {
  console.log('🧪 Starting Vault Intake Engine Test Suite...\n')

  let passed = 0
  let failed = 0

  function test(name, fn) {
    try {
      fn()
      console.log(`  ✅ [PASS] ${name}`)
      passed++
    } catch (e) {
      console.error(`  ❌ [FAIL] ${name}: ${e.message}`)
      failed++
    }
  }

  async function asyncTest(name, fn) {
    try {
      await fn()
      console.log(`  ✅ [PASS] ${name}`)
      passed++
    } catch (e) {
      console.error(`  ❌ [FAIL] ${name}: ${e.message}`)
      failed++
    }
  }

  // --- Suite 1: Intent Classification ---
  console.log('--- Suite 1: Intent Classification (isVaultIntent) ---')

  test('Food intent: "Add this to my food log for lunch and dinner today"', () => {
    assert.equal(isVaultIntent('Add this to my food log for lunch and dinner today', []), true)
  })

  test('Food intent: "just had chicken and rice"', () => {
    assert.equal(isVaultIntent('just had chicken and rice', []), true)
  })

  test('Food intent: "eating oatmeal with protein powder"', () => {
    assert.equal(isVaultIntent('eating oatmeal with protein powder', []), true)
  })

  test('Workout intent: "hit back tri and shoulders for 1 hour"', () => {
    assert.equal(isVaultIntent('hit back tri and shoulders for 1 hour', []), true)
  })

  test('Workout intent: "went to pickleball today 10k steps"', () => {
    assert.equal(isVaultIntent('went to pickleball today 10k steps', []), true)
  })

  test('Workout intent: "workout log: bench press and squats"', () => {
    assert.equal(isVaultIntent('workout log: bench press and squats', []), true)
  })

  test('Photo upload without text qualifies as vault intent', () => {
    assert.equal(isVaultIntent('', ['photo-1.jpg']), true)
  })

  test('Non-vault intent: "spawn agent"', () => {
    assert.equal(isVaultIntent('spawn agent', []), false)
  })

  test('Non-vault intent: "open agent console"', () => {
    assert.equal(isVaultIntent('open agent console', []), false)
  })

  test('Non-vault intent: "review spec"', () => {
    assert.equal(isVaultIntent('review spec', []), false)
  })

  test('Non-vault intent: "inspect diffs"', () => {
    assert.equal(isVaultIntent('inspect diffs', []), false)
  })

  test('Non-vault intent: "status"', () => {
    assert.equal(isVaultIntent('status', []), false)
  })

  test('Non-vault intent: "hello"', () => {
    assert.equal(isVaultIntent('hello', []), false)
  })

  // --- Suite 2: Markdown Section Manipulation ---
  console.log('\n--- Suite 2: Markdown Section Formatting & Appending ---')

  test('appendToMarkdownLog creates new heading if missing', () => {
    const initial = '# Food Log\n\nAppend-only.\n'
    const updated = appendToMarkdownLog(initial, '2026-10-20', '### 12:30 Lunch\n![[Inbox/Assets/meal.jpg]]')
    assert.ok(updated.includes('## 2026-10-20'))
    assert.ok(updated.includes('### 12:30 Lunch'))
    assert.ok(updated.includes('![[Inbox/Assets/meal.jpg]]'))
  })

  test('appendToMarkdownLog appends under existing heading', () => {
    const initial = '# Food Log\n\n## 2026-10-20\n\n### 08:00 Breakfast\n'
    const updated = appendToMarkdownLog(initial, '2026-10-20', '### 13:00 Lunch')
    assert.ok(updated.includes('### 08:00 Breakfast'))
    assert.ok(updated.includes('### 13:00 Lunch'))
    // Should still have only one ## 2026-10-20 heading
    const matches = updated.match(/## 2026-10-20/g)
    assert.equal(matches.length, 1)
  })

  test('sanitizeFileName removes problematic chars and preserves extension', () => {
    assert.equal(sanitizeFileName('my photo #1 (lunch).jpg'), 'my_photo_1_lunch.jpg')
    assert.equal(sanitizeFileName('receipt!@#$%^&*.PNG'), 'receipt.png')
  })

  // --- Suite 3: End-to-End Vault Intake Execution & Idempotency ---
  console.log('\n--- Suite 3: End-to-End Vault Intake & Idempotency ---')

  // Setup mock sandbox environment
  const testRoot = path.join(os.tmpdir(), `chums-vault-test-${Date.now()}`)
  const mockVault = path.join(testRoot, 'Obsidian')
  const mockUploads = path.join(testRoot, 'uploads')
  const mockCacheFile = path.join(testRoot, 'cache.json')

  fs.mkdirSync(mockVault, { recursive: true })
  fs.mkdirSync(mockUploads, { recursive: true })

  // Create initial log files
  fs.writeFileSync(path.join(mockVault, 'Food Log.md'), '# Food Log\n\nAppend-only.\n\n## 2026-10-16\n\n### 12:00 Pizza\n')
  fs.writeFileSync(path.join(mockVault, 'Workout Log.md'), '# Workout Log\n\nAppend-only.\n\n## 2026-10-14\n\n### 18:00 Gym\n')

  // Create dummy upload image
  const samplePhoto = path.join(mockUploads, '1792460470276-65deeb-photo-1.jpg')
  fs.writeFileSync(samplePhoto, Buffer.from('FAKE_IMAGE_DATA_BYTES'))

  await asyncTest('Food log with photo upload correctly copied to Inbox/Assets and appended to Food Log.md', async () => {
    clearIdempotencyCache()
    const result = await handleVaultIntake({
      text: 'Add this to my food log for lunch and dinner today',
      files: ['photo-1.jpg'],
      sessionId: 'test-session-1',
      device: 'iphone',
      intakeId: 'test-intake-001',
      vaultPath: mockVault,
      cacheFile: mockCacheFile,
      searchDirs: [mockUploads]
    })

    assert.equal(result.handled, true)
    assert.ok(result.reply.includes('Food Log.md'))

    const foodLogContent = fs.readFileSync(path.join(mockVault, 'Food Log.md'), 'utf8')
    const today = getLocalDateString()
    assert.ok(foodLogContent.includes(`## ${today}`))
    assert.ok(foodLogContent.includes('Lunch and dinner today'))
    assert.ok(foodLogContent.includes('![[Inbox/Assets/'))

    // Verify file exists in mockVault/Inbox/Assets
    const assetsDir = path.join(mockVault, 'Inbox', 'Assets')
    assert.ok(fs.existsSync(assetsDir))
    const savedAssets = fs.readdirSync(assetsDir)
    assert.equal(savedAssets.length, 1)
    assert.ok(savedAssets[0].endsWith('photo_1.jpg') || savedAssets[0].endsWith('photo-1.jpg'))
  })

  await asyncTest('Idempotency: Re-submitting identical intake returns cached reply without duplicate entry', async () => {
    const foodLogBefore = fs.readFileSync(path.join(mockVault, 'Food Log.md'), 'utf8')

    const result = await handleVaultIntake({
      text: 'Add this to my food log for lunch and dinner today',
      files: ['photo-1.jpg'],
      sessionId: 'test-session-1',
      device: 'iphone',
      intakeId: 'test-intake-001',
      vaultPath: mockVault,
      cacheFile: mockCacheFile,
      searchDirs: [mockUploads]
    })

    assert.equal(result.handled, true)
    const foodLogAfter = fs.readFileSync(path.join(mockVault, 'Food Log.md'), 'utf8')

    // Content should be 100% identical: no duplicate log append!
    assert.equal(foodLogBefore, foodLogAfter)
  })

  await asyncTest('Workout log appends to Workout Log.md', async () => {
    const result = await handleVaultIntake({
      text: 'hit back bi and shoulders for 1 hour at gym',
      files: [],
      sessionId: 'test-session-2',
      device: 'watch',
      intakeId: 'test-intake-002',
      vaultPath: mockVault,
      cacheFile: mockCacheFile,
      searchDirs: [mockUploads]
    })

    assert.equal(result.handled, true)
    assert.ok(result.reply.includes('Workout Log.md'))

    const workoutContent = fs.readFileSync(path.join(mockVault, 'Workout Log.md'), 'utf8')
    const today = getLocalDateString()
    assert.ok(workoutContent.includes(`## ${today}`))
    assert.ok(workoutContent.includes('Hit back bi and shoulders for 1 hour at gym'))
  })

  await asyncTest('Non-vault intent is rejected cleanly without modifying logs', async () => {
    const result = await handleVaultIntake({
      text: 'spawn agent',
      files: [],
      sessionId: 'test-session-3',
      vaultPath: mockVault,
      cacheFile: mockCacheFile
    })

    assert.equal(result.handled, false)
  })

  // Cleanup sandbox
  try {
    fs.rmSync(testRoot, { recursive: true, force: true })
  } catch {}

  console.log(`\n=======================================================`)
  console.log(`  Tests Complete: ${passed} Passed, ${failed} Failed`)
  console.log(`=======================================================\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch(err => {
  console.error('Unhandled test runner exception:', err)
  process.exit(1)
})
