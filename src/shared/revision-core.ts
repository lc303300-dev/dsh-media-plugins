/**
 * Prompt revision domain (Codex_DT classify_revision.py port, all-JS):
 * deterministic feedback classification + constrained revision request /
 * result contract with canonical hashes. Pure domain — no DSH imports.
 *
 * Contract (docs/prompt_revision_workflow.md + schemas/):
 * - classification: explicit_local | ambiguous_creative | structural_rewrite;
 * - explicit_local never searches the corpus; the other classes cap at 10;
 * - the result must echo the request's locked_context_sha256 so callers can
 *   reject revisions produced against a stale contract;
 * - the classifier never rewrites prompts, never searches the corpus, never
 *   submits media.
 *
 * @module dsh-media-plugins/shared/revision-core
 */

import { createHash } from 'node:crypto'
import { VIDEO_RATIOS } from './ratios.ts'

export type RevisionClass = 'explicit_local' | 'ambiguous_creative' | 'structural_rewrite'

/** Ratios a revision may lock; same 6 video ratios as the pipeline contract. */
export const VALID_REVISION_RATIOS = VIDEO_RATIOS

export interface LockedContext {
  contract_rules: string[]
  material_order: string[]
  ratio: string
  duration_seconds: number
}

export interface RevisionInput {
  current_prompt: string
  user_feedback: string
  locked_context: LockedContext
}

const STRUCTURAL_PATTERNS: RegExp[] = [
  /(?:整体|全部|整段|从头|彻底).{0,8}(?:重写|重构|重做|改写|重新设计|重新编排)/i,
  /(?:重写|重构|重做|改写|重新设计|重新编排).{0,8}(?:整体|全部|整段|叙事|结构|镜头顺序|时间线)/i,
  /(?:叙事|故事线|时间线|镜头顺序|段落结构).{0,8}(?:重构|重排|重写|重做|调整)/i,
  /(?:重新分配|重排).{0,8}(?:所有|全部|整体|镜头|时间|节奏)/i,
]

const AMBIGUOUS_PATTERNS: RegExp[] = [
  /^(?:不满意|不好|不行|不对|再改改|优化一下|调整一下|重来|换一个)[。！!,.， ]*$/,
  /(?:更|不够|太).{0,5}(?:高级|震撼|电影感|有感觉|大气|精彩|好看|自然|流畅|专业|吸引人)/,
  /(?:整体|画面|感觉|效果).{0,5}(?:一般|平淡|无聊|不好|不够|不对)/,
  /(?:提升|加强|优化|改善).{0,5}(?:质感|氛围|风格|感觉|效果|创意)$/,
]

const LOCAL_TARGET_PATTERNS: RegExp[] = [
  /第[一二三四五六七八九十\d]+(?:个|段|镜|镜头|秒)/,
  /(?:开头|结尾|首帧|尾帧|某个镜头|这个镜头|运镜|动作|音乐|音效|字幕|光线|色调|速度|时长|比例|画幅)/,
  /\d+(?:\.\d+)?\s*(?:秒|s|帧|%)/,
  /(?:改成|换成|替换为|删除|去掉|不要|保留|增加|添加|缩短|延长|调到|改为)/,
]

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

/** Classify user feedback into a stable revision class with human-readable reasons. */
export function classifyFeedback(userFeedback: string): { classification: RevisionClass; reasons: string[] } {
  const feedback = String(userFeedback ?? '').replace(/\s+/g, ' ').trim()
  if (!feedback) throw new Error('user_feedback must not be empty')

  if (matchesAny(STRUCTURAL_PATTERNS, feedback)) {
    return { classification: 'structural_rewrite', reasons: ['反馈明确要求重排叙事、时间线或整体提示词结构。'] }
  }
  const hasAmbiguousSignal = matchesAny(AMBIGUOUS_PATTERNS, feedback)
  const hasLocalTarget = matchesAny(LOCAL_TARGET_PATTERNS, feedback)
  if (hasAmbiguousSignal && !hasLocalTarget) {
    return { classification: 'ambiguous_creative', reasons: ['反馈表达审美目标或不满意，但缺少可直接执行的局部修改。'] }
  }
  if (hasLocalTarget) {
    return { classification: 'explicit_local', reasons: ['反馈包含明确的修改对象、位置、参数或替换动作。'] }
  }
  return { classification: 'ambiguous_creative', reasons: ['反馈没有形成可确定执行的局部编辑指令。'] }
}

/** Canonical JSON hash matching the Python implementation
 * (json.dumps ensure_ascii=False, sort_keys=True, separators=(",", ":")). */
export function canonicalHash(value: unknown): string {
  const encoded = canonicalStringify(value)
  return createHash('sha256').update(encoded, 'utf8').digest('hex')
}

