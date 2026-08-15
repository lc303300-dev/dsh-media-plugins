/**
 * Local image operations via sharp: EXIF orientation normalization,
 * proportional downscale to a max long edge (1920 px provider inputs,
 * 1024 px previews), and provider-input staging. Originals are never
 * overwritten; staged copies go into the private runtime.
 *
 * @module dsh-media-plugins/shared/image-ops
 */

import sharp from 'sharp'
import { basename, extname, join } from 'node:path'
import { ensureDir } from './private-runtime.ts'

/** Map sharp format names to safe file extensions. */
function formatToExt(format: string | undefined): string {
  switch (format) {
    case 'jpeg':
    case 'jpg':
      return 'jpg'
    case 'webp':
      return 'webp'
    case 'gif':
      return 'gif'
    case 'tiff':
      return 'tiff'
    case 'png':
    default:
      return 'png'
  }
}

/**
 * Normalize one local image for provider submission:
 * EXIF-orient (rotate), and if the longest edge exceeds `maxLongEdge`
 * (default 1920) scale proportionally so it is exactly `maxLongEdge`.
 * Writes a new file under `outDir`; never mutates the source.
 */
export async function normalizeProviderImage(
  src: string,
  outDir: string,
  maxLongEdge = 1920,
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
  const ext = formatToExt(meta.format)
  const base = basename(src, extname(src)).replace(/[^\w.-]+/g, '_').slice(0, 80)
  const dest = join(outDir, `${base}.${ext}`)
  const info = await target.toFile(dest)
  return { path: dest, width: info.width, height: info.height }
}

/**
 * Create a preview whose longest edge is at most `maxEdge` (default 1024),
 * EXIF-oriented, stored under `outDir`. Used for vision checks and review
 * pages; the original is never inspected directly.
 */
export async function makePreview(
  src: string,
  outDir: string,
  maxEdge = 1024,
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
  const ext = formatToExt(meta.format)
  const base = basename(src, extname(src)).replace(/[^\w.-]+/g, '_').slice(0, 80)
  const dest = join(outDir, `${base}-preview.${ext}`)
  const info = await target.toFile(dest)
  return { path: dest, width: info.width, height: info.height }
}

/** Read basic dimensions of an image without decoding pixels. */
export async function imageDimensions(src: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(src, { failOn: 'none' }).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}
