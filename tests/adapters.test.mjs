import test from 'node:test'
import assert from 'node:assert/strict'
import { ratioToSize, SUPPORTED_RATIOS, SUPPORTED_RESOLUTIONS, SUPPORTED_IMAGE_PROVIDERS, classifyHttp, runImageRouter, defaultAdapters, geminiSizeFor, gptImage2SizeFor, GPT_IMAGE_2_SIZES, GEMINI_MODELS_BY_RESOLUTION } from '../src/shared/adapters.ts'
import { MediaError, FALLBACK_ALLOWED, mediaErrors } from '../src/shared/failure.ts'
import { hasImageSignature, extensionFor } from '../src/shared/media-client.ts'

test('SUPPORTED_RATIOS is exactly the 8 contract values', () => {
  assert.deepEqual(SUPPORTED_RATIOS, ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'])
})

test('SUPPORTED_RESOLUTIONS and SUPPORTED_IMAGE_PROVIDERS match the contract', () => {
  assert.deepEqual(SUPPORTED_RESOLUTIONS, ['1K', '2K', '4K'])
  assert.deepEqual(SUPPORTED_IMAGE_PROVIDERS, ['comfly-gemini-flash-preview', 'comfly-gpt-image-2', 'dreamina-image'])
  assert.ok(!SUPPORTED_IMAGE_PROVIDERS.includes('comfly-gpt-image-2-all'), 'retired comfly-gpt-image-2-all must not be a public route')
})

test('ratioToSize maps all 8 ratios and rejects others with input_error', () => {
  assert.equal(ratioToSize('1:1'), '1024x1024')
  assert.equal(ratioToSize('16:9'), '1376x768')
  assert.throws(() => ratioToSize('4:5'), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => ratioToSize(''), (e) => e instanceof MediaError && e.cls === 'input_error')
})

test('geminiSizeFor scales the 1K allowlist by the resolution class', () => {
  assert.equal(geminiSizeFor('16:9', '1K'), '1376x768')
  assert.equal(geminiSizeFor('16:9', '2K'), '2752x1536')
  assert.equal(geminiSizeFor('1:1', '4K'), '4096x4096')
  assert.throws(() => geminiSizeFor('16:9', '8K'), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => geminiSizeFor('5:7', '1K'), (e) => e instanceof MediaError && e.cls === 'input_error')
})

test('gptImage2SizeFor resolves the GPT Image 2 pixel table per ratio x resolution', () => {
  assert.equal(gptImage2SizeFor('16:9', '1K'), '1280x720')
  assert.equal(gptImage2SizeFor('16:9', '2K'), '2048x1152')
  assert.equal(gptImage2SizeFor('9:16', '4K'), '2160x3840')
  assert.equal(GPT_IMAGE_2_SIZES['4K']['1:1'], '2880x2880')
  assert.throws(() => gptImage2SizeFor('16:9', '8K'), (e) => e instanceof MediaError && e.cls === 'input_error')
  assert.throws(() => gptImage2SizeFor('5:7', '1K'), (e) => e instanceof MediaError && e.cls === 'input_error')
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

test('defaultAdapters respects enabled filter and contract order (no retired gpt-image-2-all)', () => {
  const cfg = {
    comflyBaseURL: 'x', comflyApiKeyEnv: 'K', dreaminaPath: 'd', proxyUrl: '',
    maxConcurrency: 6, providerTimeoutMs: 120000, taskTimeoutMs: 300000, outputDir: 'o', enabled: [],
  }
  const all = defaultAdapters(cfg)
  assert.deepEqual(all.map((a) => a.id), ['comfly-gemini-flash-preview', 'comfly-gpt-image-2', 'dreamina-image'])
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
