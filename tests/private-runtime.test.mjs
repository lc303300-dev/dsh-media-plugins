import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, atomicWriteJson, acquireSlot, sha256Text, readJsonSafe, newTaskId } from '../src/shared/private-runtime.ts'

test('atomicWriteJson + readJsonSafe round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const path = join(dir, 'a', 'b', 'state.json')
    await atomicWriteJson(path, { x: 1, nested: { y: '中文' } })
    const read = await readJsonSafe(path)
    assert.deepEqual(read, { x: 1, nested: { y: '中文' } })
    assert.equal(await readJsonSafe(join(dir, 'missing.json')), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TaskStore validates transitions and persists states', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-'))
  try {
    const store = new TaskStore(join(dir, 'jobs'))
    const id = newTaskId()
    await store.create('batch1', id, 'image', { prompt: '<redacted>' })
    let state = await store.load('batch1', id)
    assert.equal(state.status, 'pending')
    await store.transition('batch1', id, 'running')
    await assert.rejects(() => store.transition('batch1', id, 'pending'), /invalid task transition/)
    await store.transition('batch1', id, 'needs_review', { nextAction: 'user_check_backend' })
    state = await store.load('batch1', id)
    assert.equal(state.status, 'needs_review')
    assert.equal(state.nextAction, 'user_check_backend')
    await assert.rejects(() => store.transition('batch1', id, 'success'), /invalid task transition/)
    await store.saveResult('batch1', id, { status: 'needs_review' })
    assert.equal((await store.listTasks('batch1')).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('slot lease: 7th concurrent waiter blocks until a slot frees', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
  try {
    const releases = []
    for (let i = 0; i < 6; i += 1) {
      releases.push(await acquireSlot(join(dir, 'locks'), 'test-cap', 6, { taskId: `t${i}`, timeoutMs: 5000 }))
    }
    const seventh = acquireSlot(join(dir, 'locks'), 'test-cap', 6, { taskId: 't7', timeoutMs: 3000 })
    let settled = false
    const waiter = seventh.then(() => { settled = true }).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(settled, false, '7th slot must wait while all 6 are held')
    await releases[0]()
    await waiter
    assert.equal(settled, true, '7th slot acquires after release')
    // timeout when no slot frees
    const timeout = acquireSlot(join(dir, 'locks'), 'test-cap', 6, { taskId: 't8', timeoutMs: 200 })
    await assert.rejects(timeout, /no free slot/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sha256Text is deterministic', () => {
  assert.equal(sha256Text('你好'), sha256Text('你好'))
  assert.notEqual(sha256Text('你好'), sha256Text('您好'))
  assert.equal(sha256Text('').length, 64)
})
