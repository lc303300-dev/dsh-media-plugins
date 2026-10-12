/**
 * Model-facing `generate_video` tool — 即梦画布 CLI（dreamina-canvas）版。
 *
 * 与旧 `seedance-cli` 版的根本差别：不再是「一次性命令行 + query_result 下载」，
 * 而是画布上的**节点式**生成，付费链路是显式的四段：
 *
 *   resource upload → node create（保存）→ node quote（报价）
 *     → node confirm（取凭证）→ node run（提交）→ operation wait → resource download
 *
 * 契约要点（2026-10 实测 1.0.2 / 09e50ac）：
 * - 公开视频模式只有 `t2v` / `first_last_frame` / `m2v`，**没有 i2v**：
 *   无参考 → t2v；单图（锁首帧比例）或两张有序图片 → first_last_frame；
 *   单图但保留调用方比例、或图片/视频/音频混合参考 → m2v；
 * - 多产物**分节点**（每节点 `--count 1`），不再用单节点多输出承载多候选；
 * - 报价 ≠ 授权：每个任务先 `node quote`，再以用户 `video_credit_ceiling`
 *   （或报价本身）作为 `--credit-ceiling` 批准，最后才 `node run`；
 * - 同一任务绝不换新的 submit-id 重放（付费不可回滚）；等待超时只表示本地等待
 *   结束，服务端任务仍在继续，因此标记 `needs_review` 并保留身份；
 * - `video_execution_mode`：production（提交+等待+下载）、production_submit_only
 *   （只提交）、test_submit_only（强制最低成本模型 + 720p，只提交不轮询）。
 *
 * @module @deepseek-ai/dsh-tool-video-gen
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { mediaErrors } from './shared/failure.ts'
import { packageRootOf } from './shared/pkg-root.ts'
import {
  TaskStore,
  appendSafeLog,
  newTaskId,
  redactPrompt,
  resolvePrivateRoot,
} from './shared/private-runtime.ts'
import { createAccountGate } from './shared/dreamina-account.ts'
import { normalizeProviderImage } from './shared/image-ops.ts'
import { createCanvasCli, resolveCanvasBinary, resolveCanvasProject } from './shared/dreamina-canvas.ts'
import {
  runCanvasVideoBatch,
  type CanvasVideoTask,
  type CanvasVideoTaskResult,
} from './shared/video-canvas-pipeline.ts'

/** Bundle root: the built tool file lives in dist/, so resolve from the package root. */
const PACKAGE_ROOT = packageRootOf(import.meta.url)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-video-gen'

/** Services required by the video tool. */
export const inject = ['tools']

import {
  VIDEO_EXECUTION_MODES,
  VIDEO_COMMANDS,
  SUPPORTED_VIDEO_MODELS,
  FIRST_LAST_PATTERN,
  promptPreferences,
  isSupportedVideoModel,
  requiresExplicitSelectionSource,
  resolveVideoModel,
  resolveVideoResolution,
  resolutionEquals,
  normalizeModel,
  limitsFor,
  DEFAULT_VIDEO_CAPACITY,
  type VideoExecutionMode,
} from './shared/video-policy.ts'
import { confirmationGateErrorForDurations, parseTasksPayload, promptCompletenessBoundaryIssue } from './shared/video-pipeline.ts'

export { VIDEO_EXECUTION_MODES }
export type { VideoExecutionMode }

/** 未传 `video_group` 时使用的固定画布（长期复用，避免每天新建画布）。 */
export const DEFAULT_CANVAS_NAME = 'dsh-media'

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /**
   * 画布 CLI 二进制路径。留空 = 自动解析：包内 `bin/` → `~/bin/`（官方安装器
   * 位置）→ PATH 上的 `dreamina-canvas`。
   */
  dreaminaPath?: string
  /** 登录态隔离名（`--profile`）；留空 = CLI 默认 `default`。 */
  dreaminaProfile?: string
  model?: string
  resolution?: string
  outputDir?: string
  privateDir?: string
  pollTimeoutMs?: number
  executionMode?: VideoExecutionMode
  /** 同时在跑的提交数（一次调用装满多少任务）。默认 10。 */
  videoCapacity?: number
  /** 提交前做一次廉价的能力预检（`model list`）。 */
  runHelpBeforeSubmit?: boolean
  /**
   * 管线默认即梦账号。空 = 不触碰登录态；否则每次 CLI 调用前确保它是活登录。
   * 账号库与切换逻辑沿用 `shared/dreamina-account.ts`。
   */
  dreaminaAccount?: string
}