function canonicalStringify(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Validate a revision input; throws with a precise message. */
export function validateRevisionInput(payload: unknown): asserts payload is RevisionInput {
  const input = payload as Partial<RevisionInput>
  if (!input || typeof input !== 'object') throw new Error('input must be an object')
  if (typeof input.current_prompt !== 'string' || !input.current_prompt.trim()) {
    throw new Error('current_prompt must be a non-empty string')
  }
  if (typeof input.user_feedback !== 'string' || !input.user_feedback.trim()) {
    throw new Error('user_feedback must be a non-empty string')
  }
  const locked = input.locked_context as Partial<LockedContext> | undefined
  if (!locked || typeof locked !== 'object') throw new Error('locked_context must be an object')
  if (!Array.isArray(locked.contract_rules) || !locked.contract_rules.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('locked_context.contract_rules must be a list of non-empty strings')
  }
  if (!Array.isArray(locked.material_order) || !locked.material_order.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('locked_context.material_order must be a list of non-empty strings')
  }
  if (!VALID_REVISION_RATIOS.includes(locked.ratio as any)) {
    throw new Error(`locked_context.ratio must be one of: ${[...VALID_REVISION_RATIOS].join(', ')}`)
  }
  const duration = locked.duration_seconds
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('locked_context.duration_seconds must be a positive number')
  }
}

/** Build a constrained DT revision request (classify only; no rewrite/corpus/media). */
export function buildRevisionRequest(payload: RevisionInput): Record<string, unknown> {
  validateRevisionInput(payload)
  const { classification, reasons } = classifyFeedback(payload.user_feedback)
  const shouldSearch = classification !== 'explicit_local'
  const scope =
    classification === 'explicit_local'
      ? '仅修改用户明确指出的局部内容'
      : '按用户反馈优化，但保留所有锁定上下文'

  return {
    schema_version: '1.0',
    kind: 'codex_dt_prompt_revision_request',
    classification,
    classification_reasons: reasons,
    should_search_corpus: shouldSearch,
    corpus_search: {
      max_results: shouldSearch ? 10 : 0,
      purpose: shouldSearch ? '仅提取可迁移的镜头结构或导演方法，不复制案例提示词。' : '明确局部修改不需要语料库。',
    },
    current_prompt: payload.current_prompt,
    current_prompt_sha256: canonicalHash(payload.current_prompt),
    user_feedback: payload.user_feedback,
    locked_context: payload.locked_context,
    locked_context_sha256: canonicalHash(payload.locked_context),
    revision_policy: {
      scope,
      preserve_unspecified_content: true,
      contract_rules_are_immutable: true,
      material_order_is_immutable: true,
      ratio_is_immutable_unless_feedback_explicitly_changes_project_settings: true,
      duration_is_immutable_unless_feedback_explicitly_changes_project_settings: true,
      forbid_model_selection_from_corpus: true,
      forbid_media_submission: true,
    },
    required_result_fields: [
      'schema_version',
      'kind',
      'classification',
      'revised_prompt',
      'changed_sections',
      'preserved_unspecified_content',
      'locked_context_sha256',
      'corpus_usage',
    ],
  }
}

export interface RevisionResult {
  schema_version: string
  kind: string
  classification: RevisionClass
  revised_prompt: string
  changed_sections: string[]
  preserved_unspecified_content: boolean
  locked_context_sha256: string
  corpus_usage: { searched: boolean; matches: Array<{ id: string; portable_pattern: string }> }
}

/** Validate a revision result against the contract; returns errors (empty = valid). */
export function validateRevisionResult(
  result: unknown,
  request?: { locked_context_sha256: string },
): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const r = result as Partial<RevisionResult> | null
  if (!r || typeof r !== 'object') return { ok: false, errors: ['result must be an object'] }
  if (r.schema_version !== '1.0') errors.push('schema_version must be "1.0"')
  if (r.kind !== 'codex_dt_prompt_revision_result') errors.push('kind must be codex_dt_prompt_revision_result')
  if (!['explicit_local', 'ambiguous_creative', 'structural_rewrite'].includes(r.classification as string)) {
    errors.push('classification must be explicit_local | ambiguous_creative | structural_rewrite')
  }
  if (typeof r.revised_prompt !== 'string' || !r.revised_prompt.trim()) errors.push('revised_prompt must be a non-empty string')
  if (!Array.isArray(r.changed_sections) || !r.changed_sections.every((s) => typeof s === 'string' && s.length > 0)) {
    errors.push('changed_sections must be a list of non-empty strings')
  }
  if (r.preserved_unspecified_content !== true) errors.push('preserved_unspecified_content must be true')
  if (typeof r.locked_context_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.locked_context_sha256)) {
    errors.push('locked_context_sha256 must be a 64-char hex string')
  }
  if (request && r.locked_context_sha256 !== request.locked_context_sha256) {
    errors.push('locked_context_sha256 does not match the request (stale contract; reject)')
  }
  const usage = r.corpus_usage as { searched?: boolean; matches?: Array<{ id: string }> } | undefined
  if (!usage || typeof usage !== 'object') {
    errors.push('corpus_usage is required')
  } else {
    if (typeof usage.searched !== 'boolean') errors.push('corpus_usage.searched must be a boolean')
    const matches = Array.isArray(usage.matches) ? usage.matches : []
    if (!Array.isArray(usage.matches)) errors.push('corpus_usage.matches must be an array')
    if (matches.length > 10) errors.push(`corpus_usage.matches must be at most 10, got ${matches.length}`)
    for (const match of matches) {
      if (typeof match.id !== 'string' || !match.id) errors.push('every corpus match requires an id')
      if (typeof (match as any).portable_pattern !== 'string' || !(match as any).portable_pattern) {
        errors.push('every corpus match requires portable_pattern')
      }
    }
    if (r.classification === 'explicit_local' && matches.length > 0) {
      errors.push('explicit_local must not use corpus matches')
    }
  }
  return { ok: errors.length === 0, errors }
}
