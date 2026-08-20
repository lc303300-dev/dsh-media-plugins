/**
 * Model-facing `generate_video` tool: text-to-video and all-around
 * reference mode (multimodal2video) through the Dreamina/Seedance CLI.
 *
 * Contract (Codex_image AGENTS.md):
 * - default model `seedance2.5`, default resolution `480p`;
 * - `video_execution_mode`: production (submit + poll + download),
 *   production_submit_only (submit, return submit_id, no auto query),
 *   test_submit_only (forces non-VIP seedance2.0 + 720p + poll=0, returns
 *   submit_id only and never queries/downloads; user checks the dashboard);
 * - explicit user 2.0/2.0fast/2.0mini (non-VIP, non-test) normalizes to
 *   seedance2.0_vip; multiframe2video is disabled legacy — never submitted;
 * - every real submit records task state under the private runtime and
 *   refuses to re-submit the same task id.
 *
 * @module @deepseek-ai/dsh-tool-video-gen
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { access, mkdir, readdir, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { mediaErrors } from './shared/failure.ts'
import {
  TaskStore,
  appendSafeLog,
  newTaskId,
  redactPrompt,
  resolvePrivateRoot,
} from './shared/private-runtime.ts'

const execFileAsync = promisify(execFile)

/** Bundle root: the built tool file lives at the package root. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-video-gen'

/** Services required by the video tool. */
export const inject = ['tools']

import {
  VIDEO_EXECUTION_MODES,
  resolveVideoModel,
  resolveVideoResolution,
  normalizeModel,
  limitsFor,
  selectVideoSubcommand,
  type VideoExecutionMode,
} from './shared/video-policy.ts'

export { VIDEO_EXECUTION_MODES }
export type { VideoExecutionMode }/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  dreaminaPath?: string
  model?: string
  resolution?: string
  outputDir?: string
  privateDir?: string
  pollTimeoutMs?: number
  executionMode?: VideoExecutionMode
  /** Run `<subcommand> -h` before every real submit (contract). */
  runHelpBeforeSubmit?: boolean
}

export const Config: z<Config> = z.object({
  dreaminaPath: z.string().default(join(PACKAGE_ROOT, 'bin', 'dreamina.exe')),
  model: z.string().default('seedance2.5'),
  resolution: z.string().default('480p'),
  outputDir: z.string().default('outputs'),
  privateDir: z.string().default(''),
  pollTimeoutMs: z.number().default(420000),
  executionMode: z.union([...VIDEO_EXECUTION_MODES]).default('production'),
  runHelpBeforeSubmit: z.boolean().default(true),
})

type ResolvedConfig = Required<Config>

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const REF_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])

/** Validate reference files: extension allowlist + existence. */
async function validateRefFiles(kind: 'image' | 'video' | 'audio', paths: string[]): Promise<void> {
  const accepted = kind === 'image' ? IMAGE_EXTENSIONS : kind === 'video' ? REF_VIDEO_EXTENSIONS : AUDIO_EXTENSIONS
  const label = kind === 'image' ? '图片' : kind === 'video' ? '参考视频' : '参考音频'
  for (const p of paths) {
    const lower = p.toLowerCase()
    if (!accepted.has(lower.slice(lower.lastIndexOf('.')))) {
      throw mediaErrors.input(`不支持的${label}文件类型：${p}`)
    }
    try {
      await access(p)
    } catch {
      throw mediaErrors.input(`${label}文件不存在或不可读：${p}`)
    }
  }
}

async function runDreamina(binary: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch (error: any) {
    const detail = error?.stderr?.trim() || error?.stdout?.trim() || error?.message || 'unknown CLI error'
    throw new Error(String(detail).slice(0, 800))
  }
}

