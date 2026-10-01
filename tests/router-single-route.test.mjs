import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runImageRouter } from '../src/shared/adapters.ts'
import { MediaError, mediaErrors } from '../src/shared/failure.ts'

// Image work is SINGLE ROUTE: the router picks exactly one adapter per
// candidate and runs it once. A paid attempt is never replayed on another
// route — a failure ends the candidate and the USER decides whether to re-queue
// it from the review page. Picking a route is free (circuit + credential
// checks), so an unconfigured/cooling-down route may still hand over to the
// next one without any provider call.

const cfg = {
  comflyBaseURL: 'http://x', comflyApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
  maxConcurrency: 6, providerTimeoutMs: 90000, taskTimeoutMs: 90000, outputDir: 'o', enabled: [],
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

test('single route: a failed route is never replaced by the next one', async () => {
  for (const cls of ['provider', 'quota', 'auth']) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
    try {
      const a = fake('a', { cls })
      const b = fake('b')
      await assert.rejects(() => runImageRouter({ ...base(dir), adapters: [a, b] }))
      assert.equal(a.calls, 1, `${cls}: the chosen route is attempted exactly once`)
      assert.equal(b.calls, 0, `${cls}: the batch must not retry on another route`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('single route: timeout, download and indeterminate failures stay final with exactly one call', async () => {
  // one fresh private root per case: a shared circuit file would trip after the
  // third failure and confuse the route choice under test
  for (const cls of ['providerTimeout', 'timeoutBeforeSubmit', 'download', 'indeterminate']) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
    try {
      const a = fake('a', { cls })
      const b = fake('b')
      await assert.rejects(() => runImageRouter({ ...base(dir), adapters: [a, b] }), undefined, `${cls} must fail the candidate`)
      assert.equal(a.calls, 1, `${cls}: one attempt`)
      assert.equal(b.calls, 0, `${cls}: no second provider`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('single route: an unready route is handed over to the next ready one without a paid call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a', { ready: false })
    const b = fake('b')
    const out = await runImageRouter({ ...base(dir), adapters: [a, b] })
    assert.equal(out.provider, 'b', 'route choice is free, so a missing credential may fall through')
    assert.equal(a.calls, 0)
    assert.equal(b.calls, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('single route: no ready route at all fails before any provider call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a', { ready: false })
    const b = fake('b', { ready: false })
    await assert.rejects(
      () => runImageRouter({ ...base(dir), adapters: [a, b] }),
      (e) => e instanceof MediaError && e.cls === 'auth_unavailable' && /no image route is ready/.test(e.message),
    )
    assert.equal(a.calls + b.calls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('single route: an explicit image_provider runs only that route and a failure is final', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a', { cls: 'provider' })
    const b = fake('b')
    await assert.rejects(
      () => runImageRouter({ ...base(dir), adapters: [a, b], imageProvider: 'a' }),
      (e) => e instanceof MediaError && e.cls === 'definite_provider_failure',
    )
    assert.equal(a.calls, 1)
    assert.equal(b.calls, 0)
    const ok = fake('a')
    const out = await runImageRouter({ ...base(dir), adapters: [ok, fake('b')], imageProvider: 'a' })
    assert.equal(out.provider, 'a')
    assert.equal(out.attempts.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('single route: unknown or disabled image_provider is input_error before any call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a')
    await assert.rejects(
      () => runImageRouter({ ...base(dir), adapters: [a], imageProvider: 'missing' }),
      (e) => e instanceof MediaError && e.cls === 'input_error' && /Unsupported image_provider/.test(e.message),
    )
    await assert.rejects(
      () => runImageRouter({ ...base(dir), config: { ...cfg, enabled: ['comfly-gemini-flash-preview'] }, imageProvider: 'comfly-gpt-image-2' }),
      (e) => e instanceof MediaError && e.cls === 'input_error' && /disabled/.test(e.message),
    )
    assert.equal(a.calls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('single route: an invalid image_resolution is input_error; a valid one reaches the adapter', async () => {
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

test('single route: a busy capacity pool stops the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const a = fake('a')
    await assert.rejects(
      () =>
        runImageRouter({
          ...base(dir),
          adapters: [a],
          config: { ...cfg, maxConcurrency: 0, providerTimeoutMs: 150, taskTimeoutMs: 150 },
        }),
      (e) => e instanceof MediaError && e.cls === 'concurrency_busy',
    )
    assert.equal(a.calls, 0, 'no provider call may happen without a slot')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('single route: three consecutive failures open the circuit and the router hands over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  try {
    const failing = fake('a', { cls: 'provider' })
    const ok = fake('b')
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => runImageRouter({ ...base(dir), adapters: [failing, ok], imageProvider: 'a' }))
    }
    assert.equal(failing.calls, 3)
    assert.equal(ok.calls, 0)
    // explicit route: an open circuit fails before executing
    await assert.rejects(
      () => runImageRouter({ ...base(dir), adapters: [failing, ok], imageProvider: 'a' }),
      (e) => e instanceof MediaError && /circuit cooldown/.test(e.message),
    )
    assert.equal(failing.calls, 3)
    // automatic choice: the cooling-down route is skipped, the ready one is chosen
    const out = await runImageRouter({ ...base(dir), adapters: [failing, ok] })
    assert.equal(out.provider, 'b')
    assert.equal(failing.calls, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
