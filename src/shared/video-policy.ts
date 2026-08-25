/**
 * Video model/execution policy (pure domain — no DSH imports).
 *
 * Contract (Codex_image video_router.py / UNIFIED_MEDIA_TOOL_REFACTOR_BLUEPRINT):
 * - default model seedance2.5, default resolution 480p; seedance2.5 supports
 *   480p/720p/1080p (aligned with the upstream video_router allowlist);
 * - test_submit_only forces non-VIP seedance2.0 + 720p + poll=0 and never
 *   queries/downloads;
 * - ordinary explicit 2.0-series (non-VIP, non-test) normalizes to
 *   seedance2.0_vip; non-default 2.0 selection requires
 *   `video_model_selection_source=user_explicit` (never infer/fall back);
 * - command set: text2video / image2video / frames2video / multimodal2video;
 *   multiframe2video is disabled legacy — the command selector never emits it;
 * - prompt may carry ratio/duration hints (promptPreferences) used as
 *   fallback when not passed as structured parameters.
 *
 * @module dsh-media-plugins/shared/video-policy
 */

export const VIDEO_EXECUTION_MODES = ['production', 'production_submit_only', 'test_submit_only'] as const
export type VideoExecutionMode = (typeof VIDEO_EXECUTION_MODES)[number]

export const VIDEO_COMMANDS = ['text2video', 'image2video', 'frames2video', 'multimodal2video'] as const
export type VideoCommand = (typeof VIDEO_COMMANDS)[number]

/** Model alias -> official CLI model id (auto-completes the seedance prefix). */
export const MODEL_ALIASES: Record<string, string> = {
  '2.0': 'seedance2.0',
  '2.0fast': 'seedance2.0fast',
  '2.0_vip': 'seedance2.0_vip',
  '2.0fast_vip': 'seedance2.0fast_vip',
  '2.0mini': 'seedance2.0mini',
  '2.5': 'seedance2.5',
}

/** Non-VIP 2.0-series models: only reachable through the test channel. */
export const NON_VIP_2_0 = new Set(['seedance2.0', 'seedance2.0fast', 'seedance2.0mini'])

export const SUPPORTED_VIDEO_MODELS = new Set([
  'seedance2.5', 'seedance2.0', 'seedance2.0fast', 'seedance2.0_vip', 'seedance2.0fast_vip', 'seedance2.0mini',
])

export interface ModelLimits {
  total: number
  durationMin: number
  durationMax: number
  resolutions: string[]
  ratios: string[]
  audioOnlyAllowed: boolean
}

export const LIMITS_SEEDANCE_2_5: ModelLimits = {
  total: 50,
  durationMin: 4,
  durationMax: 30,
  resolutions: ['480p', '720p', '1080p'],
  ratios: ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'],
  audioOnlyAllowed: true,
}

export const LIMITS_SEEDANCE_2_0: ModelLimits = {
  total: 12,
  durationMin: 4,
  durationMax: 15,
  resolutions: ['480p', '720p', '1080p', '4k'],
  ratios: ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'],
  audioOnlyAllowed: false,
}

export const LIMITS_OTHER: ModelLimits = {
  total: 12,
  durationMin: 4,
  durationMax: 15,
  resolutions: ['720p'],
  ratios: ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'],
  audioOnlyAllowed: false,
}

export function normalizeModel(value: string | undefined): string {
  if (!value) return value as unknown as string
  return MODEL_ALIASES[value] ?? value
}

export function limitsFor(model: string): ModelLimits {
  if (model === 'seedance2.5') return LIMITS_SEEDANCE_2_5
  if (model === 'seedance2.0_vip' || model === 'seedance2.0fast_vip') return LIMITS_SEEDANCE_2_0
  return LIMITS_OTHER
}

export function isSupportedVideoModel(model: string): boolean {
  return SUPPORTED_VIDEO_MODELS.has(model)
}

/**
 * Model policy: test channel forces non-VIP seedance2.0; ordinary explicit
 * 2.0-series normalizes to seedance2.0_vip; everything else passes through.
 */
export function resolveVideoModel(mode: VideoExecutionMode, userModel: string): string {
  if (mode === 'test_submit_only') return 'seedance2.0'
  return NON_VIP_2_0.has(userModel) ? 'seedance2.0_vip' : userModel
}

/** Resolution policy: test channel forces 720p; otherwise requested or default. */
export function resolveVideoResolution(
  mode: VideoExecutionMode,
  requested: string | undefined,
  defaultResolution: string,
): string {
  if (mode === 'test_submit_only') return '720p'
  return requested ?? defaultResolution
}

/** A non-default (2.0-family) model requires an explicit user selection marker. */
export function requiresExplicitSelectionSource(model: string, mode: VideoExecutionMode): boolean {
  return mode !== 'test_submit_only' && model !== 'seedance2.5'
}

/** First/last frame semantics trigger for a 2-image frames2video request. */
export const FIRST_LAST_PATTERN = /(?:首尾帧|首帧.{0,8}尾帧|first.{0,8}last\s+frame|start.{0,8}end\s+frame)/i

export interface CommandRequest {
  prompt: string
  images: number
  videos: number
  audios: number
  video_command?: string
}

/**
 * CLI subcommand selection (upstream video_router.select_video_command).
 * The disabled legacy `multiframe2video` is never produced. Explicit
 * `video_command` wins; otherwise: any video/audio -> multimodal; no images
 * -> text2video; two images with first/last semantics -> frames2video;
 * otherwise -> multimodal2video (the default for any image reference).
 */
export function selectVideoCommand(req: CommandRequest): VideoCommand {
  if (req.video_command) {
    if (req.video_command === 'multiframe2video') {
      throw new Error('multiframe2video is a disabled legacy command; use multimodal2video')
    }
    if (!(VIDEO_COMMANDS as readonly string[]).includes(req.video_command)) {
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
 * Extract ratio/duration hints embedded in the prompt (upstream
 * `_prompt_preferences`). Never interprets terminal telemetry as a duration.
 */
export function promptPreferences(prompt: string): { ratio?: string; duration?: number } {
  const ratio = ['21:9', '16:9', '9:16', '4:3', '3:4', '1:1'].find((v) => prompt.includes(v))
  let duration: number | undefined
  const labelled = /(?:视频时长|video\s*duration)\s*[:：]?\s*(\d{1,2})\s*(?:秒|s(?:ec(?:onds?)?)?)/i.exec(prompt)
  const match = labelled || /(?<![.\d])([4-9]|[12]\d|30)\s*(?:秒|s(?:ec(?:onds?)?)?)/i.exec(prompt)
  if (match) {
    const n = Number(match[1])
    if (n >= 4 && n <= 30) duration = n
  }
  return { ratio, duration }
}