function parseJson(stdout: string): any {
  const text = stdout.trim()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    if (start < 0) return undefined
    try {
      return JSON.parse(text.slice(start))
    } catch {
      return undefined
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function newestVideo(dir: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return undefined
  }
  const videos = entries
    .filter((n) => VIDEO_EXTENSIONS.has(n.slice(n.lastIndexOf('.')).toLowerCase()))
    .map((n) => join(dir, n))
  if (videos.length === 0) return undefined
  videos.sort((a, b) => b.length - a.length)
  return videos[0]
}

/** Normalize a video duration value: integer seconds, optional s/秒 suffix (upstream normalize_video_duration). */
function normalizeVideoDuration(value: unknown): number {
  if (value === undefined || value === null) return 5
  if (typeof value === 'boolean') {
    throw mediaErrors.input('duration must be an integer number of seconds')
  }
  const text = String(value).trim()
  const match = /^(\d{1,2})\s*(?:s(?:ec(?:onds?)?)?|秒)?$/i.exec(text)
  if (!match) {
    throw mediaErrors.input('duration must be an integer number of seconds, optionally followed by s or 秒')
  }
  return Number(match[1])
}

/** Dated session-group name: YYYY_MM_DD-<base> (upstream dated_video_group contract: base 1-20 chars, one line). */
function datedVideoGroup(name: string): string {
  const base = name.trim()
  if (base.length === 0 || base.length > 20 || /[\r\n]/.test(base)) {
    throw mediaErrors.input('video_group base name must contain 1-20 characters on one line')
  }
  const now = new Date()
  const ymd = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}_${String(now.getDate()).padStart(2, '0')}`
  return `${ymd}-${base}`
}

/**
 * Extract the exact session id from `session list`/`session search` table
 * output. Mirrors the upstream regex: `session list` includes a PINNED column
 * while `session search` omits it, and names may contain spaces, so the
 * trailing timestamp anchors each row.
 */
function parseSessionId(text: string, exactName: string): number | undefined {
  const pattern = /^\s*(\d+)\s+(.+?)\s+(?:(?:Yes|No)\s+)?\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\s*$/gm
  for (const match of text.matchAll(pattern)) {
    if (match[2].trim() === exactName) return Number(match[1])
  }
  return undefined
}

/** Resolve (reuse) or create the Dreamina session for a group; returns its id. */
async function resolveDreaminaSession(binary: string, groupName: string): Promise<number> {
  let text: string
  try {
    text = await runDreamina(binary, ['session', 'search', groupName], 30000)
  } catch {
    // no sessions found matching (or CLI search failed): proceed to create
    text = ''
  }
  let id = parseSessionId(text, groupName)
  if (id === undefined) {
    await runDreamina(binary, ['session', 'create', groupName], 30000)
    text = await runDreamina(binary, ['session', 'search', groupName], 30000)
    id = parseSessionId(text, groupName)
  }
  if (id === undefined) {
    throw mediaErrors.provider('Dreamina session was created but could not be resolved')
  }
  return id
}

/** Register the `generate_video` tool. */
function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_video',
      description:
        '用即梦 Dreamina（Seedance）本地 CLI 生成视频：默认走全能参考模式 multimodal2video（传任意 image/images/videos/audios 参考即启用，支持多图、参考视频与音频）；只传 prompt 时走 text2video。默认模型 seedance2.5、默认 480p；仅当前用户明确选择时才使用 seedance2.0 系列（普通 2.0 归一化为 seedance2.0_vip）。video_execution_mode：production（提交并轮询下载）、production_submit_only（仅提交返回 submit_id，不自动查询）、test_submit_only（强制非 VIP seedance2.0 + 720p，只返回 submit_id，请到即梦网站后台查看，绝不自动查询下载）。video_count 1-10 可批量并行提交（仅提交不自动轮询下载），聚合状态为 submitted/partial；video_group 指定会话分组名（自动加 YYYY_MM_DD- 日期前缀并复用/创建即梦会话，同组任务共享会话，test_submit_only 必须提供）。任务状态持久化在私有运行目录，同一任务绝不重复提交。',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: '视频提示词，UTF-8，不能为空。全能参考模式下建议用中文裸标签引用素材（如 图片1、视频1、音频1），标签序号对应该类素材的传入顺序。',
        },
        image: {
          type: 'string',
          description: '可选：单张参考图路径（PNG/JPEG/WebP）。旧参数，与 images 等价；传了任意参考即走全能参考模式。',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：本地图片参考路径列表（PNG/JPEG/WebP），可多张。seedance2.5 总参考输入（图+视频+音频）≤ 50；其余模型最多 9 张。',
        },
        videos: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：本地参考视频路径列表（mp4/mov/webm/mkv/avi/m4v）。seedance2.5 单个/总时长 2-30 秒（计入 50 个总参考上限）；其余模型最多 3 个且 2-15 秒。',
        },
        audios: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：本地参考音频路径列表（mp3/wav/m4a/aac/flac/ogg）。seedance2.5 允许纯音频参考、2-30 秒（计入 50 个总参考上限）；其余模型最多 3 个且 2-15 秒，且必须同时有至少一个图片或视频参考。',
        },
        duration: {
          type: 'integer',
          description: '视频时长（秒），默认 5；seedance2.5 为 4-30，其余模型为 4-15。',
        },
        ratio: {
          type: 'string',
          description: '画面比例，如 16:9、9:16、1:1、4:3、3:4、21:9；默认 16:9。',
        },
        video_resolution: {
          type: 'string',
          description: '分辨率：seedance2.5 支持 480p/720p/1080p；seedance2.0_vip 支持 480p/720p/1080p/4k；其余模型仅 720p。默认 480p（test 模式固定 720p）。',
        },
        model_version: {
          type: 'string',
          description: '视频模型，默认 seedance2.5；可选 2.5 / 2.0 / 2.0fast / 2.0_vip / 2.0fast_vip / 2.0mini（自动补全 seedance 前缀）。普通请求显式选 2.0 系列会归一化为 seedance2.0_vip。',
        },
        video_execution_mode: {
          type: 'string',
          enum: [...VIDEO_EXECUTION_MODES],
          description: '执行模式：production（默认，提交+轮询+下载）、production_submit_only（仅提交）、test_submit_only（测试通道，强制非 VIP 2.0/720p，仅返回 submit_id）。',
        },
        video_count: {
          type: 'integer',
          description: '可选：批量并行提交个数（1-10，默认 1）。>1 时仅提交不自动轮询下载，返回聚合状态 submitted/partial 与各 submit_id；test_submit_only 仅允许 1。',
        },
        video_group: {
          type: 'string',
          description: '可选：会话分组名（1-20 字符单行），自动加 YYYY_MM_DD- 日期前缀，复用或创建即梦会话（同一分组的任务共享会话）；test_submit_only 必须提供。',
        },
        output: {
          type: 'string',
          description: '可选输出路径（绝对路径，或相对会话工作目录的路径）。指定后产出视频会被重命名到该路径并可点击打开；省略则用 CLI 生成的文件名。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            submit_id: { type: 'string' },
            done: { type: 'boolean', required: true },
            execution_mode: { type: 'string' },
            model: { type: 'string' },
            status: { type: 'string' },
            count: { type: 'number' },
            video_group: { type: 'string' },
            video_session_id: { type: 'number' },
            results: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        render(_args: unknown, value: any) {
          if (Array.isArray(value.results)) {
            const ok = value.results.filter((r: any) => r.status === 'submitted').length
            const group = value.video_group !== undefined ? `, group=${value.video_group}` : ''
            return [{ type: 'text', text: `video batch: ${ok}/${value.count ?? value.results.length} submitted (${value.status})${group}` }]
          }
          if (value.done && value.path !== undefined) {
            return [{ type: 'text', text: `generated video: ${value.path}` }]
          }
          return [{ type: 'text', text: `video task submitted; submit_id=${value.submit_id ?? 'unknown'} (${value.execution_mode ?? 'production'}). Check progress in the Dreamina dashboard.` }]
        },
      },
      async execute(args: any, exec: any) {
        const prompt = String(args.prompt ?? '').trim()
        if (prompt.length === 0) throw mediaErrors.input('prompt must be a non-empty string')
        const mode: VideoExecutionMode = args.video_execution_mode ?? config.executionMode
        if (!VIDEO_EXECUTION_MODES.includes(mode)) throw mediaErrors.input(`unsupported video_execution_mode: ${mode}`)

        // model policy
        const userModel = normalizeModel(args.model_version ?? config.model)
        const model = resolveVideoModel(mode, userModel)
        const resolution = resolveVideoResolution(mode, args.video_resolution, config.resolution)
        const duration = normalizeVideoDuration(args.duration)
        const ratio = String(args.ratio ?? '16:9')

        const images: string[] = []
        if (typeof args.image === 'string' && args.image.trim().length > 0) images.push(args.image.trim())
        for (const p of args.images ?? []) if (typeof p === 'string' && p.trim().length > 0) images.push(p.trim())
        const videos: string[] = (args.videos ?? []).filter((p: unknown) => typeof p === 'string' && p.trim().length > 0)
        const audios: string[] = (args.audios ?? []).filter((p: unknown) => typeof p === 'string' && p.trim().length > 0)
        const totalRefs = images.length + videos.length + audios.length

        const limits = limitsFor(model)
        if (totalRefs > 0) {
          await validateRefFiles('image', images)
          await validateRefFiles('video', videos)
          await validateRefFiles('audio', audios)
          if (images.length === 0 && videos.length === 0 && audios.length > 0 && !limits.audioOnlyAllowed) {
            throw mediaErrors.input(`纯音频参考仅支持 seedance2.5 全能参考模式（当前模型 ${model}）。请指定 model_version=2.5，或补充图片/视频参考。`)
          }
          if (limits.total !== undefined && totalRefs > limits.total) {
            throw mediaErrors.input(`全能参考模式（${model}）参考输入总计最多 ${limits.total} 个，当前 ${totalRefs} 个。`)
          }
        }
        if (!Number.isFinite(duration) || duration < limits.durationMin || duration > limits.durationMax) {
          throw mediaErrors.input(`（${model}）时长必须在 ${limits.durationMin}-${limits.durationMax} 秒之间，当前 ${duration} 秒。`)
        }
        if (!limits.resolutions.includes(resolution)) {
          throw mediaErrors.input(`（${model}）不支持分辨率 ${resolution}，可选：${limits.resolutions.join(' / ')}。`)
        }
        if (!limits.ratios.includes(ratio)) {
          throw mediaErrors.input(`（${model}）不支持比例 ${ratio}，可选：${limits.ratios.join(' / ')}。`)
        }

        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)
        const taskId = newTaskId()
        const store = new TaskStore(join(privateRoot, 'jobs'))

        // ---- batch & session policy (aligned with upstream video_router) ----
        const count = args.video_count === undefined ? 1 : Number(args.video_count)
        if (!Number.isInteger(count) || count < 1 || count > 10) {
          throw mediaErrors.input('video_count must be an integer between 1 and 10')
        }
        if (mode === 'test_submit_only' && count !== 1) {
          throw mediaErrors.input('test_submit_only supports exactly one task')
        }
        let sessionId: number | undefined
        let resolvedGroupName: string | undefined
        if (args.video_group !== undefined && String(args.video_group).trim().length > 0) {
          resolvedGroupName = datedVideoGroup(String(args.video_group))
          sessionId = await resolveDreaminaSession(config.dreaminaPath, resolvedGroupName)
        } else if (mode === 'test_submit_only') {
          throw mediaErrors.input('test_submit_only requires video_group to verify session routing')
        }
        const sessionArgs = sessionId === undefined ? [] : [`--session=${sessionId}`]
        const groupFields = resolvedGroupName === undefined ? {} : { video_group: resolvedGroupName, video_session_id: sessionId }

        const buildSubmitArgs = () => totalRefs > 0
          ? ['multimodal2video', ...images.map((p) => `--image=${p}`), ...videos.map((p) => `--video=${p}`), ...audios.map((p) => `--audio=${p}`), `--prompt=${prompt}`, `--model_version=${model}`, `--video_resolution=${resolution}`, `--duration=${duration}`, `--ratio=${ratio}`, ...sessionArgs, '--poll=0']
          : ['text2video', `--prompt=${prompt}`, `--model_version=${model}`, `--video_resolution=${resolution}`, `--duration=${duration}`, `--ratio=${ratio}`, ...sessionArgs, '--poll=0']

        if (count > 1) {
          // batch: submit-only, never poll or download here (production_batch contract)
          const items = await Promise.allSettled(
            Array.from({ length: count }, async () => {
              const itemTaskId = newTaskId()
              await store.create('video', itemTaskId, 'video', {
                prompt: redactPrompt(prompt),
                mode,
                model,
                resolution,
                duration,
                ratio,
                images: images.map((p) => p),
                videos: videos.map((p) => p),
                audios: audios.map((p) => p),
                batch: true,
              })
              await store.transition('video', itemTaskId, 'running', { model, provider: 'dreamina' })
              const submitOut = await runDreamina(config.dreaminaPath, buildSubmitArgs(), 240000)
              const parsed = parseJson(submitOut)
              if (parsed === undefined || typeof parsed.submit_id !== 'string' || parsed.submit_id.length === 0) {
                throw mediaErrors.provider(`dreamina submit returned no submit_id: ${String(submitOut).slice(0, 300)}`)
              }
              if (parsed.gen_status === 'fail') {
                throw mediaErrors.provider(`dreamina task failed: ${String(parsed.fail_reason ?? 'unknown reason')}`)
              }
              return { itemTaskId, submitId: parsed.submit_id }
            }),
          )
          const results: Array<Record<string, unknown>> = items.map((item, index) => {
            if (item.status === 'fulfilled') {
              const { itemTaskId, submitId } = item.value
              void store.saveResult('video', itemTaskId, { status: 'submitted', submitId, model, mode })
              void store.transition('video', itemTaskId, 'success', { submitId, nextAction: 'query_later' })
              return { index: index + 1, submit_id: submitId, status: 'submitted', model, execution_mode: mode }
            }
            return { index: index + 1, status: 'failed', error: String(item.reason?.message ?? item.reason).slice(0, 300), model, execution_mode: mode }
          })
          const statuses = new Set(results.map((r) => r.status))
          const aggregate = statuses.size === 1 && statuses.has('submitted') ? 'submitted' : 'partial'
          const batchResult: Record<string, unknown> = { status: aggregate, count, results, done: false, execution_mode: mode, model }
          if (resolvedGroupName !== undefined) {
            batchResult.video_group = resolvedGroupName
            batchResult.video_session_id = sessionId
          }
          await appendSafeLog(privateRoot, 'generate_video', { taskId, event: 'batch_submitted', count, group: resolvedGroupName, status: aggregate })
          return batchResult
        }

        const request = {
          prompt: redactPrompt(prompt),
          mode,
          model,
          resolution,
          duration,
          ratio,
          images: images.map((p) => p),
          videos: videos.map((p) => p),
          audios: audios.map((p) => p),
        }
        await store.create('video', taskId, 'video', request)
        await store.transition('video', taskId, 'running', { model, provider: 'dreamina' })

        const outDir = join(workspaceRoot, config.outputDir)
        try {
          // contract: verify the chosen subcommand exists before any real submit
          const subcommand = selectVideoSubcommand(totalRefs)
          if (config.runHelpBeforeSubmit) {
            try {
              await runDreamina(config.dreaminaPath, [subcommand, '-h'], 15000)
            } catch (error: any) {
              await appendSafeLog(privateRoot, 'generate_video', { taskId, event: 'help_check_failed', detail: String(error?.message ?? error).slice(0, 200) })
            }
          }

          const submitArgs = buildSubmitArgs()

          const submitOut = await runDreamina(config.dreaminaPath, submitArgs, 240000)
          const submitted = parseJson(submitOut)
          if (submitted === undefined || typeof submitted.submit_id !== 'string' || submitted.submit_id.length === 0) {
            throw mediaErrors.provider(`dreamina submit returned no submit_id: ${String(submitOut).slice(0, 300)}`)
          }
          const submitId = submitted.submit_id
          if (submitted.gen_status === 'fail') {
            throw mediaErrors.provider(`dreamina task failed: ${String(submitted.fail_reason ?? 'unknown reason')}`)
          }

          await store.saveResult('video', taskId, { status: 'submitted', submitId, model, mode })
          await store.transition('video', taskId, 'running', { submitId, provider: 'dreamina', model, nextAction: mode === 'production' ? 'none' : 'query_later' })
          await appendSafeLog(privateRoot, 'generate_video', { taskId, event: 'submitted', submitId, model, mode })

          // submit-only modes never poll or download
          if (mode !== 'production') {
            if (mode === 'test_submit_only') {
              await store.transition('video', taskId, 'success', { submitId, outputPath: undefined, nextAction: 'user_check_backend' })
              return { submit_id: submitId, done: false, execution_mode: mode, model, ...groupFields }
            }
            await store.transition('video', taskId, 'success', { submitId, nextAction: 'query_later' })
            return { submit_id: submitId, done: false, execution_mode: mode, model, ...groupFields }
          }

          // production: poll until terminal or deadline
          const deadline = Date.now() + config.pollTimeoutMs
          while (Date.now() < deadline) {
            if (exec.signal?.aborted) {
              await store.transition('video', taskId, 'cancelled', { nextAction: 'query_later' })
              throw mediaErrors.cancelled('generate_video aborted')
            }
            const queried = parseJson(await runDreamina(config.dreaminaPath, ['query_result', `--submit_id=${submitId}`, `--download_dir=${outDir}`], 90000))
            if (queried?.gen_status === 'fail') {
              await store.transition('video', taskId, 'failed', { failureMessage: String(queried.fail_reason ?? 'unknown') })
              throw mediaErrors.provider(`dreamina task failed: ${String(queried.fail_reason ?? 'unknown reason')}`)
            }
            if (queried?.gen_status === 'success') {
              const video = await newestVideo(outDir)
              if (video !== undefined) {
                let finalPath = video
                const requested = args.output?.trim()
                if (requested !== undefined && requested.length > 0) {
                  finalPath = isAbsolute(requested) ? requested : join(workspaceRoot, requested)
                  await mkdir(dirname(finalPath), { recursive: true })
                  await rename(video, finalPath)
                }
                await store.saveResult('video', taskId, { status: 'success', submitId, outputPath: finalPath, model })
                await store.transition('video', taskId, 'success', { submitId, outputPath: finalPath, model })
                return { path: finalPath, submit_id: submitId, done: true, execution_mode: mode, model, ...groupFields }
              }
            }
            await sleep(5000)
          }
          await store.transition('video', taskId, 'needs_review', { nextAction: 'query_later', submitId })
          return { submit_id: submitId, done: false, execution_mode: mode, model, ...groupFields }
        } catch (error: any) {
          if (error?.cls === 'cancelled') throw error
          await store.saveResult('video', taskId, { status: 'failed', message: String(error?.message ?? error) })
          await store.transition('video', taskId, 'failed', { failureMessage: String(error?.message ?? error) })
          await appendSafeLog(privateRoot, 'generate_video', { taskId, event: 'failed', detail: String(error?.message ?? error).slice(0, 300) })
          throw error
        }
      },
      presentCall(args: any) {
        const requested = args?.output?.trim()
        if (requested === undefined || requested.length === 0) return undefined
        return {
          card: 'generic',
          kind: 'edit',
          title: `生成视频 ${requested}`,
          locations: [{ path: requested }],
        } as GenericCallView
      },
    }),
  )
}

export { apply }
