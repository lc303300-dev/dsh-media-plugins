import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ratioToSize, ratioFromPixels, normalizeRatio, SUPPORTED_RATIOS, SUPPORTED_RESOLUTIONS, SUPPORTED_IMAGE_PROVIDERS, classifyHttp, runImageRouter, defaultAdapters, geminiSizeFor, gptImage25SizeFor, GPT_IMAGE_2_5_SIZES, GPT_IMAGE_25_MODEL, GPT_IMAGE_25_RESOLUTION, GEMINI_MODELS_BY_RESOLUTION, ADAPTER_ALIASES } from '../src/shared/adapters.ts'
import { MediaError, FALLBACK_ALLOWED, mediaErrors } from '../src/shared/failure.ts'
import { hasImageSignature, extensionFor, decodeBase64Image, extractImagePayload, stageImageBytes } from '../src/shared/media-client.ts'

test('SUPPORTED_RATIOS is exactly the 8 contract values', () => {
  assert.deepEqual(SUPPORTED_RATIOS, ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'])
})

test('SUPPORTED_RESOLUTIONS and SUPPORTED_IMAGE_PROVIDERS match the contract', () => {
  assert.deepEqual(SUPPORTED_RESOLUTIONS, ['1K', '2K', '4K'])
  assert.deepEqual(SUPPORTED_IMAGE_PROVIDERS, ['comfly-gpt-image-2.5', 'comfly-gemini-flash-preview', 'dreamina-image'])
  assert.equal(SUPPORTED_IMAGE_PROVIDERS[0], 'comfly-gpt-image-2.5', 'the GPT 2.5 route is the default image route')
  assert.ok(!SUPPORTED_IMAGE_PROVIDERS.includes('comfly-gpt-image-2-all'), 'retired comfly-gpt-image-2-all must not be a public route')
})

test('ratioToSize maps all 8 ratios and rejects others with input_error', () => {
  assert.equal(ratioToSize('1:1'), '1024x1024')
  assert.equal(ratioToSize('16:9'), '1376x768')
  assert.throws(() => ratioToSize('4:5'), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => ratioToSize(''), (e) => e instanceof MediaError && e.cls === 'input_error')
})

test('normalizeRatio converts a user pixel size to the nearest standard ratio', () => {
  assert.equal(normalizeRatio('16:9'), '16:9')
  assert.equal(normalizeRatio('1920x1080'), '16:9')
  assert.equal(normalizeRatio('1920×1080'), '16:9')
  assert.equal(normalizeRatio('1920*1080'), '16:9')
  assert.equal(normalizeRatio('1080x1920'), '9:16')
  assert.equal(normalizeRatio('1024x1024'), '1:1')
  assert.equal(normalizeRatio('1620x1080'), '3:2')
  assert.equal(normalizeRatio('1440x1080'), '4:3')
  assert.equal(normalizeRatio('1080x1440'), '3:4')
  assert.equal(normalizeRatio('1080x1620'), '2:3')
  assert.equal(normalizeRatio('2560x1080'), '21:9')
  assert.equal(ratioFromPixels(3840, 2160), '16:9')
  assert.equal(ratioToSize('1920x1080'), '1376x768', 'pixel spelling resolves through the 1K base table')
  assert.throws(() => normalizeRatio('16:10'), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => normalizeRatio(''), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => ratioFromPixels(0, 100), (e) => e instanceof MediaError && e.cls === 'input_error')
})

test('geminiSizeFor scales the 1K allowlist by the resolution class', () => {
  assert.equal(geminiSizeFor('16:9', '1K'), '1376x768')
  assert.equal(geminiSizeFor('16:9', '2K'), '2752x1536')
  assert.equal(geminiSizeFor('1:1', '4K'), '4096x4096')
  assert.throws(() => geminiSizeFor('16:9', '8K'), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => geminiSizeFor('5:7', '1K'), (e) => e instanceof MediaError && e.cls === 'input_error')
})

test('gptImage25SizeFor resolves the 4K-only GPT 2.5 pixel table (the Comfly sunburst contract)', () => {
  assert.equal(GPT_IMAGE_25_MODEL, 'gpt-image-2.5-sunburst')
  assert.equal(GPT_IMAGE_25_RESOLUTION, '4K', 'the GPT 2.5 route is 4K-only')
  assert.equal(gptImage25SizeFor('16:9', '4K'), '3840x2160')
  assert.equal(gptImage25SizeFor('1920x1080', '4K'), '3840x2160', 'pixel spelling resolves to 16:9')
  assert.equal(gptImage25SizeFor('1080x1920', '4K'), '2160x3840')
  assert.equal(GPT_IMAGE_2_5_SIZES['1K'], undefined, 'the 4K-only route has no 1K ladder')
  assert.equal(GPT_IMAGE_2_5_SIZES['2K'], undefined, 'the 4K-only route has no 2K ladder')
  assert.deepEqual(GPT_IMAGE_2_5_SIZES['4K'], {
    '21:9': '3840x1648',
    '16:9': '3840x2160',
    '3:2': '3520x2352',
    '4:3': '3312x2480',
    '1:1': '2880x2880',
    '3:4': '2480x3312',
    '2:3': '2352x3520',
    '9:16': '2160x3840',
  })
  assert.throws(() => gptImage25SizeFor('16:9', '8K'), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => gptImage25SizeFor('5:7', '1K'), (e) => e instanceof MediaError && e.cls === 'input_error')
})

test('GEMINI_MODELS_BY_RESOLUTION routes 1K/2K/4K to the resolution-specific models', () => {
  assert.equal(GEMINI_MODELS_BY_RESOLUTION['1K'], 'gemini-3.1-flash-image-preview')
  assert.equal(GEMINI_MODELS_BY_RESOLUTION['2K'], 'gemini-3.1-flash-image-preview-2k')
  assert.equal(GEMINI_MODELS_BY_RESOLUTION['4K'], 'gemini-3.1-flash-image-preview-4k')
})

test('classifyHttp maps status codes to taxonomy classes', () => {
  assert.equal(classifyHttp(401).cls, 'auth_unavailable')
  assert.equal(classifyHttp(403).cls, 'auth_unavailable')
  assert.equal(classifyHttp(402).cls, 'quota_unavailable')
  assert.equal(classifyHttp(429).cls, 'quota_unavailable')
  assert.equal(classifyHttp(422).cls, 'policy_rejection')
  assert.equal(classifyHttp(500).cls, 'definite_provider_failure')
  assert.equal(classifyHttp(503).cls, 'definite_provider_failure')
})

test('fallback is allowed only for the whitelisted classes', () => {
  for (const cls of ['auth_unavailable', 'quota_unavailable', 'definite_provider_failure', 'download_failure', 'timeout_before_submit', 'provider_timeout']) {
    assert.ok(FALLBACK_ALLOWED.has(cls), `${cls} should allow fallback`)
  }
  for (const cls of ['input_error', 'indeterminate_submission', 'policy_rejection', 'cancelled', 'task_timeout']) {
    assert.ok(!FALLBACK_ALLOWED.has(cls), `${cls} must not allow fallback`)
  }
  assert.equal(mediaErrors.indeterminate('x').cls, 'indeterminate_submission')
})

test('image signature detection', () => {
  assert.ok(hasImageSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
  assert.ok(hasImageSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])))
  assert.ok(hasImageSignature(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])))
  assert.ok(!hasImageSignature(new Uint8Array([0x00, 0x01, 0x02, 0x03])))
  assert.equal(extensionFor(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), '.png')
  assert.equal(extensionFor(new Uint8Array([0xff, 0xd8, 0xff])), '.jpg')
})

