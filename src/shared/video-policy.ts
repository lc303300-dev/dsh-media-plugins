/**
 * Video model/execution policy (pure domain — no DSH imports).
 *
 * 契约来源：即梦画布 CLI（dreamina-canvas）1.0.2 的实时 `model list`
 * （2026-10-12 实测，公开 cn 制品），而不是旧 `seedance-cli` 的静态表。
 * 旧 CLI 的 canonical 名写作 `seedance2.5`，画布 CLI 写作 `seedance_2.5`，
 * 且公开视频模式只有 `t2v` / `first_last_frame` / `m2v`（没有 i2v）。
 *
 * 本模块保留「策略」职责：
 * - 用户写法 → canonical 模型名（别名表）；
 * - default model seedance_2.5 / default resolution 480p；
 * - test 通道强制最低成本模型 + 720p 且只提交不轮询；
 * - 非默认模型必须由用户显式选择（`video_model_selection_source=user_explicit`），
 *   绝不从语料/示例/容量/失败回退自动降级；
 * - prompt 里的比例/时长提示作为兜底。
 *
 * 实时规格（比例/分辨率/时长/参考上限）以 `model list` 下发为准，本文件的
 * `ModelLimits` 只在拿不到目录时兜底（见 `limitsFor`）。
 *
 * @module dsh-media-plugins/shared/video-policy
 */

export const VIDEO_EXECUTION_MODES = ['production', 'production_submit_only', 'test_submit_only'] as const
export type VideoExecutionMode = (typeof VIDEO_EXECUTION_MODES)[number]

/**
 * 旧的命令行契约名（text2video 等）仍被调用方与提示词文档使用；画布 CLI 侧
 * 由 `shared/dreamina-canvas.ts` 的 `selectCanvasVideoMode` 翻译成公开模式。
 */
export const VIDEO_COMMANDS = ['text2video', 'image2video', 'frames2video', 'multimodal2video'] as const
export type VideoCommand = (typeof VIDEO_COMMANDS)[number]

/**
 * Default VIDEO-only submit capacity: one `generate_video` call fills a batch to
 * this many tasks, and each task may carry its own `tasks[].duration` — batches
 * are NEVER split by duration (user instruction, 2026-10-06). 画布 CLI 侧每个
 * 任务是一条独立的节点提交，因此这里限制的是「同时在跑的 CLI 提交数」。
 */
export const DEFAULT_VIDEO_CAPACITY = 10

/** test 通道使用当前目录里最低成本的可调用模型（非 VIP 语义在画布 CLI 已不存在）。 */
export const TEST_CHANNEL_MODEL = 'seedance_2.0_mini'

/** test 通道固定分辨率。 */
export const TEST_CHANNEL_RESOLUTION = '720p'

/** 默认模型（画布 CLI canonical 名）。 */
export const DEFAULT_VIDEO_MODEL = 'seedance_2.5'

/** Model alias -> 画布 CLI canonical model id. */
export const MODEL_ALIASES: Record<string, string> = {
  // 用户口语版本号
  '2.5': 'seedance_2.5',
  '2.0': 'seedance_2.0_vip',
  '2.0_vip': 'seedance_2.0_vip',
  '2.0fast': 'seedance_2.0_fast_vip',
  '2.0fast_vip': 'seedance_2.0_fast_vip',
  '2.0mini': 'seedance_2.0_mini',
  '1.0fast': 'seedance_pro_fast',
  '3.0': 'wan_3.0',
  // 旧 CLI 的 canonical 写法（迁移期兼容，避免历史调用直接失效）
  'seedance2.5': 'seedance_2.5',
  'seedance2.0': 'seedance_2.0_vip',
  'seedance2.0_vip': 'seedance_2.0_vip',
  'seedance2.0fast': 'seedance_2.0_fast_vip',
  'seedance2.0fast_vip': 'seedance_2.0_fast_vip',
  'seedance2.0mini': 'seedance_2.0_mini',
  'seedance_1.0_fast': 'seedance_pro_fast',
  'wan3.0': 'wan_3.0',
  'happyhorse1.1': 'happyhorse_1.1',
  // 半归一化写法（下划线前缀但旧拼写）：`seedance_2.0fast` 这类混合形态也要吃住
  'seedance_2.0': 'seedance_2.0_vip',
  'seedance_2.0fast': 'seedance_2.0_fast_vip',
  'seedance_2.0mini': 'seedance_2.0_mini',
}