export const Config: z<Config> = z.object({
  dreaminaPath: z.string().default(''),
  dreaminaProfile: z.string().default(''),
  model: z.string().default('seedance_2.5'),
  resolution: z.string().default('480p'),
  outputDir: z.string().default('outputs'),
  privateDir: z.string().default(''),
  pollTimeoutMs: z.number().default(900000),
  executionMode: z.union([...VIDEO_EXECUTION_MODES]).default('production'),
  videoCapacity: z.number().default(DEFAULT_VIDEO_CAPACITY),
  runHelpBeforeSubmit: z.boolean().default(false),
  dreaminaAccount: z.string().default(''),
})

type ResolvedConfig = Required<Config>

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const REF_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])

export { PACKAGE_ROOT }

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

/** Normalize a video duration value: integer seconds, optional s/秒 suffix. */
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

/** Dated canvas name: YYYY_MM_DD-<base>（沿用旧 video_group 的日期前缀语义）。 */
function datedVideoGroup(name: string): string {
  const base = name.trim()
  if (base.length === 0 || base.length > 20 || /[\r\n]/.test(base)) {
    throw mediaErrors.input('video_group base name must contain 1-20 characters on one line')
  }
  const now = new Date()
  const ymd = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}_${String(now.getDate()).padStart(2, '0')}`
  return `${ymd}-${base}`
}

/** A single task spec (prompt + ordered refs); unset fields fall back to call level. */
interface TaskSpec {
  prompt: string
  images: string[]
  videos: string[]
  audios: string[]
  /**
   * Per-task duration in seconds. Resolution order: explicit `tasks[].duration`
   * → the task's own prompt hint (`视频时长：8 秒`) → the call-level duration.
   */
  duration?: number
}

/**
 * Build the ordered task specs: `tasks` list wins, else `video_count` copies of
 * the base spec. Exported for unit tests (per-task duration resolution).
 */
export function buildSpecs(args: any, base: TaskSpec & { count: number }): TaskSpec[] {
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : []
  if (rawTasks.length > 0) {
    return rawTasks.map((t: any) => {
      const images: string[] = []
      if (typeof t.image === 'string' && t.image.trim().length > 0) images.push(t.image.trim())
      for (const p of t.images ?? []) if (typeof p === 'string' && p.trim().length > 0) images.push(p.trim())
      if (images.length === 0) images.push(...base.images)
      const prompt = String(t.prompt ?? '').trim() || base.prompt
      let duration: number | undefined
      const rawDuration = t.duration
      if (rawDuration !== undefined && rawDuration !== null && String(rawDuration).trim() !== '') {
        duration = normalizeVideoDuration(rawDuration)
      } else {
        duration = promptPreferences(prompt).duration ?? base.duration
      }
      return {
        prompt,
        images,
        videos: (t.videos ?? base.videos).filter((p: unknown) => typeof p === 'string' && p.trim().length > 0),
        audios: (t.audios ?? base.audios).filter((p: unknown) => typeof p === 'string' && p.trim().length > 0),
        duration,
      }
    })
  }
  return Array.from({ length: base.count }, () => ({ ...base, duration: base.duration }))
}

/** Register the `generate_video` tool. */
function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_video',
      description:
        '统一视频生成管线（即梦画布 CLI dreamina-canvas）：所有调用分解为 N 个隔离任务，每个任务在画布上是一个独立节点（多产物分节点，每节点 count=1），先并发提交，再（production 模式）统一等待终态并按 resourceId 精确取回。付费链路固定为「保存节点 → node quote 报价 → node confirm 批准（--credit-ceiling）→ node run（--submit-id）→ operation wait → resource download」，报价不等于授权，同一任务绝不换新 submit-id 重放。视频公开模式只有 t2v / first_last_frame / m2v（没有 i2v）：无参考=t2v；单图锁首帧或两张有序图片=first_last_frame；单图但要保留指定比例、或图片/视频/音频混合参考=m2v。默认模型 seedance_2.5、默认 480p、默认 16:9、默认 5 秒（比例/时长也可从 prompt 推断兜底）。非默认模型需 video_model_selection_source=user_explicit（绝不从语料/示例/容量/失败回退自动换模型）。正式 production 提交前要求确认门：须传 video_confirmation_model / video_confirmation_resolution / video_confirmation_duration（多时长批次用 video_confirmation_durations），且与最终值一致。video_execution_mode：production（提交+等待+下载）、production_submit_only（仅提交返回 submit_id）、test_submit_only（强制最低成本模型+720p，仅提交，须提供 video_group）。video_count（1-10）为「同一 prompt+参考生成 N 份」；tasks（数组）为「不同素材/不同 prompt 的 N 个任务」。video_group 指定画布名（自动加 YYYY_MM_DD- 前缀，复用或新建画布），省略则用固定画布 dsh-media；也可用 canvas_project_id 直接指定画布。任务状态持久化在私有运行目录。',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: '视频提示词，UTF-8，不能为空。有参考素材时建议用中文裸标签引用（如 图片1、视频1、音频1），标签序号对应该类素材的传入顺序（引用按 图片 → 视频 → 音频 上传登记）。',
        },
        image: {
          type: 'string',
          description: '可选：单张参考图路径（PNG/JPEG/WebP）。旧参数，与 images 等价。',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：本地图片参考路径列表（PNG/JPEG/WebP）。seedance_2.5 参考总上限 50（图 0-30 / 视频 0-10 / 音频 0-10）；其余模型 9 图 / 3 视频 / 3 音频。',
        },
        videos: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：本地参考视频路径列表（mp4/mov/webm/mkv/avi/m4v）。有视频参考时走 m2v。',
        },
        audios: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：本地参考音频路径列表（mp3/wav/m4a/aac/flac/ogg）。纯音频参考仅 seedance_2.5 支持。',
        },
        duration: {
          type: 'integer',
          description: '视频时长（秒）；默认 5，或从 prompt 推断。seedance_2.5 为 4-30；seedance_2.0 系列 4-15；seedance_pro_fast 5-10。',
        },
        ratio: {
          type: 'string',
          description: '画面比例（21:9/16:9/4:3/1:1/3:4/9:16）；默认 16:9 或从 prompt 推断。显式传 ratio 时单图场景走 m2v 以保留该比例，否则单图走 first_last_frame（比例由首帧决定）。',
        },
        video_command: {
          type: 'string',
          enum: [...VIDEO_COMMANDS],
          description: '可选：显式覆盖命令（text2video/image2video/frames2video/multimodal2video）。内部映射到画布 CLI 的公开模式 t2v / first_last_frame / m2v（image2video 单图默认走 first_last_frame）。multiframe2video 是禁用遗留命令。',
        },
        video_resolution: {
          type: 'string',
          description: '分辨率：seedance_2.5 支持 480p/720p/1080p；seedance_2.0_vip 支持 720p/1080p/4k；seedance_2.0_fast_vip / _mini 仅 720p；wan_3.0 / happyhorse_1.1 为 720P/1080P。默认 480p（test 模式固定 720p）。',
        },
        model_version: {
          type: 'string',
          description: '视频模型 canonical 名或别名：seedance_2.5（默认）/ seedance_2.0_vip / seedance_2.0_fast_vip / seedance_2.0_mini / seedance_pro_fast / wan_3.0 / happyhorse_1.1；也接受 2.5 / 2.0_vip / 2.0fast_vip / 1.0fast 等简写。',
        },
        video_model_selection_source: {
          type: 'string',
          enum: ['user_explicit'],
          description: '仅当使用非默认模型（非 seedance_2.5）时必填（=user_explicit），表示用户明确选择了该模型；绝不从语料/示例/容量/失败回退自动选。',
        },
        video_execution_mode: {
          type: 'string',
          enum: [...VIDEO_EXECUTION_MODES],
          description: '执行模式：production（默认，提交+等待+下载）、production_submit_only（仅提交返回 submit_id）、test_submit_only（测试通道，强制最低成本模型+720p，仅提交不轮询，须提供 video_group）。',
        },
        video_count: {
          type: 'integer',
          description: '可选：同一 prompt+参考生成 N 份（1-10，默认 1）。每个产物是独立节点。',
        },
        tasks: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '可选：不同素材/不同 prompt 的 N 个任务 [{prompt, image?, images?, videos?, audios?, duration?}]。提供时忽略 video_count；模型/分辨率/比例在调用级共享，时长可以逐任务。一次调用请按容量装满（默认 10 个/次），不要按时长拆分。',
        },
        tasks_path: {
          type: 'string',
          description: '可选：tasks 的 JSON 文件路径（UTF-8），内容为 tasks 数组或 {"tasks":[...]}（`prompt_batch run_batch` 会写出 submission-callN.json）。**优先于入参 tasks**：用它提交可做到零转录，提示词逐字节等于审阅版；确认项仍须显式传入。',
        },
        video_confirmation_model: {
          type: 'string',
          description: '确认门：正式 production 提交前必须传入已确认的模型，且须与最终模型一致。',
        },
        video_confirmation_resolution: {
          type: 'string',
          description: '确认门：正式 production 提交前必须传入已确认的分辨率，且须与最终分辨率一致。',
        },
        video_confirmation_duration: {
          type: 'integer',
          description: '确认门：正式 production 提交前必须传入已确认的时长（单一时长时使用；多时长批次改用 video_confirmation_durations）。',
        },
        video_confirmation_durations: {
          type: 'string',
          description: '确认门（多时长批次）：当 tasks[] 自带不同 duration 时必填，逗号分隔的时长集合，须与最终集合完全一致（如 "12,15,15"）。',
        },
        video_credit_ceiling: {
          type: 'integer',
          description: '可选：本次每个任务允许消耗的积分上限（整数）。不传时以服务端 `node quote` 的报价本身作为上限；报价超过该值时不会提交。',
        },
        video_group: {
          type: 'string',
          description: '可选：画布名（1-20 字符单行），自动加 YYYY_MM_DD- 日期前缀；复用同名画布或新建。省略时使用固定画布 dsh-media。test_submit_only 必须提供。',
        },
        canvas_project_id: {
          type: 'string',
          description: '可选：直接指定画布 projectId（UUID），跳过按名解析。与 video_group 二选一，二者都传时以本项为准。',
        },
        output: {
          type: 'string',
          description: '可选输出路径（绝对路径，或相对会话工作目录的路径）。仅在单任务时生效；多任务时产物落在输出目录下并带任务前缀。',
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
            canvas_project_id: { type: 'string' },
            canvas_web_url: { type: 'string' },
            node_id: { type: 'string' },
            results: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        render(_args: unknown, value: any) {
          if (Array.isArray(value.results)) {
            const ok = value.results.filter((r: any) => r.status === 'success' || r.status === 'submitted').length
            const group = value.video_group !== undefined ? `, canvas=${value.video_group}` : ''
            return [{ type: 'text', text: `video batch: ${ok}/${value.count ?? value.results.length} (${value.status})${group}` }]
          }
          if (value.done && value.path !== undefined) {
            return [{ type: 'text', text: `generated video: ${value.path}` }]
          }
          return [{ type: 'text', text: `video task submitted; submit_id=${value.submit_id ?? 'unknown'} (${value.execution_mode ?? 'production'}). Check progress on the canvas.` }]
        },
      },
      async execute(args: any, exec: any) {
        const prompt0 = String(args.prompt ?? '').trim()
        const boundaryIssue = promptCompletenessBoundaryIssue(prompt0)
        if (boundaryIssue) throw mediaErrors.input(boundaryIssue)
        const mode: VideoExecutionMode = args.video_execution_mode ?? config.executionMode
        if (!VIDEO_EXECUTION_MODES.includes(mode)) throw mediaErrors.input(`unsupported video_execution_mode: ${mode}`)

        // ---- shared call-level settings (one set for the whole call) ----
        const prefs = promptPreferences(prompt0)
        const userModel = normalizeModel(args.model_version ?? config.model)
        const model = resolveVideoModel(mode, userModel)
        const resolution = resolveVideoResolution(mode, args.video_resolution, config.resolution)
        const duration = normalizeVideoDuration(args.duration ?? prefs.duration)
        const ratio = String(args.ratio ?? prefs.ratio ?? '16:9')
        // 单图场景的关键判据：调用方是否**显式**要比例（决定 m2v 还是 first_last_frame）。
        const explicitRatio = args.ratio !== undefined || prefs.ratio !== undefined

        if (!isSupportedVideoModel(model)) {
          throw mediaErrors.input(`不支持的视频模型 ${model}，可选：${[...SUPPORTED_VIDEO_MODELS].join(' / ')}`)
        }
        if (requiresExplicitSelectionSource(model, mode) && String(args.video_model_selection_source ?? '').trim() !== 'user_explicit') {
          throw mediaErrors.input('非默认视频模型要求 video_model_selection_source=user_explicit（必须是用户明确选择，绝不从语料/示例/容量/失败回退自动选）')
        }

        const limits = limitsFor(model)
        if (!Number.isFinite(duration) || duration < limits.durationMin || duration > limits.durationMax) {
          throw mediaErrors.input(`（${model}）时长必须在 ${limits.durationMin}-${limits.durationMax} 秒之间，当前 ${duration} 秒。`)
        }
        if (!limits.resolutions.some((r) => resolutionEquals(r, resolution))) {
          throw mediaErrors.input(`（${model}）不支持分辨率 ${resolution}，可选：${limits.resolutions.join(' / ')}。`)
        }

        // ---- task decomposition (unified: N tasks always) ----
        const baseImages: string[] = []
        if (typeof args.image === 'string' && args.image.trim().length > 0) baseImages.push(args.image.trim())
        for (const p of args.images ?? []) if (typeof p === 'string' && p.trim().length > 0) baseImages.push(p.trim())
        const baseVideos = (args.videos ?? []).filter((p: unknown) => typeof p === 'string' && p.trim().length > 0)
        const baseAudios = (args.audios ?? []).filter((p: unknown) => typeof p === 'string' && p.trim().length > 0)
        // Zero-transcription submission: `tasks_path` wins over inline `tasks`.
        let rawTasks = Array.isArray(args.tasks) ? args.tasks : []
        if (typeof args.tasks_path === 'string' && args.tasks_path.trim().length > 0) {
          const tasksFile = args.tasks_path.trim()
          let tasksRaw: string
          try {
            tasksRaw = await readFile(tasksFile, 'utf8')
          } catch (error: any) {
            throw mediaErrors.input(`tasks_path is not readable: ${tasksFile} (${String(error?.message ?? error)})`)
          }
          try {
            rawTasks = parseTasksPayload(tasksRaw)
          } catch (error: any) {
            throw mediaErrors.input(`invalid tasks_path payload (${tasksFile}): ${String(error?.message ?? error)}`)
          }
        }
        let count: number
        if (rawTasks.length > 0) {
          count = rawTasks.length
        } else {
          const c = args.video_count === undefined ? 1 : Number(args.video_count)
          if (!Number.isInteger(c) || c < 1 || c > 10) throw mediaErrors.input('video_count must be an integer between 1 and 10')
          count = c
        }
        if (mode === 'test_submit_only' && count !== 1) {
          throw mediaErrors.input('test_submit_only supports exactly one task')
        }
        const base: TaskSpec & { count: number } = {
          prompt: prompt0,
          images: baseImages,
          videos: baseVideos,
          audios: baseAudios,
          count,
        }
        const specArgs = rawTasks === args.tasks ? args : { ...args, tasks: rawTasks }
        const specs = buildSpecs(specArgs, base)

        // validate refs + per-task limits
        for (let i = 0; i < specs.length; i += 1) {
          const spec = specs[i]
          const specDuration = spec.duration ?? duration
          if (!Number.isFinite(specDuration) || specDuration < limits.durationMin || specDuration > limits.durationMax) {
            throw mediaErrors.input(`（${model}）第 ${i + 1} 个任务的时长必须在 ${limits.durationMin}-${limits.durationMax} 秒之间，当前 ${specDuration} 秒。`)
          }
          const totalRefs = spec.images.length + spec.videos.length + spec.audios.length
          if (totalRefs > 0) {
            await validateRefFiles('image', spec.images)
            await validateRefFiles('video', spec.videos)
            await validateRefFiles('audio', spec.audios)
            if (spec.images.length === 0 && spec.videos.length === 0 && spec.audios.length > 0 && !limits.audioOnlyAllowed) {
              throw mediaErrors.input(`纯音频参考仅支持 seedance_2.5 多模态模式（当前模型 ${model}）。请指定 model_version=2.5，或补充图片/视频参考。`)
            }
            if (totalRefs > limits.total) {
              throw mediaErrors.input(`（${model}）参考输入总计最多 ${limits.total} 个，当前 ${totalRefs} 个。`)
            }
            if (spec.videos.length > 0 || spec.audios.length > 0) {
              if (!limits.supportsMultimodal) {
                throw mediaErrors.input(`（${model}）不支持多模态参考（视频/音频），请改用 seedance_2.5 等支持 m2v 的模型。`)
              }
            }
            if (spec.images.length > 2 && !limits.supportsMultimodal) {
              throw mediaErrors.input(`（${model}）最多支持两帧图片（首帧/首尾帧），当前 ${spec.images.length} 张。`)
            }
            if (spec.images.length > 2 && spec.images.length > limits.total) {
              throw mediaErrors.input(`（${model}）图片参考最多 ${limits.total} 张，当前 ${spec.images.length} 张。`)
            }
          }
          const command = String(args.video_command ?? '')
          if (command === 'frames2video' && spec.images.length !== 2) {
            throw mediaErrors.input('frames2video 需要恰好两张图（首帧 + 尾帧）')
          }
          if (command === 'image2video' && spec.images.length !== 1) {
            throw mediaErrors.input('image2video 需要恰好一张主图（--image）')
          }
          if ((command === 'image2video' || command === 'frames2video') && (spec.videos.length > 0 || spec.audios.length > 0)) {
            throw mediaErrors.input(`${command} 不支持视频/音频参考`)
          }
        }

        // ---- per-task durations + confirmation gate ----
        const specDurations = specs.map((spec) => spec.duration ?? duration)
        const uniqueDurations = [...new Set(specDurations)].sort((a, b) => a - b)
        const gateErr = confirmationGateErrorForDurations(
          mode,
          { model, resolution, durations: uniqueDurations },
          {
            model: String(args.video_confirmation_model ?? '').trim() || undefined,
            resolution: String(args.video_confirmation_resolution ?? '').trim() || undefined,
            duration: args.video_confirmation_duration,
            durations: args.video_confirmation_durations,
          },
        )
        if (gateErr) throw mediaErrors.input(gateErr)

        const creditCeiling = args.video_credit_ceiling === undefined ? undefined : Number(args.video_credit_ceiling)
        if (creditCeiling !== undefined && (!Number.isInteger(creditCeiling) || creditCeiling < 0)) {
          throw mediaErrors.input('video_credit_ceiling must be a non-negative integer')
        }

        const capacity = Math.max(1, Math.floor(Number(config.videoCapacity) || DEFAULT_VIDEO_CAPACITY))
        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)
        const store = new TaskStore(join(privateRoot, 'jobs'))
        const accountGate = createAccountGate(privateRoot, config.dreaminaAccount, async (info) => {
          await appendSafeLog(privateRoot, 'dreamina-account', { action: 'auto-switch', ...info })
        })
        // Fail here — before any paid submit — when the configured account is broken.
        await accountGate.ensure()

        const binary = await resolveCanvasBinary(config.dreaminaPath)
        const cli = createCanvasCli({
          binary,
          profile: config.dreaminaProfile,
          ensureAccount: () => accountGate.ensure(),
          timeoutMs: 300_000,
        })

        // ---- canvas resolution (reuse a same-named canvas, never touch `--use`) ----
        const explicitProject = String(args.canvas_project_id ?? '').trim()
        let project: { projectId: string; name?: string; webUrl?: string; created: boolean }
        let resolvedGroupName: string | undefined
        if (explicitProject.length > 0) {
          project = { projectId: explicitProject, created: false }
        } else {
          if (mode === 'test_submit_only' && String(args.video_group ?? '').trim().length === 0) {
            throw mediaErrors.input('test_submit_only requires video_group to verify canvas routing')
          }
          resolvedGroupName = String(args.video_group ?? '').trim().length > 0 ? datedVideoGroup(String(args.video_group)) : DEFAULT_CANVAS_NAME
          project = await resolveCanvasProject(cli, resolvedGroupName)
          if (resolvedGroupName === DEFAULT_CANVAS_NAME) resolvedGroupName = undefined
        }
        // 能力预检（可选）：一次廉价 `model list` 证明二进制与登录可用。
        if (config.runHelpBeforeSubmit) {
          try {
            await cli.run(['model', 'list', '--type', 'video'], { timeoutMs: 60_000 })
          } catch (error: any) {
            await appendSafeLog(privateRoot, 'generate_video', { event: 'model_list_check_failed', detail: String(error?.message ?? error).slice(0, 200) })
          }
        }

        // ---- per-task isolation: its own dir, its own persisted identity ----
        const batchId = `video-${newTaskId()}`
        const tasks: CanvasVideoTask[] = []
        const taskDirs: string[] = []
        const submitIds: string[] = []
        const taskIds: string[] = []
        for (let i = 0; i < specs.length; i += 1) {
          const spec = specs[i]
          const taskId = newTaskId()
          const dir = await store.taskDir(batchId, taskId)
          await store.create(batchId, taskId, 'video', {
            prompt: redactPrompt(spec.prompt), mode, model, resolution, duration: spec.duration ?? duration, ratio,
            images: spec.images.map((p) => p), videos: spec.videos.map((p) => p), audios: spec.audios.map((p) => p),
            canvasProjectId: project.projectId,
          })
          const submitId = randomUUID()
          await store.transition(batchId, taskId, 'running', { model, provider: 'dreamina-canvas', submitId, nextAction: mode === 'production' ? 'none' : 'query_later' })
          await mkdir(join(dir, 'outputs'), { recursive: true })
          // 参考图规范化（EXIF 方向 + ≤1920px）后再上传，避免把超大/歪的图传上画布
          const submitImages: string[] = []
          if (spec.images.length > 0) {
            const inputDir = join(dir, 'inputs')
            await mkdir(inputDir, { recursive: true })
            for (const img of spec.images) {
              submitImages.push((await normalizeProviderImage(img, inputDir, 1920)).path)
            }
          }
          taskIds.push(taskId)
          taskDirs.push(join(dir, 'outputs'))
          submitIds.push(submitId)
          tasks.push({
            taskId,
            title: `${resolvedGroupName ?? 'dsh-media'}-${i + 1}`,
            prompt: spec.prompt,
            images: submitImages,
            videos: spec.videos,
            audios: spec.audios,
            duration: spec.duration ?? duration,
            video_command: args.video_command,
            firstLastHint: FIRST_LAST_PATTERN.test(spec.prompt),
            explicitRatio,
          })
        }

        // ---- 容量闸门：一次调用装满容量个并发提交 ----
        const results = await runCanvasVideoBatch(
          {
            cli,
            projectId: project.projectId,
            model,
            resolution,
            ratio,
            pollTimeoutMs: config.pollTimeoutMs,
            pollIntervalMs: 5000,
            creditCeiling,
            submitOnly: mode !== 'production',
            concurrency: capacity,
            log: (event, payload) => appendSafeLog(privateRoot, 'generate_video', { batchId, event, ...payload }),
            signal: exec.signal,
          },
          tasks,
          taskDirs,
          submitIds,
        )

        // ---- 交付：把产物挪到可点击的位置，并更新持久状态 ----
        const deliverRoot = join(workspaceRoot, config.outputDir)
        await mkdir(deliverRoot, { recursive: true })
        const requested = typeof args.output === 'string' ? args.output.trim() : ''
        for (let i = 0; i < results.length; i += 1) {
          const result = results[i]
          const taskId = taskIds[i]
          if (result.status === 'success' && result.path) {
            let finalPath = result.path
            if (count === 1 && requested.length > 0) {
              finalPath = isAbsolute(requested) ? requested : join(workspaceRoot, requested)
            } else {
              finalPath = join(deliverRoot, `${taskId.slice(0, 8)}-${basename(result.path)}`)
            }
            if (finalPath !== result.path) {
              await mkdir(dirname(finalPath), { recursive: true })
              await rename(result.path, finalPath)
            }
            result.path = finalPath
            await store.saveResult(batchId, taskId, { status: 'success', submitId: result.submitId, outputPath: finalPath, model })
            await store.transition(batchId, taskId, 'success', { submitId: result.submitId, outputPath: finalPath, model, nodeId: result.nodeId, resourceId: result.resourceId })
            continue
          }
          if (result.status === 'failed') {
            await store.saveResult(batchId, taskId, { status: 'failed', submitId: result.submitId, message: result.error })
            await store.transition(batchId, taskId, 'failed', { submitId: result.submitId, failureMessage: result.error, nodeId: result.nodeId })
            continue
          }
          await store.saveResult(batchId, taskId, { status: result.status, submitId: result.submitId, nodeId: result.nodeId })
          await store.transition(batchId, taskId, 'needs_review', {
            submitId: result.submitId,
            nodeId: result.nodeId,
            nextAction: mode === 'production' ? 'query_later' : 'none',
          })
        }

        await appendSafeLog(privateRoot, 'generate_video', {
          batchId,
          event: 'finished',
          count,
          canvas: project.projectId,
          status: results.every((r) => r.status === 'success') ? 'success' : results.some((r) => r.status === 'failed') ? 'partial' : 'submitted',
        })

        const canvasFields: Record<string, unknown> = { canvas_project_id: project.projectId }
        if (project.webUrl) canvasFields.canvas_web_url = project.webUrl
        if (resolvedGroupName) canvasFields.video_group = resolvedGroupName

        if (count === 1) {
          const only = results[0]
          if (only.status === 'success' && only.path) {
            return { path: only.path, submit_id: only.submitId, done: true, execution_mode: mode, model, node_id: only.nodeId, ...canvasFields }
          }
          if (only.status === 'failed') throw mediaErrors.provider(`dreamina-canvas task failed: ${only.error ?? 'unknown reason'}`)
          return { submit_id: only.submitId, done: false, execution_mode: mode, model, node_id: only.nodeId, ...canvasFields }
        }

        const mapped = results.map((result, index) => ({
          index: index + 1,
          submit_id: result.submitId,
          node_id: result.nodeId,
          status: result.status,
          ...(result.path ? { path: result.path } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.advice ? { advice: result.advice } : {}),
          model,
          execution_mode: mode,
        }))
        const statuses = new Set(mapped.map((r) => r.status))
        const aggregate = statuses.size === 1 && statuses.has('success') ? 'success' : statuses.size === 1 && statuses.has('failed') ? 'failed' : 'partial'
        return { status: aggregate, count, results: mapped, done: false, execution_mode: mode, model, ...canvasFields }
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
