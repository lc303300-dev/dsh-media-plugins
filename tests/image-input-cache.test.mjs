import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { runImageRouter } from '../src/shared/adapters.ts'
import { MediaError } from '../src/shared/failure.ts'

// Reference inputs are normalized (EXIF + <=1920 px) once per distinct source
// and reused by every candidate. Before the content-addressed cache, a group of
// N candidates re-encoded the same reference set N times into N per-task
// directories, so a 40-image batch paid ~40x the sharp work for identical
// inputs. The source files themselves are never touched.

const cfg = {
  comflyBaseURL: 'http://x', comflyApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
  maxConcurrency: 4, providerTimeoutMs: 90000, taskTimeoutMs: 90000, outputDir: 'o', enabled: [],
}

/** Fake adapter that records the normalized input paths handed to it. */
function capture(id) {
  const seen = []
  const adapter = {
    id,
    model: `${id}-model`,
    capacityKey: id,
    async checkReady() {
      return { ready: true }
    },
    async execute(input) {
      seen.push(input.images)
      return { outputPath: join(tmpdir(), `fake-${id}-${seen.length}.png`) }
    },
  }
  return { adapter, seen }
}

async function makeRef(dir, name, width, height) {
  const path = join(dir, name)
  await sharp({ create: { width, height, channels: 3, background: { r: 24, g: 120, b: 200 } } })
    .png()
    .toFile(path)
  return path
}

function base(dir, privateRoot, images) {
  return { prompt: 'p', images, ratio: '16:9', config: cfg, workspaceRoot: dir, privateRoot }
}

test('reference inputs: one normalized copy is reused across candidates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inputs-'))
  try {
    const privateRoot = join(dir, 'private')
    const ref = await makeRef(dir, 'ref.png', 2400, 1200)
    const first = capture('a')
    const second = capture('b')

    await runImageRouter({ ...base(dir, privateRoot, [ref]), adapters: [first.adapter] })
    await runImageRouter({ ...base(dir, privateRoot, [ref]), adapters: [second.adapter] })

    assert.equal(first.seen[0].length, 1, 'the adapter receives exactly one normalized input')
    assert.equal(
      first.seen[0][0],
      second.seen[0][0],
      'a later candidate must reuse the cached normalized file, not re-encode it',
    )
    const cached = readdirSync(join(privateRoot, 'inputs-cache'))
    assert.equal(cached.length, 1, 'exactly one cache entry for one distinct source')
    assert.match(cached[0], /\.jpg$/, 'an opaque reference is uploaded as JPEG (not a ~10x bigger PNG)')

    const meta = await sharp(first.seen[0][0]).metadata()
    assert.equal(Math.max(meta.width, meta.height), 1920, 'long edge is bounded to 1920 px')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reference inputs: an already-small source is not enlarged and is still cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inputs-small-'))
  try {
    const privateRoot = join(dir, 'private')
    const ref = await makeRef(dir, 'small.png', 320, 180)
    const a = capture('a')
    await runImageRouter({ ...base(dir, privateRoot, [ref]), adapters: [a.adapter] })
    const meta = await sharp(a.seen[0][0]).metadata()
    assert.equal(meta.width, 320)
    assert.equal(meta.height, 180)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reference inputs: a changed source invalidates its cache entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inputs-invalidate-'))
  try {
    const privateRoot = join(dir, 'private')
    const ref = await makeRef(dir, 'ref.png', 2000, 1000)
    const a = capture('a')
    await runImageRouter({ ...base(dir, privateRoot, [ref]), adapters: [a.adapter] })
    const firstPath = a.seen[0][0]

    // same path, new content: rewriting with a different size and a newer mtime
    // must produce a new cache entry instead of serving the stale normalization
    await makeRef(dir, 'ref.png', 640, 360)
    const future = new Date(Date.now() + 5000)
    utimesSync(ref, future, future)

    const b = capture('b')
    await runImageRouter({ ...base(dir, privateRoot, [ref]), adapters: [b.adapter] })
    assert.notEqual(b.seen[0][0], firstPath, 'stale normalization must not be reused after the source changed')
    const meta = await sharp(b.seen[0][0]).metadata()
    assert.equal(meta.width, 640)
    assert.equal(meta.height, 360)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reference inputs: an alpha source keeps PNG (JPEG has no alpha channel)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inputs-alpha-'))
  try {
    const privateRoot = join(dir, 'private')
    const ref = join(dir, 'alpha.png')
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toFile(ref)
    const a = capture('a')
    await runImageRouter({ ...base(dir, privateRoot, [ref]), adapters: [a.adapter] })
    const cached = readdirSync(join(privateRoot, 'inputs-cache'))
    assert.equal(cached.length, 1)
    assert.match(cached[0], /\.png$/, 'alpha must survive, so the copy stays PNG')
    const meta = await sharp(a.seen[0][0]).metadata()
    assert.equal(meta.hasAlpha, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reference inputs: an unreadable reference fails as input_error before any provider call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inputs-missing-'))
  try {
    const privateRoot = join(dir, 'private')
    const a = capture('a')
    await assert.rejects(
      () => runImageRouter({ ...base(dir, privateRoot, [join(dir, 'nope.png')]), adapters: [a.adapter] }),
      (error) => error instanceof MediaError && error.cls === 'input_error' && /cannot read reference image/.test(error.message),
    )
    assert.equal(a.seen.length, 0, 'no paid call may happen when a reference cannot be read')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
