/**
 * Model-facing `generate_video` tool: text-to-video and image-to-video via the
 * local Dreamina (Seedance) CLI. The CLI is an authenticated local client, not
 * an HTTP API: it submits an async task, polls `query_result`, downloads the
 * result into the session workspace, and returns the video path.
 * @module @deepseek-ai/dsh-tool-video-gen
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { mkdir, readdir, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

/** Bundle root：本 bundle 的产物直接落在包根目录（tool-video-gen.js），
 *  故 src/ 下源码转译后一层 dirname 即回到包根目录。 */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
/** Bundled Dreamina CLI binary under `<bundle>/bin/`. */
const BUNDLED_DREAMINA = join(PACKAGE_ROOT, 'bin', 'dreamina.exe')

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-video-gen'

/** Services required by the video tool (none beyond the registry). */
export const inject = ['tools']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Absolute path to the Dreamina CLI binary. */
  dreaminaPath?: string
  /** Default video model. */
  model?: string
  /** Default video resolution. */
  resolution?: string
  /** Output directory, resolved against the session workspace. */
  outputDir?: string
  /** Total poll budget in milliseconds while the async task finishes. */
  pollTimeoutMs?: number
  /** 测试线路：仅提交任务、不轮询结果，由用户到官方后台查看进度。 */
  submitOnly?: boolean
}

export const Config: z<Config> = z.object({
  dreaminaPath: z.string().default(BUNDLED_DREAMINA),
  model: z.string().default('seedance2.0_vip'),
  resolution: z.string().default('720p'),
  outputDir: z.string().default('outputs'),
  pollTimeoutMs: z.number().default(420000),
  submitOnly: z.boolean().default(false),
})

type ResolvedConfig = Required<Config>

/** Video file extensions the CLI may download. */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])

interface DreaminaTask {
  submit_id?: unknown
  gen_status?: unknown
  fail_reason?: unknown
}

/** Run the CLI and return its stdout; rejects with stderr on non-zero exit. */
async function runDreamina(binary: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    const detail = err.stderr?.trim() || err.stdout?.trim() || err.message || 'unknown CLI error'
    throw new Error(detail)
  }
}

/** Parse the CLI's JSON output, tolerating leading non-JSON noise. */
function parseJson<T>(stdout: string): T | undefined {
  const text = stdout.trim()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    const start = text.indexOf('{')
    if (start < 0) return undefined
    try {
      return JSON.parse(text.slice(start)) as T
    } catch {
      return undefined
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** List the newest video file inside a directory, or undefined. */
async function newestVideo(dir: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return undefined
  }
  const videos = entries
    .filter(name => VIDEO_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase()))
    .map(name => join(dir, name))
  if (videos.length === 0) return undefined
  // The CLI names downloads deterministically; pick the longest name as a
  // stable heuristic for the freshest result when multiple exist.
  videos.sort((a, b) => b.length - a.length)
  return videos[0]
}

