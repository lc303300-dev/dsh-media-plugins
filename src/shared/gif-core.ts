/**
 * Video→GIF domain (Codex_Gif rebuild, all-JS): ffmpeg two-pass
 * palettegen/paletteuse with a staged quality search (width/FPS/dither),
 * a size budget, optional denoise/anti-moire/color tuning and optional
 * gifsicle lossy optimization. Pure computation + exec; no DSH imports.
 *
 * Contract (Codex_Gif convert-video-to-gif.ps1):
 * - default size budget 10 MB, quality-first staged downgrade;
 * - `strict` mode keeps trying below the minimum width when nothing fits;
 * - `quality` mode stops at the minimum width and returns the smallest hit;
 * - palettegen `stats_mode`, paletteuse `diff_mode` + dither configurable;
 * - optional `-t` duration cap for long inputs;
 * - optional gifsicle `-O3 --careful --lossy=N` post-optimization.
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

/** Extra stages tried only in `strict` mode after the default plan is exhausted. */
export const STRICT_EXTRA_STAGES: Array<{ width: number; fps: number }> = [
  { width: 320, fps: 4 },
  { width: 240, fps: 3 },
]

export type GifMode = 'quality' | 'strict'
export type DitherMode = 'bayer' | 'sierra2_4a' | 'floyd_steinberg' | 'none'
export type DenoiseLevel = 'off' | 'light' | 'medium'

export interface GifOptions {
  /** Fixed output width (single stage) when set. */
  width?: number
  /** Fixed fps (single stage) when set. */
  fps?: number
  maxSizeMB?: number
  /** 'quality' stops at minWidth; 'strict' keeps shrinking below it. */
  mode?: GifMode
  /** Lowest width the quality mode will try (default 360). */
  minWidth?: number
  dither?: DitherMode
  /** bayer_scale 0-5 (only when dither=bayer). */
  bayerScale?: number
  paletteStatsMode?: 'diff' | 'full' | 'single'
  /** paletteuse diff_mode (default rectangle). */
  diffMode?: 'rectangle' | 'none'
  /** Hard cap on palette colors (max_colors). */
  colorCount?: number
  /** Truncate the input to at most this many seconds. */
  maxDurationSec?: number
  denoise?: DenoiseLevel
  antiMoire?: boolean
  /** Optional gifsicle binary; when set with lossy >= 0, optimizes the hit. */
  gifsiclePath?: string
  /** gifsicle --lossy level 0-200 (requires gifsiclePath). */
  lossy?: number
  /** Custom stage plan (overrides the default ladder). */
  stages?: Array<{ width: number; fps: number }>
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
  optimized?: boolean
  stagesTried: string[]
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

function ditherExpression(dither: DitherMode, bayerScale: number): string {
  switch (dither) {
    case 'none':
      return 'none'
    case 'sierra2_4a':
      return 'sierra2_4a'
    case 'floyd_steinberg':
      return 'floyd_steinberg'
    default:
      return `bayer:bayer_scale=${bayerScale}`
  }
}

function denoiseExpression(level: DenoiseLevel): string | undefined {
  if (level === 'off') return undefined
  // hqdn3d=luma_sp:chroma_sp:luma_tmp:chroma_tmp
  return level === 'light' ? 'hqdn3d=1.5:1.5:4:4' : 'hqdn3d=3:3:6:6'
}

/** Build the stage plan honoring custom stages / fixed params / mode. */
export function stagePlan(options: GifOptions): Array<{ width: number; fps: number }> {
  if (options.stages && options.stages.length > 0) return options.stages
  if (options.width !== undefined || options.fps !== undefined) {
    return [{ width: options.width ?? 720, fps: options.fps ?? 10 }]
  }
  const plan = [...QUALITY_STAGES]
  if (options.mode === 'strict') plan.push(...STRICT_EXTRA_STAGES)
  return plan
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
  const stages = stagePlan(options)
  const statsMode = options.paletteStatsMode ?? 'diff'
  const diffMode = options.diffMode ?? 'rectangle'
  const bayerScale = Math.max(0, Math.min(5, options.bayerScale ?? 5))
  const dither = options.dither ?? 'bayer'
  const denoise = options.denoise ?? 'off'
  const attempts: string[] = []
  const kept: Array<{ path: string; size: number; width: number; fps: number }> = []
  const durationArg = options.maxDurationSec && options.maxDurationSec > 0 ? ['-t', String(options.maxDurationSec)] : []
  const scaleFlags = `flags=lanczos${options.antiMoire ? '+accurate_rnd' : ''}`
  const denoiseFilter = denoiseExpression(denoise)

  for (const stage of stages) {
    const width = stage.width
    const fps = stage.fps
    const palette = join(outDir, `palette-${width}-${fps}.png`)
    const gif = join(outDir, `out-${width}-${fps}.gif`)
    try {
      const pre = [denoiseFilter, `fps=${fps},scale=${width}:-1:${scaleFlags}`].filter(Boolean).join(',')
      const palettegen = `${pre},palettegen=stats_mode=${statsMode}${options.colorCount && options.colorCount > 0 ? `:max_colors=${options.colorCount}` : ''}`
      // pass 1: palette
      await runFfmpeg(ffmpeg, ['-y', ...durationArg, '-i', videoPath, '-vf', palettegen, palette], options.timeoutMs ?? 120000)
      // pass 2: paletteuse
      const ditherExpr = ditherExpression(dither, bayerScale)
      const paletteuse = `fps=${fps},scale=${width}:-1:${scaleFlags}[x];[x][1:v]paletteuse=dither=${ditherExpr}${diffMode === 'none' ? '' : `:diff_mode=${diffMode}`}`
      await runFfmpeg(ffmpeg, ['-y', ...durationArg, '-i', videoPath, '-i', palette, '-lavfi', paletteuse, gif], options.timeoutMs ?? 120000)
      let finalFile = gif
      let optimized = false
      // optional gifsicle post-optimization
      if (options.gifsiclePath && (options.lossy ?? -1) >= 0) {
        try {
          const optimizedFile = join(outDir, `opt-${width}-${fps}.gif`)
          await execFileAsync(options.gifsiclePath, ['-O3', '--careful', `--lossy=${options.lossy}`, '-o', optimizedFile, gif], { timeout: 120000, windowsHide: true })
          await unlink(gif).catch(() => undefined)
          finalFile = optimizedFile
          optimized = true
        } catch {
          /* gifsicle failed: keep the ffmpeg output */
        }
      }
      const size = (await stat(finalFile)).size
      attempts.push(`${width}px@${fps}fps=${Math.round(size / 1024)}KB${optimized ? '(opt)' : ''}`)
      await unlink(palette).catch(() => undefined)
      kept.push({ path: finalFile, size, width, fps })
      if (size <= maxBytes) {
        return { path: finalFile, sizeBytes: size, width, fps, attempts: attempts.length, withinBudget: true, optimized, stagesTried: attempts }
      }
      // over budget: keep it as a fallback candidate and continue downgrading
    } catch (error: any) {
      attempts.push(`${width}px@${fps}fps=error:${String(error?.message ?? error).slice(0, 80)}`)
    }
  }
  // no stage met the budget; return the smallest produced file if any
  if (kept.length > 0) {
    kept.sort((a, b) => a.size - b.size)
    const smallest = kept[0]
    return { path: smallest.path, sizeBytes: smallest.size, width: smallest.width, fps: smallest.fps, attempts: attempts.length, withinBudget: smallest.size <= maxBytes, stagesTried: attempts }
  }
  throw new Error(`video-to-gif failed at all stages: ${attempts.join(' | ')}`)
}
