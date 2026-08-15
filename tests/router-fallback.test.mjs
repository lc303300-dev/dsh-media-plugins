import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runImageRouter } from '../src/shared/adapters.ts'
import { MediaError, mediaErrors } from '../src/shared/failure.ts'

const cfg = {
  comflyBaseURL: 'http://x', comflyApiKeyEnv: 'K', apimartBaseURL: 'http://x', apimartApiKeyEnv: 'K',
  geminiApiURL: 'http://x', geminiApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
  maxConcurrency: 6, providerTimeoutMs: 120000, taskTimeoutMs: 300000, outputDir: 'o', enabled: [],
}

/** Fake adapter with a call counter and an injectable outcome. */
function fake(id, outcome = {}) {
  const adapter = {
    id,
    model: `${id}-model`,
    capacityKey: id,
    calls: 0,
    async checkReady() {
      return { ready: outcome.ready !== false, reason: outcome.ready === false ? 'not ready' : undefined }
    },
    async execute() {
      adapter.calls += 1
      if (outcome.cls) {
        const factory = mediaErrors[outcome.cls]
        if (factory) throw factory(`fake ${id} failure`)
        throw new Error(`fake ${id} failure`)
      }
      return { outputPath: join(tmpdir(), `fake-${id}.png`) }
    },
  }
  return adapter
}

function base(privateRoot) {
  return { prompt: 'test', images: [], ratio: '1:1', config: cfg, workspaceRoot: tmpdir(), privateRoot }
}

test('router: definite failure falls back to the next adapter, stops on success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a', { cls: 'provider' })
    const b = fake('b')
    const c = fake('c')
    const out = await runImageRouter({ ...base(dir), adapters: [a, b, c] })
    assert.equal(out.provider, 'b')
    assert.equal(a.calls, 1)
    assert.equal(b.calls, 1)
    assert.equal(c.calls, 0, 'later adapters must not run after success')
    assert.equal(out.attempts.length, 2)
    assert.equal(out.attempts[0].status, 'failed')
    assert.equal(out.attempts[1].status, 'success')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('router: indeterminate submission stops immediately with needs_review semantics and exactly 1 call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a', { cls: 'indeterminate' })
    const b = fake('b')
    await assert.rejects(
      () => runImageRouter({ ...base(dir), adapters: [a, b] }),
      (e) => e instanceof MediaError && e.cls === 'indeterminate_submission',
    )
    assert.equal(a.calls, 1, 'indeterminate must not be retried')
    assert.equal(b.calls, 0, 'indeterminate must not fall through to another paid provider')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('router: input_error and policy_rejection never fall back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    for (const cls of ['input', 'policy']) {
      const a = fake('a', { cls })
      const b = fake('b')
      await assert.rejects(() => runImageRouter({ ...base(dir), adapters: [a, b] }), (e) => e instanceof MediaError && e.cls === `${cls}_error` || e.cls === 'policy_rejection')
      assert.equal(a.calls, 1)
      assert.equal(b.calls, 0, `${cls}_error must not fall back`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('router: not-ready adapters are skipped without executing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a', { ready: false })
    const b = fake('b')
    const out = await runImageRouter({ ...base(dir), adapters: [a, b] })
    assert.equal(out.provider, 'b')
    assert.equal(a.calls, 0)
    assert.equal(out.attempts[0].status, 'skipped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('router: all allowed-failures exhausted -> task fails with full attempt record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a', { cls: 'provider' })
    const b = fake('b', { cls: 'download' })
    await assert.rejects(() => runImageRouter({ ...base(dir), adapters: [a, b] }), /all image providers failed/)
    assert.equal(a.calls, 1)
    assert.equal(b.calls, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
