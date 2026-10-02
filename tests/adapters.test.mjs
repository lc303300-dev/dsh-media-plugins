import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ratioToSize, ratioFromPixels, normalizeRatio, SUPPORTED_RATIOS, SUPPORTED_RESOLUTIONS, SUPPORTED_IMAGE_PROVIDERS, classifyHttp, runImageRouter, defaultAdapters, geminiSizeFor, gptImage2SizeFor, GPT_IMAGE_2_4K_MODEL, GPT_IMAGE_2_4K_RESOLUTION, GPT_IMAGE_2_4K_LONG_EDGE, GEMINI_IMAGE_RESOLUTION, GEMINI_MODELS_BY_RESOLUTION, ADAPTER_ALIASES, IMAGE_CAPACITY_KEY, DEFAULT_IMAGE_CONCURRENCY } from '../src/shared/adapters.ts'
import { MediaError, FALLBACK_ALLOWED, STOP_CLASSES, ALL_FAILURE_CLASSES, mediaErrors } from '../src/shared/failure.ts'
import { hasImageSignature, extensionFor, decodeBase64Image, extractImagePayload, stageImageBytes } from '../src/shared/media-client.ts'

test('SUPPORTED_RATIOS is exactly the 8 contract values', () => {
  assert.deepEqual(SUPPORTED_RATIOS, ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'])
})

test('SUPPORTED_RESOLUTIONS and SUPPORTED_IMAGE_PROVIDERS match the contract', () => {
  assert.deepEqual(SUPPORTED_RESOLUTIONS, ['1K', '2K', '4K'])
  assert.deepEqual(SUPPORTED_IMAGE_PROVIDERS, ['comfly-gpt-image-2-4k', 'comfly-gemini-flash-preview', 'dreamina-image'])
  assert.equal(SUPPORTED_IMAGE_PROVIDERS[0], 'comfly-gpt-image-2-4k', 'the GPT Image 2 route is the default image route')
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

test('geminiSizeFor is 2K-only: the withdrawn 1K/4K classes are input_error at the helper', () => {
  assert.equal(GEMINI_IMAGE_RESOLUTION, '2K', 'the Gemini route is 2K-only')
  assert.equal(geminiSizeFor('16:9', '2K'), '2752x1536')
  assert.equal(geminiSizeFor('1:1', '2K'), '2048x2048')
  assert.equal(geminiSizeFor('9:16', '2K'), '1536x2752')
  assert.equal(geminiSizeFor('1920x1080', '2K'), '2752x1536', 'pixel spelling resolves to 16:9, then the 2K ladder')
  assert.equal(geminiSizeFor('1920*1080', '2K'), '2752x1536', 'the asterisk spelling resolves the same way')
  assert.equal(geminiSizeFor('1920×1080', '2K'), '2752x1536', 'the multiplication-sign spelling resolves the same way')
  assert.throws(() => geminiSizeFor('16:9', '1K'), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => geminiSizeFor('16:9', '4K'), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => geminiSizeFor('16:9', '8K'), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => geminiSizeFor('5:7', '2K'), (e) => e instanceof MediaError && e.cls === 'input_error')
})

test('gptImage2SizeFor derives the 2048-px long edge the GPT Image 2 route renders (aspect_ratio mode)', () => {
  assert.equal(GPT_IMAGE_2_4K_MODEL, 'gpt-image-2-4k')
  assert.equal(GPT_IMAGE_2_4K_RESOLUTION, '2K', 'the GPT Image 2 route reports the 2K class')
  assert.equal(GPT_IMAGE_2_4K_LONG_EDGE, 2048, 'aspect_ratio mode renders a 2048-px long edge')
  assert.equal(gptImage2SizeFor('16:9'), '2048x1152', 'measured output for 16:9')
  assert.equal(gptImage2SizeFor('1920x1080'), '2048x1152', 'pixel spelling resolves to 16:9')
  assert.equal(gptImage2SizeFor('1080x1920'), '1152x2048')
  assert.equal(gptImage2SizeFor('1:1'), '2048x2048')
  assert.equal(gptImage2SizeFor('21:9'), '2048x878')
  assert.throws(() => gptImage2SizeFor('5:7'), (e) => e instanceof MediaError && e.cls === 'input_error')
})

test('GEMINI_MODELS_BY_RESOLUTION keeps only the 2K model', () => {
  assert.equal(GEMINI_MODELS_BY_RESOLUTION[GEMINI_IMAGE_RESOLUTION], 'gemini-3.1-flash-image-preview-2k')
  assert.deepEqual(Object.keys(GEMINI_MODELS_BY_RESOLUTION), ['2K'], 'the route exposes exactly one resolution class')
  assert.equal(GEMINI_MODELS_BY_RESOLUTION['1K'], undefined, 'the 2K-only route has no 1K model')
  assert.equal(GEMINI_MODELS_BY_RESOLUTION['4K'], undefined, 'the 2K-only route has no 4K model')
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

test('fallback is allowed only for the three error classes', () => {
  for (const cls of ['auth_unavailable', 'quota_unavailable', 'definite_provider_failure']) {
    assert.ok(FALLBACK_ALLOWED.has(cls), `${cls} should allow fallback`)
  }
  for (const cls of ['input_error', 'indeterminate_submission', 'policy_rejection', 'cancelled', 'task_timeout',
    'timeout_before_submit', 'provider_timeout', 'download_failure', 'concurrency_busy']) {
    assert.ok(!FALLBACK_ALLOWED.has(cls), `${cls} must not allow fallback`)
  }
  assert.equal(mediaErrors.indeterminate('x').cls, 'indeterminate_submission')
  assert.equal(mediaErrors.busy('x').cls, 'concurrency_busy')
})

test('failure taxonomy: the two sets partition every class, and only errors may fall back', () => {
  assert.equal(FALLBACK_ALLOWED.size, 3, 'only auth/quota/5xx-style failures may switch route')
  assert.equal(FALLBACK_ALLOWED.size + STOP_CLASSES.size, ALL_FAILURE_CLASSES.length, 'every class must be classified exactly once')
  for (const cls of ALL_FAILURE_CLASSES) {
    assert.equal(FALLBACK_ALLOWED.has(cls) || STOP_CLASSES.has(cls), true, `${cls} must be in one of the two sets`)
    assert.equal(FALLBACK_ALLOWED.has(cls) && STOP_CLASSES.has(cls), false, `${cls} must not be in both sets`)
  }
  // the classes that were deliberately moved out of the fallback set
  for (const cls of ['timeout_before_submit', 'provider_timeout', 'download_failure', 'concurrency_busy']) {
    assert.ok(STOP_CLASSES.has(cls), `${cls} must stop routing instead of paying twice`)
  }
})

test('image signature detection', () => {
  assert.ok(hasImageSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
  assert.ok(hasImageSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])))
  assert.ok(hasImageSignature(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])))
  assert.ok(!hasImageSignature(new Uint8Array([0x00, 0x01, 0x02, 0x03])))
  assert.equal(extensionFor(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), '.png')
  assert.equal(extensionFor(new Uint8Array([0xff, 0xd8, 0xff])), '.jpg')
})

test('extractImagePayload prefers b64_json and falls back to url', () => {
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

test('defaultAdapters puts the GPT Image 2 route first (default image route)', () => {
  const cfg = {
    comflyBaseURL: 'x', comflyApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
    maxConcurrency: 6, providerTimeoutMs: 90000, taskTimeoutMs: 90000, outputDir: 'o', enabled: [],
  }
  const all = defaultAdapters(cfg)
  assert.deepEqual(all.map((a) => a.id), ['comfly-gpt-image-2-4k', 'comfly-gemini-flash-preview', 'dreamina-image'])
  assert.equal(all[0].model, 'gpt-image-2-4k')
  const filtered = defaultAdapters({ ...cfg, enabled: ['comfly-gemini-flash-preview'] })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].id, 'comfly-gemini-flash-preview')
  assert.equal(filtered[0].model, 'gemini-3.1-flash-image-preview-2k', 'the Gemini route ships the 2K model')
})

test('retired alias: comfly-gemini-lite is neither an adapter id nor an alias any more', () => {
  const cfg = {
    comflyBaseURL: 'x', comflyApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
    maxConcurrency: 6, providerTimeoutMs: 90000, taskTimeoutMs: 90000, outputDir: 'o', enabled: [],
  }
  assert.equal(ADAPTER_ALIASES['comfly-gemini-lite'], undefined)
  assert.deepEqual(Object.keys(ADAPTER_ALIASES), ['comfly-gpt-image-2', 'comfly-gpt-image-2.5'], 'only the two former GPT spellings remain')
  assert.deepEqual(defaultAdapters({ ...cfg, enabled: ['comfly-gemini-lite'] }), [], 'the retired id selects no adapter')
})

test('legacy adapter id aliases: both former GPT spellings select the GPT Image 2 route', () => {
  const cfg = {
    comflyBaseURL: 'x', comflyApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
    maxConcurrency: 6, providerTimeoutMs: 90000, taskTimeoutMs: 90000, outputDir: 'o', enabled: [],
  }
  assert.equal(ADAPTER_ALIASES['comfly-gpt-image-2'], 'comfly-gpt-image-2-4k')
  assert.equal(ADAPTER_ALIASES['comfly-gpt-image-2.5'], 'comfly-gpt-image-2-4k')
  for (const legacy of ['comfly-gpt-image-2', 'comfly-gpt-image-2.5']) {
    const filtered = defaultAdapters({ ...cfg, enabled: [legacy] })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].id, 'comfly-gpt-image-2-4k')
    assert.equal(filtered[0].model, 'gpt-image-2-4k')
  }
})

test('every image route leases ONE shared image pool; video capacity is never image-visible', () => {
  const cfg = {
    comflyBaseURL: 'x', comflyApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
    maxConcurrency: DEFAULT_IMAGE_CONCURRENCY, providerTimeoutMs: 90000, taskTimeoutMs: 90000, outputDir: 'o', enabled: [],
  }
  const chain = defaultAdapters(cfg)
  assert.equal(chain.length, 3, 'GPT Image 2 -> Gemini 2K -> Dreamina')
  assert.deepEqual([...new Set(chain.map((a) => a.capacityKey))], [IMAGE_CAPACITY_KEY], 'all image routes share the single pool')
  assert.equal(IMAGE_CAPACITY_KEY, 'image')
  assert.equal(DEFAULT_IMAGE_CONCURRENCY, 10, 'the shared image pool is 10 concurrent images')
  assert.ok(!chain.some((a) => a.capacityKey === 'seedance-cli'), 'the video pool must not be reachable from an image route')
})
