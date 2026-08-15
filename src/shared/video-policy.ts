/**
 * Video model/execution policy (pure domain — no DSH imports).
 *
 * Contract (Codex_image AGENTS.md / UNIFIED_MEDIA_TOOL_REFACTOR_BLUEPRINT):
 * - default model seedance2.5, default resolution 480p;
 * - test_submit_only forces non-VIP seedance2.0 + 720p + poll=0 and never
 *   queries/downloads;
 * - ordinary explicit 2.0-series (non-VIP, non-test) normalizes to
 *   seedance2.0_vip;
 * - multiframe2video is disabled legacy — the command selector never emits it.
 *
 * @module dsh-media-plugins/shared/video-policy
 */

export const VIDEO_EXECUTION_MODES = ['production', 'production_submit_only', 'test_submit_only'] as const
export type VideoExecutionMode = (typeof VIDEO_EXECUTION_MODES)[number]

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
  resolutions: ['480p', '720p'],
  ratios: ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'],
  audioOnlyAllowed: true,
}

export const LIMITS_SEEDANCE_2_0: ModelLimits = {
  total: 12,
  durationMin: 4,
  durationMax: 15,
  resolutions: ['720p', '1080p', '4k'],
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

/**
 * CLI subcommand selection. The disabled legacy `multiframe2video` is never
 * produced; any reference input (or audio) routes to multimodal2video.
 */
export function selectVideoSubcommand(totalRefs: number): 'text2video' | 'multimodal2video' {
  return totalRefs > 0 ? 'multimodal2video' : 'text2video'
}
