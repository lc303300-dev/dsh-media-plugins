/**
 * Local image operations via sharp: EXIF orientation normalization,
 * proportional downscale to a max long edge (1920 px, JPEG q85 by default),
 * and provider-input staging. Originals are never overwritten; staged copies
 * go into the private runtime.
 *
 * @module dsh-media-plugins/shared/image-ops
 */

import sharp from 'sharp'
import { basename, extname, join } from 'node:path'
import { ensureDir } from './private-runtime.ts'

/** Global longest-edge cap for every image copy the pipeline produces. */
export const MAX_IMAGE_EDGE = 1920

/** JPEG quality for normalized copies (opaque images). */
export const JPEG_QUALITY = 85

/** PNG is kept only when the source actually carries alpha (JPEG has none). */
function encodeCopy(pipeline: sharp.Sharp, hasAlpha: boolean): sharp.Sharp {
  return hasAlpha
    ? pipeline.png()
    : pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
}

/** Extension matching {@link encodeCopy}. */
function copyExtension(hasAlpha: boolean): 'png' | 'jpg' {
  return hasAlpha ? 'png' : 'jpg'
}

/**
 * Normalize one local image for provider submission:
 * EXIF-orient (rotate), and if the longest edge exceeds `maxLongEdge`
 * (default 1920) scale proportionally so it is exactly `maxLongEdge`.
 * Opaque images are written as JPEG q85; alpha sources stay PNG.
 * Writes a new file under `outDir`; never mutates the source.
 */
export async function normalizeProviderImage(
  src: string,
  outDir: string,
  maxLongEdge = MAX_IMAGE_EDGE,
): Promise<{ path: string; width: number; height: number }> {
  await ensureDir(outDir)
  const pipeline = sharp(src, { failOn: 'none' }).rotate()
  const meta = await pipeline.metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  const longest = Math.max(width, height)
  let target = pipeline
  if (longest > maxLongEdge) {
    target = pipeline.resize({ width: maxLongEdge, height: maxLongEdge, fit: 'inside', withoutEnlargement: true })
  }
  const hasAlpha = meta.hasAlpha === true
  const base = basename(src, extname(src)).replace(/[^\w.-]+/g, '_').slice(0, 80)
  const dest = join(outDir, `${base}.${copyExtension(hasAlpha)}`)
  const info = await encodeCopy(target, hasAlpha).toFile(dest)
  return { path: dest, width: info.width, height: info.height }
}

/**
 * Create a preview whose longest edge is at most `maxEdge` (default 1920),
 * EXIF-oriented, JPEG q85 for opaque sources (PNG only when alpha is real),
 * stored under `outDir`. Used for vision checks and review pages; the original
 * is never inspected directly.
 */
export async function makePreview(
  src: string,
  outDir: string,
  maxEdge = MAX_IMAGE_EDGE,
): Promise<{ path: string; width: number; height: number }> {
  await ensureDir(outDir)
  const pipeline = sharp(src, { failOn: 'none' }).rotate()
  const meta = await pipeline.metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  const longest = Math.max(width, height)
  let target = pipeline
  if (longest > maxEdge) {
    target = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
  }
  const hasAlpha = meta.hasAlpha === true
  const base = basename(src, extname(src)).replace(/[^\w.-]+/g, '_').slice(0, 80)
  const dest = join(outDir, `${base}-preview.${copyExtension(hasAlpha)}`)
  const info = await encodeCopy(target, hasAlpha).toFile(dest)
  return { path: dest, width: info.width, height: info.height }
}

/** Read basic dimensions of an image without decoding pixels. */
export async function imageDimensions(src: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(src, { failOn: 'none' }).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}