/** 画布 CLI 当前公开的可调用视频模型（实测目录；`model list` 仍是权威）。 */
export const SUPPORTED_VIDEO_MODELS = new Set([
  'seedance_2.5',
  'seedance_2.0_vip',
  'seedance_2.0_fast_vip',
  'seedance_2.0_mini',
  'seedance_pro_fast',
  'wan_3.0',
  'happyhorse_1.1',
])

export interface ModelLimits {
  /** 参考素材总数上限。 */
  total: number
  durationMin: number
  durationMax: number
  /** 小写化的分辨率取值。 */
  resolutions: string[]
  ratios: string[]
  audioOnlyAllowed: boolean
  /** 该模型是否提供 m2v（多模态参考）模式。 */
  supportsMultimodal: boolean
}

export const LIMITS_SEEDANCE_2_5: ModelLimits = {
  total: 50,
  durationMin: 4,
  durationMax: 30,
  resolutions: ['480p', '720p', '1080p'],
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  audioOnlyAllowed: true,
  supportsMultimodal: true,
}

export const LIMITS_SEEDANCE_2_0_VIP: ModelLimits = {
  total: 12,
  durationMin: 4,
  durationMax: 15,
  resolutions: ['720p', '1080p', '4k'],
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  audioOnlyAllowed: false,
  supportsMultimodal: true,
}

export const LIMITS_SEEDANCE_2_0_FAST: ModelLimits = {
  total: 12,
  durationMin: 4,
  durationMax: 15,
  resolutions: ['720p'],
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  audioOnlyAllowed: false,
  supportsMultimodal: true,
}

export const LIMITS_WAN_3_0: ModelLimits = {
  total: 20,
  durationMin: 4,
  durationMax: 15,
  resolutions: ['720p', '1080p'],
  ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
  audioOnlyAllowed: false,
  supportsMultimodal: true,
}

export const LIMITS_HAPPYHORSE: ModelLimits = {
  total: 9,
  durationMin: 4,
  durationMax: 15,
  resolutions: ['720p', '1080p'],
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  audioOnlyAllowed: false,
  supportsMultimodal: true,
}

/** 只提供 t2v / first_last_frame（没有 m2v）的模型。 */
export const LIMITS_FRAMES_ONLY: ModelLimits = {
  total: 2,
  durationMin: 5,
  durationMax: 10,
  resolutions: ['720p', '1080p'],
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  audioOnlyAllowed: false,
  supportsMultimodal: false,
}

export function normalizeModel(value: string | undefined): string {
  if (!value) return value as unknown as string
  return MODEL_ALIASES[value] ?? MODEL_ALIASES[value.toLowerCase()] ?? value
}

export function limitsFor(model: string): ModelLimits {
  switch (model) {
    case 'seedance_2.5':
      return LIMITS_SEEDANCE_2_5
    case 'seedance_2.0_vip':
      return LIMITS_SEEDANCE_2_0_VIP
    case 'seedance_2.0_fast_vip':
    case 'seedance_2.0_mini':
      return LIMITS_SEEDANCE_2_0_FAST
    case 'wan_3.0':
      return LIMITS_WAN_3_0
    case 'happyhorse_1.1':
      return LIMITS_HAPPYHORSE
    case 'seedance_pro_fast':
      return LIMITS_FRAMES_ONLY
    default:
      return LIMITS_FRAMES_ONLY
  }
}

export function isSupportedVideoModel(model: string): boolean {
  return SUPPORTED_VIDEO_MODELS.has(model)
}

/** 分辨率比较：画布 CLI 同一目录里出现 `720p` 与 `720P` 两种拼写。 */
export function resolutionEquals(a: string, b: string): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

/**
 * Model policy: test 通道强制最低成本模型；其余原样透传（别名已在
 * `normalizeModel` 解析）。画布 CLI 不再有「非 VIP 2.0」这一档，因此旧的
 * 2.0 系列一律归一到 `seedance_2.0_vip`。
 */
