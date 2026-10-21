/**
 * Image-copy policy: every preview / provider copy is capped at 1920 px and
 * written as JPEG q85; PNG is kept only when the source actually has alpha.
 * Locked here because this policy is shared by image_preview, prompt_batch,
 * creative_writer (vision) and the video/image provider staging paths.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { MAX_IMAGE_EDGE, makePreview, normalizeProviderImage } from '../src/shared/image-ops.ts'

async function makeSource(dir, width, height, alpha = false) {
  const src = join(dir, alpha ? 'source-alpha.png' : 'source.png')
  const background = alpha
    ? { r: 20, g: 40, b: 60, alpha: 0.5 }
    : { r: 20, g: 40, b: 60 }
  await sharp({
    create: { width, height, channels: alpha ? 4 : 3, background },
  }).png().toFile(src)
  return src
}

test('preview and provider copies are 1920 px JPEG', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-image-policy-'))
  try {
    const src = await makeSource(dir, 2048, 1152)
    const preview = await makePreview(src, join(dir, 'preview'))
    assert.equal(MAX_IMAGE_EDGE, 1920)
    assert.equal(preview.width, 1920)
    assert.equal(preview.height, 1080)
    assert.match(preview.path, /\.jpg$/)

    const provider = await normalizeProviderImage(src, join(dir, 'provider'))
    assert.equal(provider.width, 1920)
    assert.equal(provider.height, 1080)
    assert.match(provider.path, /\.jpg$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('alpha sources stay PNG (JPEG cannot carry alpha)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-image-alpha-'))
  try {
    const src = await makeSource(dir, 480, 320, true)
    const preview = await makePreview(src, join(dir, 'preview'))
    assert.match(preview.path, /\.png$/)
    const provider = await normalizeProviderImage(src, join(dir, 'provider'))
    assert.match(provider.path, /\.png$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
