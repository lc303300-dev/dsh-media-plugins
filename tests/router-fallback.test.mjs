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

test('router: explicit image_provider runs only that route and never falls back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a', { cls: 'provider' })
    const b = fake('b')
    await assert.rejects(
      () => runImageRouter({ ...base(dir), adapters: [a, b], imageProvider: 'a' }),
      (e) => e instanceof MediaError && e.cls === 'definite_provider_failure',
    )
    assert.equal(a.calls, 1)
    assert.equal(b.calls, 0, 'explicit route must not fall back to another paid provider')
    const ok = fake('a')
    const out = await runImageRouter({ ...base(dir), adapters: [ok, fake('b')], imageProvider: 'a' })
    assert.equal(out.provider, 'a')
    assert.equal(out.attempts.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('router: explicit unknown/disabled image_provider is input_error before any call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a')
    await assert.rejects(
      () => runImageRouter({ ...base(dir), adapters: [a], imageProvider: 'missing' }),
      (e) => e instanceof MediaError && e.cls === 'input_error' && /Unsupported image_provider/.test(e.message),
    )
    await assert.rejects(
      () => runImageRouter({ ...base(dir), adapters: [a], imageProvider: 'comfly-gpt-image-2-all' }),
      (e) => e instanceof MediaError && e.cls === 'input_error' && /Unsupported image_provider/.test(e.message),
    )
    // disabled route: rejected through the real contract chain without any provider call
    await assert.rejects(
      () => runImageRouter({ ...base(dir), config: { ...cfg, enabled: ['comfly-gemini-flash-preview'] }, imageProvider: 'comfly-gpt-image-2' }),
      (e) => e instanceof MediaError && e.cls === 'input_error' && /disabled/.test(e.message),
    )
    assert.equal(a.calls, 0, 'validation failures must never reach a provider')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('router: invalid image_resolution is input_error before any call; valid value reaches the adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    let received = null
    const a = {
      id: 'a',
      model: 'm',
      capacityKey: 'a',
      async checkReady() {
        return { ready: true }
      },
      async execute(input) {
        received = { ratio: input.ratio, resolution: input.resolution, size: input.size }
        return { outputPath: join(tmpdir(), `fake-${Date.now()}.png`) }
      },
    }
    await assert.rejects(
      () => runImageRouter({ ...base(dir), adapters: [a], resolution: '8K' }),
      (e) => e instanceof MediaError && e.cls === 'input_error' && /image_resolution/.test(e.message),
    )
    const out = await runImageRouter({ ...base(dir), adapters: [a], resolution: '4K' })
    assert.equal(out.provider, 'a')
    assert.deepEqual(received, { ratio: '1:1', resolution: '4K', size: '1024x1024' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('router: circuit breaker opens after 3 consecutive failures and skips the adapter during cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const failing = fake('a', { cls: 'provider' })
    const ok = fake('b')
    // three failures trip the circuit for adapter 'a'
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(
        () => runImageRouter({ ...base(dir), adapters: [failing, ok], imageProvider: 'a' }),
        (e) => e instanceof MediaError && e.cls === 'definite_provider_failure',
      )
    }
    assert.equal(failing.calls, 3)
    assert.equal(ok.calls, 0)
    // fourth attempt: circuit is open — explicit route fails before executing
    await assert.rejects(
      () => runImageRouter({ ...base(dir), adapters: [failing, ok], imageProvider: 'a' }),
      (e) => e instanceof MediaError && /circuit cooldown/.test(e.message),
    )
    assert.equal(failing.calls, 3, 'open circuit must not execute the adapter')
    // default routing: open-circuit adapter is skipped, later adapter wins
    const out = await runImageRouter({ ...base(dir), adapters: [failing, ok] })
    assert.equal(out.provider, 'b')
    assert.equal(out.attempts[0].failureClass, 'circuit_open')
    assert.equal(failing.calls, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('router: a success resets the circuit counter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    let fail = true
    const flaky = {
      id: 'a',
      model: 'm',
      capacityKey: 'a',
      calls: 0,
      async checkReady() {
        return { ready: true }
      },
      async execute() {
        this.calls += 1
        if (fail) throw mediaErrors.provider('flaky failure')
        return { outputPath: join(tmpdir(), `fake-${Date.now()}.png`) }
      },
    }
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => runImageRouter({ ...base(dir), adapters: [flaky], imageProvider: 'a' }))
    }
    // simulate cooldown expiry: clear the circuit state so the adapter may run again
    const { rm } = await import('node:fs/promises')
    await rm(join(dir, 'providers', 'a', 'circuit.json'), { force: true })
    fail = false
    const out = await runImageRouter({ ...base(dir), adapters: [flaky], imageProvider: 'a' })
    assert.equal(out.provider, 'a')
    assert.equal(flaky.calls, 4)
    // success reset the counter: a failure no longer trips from 3
    fail = true
    await assert.rejects(() => runImageRouter({ ...base(dir), adapters: [flaky], imageProvider: 'a' }))
    assert.equal(flaky.calls, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
