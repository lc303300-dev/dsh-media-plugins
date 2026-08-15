/**
 * Video→GIF domain (Codex_Gif rebuild, all-JS): ffmpeg two-pass
 * palettegen/paletteuse with a staged quality search (width/FPS/dither)
 * and a size budget. Pure computation + exec; no DSH imports.
 *
 * @module dsh-media-plugins/shared/gif-core
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/** Candidate (width, fps) stages, highest quality first. */
export const QUALITY_STAGES: Array<{ width: number; fps: number }> = [
  { width: 960, fps: 15 },
  { width: 720, fps: 12 },
  { width: 640, fps: 10 },
  { width: 480, fps: 8 },
  { width: 360, fps: 6 },
]

export interface GifOptions {
  width?: number
  fps?: number
  maxSizeMB?: number
  dither?: 'bayer' | 'floyd_steinberg' | 'none'
  ffmpegPath: string
  timeoutMs?: number
}

export interface GifResult {
  path: string
  sizeBytes: number
  width: number
  fps: number
  attempts: number
  withinBudget: boolean
}

/** Run ffmpeg; throws on non-zero exit with stderr. */
export async function runFfmpeg(ffmpegPath: string, args: string[], timeoutMs = 120000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(ffmpegPath, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch (error: any) {
    const detail = error?.stderr?.trim() || error?.message || 'ffmpeg error'
    throw new Error(String(detail).slice(0, 600))
  }
}

/** Resolve an ffmpeg binary: explicit path, FFMPEG_PATH env, PATH, common installs. */
export async function resolveFfmpeg(explicit?: string): Promise<string | undefined> {
  const candidates = [
    explicit,
    process.env.FFMPEG_PATH,
    'ffmpeg',
    'C:\\Program Files\\oopz\\ffmpeg.exe',
    'C:\\Program Files\\Topaz Labs LLC\\Topaz Video\\ffmpeg.exe',
    'C:\\Program Files\\Virtual Desktop Streamer\\ffmpeg.exe',
  ].filter((p): p is string => Boolean(p))
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      /* try next */
    }
  }
  return undefined
}

/** Convert a video to GIF with staged quality search under the size budget. */
export async function videoToGif(
  videoPath: string,
  outDir: string,
  options: GifOptions,
): Promise<GifResult> {
  await mkdir(outDir, { recursive: true })
  const maxSize = options.maxSizeMB ?? 10
  const maxBytes = maxSize * 1024 * 1024
  const ffmpeg = options.ffmpegPath
  const stages = options.width || options.fps
    ? [{ width: options.width ?? 720, fps: options.fps ?? 10 }]
    : QUALITY_STAGES
  const attempts: string[] = []

  for (const stage of stages) {
    const width = stage.width
    const fps = stage.fps
    const palette = join(outDir, `palette-${width}-${fps}.png`)
    const gif = join(outDir, `out-${width}-${fps}.gif`)
    try {
      // pass 1: palette
      await runFfmpeg(ffmpeg, [
        '-y', '-i', videoPath,
        '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=stats_mode=diff`,
        palette,
      ], options.timeoutMs ?? 120000)
      // pass 2: paletteuse
      const dither = options.dither ?? 'bayer'
      const ditherExpr = dither === 'none' ? 'none' : dither === 'floyd_steinberg' ? 'floyd_steinberg' : 'bayer:bayer_scale=5'
      await runFfmpeg(ffmpeg, [
        '-y', '-i', videoPath, '-i', palette,
        '-lavfi', `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=${ditherExpr}`,
        gif,
      ], options.timeoutMs ?? 120000)
      const size = (await stat(gif)).size
      attempts.push(`${width}px@${fps}fps=${Math.round(size / 1024)}KB`)
      await unlink(palette).catch(() => undefined)
      if (size <= maxBytes) {
        return { path: gif, sizeBytes: size, width, fps, attempts: attempts.length, withinBudget: true }
      }
      // keep the best attempt if we fall through
      await unlink(gif).catch(() => undefined)
    } catch (error: any) {
      attempts.push(`${width}px@${fps}fps=error:${String(error?.message ?? error).slice(0, 80)}`)
    }
  }
  // no stage met the budget; return the smallest produced file if any
  const files = (await readdir(outDir)).filter((f) => f.endsWith('.gif'))
  if (files.length > 0) {
    const sized: Array<{ path: string; size: number }> = []
    for (const f of files) {
      sized.push({ path: join(outDir, f), size: (await stat(join(outDir, f))).size })
    }
    sized.sort((a, b) => a.size - b.size)
    const smallest = sized[0]
    const m = smallest.path.match(/out-(\d+)-(\d+)\.gif/)
    return { path: smallest.path, sizeBytes: smallest.size, width: m ? Number(m[1]) : 0, fps: m ? Number(m[2]) : 0, attempts: attempts.length, withinBudget: smallest.size <= maxBytes }
  }
  throw new Error(`video-to-gif failed at all stages: ${attempts.join(' | ')}`)
}