test('extractImagePayload prefers b64_json (GPT 2.5) and falls back to url', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64')
  const inline = extractImagePayload({ data: [{ b64_json: png }] })
  assert.ok(inline.bytes instanceof Uint8Array)
  assert.equal(Buffer.from(inline.bytes).toString('base64'), png)
  assert.equal(inline.url, undefined)
  const dataUri = decodeBase64Image(`data:image/png;base64,${png}`)
  assert.equal(Buffer.from(dataUri).toString('base64'), png)
  const dataUriPayload = extractImagePayload({ data: [{ b64_json: `data:image/png;base64,${png}` }] })
  assert.equal(Buffer.from(dataUriPayload.bytes).toString('base64'), png)
  assert.equal(extractImagePayload({ data: [{ url: ' https://x/y.png ' }] }).url, 'https://x/y.png')
  assert.throws(() => extractImagePayload({ data: [] }), /no image data/)
  assert.throws(() => extractImagePayload({ data: [{}] }), /neither/)
  assert.throws(
    () => extractImagePayload({ data: [{ b64_json: Buffer.from('not-an-image').toString('base64') }] }),
    /not a valid image/,
  )
})

test('stageImageBytes validates the signature and stages atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-img-'))
  try {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const staged = await stageImageBytes(png, dir)
    assert.ok(staged.endsWith('.png'))
    assert.ok(existsSync(staged))
    await assert.rejects(() => stageImageBytes(new Uint8Array([0x00, 0x01, 0x02, 0x03]), dir), /not a valid image/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('defaultAdapters puts the GPT 2.5 route first (default image route)', () => {
  const cfg = {
    comflyBaseURL: 'x', comflyApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
    maxConcurrency: 6, providerTimeoutMs: 120000, taskTimeoutMs: 300000, outputDir: 'o', enabled: [],
  }
  const all = defaultAdapters(cfg)
  assert.deepEqual(all.map((a) => a.id), ['comfly-gpt-image-2.5', 'comfly-gemini-flash-preview', 'dreamina-image'])
  assert.equal(all[0].model, 'gpt-image-2.5-sunburst')
  const filtered = defaultAdapters({ ...cfg, enabled: ['comfly-gemini-flash-preview'] })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].id, 'comfly-gemini-flash-preview')
})

test('legacy adapter id alias: comfly-gemini-lite still selects the renamed adapter', () => {
  const cfg = {
    comflyBaseURL: 'x', comflyApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
    maxConcurrency: 6, providerTimeoutMs: 120000, taskTimeoutMs: 300000, outputDir: 'o', enabled: [],
  }
  const filtered = defaultAdapters({ ...cfg, enabled: ['comfly-gemini-lite'] })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].id, 'comfly-gemini-flash-preview')
})

test('legacy adapter id alias: comfly-gpt-image-2 still selects the GPT 2.5 route', () => {
  const cfg = {
    comflyBaseURL: 'x', comflyApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
    maxConcurrency: 6, providerTimeoutMs: 120000, taskTimeoutMs: 300000, outputDir: 'o', enabled: [],
  }
  assert.equal(ADAPTER_ALIASES['comfly-gpt-image-2'], 'comfly-gpt-image-2.5')
  const filtered = defaultAdapters({ ...cfg, enabled: ['comfly-gpt-image-2'] })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].id, 'comfly-gpt-image-2.5')
  assert.equal(filtered[0].model, 'gpt-image-2.5-sunburst')
})