/** Register the `generate_video` tool. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig

  ctx.tools.register(defineTool({
    name: 'generate_video',
    description: '用即梦 Dreamina（Seedance）本地 CLI 生成视频：文生视频传 prompt；图生视频再传 image（单张首帧图）。任务异步，工具会轮询直到完成并下载到 workspace/outputs，返回视频绝对路径；超时则返回 submit_id 供稍后查询。生成会消耗积分。',
    parameters: {
      prompt: { type: 'string', required: true, description: '视频提示词，UTF-8，不能为空。' },
      image: { type: 'string', description: '可选：图生视频的首帧图路径（PNG/JPEG）。传了则走 image2video。' },
      duration: { type: 'integer', description: '视频时长（秒），默认 5；seedance2.0 系列 4-15 秒。' },
      ratio: { type: 'string', description: '画面比例，如 16:9、9:16、1:1；仅文生视频用，默认 16:9。' },
      video_resolution: { type: 'string', description: '分辨率，如 720p/1080p/4k；默认 720p。' },
      model_version: { type: 'string', description: '视频模型，默认 seedance2.0_vip；可选 seedance2.0/2.0fast/2.0_vip/2.0fast_vip/2.0mini/2.5。' },
      output: { type: 'string', description: '可选输出路径（绝对路径，或相对会话工作目录的路径）。指定后产出视频会被重命名到该路径并可点击打开；省略则用 CLI 生成的文件名。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          submit_id: { type: 'string' },
          done: { type: 'boolean', required: true },
        },
      },
      render(_args, value) {
        if (value.done && value.path !== undefined) {
          return [{ type: 'text', text: `generated video: ${value.path}` }]
        }
        return [{ type: 'text', text: `video task submitted; submit_id=${value.submit_id ?? 'unknown'}. Check progress in the Dreamina dashboard.` }]
      },
    },
    // Long async task: never run concurrently with sibling calls.
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')

      const model = args.model_version ?? resolved.model
      const resolution = args.video_resolution ?? resolved.resolution
      const duration = args.duration ?? 5
      const ratio = args.ratio ?? '16:9'
      const image = args.image?.trim()

      const workspaceRoot = exec.agent?.session.header.cwd ?? process.cwd()
      const outDir = join(workspaceRoot, resolved.outputDir)

      const submitArgs = image !== undefined && image.length > 0
        ? ['image2video', `--image=${image}`, `--prompt=${prompt}`, `--model_version=${model}`, `--video_resolution=${resolution}`, `--duration=${duration}`, '--poll=0']
        : ['text2video', `--prompt=${prompt}`, `--model_version=${model}`, `--video_resolution=${resolution}`, `--duration=${duration}`, `--ratio=${ratio}`, '--poll=0']

      const submitOut = await runDreamina(resolved.dreaminaPath, submitArgs, 240000)
      const submitted = parseJson<DreaminaTask>(submitOut)
      if (submitted === undefined || typeof submitted.submit_id !== 'string' || submitted.submit_id.length === 0) {
        throw new Error(`dreamina submit returned no submit_id: ${submitOut.trim().slice(0, 300)}`)
      }
      const submitId = submitted.submit_id
      if (submitted.gen_status === 'fail') {
        throw new Error(`dreamina task failed: ${String(submitted.fail_reason ?? 'unknown reason')}`)
      }

      // 测试线路：仅提交，不轮询，由用户到官方后台查看进度。
      if (resolved.submitOnly) {
        return { submit_id: submitId, done: false }
      }

      // Poll query_result until the CLI downloads a video or the budget expires.
      const deadline = Date.now() + resolved.pollTimeoutMs
      while (Date.now() < deadline) {
        if (exec.signal.aborted) throw new Error('generate_video aborted')
        const queryOut = await runDreamina(
          resolved.dreaminaPath,
          ['query_result', `--submit_id=${submitId}`, `--download_dir=${outDir}`],
          90000,
        )
        const queried = parseJson<DreaminaTask>(queryOut)
        if (queried?.gen_status === 'fail') {
          throw new Error(`dreamina task failed: ${String(queried.fail_reason ?? 'unknown reason')}`)
        }
        if (queried?.gen_status === 'success') {
          const video = await newestVideo(outDir)
          if (video !== undefined) {
            const requested = args.output?.trim()
            let finalPath = video
            if (requested !== undefined && requested.length > 0) {
              finalPath = isAbsolute(requested) ? requested : join(workspaceRoot, requested)
              await mkdir(dirname(finalPath), { recursive: true })
              await rename(video, finalPath)
            }
            return { path: finalPath, submit_id: submitId, done: true }
          }
        }
        await sleep(5000)
      }

      return { submit_id: submitId, done: false }
    },
    presentCall(args): GenericCallView | undefined {
      const requested = args.output?.trim()
      if (requested === undefined || requested.length === 0) return undefined
      return {
        card: 'generic',
        kind: 'edit',
        title: `生成视频 ${requested}`,
        locations: [{ path: requested }],
      }
    },
  }))
}
