import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { normalizeProviderImage, makePreview } from '../src/shared/image-ops.ts'
import { sha256File } from '../src/shared/private-runtime.ts'

test('normalizeProviderImage: >1920px wide image is downscaled to 1920 long edge, original untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-io-'))
  try {
    const src = join(dir, 'wide.png')
    await sharp({ create: { width: 3000, height: 1000, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toFile(src)
    const beforeHash = await sha256File(src)
    const out = await normalizeProviderImage(src, join(dir, 'normalized'), 1920)
    const meta = await sharp(out.path).metadata()
    assert.equal(Math.max(meta.width ?? 0, meta.height ?? 0), 1920)
    assert.equal(meta.width, 1920) // 3000x1000 -> 1920x640
    assert.equal(meta.height, 640)
    assert.equal(await sha256File(src), beforeHash, 'original must not be modified')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('normalizeProviderImage: EXIF orientation 6 is applied (landscape source becomes portrait)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-exif-'))
  try {
    const src = join(dir, 'exif.png')
    // 1600x900 with EXIF orientation 6 (rotate 90 CW): displayed as 900x1600
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 30, g: 120, b: 200 } } })
      .withMetadata({ orientation: 6 })
      .png()
      .toFile(src)
    const beforeHash = await sha256File(src)
    const out = await normalizeProviderImage(src, join(dir, 'normalized'), 1920)
    const meta = await sharp(out.path).metadata()
    assert.ok(meta.height > meta.width, 'after auto-orient the image must be portrait')
    assert.equal(meta.width, 900)
    assert.equal(meta.height, 1600)
    assert.equal(await sha256File(src), beforeHash, 'original must not be modified')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('makePreview: longest edge capped at 1024 for a huge image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prev-'))
  try {
    const src = join(dir, 'big.png')
    await sharp({ create: { width: 4000, height: 2000, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(src)
    const prev = await makePreview(src, join(dir, 'previews'), 1024)
    const meta = await sharp(prev.path).metadata()
    assert.equal(Math.max(meta.width ?? 0, meta.height ?? 0), 1024)
    const raw = readFileSync(prev.path)
    assert.ok(raw.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
