/**
 * Model-facing `generate_video` tool: one unified Seedance/Dreamina video
 * pipeline (Codex_image Media-Router rebuild). There is no separate
 * "single" vs "batch" execution path — every call decomposes into N tasks,
 * each isolated in its own job/output directory, then submits all and
 * (for `production`) polls all and downloads each task's own result.
 *
 * Precise polling (never grabs another task's video):
 * - each task downloads into `<private>/jobs/<batch>/<task>/outputs/`;
 * - after `query_result --submit_id=X --download_dir=<taskDir>`, the result
 *   is picked only from that task's own directory, matched by `submit_id`
 *   appearing in the filename (fallback: newest valid video in the same
 *   isolated directory — safe because the dir belongs to exactly one task);
 * - the picked file is validated as a real video before acceptance.
 *
 * Contract (Codex_image video_router.py / UNIFIED_MEDIA_TOOL_REFACTOR_BLUEPRINT):
 * - default model `seedance2.5`, default resolution `480p`, default
 *   ratio `16:9`, default duration `5`; ratio/duration may also be inferred
 *   from the prompt when not passed as structured parameters;
 * - commands: text2video / image2video / frames2video / multimodal2video
 *   (auto-selected; `video_command` may override). multiframe2video is the
 *   disabled legacy command — never emitted;
 * - `video_execution_mode`: production (submit + poll + download),
 *   production_submit_only (submit, return submit_id, no poll),
 *   test_submit_only (forces non-VIP seedance2.0 + 720p + poll=0, returns
 *   submit_id only, never queries/downloads);
 * - formal production submission requires a confirmation gate: the caller
 *   must pass `video_confirmation_model` / `video_confirmation_resolution`
 *   / `video_confirmation_duration` and each must equal the resolved value;
 * - a non-default 2.0-family model requires `video_model_selection_source=
 *   user_explicit` (never infer or fall back); ordinary explicit 2.0-series
 *   normalizes to seedance2.0_vip;
 * - `video_group` reuses one dated Dreamina session for every task in the
 *   call (Codex semantics); test_submit_only must provide a group;
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
import { access, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { mediaErrors } from './shared/failure.ts'
import { packageRootOf } from './shared/pkg-root.ts'
import {
  TaskStore,
  acquireSlot,
  appendSafeLog,
  newTaskId,
  redactPrompt,
  resolvePrivateRoot,
} from './shared/private-runtime.ts'
import { normalizeProviderImage } from './shared/image-ops.ts'

const execFileAsync = promisify(execFile)

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
  selectVideoCommand,
  promptPreferences,
  isSupportedVideoModel,
  requiresExplicitSelectionSource,
  resolveVideoModel,
  resolveVideoResolution,
  normalizeModel,
  limitsFor,
  type VideoCommand,
  type VideoExecutionMode,
} from './shared/video-policy.ts'
import { confirmationGateError, isVideoExtName, pickDownloadedVideo as pickDownloadedVideoPure, promptCompletenessBoundaryIssue } from './shared/video-pipeline.ts'

export { VIDEO_EXECUTION_MODES }
export type { VideoExecutionMode }

/** Plugin config (all optional — `Config` supplies the defaults). */
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

