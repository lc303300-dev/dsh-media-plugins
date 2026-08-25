/**
 * Video pipeline selection helpers (pure domain — no DSH imports).
 *
 * The core guarantee behind precise polling is: never pick another task's
 * video. The selection is purely a function of (a) the set of candidate
 * files inside ONE task's own download directory and (b) the task's
 * submit_id. Higher layers guarantee the directory is task-isolated; this
 * module guarantees the filename/validity ordering.
 *
 * @module dsh-media-plugins/shared/video-pipeline
 */

export const VIDEO_FILE_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'] as const

/** Terminal-execution metadata that must never be treated as a prompt (Codex service.validate_prompt_completeness). */
export const PROMPT_TERMINAL_METADATA = /^\s*(?:Exit code|Wall time|Output|Script completed|Script error)\s*:/im

/** Deterministic prompt boundary: reject empty prompts and terminal metadata leakage. */
export function promptCompletenessBoundaryIssue(prompt: string): string | null {
  const text = (prompt ?? '').trim()
  if (!text) return 'Prompt is empty'
  if (PROMPT_TERMINAL_METADATA.test(text)) return 'Prompt contains terminal execution metadata'
  return null
}

export function isVideoExtName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return (VIDEO_FILE_EXTENSIONS as readonly string[]).includes(name.slice(dot).toLowerCase())
}

export interface DownloadCandidate {
  name: string
  mtimeMs: number
  /** Passes the validity check (readable, non-empty, real container). */
  valid: boolean
}

/**
 * Choose which downloaded file belongs to `submitId` from one task's own
 * download folder. Strict priority: a filename containing the submit_id wins
 * (and among those the newest valid one); if none matches, fall back to the
 * newest valid video in the same isolated directory. Returns undefined when
 * nothing is valid yet (the task is still writing / not ready).
 */
export function pickDownloadedVideo(candidates: DownloadCandidate[], submitId: string): DownloadCandidate | undefined {
  const videos = candidates.filter((c) => isVideoExtName(c.name))
  if (videos.length === 0) return undefined
  const want = submitId.trim().toLowerCase()
  const bySubmit = videos.filter((c) => c.name.toLowerCase().includes(want))
  const pool = bySubmit.length > 0 ? bySubmit : videos
  const valid = pool.filter((c) => c.valid)
  if (valid.length === 0) return undefined
  return valid.reduce((best, c) => (c.mtimeMs > best.mtimeMs ? c : best))
}

/**
 * Deterministic confirmation gate (Codex_image video_router contract):
 * formal (non-test) submission requires the caller to re-declare the
 * confirmed model / resolution / duration and each must equal the resolved
 * value. Duration accepts plain integers or the `5`/`5s`/`5秒` forms.
 * Returns a cleartext error message, or null when the gate passes.
 */
export function confirmationGateError(
  mode: string,
  resolved: { model: string; resolution: string; duration: number },
  confirmed: { model?: string; resolution?: string; duration?: unknown },
): string | null {
  if (mode === 'test_submit_only') return null
  if (!confirmed.model || !confirmed.resolution || confirmed.duration === undefined || confirmed.duration === null) {
    return 'formal video submission requires confirmation of model, resolution, and duration (pass video_confirmation_model / video_confirmation_resolution / video_confirmation_duration)'
  }
  const match = /^(\d{1,2})\s*(?:s(?:ec(?:onds?)?)?|秒)?$/i.exec(String(confirmed.duration).trim())
  if (!match) return `confirmed video duration "${confirmed.duration}" is not a valid integer duration`
  const cDur = Number(match[1])
  if (confirmed.model !== resolved.model) return `confirmed video model ${confirmed.model} does not match the final request ${resolved.model}`
  if (confirmed.resolution !== resolved.resolution) return `confirmed video resolution ${confirmed.resolution} does not match the final request ${resolved.resolution}`
  if (cDur !== resolved.duration) return `confirmed video duration ${cDur} does not match the final request ${resolved.duration}`
  return null
}

/* ------------------------------------------------------------------ */
/* 创作完整性门（dt-video-prompt 编排器：完整/不完整 → 是否必须查语料） */
/* ------------------------------------------------------------------ */

export type PromptCompletenessVerdict = 'complete' | 'incomplete'

export interface CompletenessMedia {
  images: number
  videos: number
  audios: number
}

/**
 * Chinese bare reference labels (图片N/视频N/音频N), per the adapter contract
 * (refs/first-frame-rules.md, default-video-generation SKILL.md): no `@` chip,
 * no `参考` prefix, no English form. Optional whitespace between the kind and
 * the number still counts as a binding (it is normalizable).
 */
export const BARE_REF_LABEL = /(?:图片|视频|音频)\s*\d+/

/**
 * Non-conforming reference forms that must be normalized away before submit:
 * `@图片1` / `@Image 1` chips, `参考图片1` prefixes, and English kind tokens.
 */
export const NONCONFORMING_REF_LABEL = /(?:@\s*(?:图片|视频|音频|[Ii]mage|[Vv]ideo|[Aa]udio|[Ii][Mm][Gg])\s*\d+|参考\s*(?:图片|视频|音频)\s*\d+)/

