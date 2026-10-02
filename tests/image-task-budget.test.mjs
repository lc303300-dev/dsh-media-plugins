import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultAdapters, runImageRouter } from '../src/shared/adapters.ts'

// The per-candidate time box is ONE number (90 s by default) covering submit,
// download and any download retry. This guard exists because the download used
// to restart a fresh full budget: a URL-returning route could spend the whole
// submit box and then up to `maxAttempts x timeout` more, so a single candidate
// outlived the box the batch dispatch deadline is built on.

/** Start a stub provider: /v1/images/generations answers with a hanging image url. */
async function stubProvider({ hangMs }) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/images/generations')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${server.address().port}/image.png` }] }))
      return
    }
    // never answer within the test window: force the download to time out
    setTimeout(() => {
      try {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      } catch {
        /* the client already gave up */
      }
    }, hangMs).unref?.()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

test('candidate box: a hanging image download cannot spend a fresh budget per attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-budget-'))
  const savedProxy = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY }
  delete process.env.HTTP_PROXY
  delete process.env.HTTPS_PROXY
  const server = await stubProvider({ hangMs: 30_000 })
  try {
    const port = server.address().port
    const boxMs = 3000
    const cfg = {
      comflyBaseURL: `http://127.0.0.1:${port}/v1`,
      comflyApiKeyEnv: 'K',
      dreaminaPath: 'missing-dreamina',
      proxyUrl: '',
      maxConcurrency: 4,
      providerTimeoutMs: boxMs,
      taskTimeoutMs: boxMs,
      outputDir: 'o',
      enabled: ['comfly-gpt-image-2-4k'],
      credentials: { K: 'test-key' },
    }
    const adapters = defaultAdapters(cfg)
    const started = Date.now()
    await assert.rejects(() =>
      runImageRouter({
        prompt: 'p',
        images: [],
        ratio: '1:1',
        config: cfg,
        workspaceRoot: dir,
        privateRoot: join(dir, 'private'),
        adapters,
        imageProvider: 'comfly-gpt-image-2-4k',
      }),
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed >= boxMs - 250, `must use its box (took ${elapsed} ms)`)
    assert.ok(
      elapsed < boxMs + 1200,
      `must stop at the candidate deadline, not restart the budget per download attempt (took ${elapsed} ms)`,
    )
  } finally {
    server.close()
    if (savedProxy.http !== undefined) process.env.HTTP_PROXY = savedProxy.http
    if (savedProxy.https !== undefined) process.env.HTTPS_PROXY = savedProxy.https
    rmSync(dir, { recursive: true, force: true })
  }
})