export function resolveVideoModel(mode: VideoExecutionMode, userModel: string): string {
  if (mode === 'test_submit_only') return TEST_CHANNEL_MODEL
  // 别名归一化放在这里，保证任何调用路径（工具层、测试、旧调用方）拿到的
  // 都是画布 CLI 的 canonical 名，而不是用户口语写法。
  return normalizeModel(userModel)
}

/** Resolution policy: test 通道强制 720p；否则请求值或默认值。 */
export function resolveVideoResolution(
  mode: VideoExecutionMode,
  requested: string | undefined,
  defaultResolution: string,
): string {
  if (mode === 'test_submit_only') return TEST_CHANNEL_RESOLUTION
  return requested ?? defaultResolution
}

/** A non-default model requires an explicit user selection marker. */
export function requiresExplicitSelectionSource(model: string, mode: VideoExecutionMode): boolean {
  return mode !== 'test_submit_only' && model !== DEFAULT_VIDEO_MODEL
}

/** 首尾帧语义触发词（用于单图/双图时判断是否走 first_last_frame）。 */
export const FIRST_LAST_PATTERN = /(?:首尾帧|首帧.{0,8}尾帧|first.{0,8}last\s+frame|start.{0,8}end\s+frame)/i

export interface CommandRequest {
  prompt: string
  images: number
  videos: number
  audios: number
  video_command?: string
}

/**
 * 兼容层的命令选择（旧契约名）。真正的画布模式由
 * `shared/dreamina-canvas.ts#selectCanvasVideoMode` 决定；这里保留是为了让
 * 既有调用方与文档继续按 text2video/image2video/frames2video/multimodal2video
 * 表达意图，并保证 `multiframe2video` 永远不会被产出。
 */
export function selectVideoCommand(req: CommandRequest): VideoCommand {
  if (req.video_command) {
    if (req.video_command === 'multiframe2video') {
      throw new Error('multiframe2video is a disabled legacy command; use multimodal2video')
    }
    if (!(VIDEO_COMMANDS as readonly string[]).includes(req.video_command)) {
      // 新公开模式名也接受（t2v / first_last_frame / m2v），原样返回以便上层映射
      if (req.video_command === 't2v') return 'text2video'
      if (req.video_command === 'first_last_frame') return 'frames2video'
      if (req.video_command === 'm2v') return 'multimodal2video'
      throw new Error(`Unsupported video command: ${req.video_command}`)
    }
    return req.video_command as VideoCommand
  }
  if (req.videos > 0 || req.audios > 0) return 'multimodal2video'
  if (req.images === 0) return 'text2video'
  if (req.images === 2 && FIRST_LAST_PATTERN.test(req.prompt)) return 'frames2video'
  return 'multimodal2video'
}

/**
 * Explicit duration declaration only (`视频时长：N 秒` / `video duration: N`).
 *
 * Deliberately narrower than `promptPreferences`: the bare-number fallback there
 * exists for upstream `_prompt_preferences` compatibility, and it misfires on
 * storyboard timelines — `2.5-5秒` reads as a 5-second video. Batch planning must
 * use this stricter form so a timecoded prompt never overrides the batch duration.
 */
export function promptDurationLabel(prompt: string): number | undefined {
  const labelled = /(?:视频时长|video\s*duration)\s*[:：]?\s*(\d{1,2})\s*(?:秒|s(?:ec(?:onds?)?)?)/i.exec(prompt)
  if (!labelled) return undefined
  const n = Number(labelled[1])
  return n >= 4 && n <= 30 ? n : undefined
}

/**
 * Extract ratio/duration hints embedded in the prompt (upstream
 * `_prompt_preferences`). Never interprets terminal telemetry as a duration.
 */
export function promptPreferences(prompt: string): { ratio?: string; duration?: number } {
  const ratio = ['21:9', '16:9', '9:16', '4:3', '3:4', '1:1'].find((v) => prompt.includes(v))
  let duration = promptDurationLabel(prompt)
  if (duration === undefined) {
    const match = /(?<![.\d])([4-9]|[12]\d|30)\s*(?:秒|s(?:ec(?:onds?)?)?)/i.exec(prompt)
    if (match) {
      const n = Number(match[1])
      if (n >= 4 && n <= 30) duration = n
    }
  }
  return { ratio, duration }
}
