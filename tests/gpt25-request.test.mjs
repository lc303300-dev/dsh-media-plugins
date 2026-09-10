/**
 * Offline contract tests for the Comfly GPT 2.5 ("sunburst") image route:
 * a local mock provider captures the exact request the route sends, so the
 * wire contract (concrete pixel `size`, no `resolution`, no `response_format`,
 * image read from `data[0].b64_json`) is verified without any paid call.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAiImageResult } from '../src/shared/media-client.ts'
import { runImageRouter } from '../src/shared/adapters.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Run `fn` against a local mock provider, with proxy env vars neutralized. */
async function withMockProvider(respond, fn) {
  const saved = {}
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  const captured = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      captured.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      respond(res, req.url)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`
  try {
    return await fn({ captured, baseURL })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const jsonB64 = (res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
}

test('GPT 2.5 text-to-image body: model + pixel size + n only; no resolution/response_format', async () => {
  await withMockProvider(jsonB64, async ({ captured, baseURL }) => {
    const payload = await openAiImageResult({
      baseURL,
      apiKey: 'test-key',
      model: 'gpt-image-2.5-sunburst',
      prompt: '一只坐在窗边的橘猫',
      size: '3840x2160',
      sendResolution: false,
      sendResponseFormat: false,
      resolution: '4K',
      timeoutMs: 5000,
    })
    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, '/v1/images/generations')
    assert.equal(captured[0].headers.authorization, 'Bearer test-key')
    assert.match(String(captured[0].headers['content-type']), /application\/json; charset=utf-8/)
    const body = JSON.parse(captured[0].body.toString('utf8'))
    assert.deepEqual(Object.keys(body).sort(), ['model', 'n', 'prompt', 'size'])
    assert.equal(body.model, 'gpt-image-2.5-sunburst')
    assert.equal(body.size, '3840x2160')
    assert.equal(body.n, 1)
    assert.equal('resolution' in body, false, 'GPT 2.5 must never receive resolution')
    assert.equal('response_format' in body, false, 'GPT 2.5 must never receive response_format')
    // data[0].b64_json is decoded into bytes
    assert.ok(payload.bytes instanceof Uint8Array)
    assert.deepEqual(Buffer.from(payload.bytes), PNG)
    assert.equal(payload.url, undefined)
  })
})

test('GPT 2.5 image edit body: multipart image repeated per reference, no resolution/response_format', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gpt25-'))
  try {
    const ref1 = join(dir, 'ref1.png')
    const ref2 = join(dir, 'ref2.png')
    writeFileSync(ref1, PNG)
    writeFileSync(ref2, PNG)
    await withMockProvider(jsonB64, async ({ captured, baseURL }) => {
      const payload = await openAiImageResult({
        baseURL,
        apiKey: 'test-key',
        model: 'gpt-image-2.5-sunburst',
        prompt: '把背景换成夜晚',
        size: '2160x3840',
        sendResolution: false,
        sendResponseFormat: false,
        resolution: '4K',
        images: [ref1, ref2],
        timeoutMs: 5000,
      })
      assert.equal(captured[0].url, '/v1/images/edits')
      assert.match(String(captured[0].headers['content-type']), /multipart\/form-data; boundary=/)
      const text = captured[0].body.toString('latin1')
      assert.match(text, /name="model"\r\n\r\ngpt-image-2\.5-sunburst/)
      assert.match(text, /name="size"\r\n\r\n2160x3840/)
      assert.match(text, /name="n"\r\n\r\n1/)
      assert.equal((text.match(/name="image"; filename=/g) ?? []).length, 2, 'one image field per reference')
      assert.doesNotMatch(text, /name="resolution"/)
      assert.doesNotMatch(text, /name="response_format"/)
      assert.ok(payload.bytes instanceof Uint8Array)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Gemini 2K route body still carries resolution + response_format and reads a url', async () => {
  await withMockProvider((res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ url: 'https://cdn.example/img.png' }] }))
  }, async ({ captured, baseURL }) => {
    const payload = await openAiImageResult({
      baseURL,
      apiKey: 'k',
      model: 'gemini-3.1-flash-image-preview-2k',
      prompt: 'p',
      size: '2048x2048',
      sendResolution: true,
      sendResponseFormat: true,
      resolution: '2K',
      timeoutMs: 5000,
    })
    const body = JSON.parse(captured[0].body.toString('utf8'))
    assert.equal(body.model, 'gemini-3.1-flash-image-preview-2k')
    assert.equal(body.resolution, '2k')
    assert.equal(body.response_format, 'url')
    assert.equal(payload.url, 'https://cdn.example/img.png')
    assert.equal(payload.bytes, undefined)
  })
})

test('router: GPT 2.5 is the default route, a pixel ratio is converted, and 2K is clamped to 4K', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gpt25-router-'))
  try {
    await withMockProvider(jsonB64, async ({ captured, baseURL }) => {
      const base = {
        prompt: '一只坐在窗边的橘猫',
        images: [],
        config: {
          comflyBaseURL: baseURL,
          comflyApiKeyEnv: 'COMFLY_API_KEY',
          dreaminaPath: join(dir, 'missing-dreamina.exe'),
          proxyUrl: '',
          maxConcurrency: 2,
          providerTimeoutMs: 15000,
          taskTimeoutMs: 60000,
          outputDir: 'outputs',
          enabled: [],
          credentials: { COMFLY_API_KEY: 'test-key' },
        },
        workspaceRoot: dir,
        privateRoot: join(dir, 'private'),
      }
      // the user asked for 1920x1080 and 2K: convert the ratio, clamp the class up to 4K
      const outcome = await runImageRouter({ ...base, ratio: '1920x1080', resolution: '2K' })
      assert.equal(outcome.provider, 'comfly-gpt-image-2.5', 'GPT 2.5 is the default route')
      assert.equal(outcome.model, 'gpt-image-2.5-sunburst')
      assert.equal(outcome.resolution, '4K', 'a requested 2K is clamped up to 4K')
      assert.equal(outcome.size, '3840x2160')
      assert.ok(existsSync(outcome.outputPath), 'the b64 payload is staged on disk')
      assert.equal(captured.length, 1)
      assert.equal(captured[0].url, '/v1/images/generations')
      const body = JSON.parse(captured[0].body.toString('utf8'))
      assert.equal(body.size, '3840x2160', '1920x1080 → 16:9 → 4K pixels')
      assert.equal(body.model, 'gpt-image-2.5-sunburst')
      assert.equal('resolution' in body, false)
      assert.equal('response_format' in body, false)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('router: the Gemini route is 2K-only — a requested 4K/1K is clamped to 2K in the wire body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gemini-2k-'))
  let origin = ''
  try {
    const respond = (res, url) => {
      if (url === '/img.png') {
        res.setHeader('content-type', 'image/png')
        res.end(PNG)
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ url: `${origin}/img.png` }] }))
    }
    await withMockProvider(respond, async ({ captured, baseURL }) => {
      origin = baseURL.slice(0, -'/v1'.length)
      const base = {
        prompt: '一只坐在窗边的橘猫',
        images: [],
        imageProvider: 'comfly-gemini-flash-preview',
        config: {
          comflyBaseURL: baseURL,
          comflyApiKeyEnv: 'COMFLY_API_KEY',
          dreaminaPath: join(dir, 'missing-dreamina.exe'),
          proxyUrl: '',
          maxConcurrency: 2,
          providerTimeoutMs: 15000,
          taskTimeoutMs: 60000,
          outputDir: 'outputs',
          enabled: [],
          credentials: { COMFLY_API_KEY: 'test-key' },
        },
        workspaceRoot: dir,
        privateRoot: join(dir, 'private'),
      }
      // 1K and 4K are withdrawn on the Gemini route: both clamp to 2K instead of failing
      for (const requested of ['4K', '1K']) {
        const outcome = await runImageRouter({ ...base, ratio: '1920x1080', resolution: requested })
        assert.equal(outcome.provider, 'comfly-gemini-flash-preview')
        assert.equal(outcome.model, 'gemini-3.1-flash-image-preview-2k')
        assert.equal(outcome.resolution, '2K', `a requested ${requested} is clamped to 2K`)
        assert.equal(outcome.size, '2752x1536', '1920x1080 → 16:9 → 2K pixels')
        assert.ok(existsSync(outcome.outputPath), 'the downloaded url payload is staged on disk')
      }
      const bodies = captured
        .filter((c) => c.url === '/v1/images/generations')
        .map((c) => JSON.parse(c.body.toString('utf8')))
      assert.equal(bodies.length, 2, 'one generation call per request')
      for (const body of bodies) {
        assert.equal(body.model, 'gemini-3.1-flash-image-preview-2k')
        assert.equal(body.size, '2752x1536')
        assert.equal(body.resolution, '2k')
        assert.equal(body.response_format, 'url')
      }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