/** Lightweight validity check: readable, non-empty, and a recognized container header. */
async function isValidVideo(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    if (s.size <= 0) return false
    const { open } = await import('node:fs/promises')
    const handle = await open(path, 'r')
    try {
      const buf = Buffer.alloc(16)
      await handle.read(buf, 0, 16, 0)
      if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true // mp4 (ftyp)
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'AVI ') return true // avi
      if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true // webm/mkv (ebml)
      return false
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

/**
 * Pick the download for one task, reading ONLY that task's own directory,
 * then delegating ordering (submit_id match first, then newest valid video
 * in the isolated dir) to the pure selector.
 */
async function pickDownloadedVideo(taskDir: string, submitId: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(taskDir)
  } catch {
    return undefined
  }
  const candidates: Array<{ name: string; mtimeMs: number; valid: boolean }> = []
  for (const name of entries) {
    if (!isVideoExtName(name)) continue
    const full = join(taskDir, name)
    const valid = await isValidVideo(full)
    const mtimeMs = valid ? (await stat(full)).mtimeMs : 0
    candidates.push({ name, mtimeMs, valid })
  }
  const chosen = pickDownloadedVideoPure(candidates, submitId)
  return chosen ? join(taskDir, chosen.name) : undefined
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

/** A single task spec (prompt + ordered refs); settings are shared at call level. */
interface TaskSpec {
  prompt: string
  images: string[]
  videos: string[]
  audios: string[]
}

/** Build the ordered task specs: `tasks` list wins, else `video_count` copies of the base spec. */
function buildSpecs(args: any, base: TaskSpec & { count: number }): TaskSpec[] {
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : []
  if (rawTasks.length > 0) {
    return rawTasks.map((t: any) => {
      const images: string[] = []
      if (typeof t.image === 'string' && t.image.trim().length > 0) images.push(t.image.trim())
      for (const p of t.images ?? []) if (typeof p === 'string' && p.trim().length > 0) images.push(p.trim())
      if (images.length === 0) images.push(...base.images)
      return {
        prompt: String(t.prompt ?? '').trim() || base.prompt,
        images,
        videos: (t.videos ?? base.videos).filter((p: unknown) => typeof p === 'string' && p.trim().length > 0),
        audios: (t.audios ?? base.audios).filter((p: unknown) => typeof p === 'string' && p.trim().length > 0),
      }
    })
  }
  return Array.from({ length: base.count }, () => base)
}

/** Register the `generate_video` tool. */
function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_video',
      description:
        '统一视频生成管线（即梦 Dreamina/Seedance 本地 CLI）：不再区分单条与批量，所有调用都会分解成 N 个隔离任务（各占独立下载目录），先并发提交，再（production 模式）统一轮询并按 submit_id 精确取回各自的视频。命令集与 Codex 对齐：text2video（只传 prompt）/ image2video（单主图）/ frames2video（两张图+首尾帧语义）/ multimodal2video（图/视频/音频全能参考），可显式传 video_command 覆盖；multiframe2video 是禁用遗留命令。默认模型 seedance2.5、默认 480p、默认 16:9、默认 5 秒（比例/时长也可从 prompt 推断作兜底）。非默认 seedance2.0 系列需 video_model_selection_source=user_explicit；普通显式 2.0 归一化为 seedance2.0_vip。正式 production 提交前要求确认门：须传 video_confirmation_model / video_confirmation_resolution / video_confirmation_duration 且与最终值一致。video_execution_mode：production（提交+轮询+下载）、production_submit_only（仅提交返回 submit_id，不查询）、test_submit_only（强制非 VIP seedance2.0 + 720p，只返回 submit_id，务必去即梦后台查看，绝不自动查询下载，且必须提供 video_group）。video_count（1-10）为“同一 prompt+参考生成 N 份”；`tasks`（数组）为“不同素材/不同 prompt 的 N 个任务”（各自可用 prompt/images/videos/audios，模型/分辨率/时长/比例在调用级共享）。video_group 指定会话分组名（自动加 YYYY_MM_DD- 日期前缀，复用或新建即梦会话，同组所有任务共享同一 session）。任务状态持久化在私有运行目录，同一任务绝不重复提交。',
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
          description: '视频时长（秒）；默认 5，或从 prompt 推断。seedance2.5 为 4-30，其余模型为 4-15。',
        },
        ratio: {
          type: 'string',
          description: '画面比例（1:1/3:4/16:9/4:3/9:16/21:9）；默认 16:9 或从 prompt 推断。image2video/frames2video 由图片推断，不设此项。',
        },
        video_command: {
          type: 'string',
          enum: [...VIDEO_COMMANDS],
          description: '可选：显式覆盖子命令（text2video/image2video/frames2video/multimodal2video）；缺省按输入自动选择。multiframe2video 是禁用遗留命令。',
        },
        video_resolution: {
          type: 'string',
          description: '分辨率：seedance2.5 支持 480p/720p/1080p；seedance2.0_vip 支持 480p/720p/1080p/4k；其余模型仅 720p。默认 480p（test 模式固定 720p）。',
        },
        model_version: {
          type: 'string',
          description: '视频模型，默认 seedance2.5；可选 2.5 / 2.0 / 2.0fast / 2.0_vip / 2.0fast_vip / 2.0mini（自动补全 seedance 前缀）。普通请求显式选 2.0 系列会归一化为 seedance2.0_vip。',
        },
        video_model_selection_source: {
          type: 'string',
          enum: ['user_explicit'],
          description: '仅当使用非默认 seedance2.0 系列模型时必填（=user_explicit），表示用户明确选择了该模型；绝不从语料/示例/容量/失败回退自动选 2.0。',
        },
        video_execution_mode: {
          type: 'string',
          enum: [...VIDEO_EXECUTION_MODES],
          description: '执行模式：production（默认，提交+轮询+下载）、production_submit_only（仅提交）、test_submit_only（测试通道，强制非 VIP 2.0/720p，仅返回 submit_id）。',
        },
        video_count: {
          type: 'integer',
          description: '可选：同一 prompt+参考生成 N 份（1-10，默认 1）。',
        },
        tasks: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '可选：不同素材/不同 prompt 的 N 个任务 [{prompt, image?, images?, videos?, audios?}]。提供时忽略 video_count；模型/分辨率/时长/比例/确认项在调用级共享。',
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
          description: '确认门：正式 production 提交前必须传入已确认的时长，且须与最终时长一致。',
        },
        video_group: {
          type: 'string',
          description: '可选：会话分组名（1-20 字符单行），自动加 YYYY_MM_DD- 日期前缀，复用或新建即梦会话（同组所有任务共享同一 session）；test_submit_only 必须提供。',
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
            const ok = value.results.filter((r: any) => r.status === 'success' || r.status === 'submitted').length
            const group = value.video_group !== undefined ? `, group=${value.video_group}` : ''
            return [{ type: 'text', text: `video batch: ${ok}/${value.count ?? value.results.length} (${value.status})${group}` }]
          }
          if (value.done && value.path !== undefined) {
            return [{ type: 'text', text: `generated video: ${value.path}` }]
          }
          return [{ type: 'text', text: `video task submitted; submit_id=${value.submit_id ?? 'unknown'} (${value.execution_mode ?? 'production'}). Check progress in the Dreamina dashboard.` }]
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

        if (!isSupportedVideoModel(model)) {
          throw mediaErrors.input(`不支持的视频模型 ${model}，可选：${[...SUPPORTED_VIDEO_MODELS].join(' / ')}`)
        }
        if (requiresExplicitSelectionSource(model, mode) && String(args.video_model_selection_source ?? '').trim() !== 'user_explicit') {
          throw mediaErrors.input('seedance2.0 系列模型要求 video_model_selection_source=user_explicit（必须是用户明确选择，绝不从语料/示例/容量/失败回退自动选 2.0）')
        }

        const limits = limitsFor(model)
        if (!Number.isFinite(duration) || duration < limits.durationMin || duration > limits.durationMax) {
          throw mediaErrors.input(`（${model}）时长必须在 ${limits.durationMin}-${limits.durationMax} 秒之间，当前 ${duration} 秒。`)
        }
        if (!limits.resolutions.includes(resolution)) {
          throw mediaErrors.input(`（${model}）不支持分辨率 ${resolution}，可选：${limits.resolutions.join(' / ')}。`)
        }

        // ---- confirmation gate (production / production_submit_only; test skips) ----
        const gateErr = confirmationGateError(
          mode,
          { model, resolution, duration },
          {
            model: String(args.video_confirmation_model ?? '').trim() || undefined,
            resolution: String(args.video_confirmation_resolution ?? '').trim() || undefined,
            duration: args.video_confirmation_duration,
          },
        )
        if (gateErr) throw mediaErrors.input(gateErr)

        // ---- task decomposition (unified: N tasks always) ----
        const baseImages: string[] = []
        if (typeof args.image === 'string' && args.image.trim().length > 0) baseImages.push(args.image.trim())
        for (const p of args.images ?? []) if (typeof p === 'string' && p.trim().length > 0) baseImages.push(p.trim())
        const baseVideos = (args.videos ?? []).filter((p: unknown) => typeof p === 'string' && p.trim().length > 0)
        const baseAudios = (args.audios ?? []).filter((p: unknown) => typeof p === 'string' && p.trim().length > 0)
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : []
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
        const specs = buildSpecs(args, base)

        // validate refs + per-command input counts + limits per spec
        const specCommands: VideoCommand[] = specs.map((spec) => selectVideoCommand({ prompt: spec.prompt, images: spec.images.length, videos: spec.videos.length, audios: spec.audios.length, video_command: args.video_command }))
        for (let i = 0; i < specs.length; i += 1) {
          const spec = specs[i]
          const command = specCommands[i]
          const totalRefs = spec.images.length + spec.videos.length + spec.audios.length
          if (totalRefs > 0) {
            await validateRefFiles('image', spec.images)
            await validateRefFiles('video', spec.videos)
            await validateRefFiles('audio', spec.audios)
            if (spec.images.length === 0 && spec.videos.length === 0 && spec.audios.length > 0 && !limits.audioOnlyAllowed) {
              throw mediaErrors.input(`纯音频参考仅支持 seedance2.5 全能参考模式（当前模型 ${model}）。请指定 model_version=2.5，或补充图片/视频参考。`)
            }
            if (limits.total !== undefined && totalRefs > limits.total) {
              throw mediaErrors.input(`全能参考模式（${model}）参考输入总计最多 ${limits.total} 个，当前 ${totalRefs} 个。`)
            }
          }
          if (command === 'image2video' && spec.images.length !== 1) {
            throw mediaErrors.input('image2video 需要恰好一张主图（--image）')
          }
          if (command === 'frames2video' && spec.images.length !== 2) {
            throw mediaErrors.input('frames2video 需要恰好两张图（--first/--last）')
          }
          if ((command === 'image2video' || command === 'frames2video') && (spec.videos.length > 0 || spec.audios.length > 0)) {
            throw mediaErrors.input(`${command} 不支持视频/音频参考`)
          }
        }

        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)
        const store = new TaskStore(join(privateRoot, 'jobs'))

        // ---- group (reuse ONE dated session for all tasks in the call) ----
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

        const buildArgsFor = (command: VideoCommand, spec: TaskSpec): string[] => {
          const head = ['--prompt', spec.prompt, '--model_version', model, '--video_resolution', resolution, '--duration', String(duration), ...sessionArgs, '--poll', '0']
          if (command === 'text2video') return ['text2video', ...head, '--ratio', ratio]
          if (command === 'image2video') return ['image2video', '--image', spec.images[0], ...head]
          if (command === 'frames2video') return ['frames2video', '--first', spec.images[0], '--last', spec.images[1], ...head]
          const refs: string[] = []
          for (const p of spec.images) refs.push('--image', p)
          for (const p of spec.videos) refs.push('--video', p)
          for (const p of spec.audios) refs.push('--audio', p)
          return ['multimodal2video', ...refs, ...head, '--ratio', ratio]
        }
        const submitOne = async (t: { taskId: string; submitSpec: TaskSpec; command: VideoCommand }): Promise<string> => {
          // concurrency gate (upstream seedance-cli max_concurrency = 6)
          const release = await acquireSlot(privateRoot, 'seedance-cli', 6, { taskId: t.taskId, timeoutMs: 180_000 })
          try {
            const submitOut = await runDreamina(config.dreaminaPath, buildArgsFor(t.command, t.submitSpec), 240_000)
            const parsed = parseJson(submitOut)
            if (parsed === undefined || typeof parsed.submit_id !== 'string' || parsed.submit_id.length === 0) {
              throw mediaErrors.provider(`dreamina submit returned no submit_id: ${String(submitOut).slice(0, 300)}`)
            }
            if (parsed.gen_status === 'fail') {
              throw mediaErrors.provider(`dreamina task failed: ${String(parsed.fail_reason ?? 'unknown reason')}`)
            }
            return parsed.submit_id as string
          } finally {
            await release()
          }
        }

        // ---- unified: create + submit EVERY task concurrently (isolated output dirs) ----
        const batchId = `video-${newTaskId()}`
        const tasks: Array<{ taskId: string; spec: TaskSpec; submitSpec: TaskSpec; command: VideoCommand; dir: string }> = []
        for (let i = 0; i < specs.length; i += 1) {
          const spec = specs[i]
          const taskId = newTaskId()
          const dir = await store.taskDir(batchId, taskId)
          await store.create(batchId, taskId, 'video', {
            prompt: redactPrompt(spec.prompt), mode, model, resolution, duration, ratio,
            images: spec.images.map((p) => p), videos: spec.videos.map((p) => p), audios: spec.audios.map((p) => p),
          })
          await store.transition(batchId, taskId, 'running', { model, provider: 'dreamina' })
          await mkdir(join(dir, 'outputs'), { recursive: true })
          // normalize reference images (EXIF orientation + ≤1920 px) into the task's private inputs dir
          const submitImages: string[] = []
          if (spec.images.length > 0) {
            const inputDir = join(dir, 'inputs')
            await mkdir(inputDir, { recursive: true })
            for (const img of spec.images) {
              submitImages.push((await normalizeProviderImage(img, inputDir, 1920)).path)
            }
          }
          const submitSpec: TaskSpec = { ...spec, images: submitImages }
          tasks.push({ taskId, spec, submitSpec, command: specCommands[i], dir })
        }

        // best-effort user_credit probe + subcommand help check before any real submit
        if (config.runHelpBeforeSubmit) {
          try {
            await runDreamina(config.dreaminaPath, [specCommands[0], '-h'], 15000)
          } catch (error: any) {
            await appendSafeLog(privateRoot, 'generate_video', { taskId: tasks[0]?.taskId, event: 'help_check_failed', detail: String(error?.message ?? error).slice(0, 200) })
          }
          try {
            await runDreamina(config.dreaminaPath, ['user_credit'], 20000)
          } catch {
            await appendSafeLog(privateRoot, 'generate_video', { taskId: tasks[0]?.taskId, event: 'user_credit_unavailable' })
          }
        }

        const submitted = await Promise.allSettled(
          tasks.map((t) => submitOne(t)),
        )

        const taskStates: Array<{
          taskId: string
          spec: TaskSpec
          dir: string
          submitId?: string
          failed?: string
          done: boolean
          path?: string
        }> = tasks.map((t, index) => {
          const s = submitted[index]
          return {
            ...t,
            failed: s.status === 'rejected' ? String((s as any).reason?.message ?? (s as any).reason).slice(0, 300) : undefined,
            submitId: s.status === 'fulfilled' ? (s as any).value : undefined,
            done: false,
          }
        })

        for (const t of taskStates) {
          if (t.failed) {
            await store.saveResult(batchId, t.taskId, { status: 'failed', message: t.failed })
            await store.transition(batchId, t.taskId, 'failed', { failureMessage: t.failed })
            continue
          }
          await store.saveResult(batchId, t.taskId, { status: 'submitted', submitId: t.submitId, model, mode })
          await store.transition(batchId, t.taskId, 'running', { submitId: t.submitId, provider: 'dreamina', model, nextAction: mode === 'production' ? 'none' : 'query_later' })
        }

        await appendSafeLog(privateRoot, 'generate_video', { taskId: tasks[0]?.taskId, event: 'submitted', count, group: resolvedGroupName, status: 'submitted' })

        // submit-only modes never poll or download
        if (mode !== 'production') {
          for (const t of taskStates) {
            if (t.failed) continue
            if (mode === 'test_submit_only') {
              await store.transition(batchId, t.taskId, 'success', { submitId: t.submitId, outputPath: undefined, nextAction: 'user_check_backend' })
            } else {
              await store.transition(batchId, t.taskId, 'success', { submitId: t.submitId, nextAction: 'query_later' })
            }
          }
          if (count === 1) {
            return { submit_id: taskStates[0].submitId, done: false, execution_mode: mode, model, ...groupFields }
          }
          const results = taskStates.map((t) =>
            t.failed ? { status: 'failed', error: t.failed, model, execution_mode: mode } : { submit_id: t.submitId, status: 'submitted', model, execution_mode: mode },
          )
          const statuses = new Set(results.map((r) => r.status))
          const aggregate = statuses.size === 1 && statuses.has('submitted') ? 'submitted' : 'partial'
          return { status: aggregate, count, results, done: false, execution_mode: mode, model, ...groupFields }
        }

        // ---- production: unified poll of every task, each into its OWN output dir ----
        const deadline = Date.now() + config.pollTimeoutMs
        const deliverRoot = join(workspaceRoot, config.outputDir)
        await mkdir(deliverRoot, { recursive: true })
        while (Date.now() < deadline) {
          if (exec.signal?.aborted) {
            for (const t of taskStates) {
              if (!t.done && !t.failed) await store.transition(batchId, t.taskId, 'cancelled', { nextAction: 'query_later' })
            }
            throw mediaErrors.cancelled('generate_video aborted')
          }
          let allTerminal = true
          for (const t of taskStates) {
            if (t.done || t.failed) continue
            const taskDir = join(t.dir, 'outputs')
            const queried = parseJson(await runDreamina(config.dreaminaPath, ['query_result', `--submit_id=${t.submitId}`, `--download_dir=${taskDir}`], 90000))
            if (queried?.gen_status === 'fail') {
              await store.transition(batchId, t.taskId, 'failed', { failureMessage: String(queried.fail_reason ?? 'unknown') })
              t.failed = String(queried.fail_reason ?? 'unknown')
              continue
            }
            if (queried?.gen_status === 'success') {
              const video = await pickDownloadedVideo(taskDir, t.submitId as string)
              if (video !== undefined) {
                let finalPath = video
                const requested = args.output?.trim()
                if (count === 1 && requested !== undefined && requested.length > 0) {
                  finalPath = isAbsolute(requested) ? requested : join(workspaceRoot, requested)
                } else {
                  // keep deliverables accessible while polling stays isolated
                  finalPath = join(deliverRoot, `${t.taskId.slice(0, 8)}-${basename(video)}`)
                }
                if (finalPath !== video) {
                  await mkdir(dirname(finalPath), { recursive: true })
                  await rename(video, finalPath)
                }
                await store.saveResult(batchId, t.taskId, { status: 'success', submitId: t.submitId, outputPath: finalPath, model })
                await store.transition(batchId, t.taskId, 'success', { submitId: t.submitId, outputPath: finalPath, model })
                t.done = true
                t.path = finalPath
                continue
              }
              allTerminal = false
            } else {
              allTerminal = false
            }
          }
          if (allTerminal) break
          await sleep(5000)
        }
        // any still-not-terminal task -> needs_review
        for (const t of taskStates) {
          if (t.done || t.failed) continue
          await store.transition(batchId, t.taskId, 'needs_review', { nextAction: 'query_later', submitId: t.submitId })
        }

        if (count === 1) {
          const only = taskStates[0]
          if (only.done && only.path !== undefined) return { path: only.path, submit_id: only.submitId, done: true, execution_mode: mode, model, ...groupFields }
          if (only.failed) throw mediaErrors.provider(`dreamina task failed: ${only.failed}`)
          return { submit_id: only.submitId, done: false, execution_mode: mode, model, ...groupFields }
        }

        const results = taskStates.map((t, index) =>
          t.done && t.path !== undefined
            ? { index: index + 1, submit_id: t.submitId, status: 'success', path: t.path, model, execution_mode: mode }
            : t.failed
              ? { index: index + 1, status: 'failed', error: t.failed, model, execution_mode: mode }
              : { index: index + 1, submit_id: t.submitId, status: 'needs_review', model, execution_mode: mode },
        )
        const statuses = new Set(results.map((r) => r.status))
        const aggregate = statuses.size === 1 && statuses.has('success') ? 'success' : statuses.size === 1 && statuses.has('failed') ? 'failed' : 'partial'
        return { status: aggregate, count, results, done: false, execution_mode: mode, model, ...groupFields }
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