/** Map an (English or Chinese) reference kind token to its Chinese bare kind. */
function refKindToChinese(kind: string): '图片' | '视频' | '音频' {
  const k = String(kind).toLowerCase()
  if (k === '视频' || k.startsWith('vid') || k === 'video') return '视频'
  if (k === '音频' || k.startsWith('aud') || k === 'audio') return '音频'
  return '图片'
}

export interface ReferenceLabelNormalization {
  prompt: string
  changed: string[]
}

/**
 * Deterministic, idempotent reference-label normalization to the adapter's
 * bare-label contract: `@图片1` / `@Image 1` / `参考图片2` / `图片 3` →
 * `图片N`. Only the label token is rewritten; all other prompt text is left
 * untouched. Returns the normalized prompt and a human-readable change log.
 */
export function normalizeReferenceLabels(prompt: string): ReferenceLabelNormalization {
  const source = String(prompt ?? '')
  if (!source) return { prompt: source, changed: [] }
  const changed: string[] = []
  let text = source
  // 1) `@` chip forms (including English): @图片1, @图片 1, @Image 1, @IMG 2
  text = text.replace(/@\s*(图片|视频|音频|[Ii]mage|[Vv]ideo|[Aa]udio|[Ii][Mm][Gg])\s*(\d+)/g, (whole, kind: string, num: string) => {
    const label = `${refKindToChinese(kind)}${num}`
    changed.push(`${whole} → ${label}`)
    return label
  })
  // 2) `参考` prefix forms: 参考图片1, 参考图片 1
  text = text.replace(/参考\s*(图片|视频|音频)\s*(\d+)/g, (whole, kind: string, num: string) => {
    const label = `${kind}${num}`
    changed.push(`${whole} → ${label}`)
    return label
  })
  // 3) whitespace inside an otherwise-bare label: 图片 1 → 图片1 (1-2 digits;
  //    the lookahead keeps multi-digit numbers like years from being split)
  text = text.replace(/(图片|视频|音频)\s+(\d{1,2})(?!\d)/g, (whole, kind: string, num: string) => {
    const label = `${kind}${num}`
    changed.push(`${whole} → ${label}`)
    return label
  })
  return { prompt: text, changed: [...new Set(changed)] }
}

/**
 * Deterministic completeness classifier for a video generation prompt
 * (Codex_DT non-destructive gate). A prompt is "complete" only when it
 * carries (a) an executable subject/action, (b) camera/motion or temporal
 * progression, and (c) reference bindings for the supplied media — where the
 * bindings must use the adapter's bare labels (图片N/视频N/音频N), not
 * `@图片N` chips or `参考图片N` prefixes. Anything missing returns
 * "incomplete" with the specific reasons, so the orchestrator knows it must
 * consult the corpus before authoring.
 */
export function classifyVideoPromptCompleteness(prompt: string, media: CompletenessMedia): { verdict: PromptCompletenessVerdict; reasons: string[] } {
  const text = (prompt ?? '').trim()
  const reasons: string[] = []
  if (!text) {
    return { verdict: 'incomplete', reasons: ['prompt is empty'] }
  }
  const hasSubjectOrAction = /(?:镜头|机位|画面|展现|穿过|掠过|飞越|航拍|穿行|推进|拉升|环绕|驶|奔|飞|走|主体|人物|角色|它|他|她)/.test(text)
  const hasCameraOrTemporal = /(?:镜头|机位|运镜|推进|推近|环绕|航拍|低空|平视|俯视|仰拍|横移|跟拍|摇|弧线|俯冲|侧倾|\d+-\d+|\d+\s*秒|第一段|第二段|镜头[一二三四五六七八九十\d])/.test(text)
  const hasRefs = media.images + media.videos + media.audios > 0
  const hasBareBinding = hasRefs ? BARE_REF_LABEL.test(text) : true
  const hasNonConformingBinding = hasRefs ? NONCONFORMING_REF_LABEL.test(text) : false
  if (!hasSubjectOrAction) reasons.push('缺少可执行的主体/动作或镜头意图')
  if (!hasCameraOrTemporal) reasons.push('缺少镜头/运镜或时间推进')
  if (hasRefs && !hasBareBinding) {
    reasons.push('缺少素材引用绑定（图片/视频/音频编号）')
  } else if (hasRefs && hasNonConformingBinding) {
    reasons.push('素材引用必须使用中文裸标签（图片N/视频N/音频N），禁用 @图片N、参考图片N、@Image N 等变体')
  }
  return { verdict: reasons.length === 0 ? 'complete' : 'incomplete', reasons }
}

/** Deterministic rule: an incomplete prompt must consult the corpus before authoring. */
export function completenessRequiresCorpus(verdict: PromptCompletenessVerdict): boolean {
  return verdict === 'incomplete'
}

/**
 * Authoring gate: if the prompt is incomplete but no corpus retrieval was
 * performed, authoring must be rejected so the corpus step cannot be skipped.
 */
export function authoringCorpusGateError(verdict: PromptCompletenessVerdict, corpusHits: number): string | null {
  if (verdict === 'incomplete' && (!Number.isFinite(corpusHits) || corpusHits < 1)) {
    return 'incomplete prompt requires corpus retrieval (run prompt_revision search_corpus and pass corpus_hits) before authoring'
  }
  return null
}
