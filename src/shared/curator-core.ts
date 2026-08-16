/**
 * Skill Curator domain (Codex_CS codex-cs-skill-curator port, all-JS):
 * scaffold standard business-Skill packages, per-slot count rules,
 * package validation (validator 1.1.0 semantics), intake receipts with
 * package-hash binding, and planned-count derivation from duration.
 * Pure domain — no DSH imports, no provider/model selection.
 *
 * @module dsh-media-plugins/shared/curator-core
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export const VALIDATOR_VERSION = '1.1.0'
export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const REFERENCE_IDS = ['image', 'video', 'audio']
export const REFERENCE_ROLES = ['identity', 'scene', 'style', 'start_frame', 'end_frame', 'footage', 'music', 'sound', 'other']
export const ALLOWED_VIDEO_MODES = ['image2video', 'frames2video', 'multimodal2video']
export const REQUIRED_KNOWLEDGE: Record<string, string> = {
  creative_guidance: 'references/creative-guidance.md',
  community_experience: 'references/community-experience.md',
  failure_cases: 'references/failure-cases.md',
  examples: 'references/examples.md',
}
export const REQUIRED_FILES = ['SKILL.md', 'contract.json', 'agents/openai.yaml', ...Object.values(REQUIRED_KNOWLEDGE)]
export const PLACEHOLDER_MARKERS = ['CURATOR-REQUIRED', '{{', '}}', '[TODO', 'TODO:']
export const ROUTING_LIST_FIELDS = ['aliases', 'user_intents', 'subjects', 'styles', 'narrative_patterns', 'negative_intents']

const TERMINAL_METADATA = /^\s*(?:Exit code|Wall time|Output|Script completed|Script error)\s*:/im
const WINDOWS_ABSOLUTE_PATH = /(?:^|[\s'"`(])(?:[a-z]:\\|\\\\)[^\r\n]*/i
const SECRET_PATTERN = /(?:api[_ -]?key|authorization|bearer|cookie|secret|token)\s*[:=]\s*[^\s<>{}\[\]]+/i
const FORBIDDEN_EXECUTION = /(?:seedance-cli|dreamina\.exe|agy\.exe|media_router\.service|--model_version|--poll\b|query_result|user_credit)/i
const TEXT2VIDEO = /\btext2video\b/i

/** Count-rule roles whose count must not scale with duration. */
export const FIXED_ROLES = new Set(['identity', 'style', 'start_frame', 'end_frame', 'music', 'sound'])

export type CountRuleType = 'fixed' | 'duration_formula' | 'duration_lookup' | 'bounded_recommendation'
export type CountEnforcement = 'required' | 'recommended'
export type CountProvenance = 'source_explicit' | 'curator_default' | 'user_approved_inference'
export type CountConfidence = 'high' | 'medium' | 'low'

export interface CountRule {
  type: CountRuleType
  enforcement: CountEnforcement
  fixed_count: number | null
  seconds_per_item: number | null
  rounding: 'ceil' | 'floor' | 'round' | null
  duration_share: number
  duration_to_count: Array<{ duration_seconds: number; count: number }>
  provenance: CountProvenance
  confidence: CountConfidence
  rationale: string
}

export interface ReferenceSlot {
  id: string
  media_type: string
  role: string
  description: string
  required: boolean
  min_count: number
  max_count: number | null
  count_rule: CountRule
  ordered: boolean
  observation_required: boolean
}

export interface Issue {
  code: string
  message: string
  path?: string
}

/** Default pacing rule for a slot without an explicit one (count_rules.py port). */
export function defaultCountRule(reference: Partial<ReferenceSlot>): CountRule {
  const minimum = Number(reference.min_count ?? 0)
  const maximum = reference.max_count ?? null
  const role = reference.role
  if (FIXED_ROLES.has(role ?? '') || (maximum !== null && maximum === minimum)) {
    let fixed = Math.max(minimum, reference.required ? 1 : 0)
    if (maximum !== null) fixed = Math.min(fixed, maximum)
    return {
      type: 'fixed',
      enforcement: 'required',
      fixed_count: fixed,
      seconds_per_item: null,
      rounding: null,
      duration_share: 1,
      duration_to_count: [],
      provenance: 'curator_default',
      confidence: 'medium',
      rationale: '该素材承担稳定身份、风格、边界帧或声音基准职责，默认数量不随视频时长增加。',
    }
  }
  return {
    type: 'bounded_recommendation',
    enforcement: 'recommended',
    fixed_count: null,
    seconds_per_item: 5,
    rounding: 'ceil',
    duration_share: 1,
    duration_to_count: [],
    provenance: 'curator_default',
    confidence: 'low',
    rationale: '来源没有明确节奏时，默认每约五秒推荐一项可变场景素材，并保留契约上下限作为硬边界。',
  }
}

/** Add missing count rules to every reference slot; returns additions. */
export function addMissingCountRules(contract: { references?: Array<Record<string, unknown>> }): {
  contract: Record<string, unknown>
  additions: Array<Record<string, unknown>>
} {
  const result = JSON.parse(JSON.stringify(contract)) as Record<string, unknown>
  const additions: Array<Record<string, unknown>> = []
  const references = Array.isArray(result.references) ? (result.references as Array<Record<string, unknown>>) : []
  for (const reference of references) {
    if ('count_rule' in reference) continue
    const rule = defaultCountRule(reference as unknown as Partial<ReferenceSlot>)
    reference.count_rule = rule
    additions.push({ slot_id: reference.id, ...rule })
  }
  return { contract: result, additions }
}

/** Derive the planned count for a slot from the confirmed duration (material collection). */
export function plannedCount(rule: CountRule, durationSeconds: number): number {
  switch (rule.type) {
    case 'fixed':
      return rule.fixed_count ?? 0
    case 'duration_formula':
    case 'bounded_recommendation': {
      if (rule.seconds_per_item === null || rule.rounding === null) return rule.fixed_count ?? 0
      const raw = (durationSeconds * rule.duration_share) / rule.seconds_per_item
      const value = rule.rounding === 'ceil' ? Math.ceil(raw) : rule.rounding === 'floor' ? Math.floor(raw) : Math.round(raw)
      return value
    }
    case 'duration_lookup': {
      const anchors = [...rule.duration_to_count].sort((a, b) => a.duration_seconds - b.duration_seconds)
      let count = rule.fixed_count ?? 0
      for (const anchor of anchors) {
        if (durationSeconds >= anchor.duration_seconds) count = anchor.count
      }
      return count
    }
    default:
      return rule.fixed_count ?? 0
  }
}

/* ------------------------------------------------------------------ */
/* Package hashing & validation                                        */
/* ------------------------------------------------------------------ */

/** File SHA-256. */
export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Length-prefixed package hash over sorted files (intake-receipt excluded unless requested). */
export function packageSha256(root: string, includeReceipt = false): string {
  const digest = createHash('sha256')
  const files = listFiles(root).filter((path) => includeReceipt || basename(path) !== 'intake-receipt.json')
  for (const path of files) {
    const relative = path.replaceAll('\\', '/').replace(root.replaceAll('\\', '/'), '').replace(/^\//, '')
    const relBuf = Buffer.from(relative, 'utf8')
    const data = readFileSync(path)
    digest.update(int64(relBuf.length))
    digest.update(relBuf)
    digest.update(int64(data.length))
    digest.update(data)
  }
  return digest.digest('hex')
}

function int64(value: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(value))
  return buf
}

function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isFile()) out.push(path)
      else walk(path)
    }
  }
  walk(root)
  // Windows path semantics sort case-insensitively (Python WindowsPath comparison);
  // this ordering is part of the length-prefixed package hash contract.
  return out.sort((a, b) => {
    const la = a.toLowerCase()
    const lb = b.toLowerCase()
    return la < lb ? -1 : la > lb ? 1 : 0
  })
}

/** Parse SKILL.md YAML frontmatter; returns {metadata, body}. */
export function parseFrontmatter(text: string): { metadata: Record<string, string>; body: string } {
  const match = text.match(/^---\s*\r?\n(.*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/s)
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter')
  const metadata: Record<string, string> = {}
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim()) continue
    const field = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/)
    if (!field) throw new Error(`Unsupported frontmatter line: ${raw}`)
    metadata[field[1]] = field[2].trim().replace(/^["']|["']$/g, '')
  }
  return { metadata, body: match[2].trim() }
}

/** Parse the display fields out of agents/openai.yaml (regex, matching the Python port). */
export function parseOpenaiYaml(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const key of ['display_name', 'short_description', 'default_prompt']) {
    const match = text.match(new RegExp(`^\\s+${key}:\\s*["'](.*?)["']\\s*$`, 'm'))
    if (match) values[key] = match[1]
  }
  return values
}

function add(issues: Issue[], code: string, message: string, path?: string): void {
  issues.push({ code, message, path })
}

/** Validate a skill package directory (validator 1.1.0 semantics). */
export function validatePackage(root: string, requireReceipt = false): Issue[] {
  const issues: Issue[] = []
  let stat
  try {
    stat = statSync(root)
  } catch {
    return [{ code: 'PACKAGE_NOT_FOUND', message: 'Skill package directory does not exist', path: root }]
  }
  if (!stat.isDirectory()) return [{ code: 'PACKAGE_NOT_FOUND', message: 'Skill package directory does not exist', path: root }]

  const missing = REQUIRED_FILES.filter((path) => {
    try {
      statSync(join(root, path))
      return false
    } catch {
      return true
    }
  })
  for (const path of missing) add(issues, 'MISSING_FILE', `Required file is missing: ${path}`, path)
  if (missing.length > 0) return issues

  const skillId = basename(root)
  if (!SKILL_ID_PATTERN.test(skillId) || skillId.length > 64) {
    add(issues, 'INVALID_SKILL_ID', 'Directory name must be lowercase hyphen-case and at most 64 characters', basename(root))
  }

  let metadata: Record<string, string> = {}
  let body = ''
  try {
    const parsed = parseFrontmatter(readFileSync(join(root, 'SKILL.md'), 'utf8'))
    metadata = parsed.metadata
    body = parsed.body
  } catch (error: any) {
    add(issues, 'INVALID_SKILL_FRONTMATTER', String(error?.message ?? error), 'SKILL.md')
  }
  if (Object.keys(metadata).length !== 2 || !('name' in metadata) || !('description' in metadata)) {
    add(issues, 'INVALID_SKILL_FRONTMATTER', 'Frontmatter must contain only name and description', 'SKILL.md')
  }
  if (metadata.name !== skillId) add(issues, 'SKILL_ID_MISMATCH', 'SKILL.md name must equal the package directory name', 'SKILL.md')
  if (metadata.description && metadata.description.length < 20) {
    add(issues, 'DESCRIPTION_TOO_SHORT', 'Skill description must explain capability and trigger conditions', 'SKILL.md')
  }
  if (!body) add(issues, 'EMPTY_SKILL_BODY', 'SKILL.md body must not be empty', 'SKILL.md')

  let contract: Record<string, unknown> = {}
  try {
    contract = JSON.parse(readFileSync(join(root, 'contract.json'), 'utf8'))
  } catch (error: any) {
    add(issues, 'INVALID_CONTRACT_JSON', String(error?.message ?? error), 'contract.json')
  }
  const allowedTop = ['schema_version', 'skill_id', 'display_name', 'description', 'references', 'video', 'authoring', 'knowledge']
  const topKeys = Object.keys(contract).sort()
  if (JSON.stringify(topKeys) !== JSON.stringify([...allowedTop].sort())) {
    add(issues, 'INVALID_CONTRACT_FIELDS', `contract.json fields must be exactly: ${[...allowedTop].sort().join(', ')}`, 'contract.json')
  }
  if (contract.schema_version !== 1) add(issues, 'INVALID_SCHEMA_VERSION', 'contract schema_version must be 1', 'contract.json')
  if (contract.skill_id !== skillId) add(issues, 'CONTRACT_ID_MISMATCH', 'contract skill_id must equal the package directory name', 'contract.json')
  if (String(contract.display_name ?? '').length < 2) add(issues, 'INVALID_DISPLAY_NAME', 'display_name must not be empty', 'contract.json')
  if (String(contract.description ?? '').length < 20) {
    add(issues, 'CONTRACT_DESCRIPTION_TOO_SHORT', 'contract description must be at least 20 characters', 'contract.json')
  }

  const references = Array.isArray(contract.references) ? (contract.references as Array<Record<string, unknown>>) : []
  if (!Array.isArray(contract.references) || references.length === 0) {
    add(issues, 'MISSING_REFERENCES', 'At least one image, video, or audio reference slot is required', 'contract.json')
  }
  const seenIds = new Set<string>()
  let minimumTotal = 0
  references.forEach((item, index) => {
    const path = `contract.json:references[${index + 1}]`
    const requiredFields = ['id', 'media_type', 'role', 'description', 'required', 'min_count', 'max_count', 'count_rule', 'ordered', 'observation_required']
    if (!item || typeof item !== 'object' || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify([...requiredFields].sort())) {
      add(issues, 'INVALID_REFERENCE_FIELDS', `Reference fields must be exactly: ${[...requiredFields].sort().join(', ')}`, path)
      return
    }
    const refId = String(item.id ?? '')
    if (!SKILL_ID_PATTERN.test(refId)) add(issues, 'INVALID_REFERENCE_ID', 'Reference id must use lowercase hyphen-case', path)
    else if (seenIds.has(refId)) add(issues, 'DUPLICATE_REFERENCE_ID', `Duplicate reference id: ${refId}`, path)
    else seenIds.add(refId)
    if (!REFERENCE_IDS.includes(String(item.media_type))) add(issues, 'INVALID_MEDIA_TYPE', 'media_type must be image, video, or audio', path)
    if (!REFERENCE_ROLES.includes(String(item.role))) add(issues, 'INVALID_REFERENCE_ROLE', `Unsupported role: ${item.role}`, path)
    if (String(item.description ?? '').length < 4) add(issues, 'REFERENCE_DESCRIPTION_TOO_SHORT', 'Reference description must explain its purpose', path)
    for (const field of ['required', 'ordered', 'observation_required']) {
      if (typeof item[field] !== 'boolean') add(issues, 'INVALID_REFERENCE_BOOLEAN', `${field} must be boolean`, path)
    }
    const minimum = item.min_count
    const maximum = item.max_count ?? null
    if (typeof minimum !== 'number' || !Number.isInteger(minimum) || minimum < 0) {
      add(issues, 'INVALID_MIN_COUNT', 'min_count must be a non-negative integer', path)
    } else {
      minimumTotal += minimum
    }
    if (maximum !== null && (typeof maximum !== 'number' || !Number.isInteger(maximum) || maximum < 1)) {
      add(issues, 'INVALID_MAX_COUNT', 'max_count must be null or a positive integer', path)
    }
    if (typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum) {
      add(issues, 'INVALID_REFERENCE_RANGE', 'min_count must not exceed max_count', path)
    }
    if (item.required === true && minimum === 0) add(issues, 'REQUIRED_REFERENCE_WITH_ZERO_MIN', 'A required reference must have min_count >= 1', path)

    const rule = item.count_rule as Record<string, unknown> | undefined
    const ruleFields = ['type', 'enforcement', 'fixed_count', 'seconds_per_item', 'rounding', 'duration_share', 'duration_to_count', 'provenance', 'confidence', 'rationale']
    if (!rule || typeof rule !== 'object' || JSON.stringify(Object.keys(rule).sort()) !== JSON.stringify([...ruleFields].sort())) {
      add(issues, 'INVALID_COUNT_RULE_FIELDS', `count_rule fields must be exactly: ${[...ruleFields].sort().join(', ')}`, path)
      return
    }
    const ruleType = rule.type
    if (!['fixed', 'duration_formula', 'duration_lookup', 'bounded_recommendation'].includes(String(ruleType))) {
      add(issues, 'INVALID_COUNT_RULE_TYPE', 'Unsupported count_rule type', path)
    }
    if (!['required', 'recommended'].includes(String(rule.enforcement))) {
      add(issues, 'INVALID_COUNT_ENFORCEMENT', 'count_rule.enforcement must be required or recommended', path)
    }
    if (ruleType === 'bounded_recommendation' && rule.enforcement !== 'recommended') {
      add(issues, 'INVALID_COUNT_ENFORCEMENT', 'bounded_recommendation must use recommended enforcement', path)
    }
    const fixed = rule.fixed_count
    if (ruleType === 'fixed') {
      if (typeof fixed !== 'number' || !Number.isInteger(fixed) || fixed < minimum || (maximum !== null && fixed > maximum)) {
        add(issues, 'INVALID_FIXED_COUNT', 'fixed_count must be an integer inside min_count/max_count', path)
      }
    } else if (fixed !== null && fixed !== undefined) {
      add(issues, 'UNEXPECTED_FIXED_COUNT', 'Only fixed rules may set fixed_count', path)
    }
    if (ruleType === 'duration_formula' || ruleType === 'bounded_recommendation') {
      const seconds = rule.seconds_per_item
      if (typeof seconds !== 'number' || seconds <= 0) add(issues, 'INVALID_SECONDS_PER_ITEM', 'Formula rules require positive seconds_per_item', path)
      if (!['ceil', 'floor', 'round'].includes(String(rule.rounding))) add(issues, 'INVALID_COUNT_ROUNDING', 'Formula rules require ceil, floor, or round', path)
    } else if (rule.seconds_per_item !== null && rule.seconds_per_item !== undefined) {
      add(issues, 'UNEXPECTED_COUNT_FORMULA', 'Non-formula rules must not set seconds_per_item or rounding', path)
    }
    const share = rule.duration_share
    if (typeof share !== 'number' || share <= 0 || share > 1) add(issues, 'INVALID_DURATION_SHARE', 'duration_share must be greater than 0 and at most 1', path)
    const lookup = rule.duration_to_count
    if (!Array.isArray(lookup)) {
      add(issues, 'INVALID_DURATION_LOOKUP', 'duration_to_count must be an array', path)
    } else if (ruleType === 'duration_lookup') {
      if (lookup.length === 0) add(issues, 'EMPTY_DURATION_LOOKUP', 'duration_lookup requires at least one anchor', path)
      const durations: number[] = []
      lookup.forEach((anchor: any) => {
        if (!anchor || typeof anchor !== 'object' || JSON.stringify(Object.keys(anchor).sort()) !== JSON.stringify(['duration_seconds', 'count'].sort())) {
          add(issues, 'INVALID_DURATION_ANCHOR', 'Each duration lookup anchor requires duration_seconds and count', path)
          return
        }
        const d = anchor.duration_seconds
        const c = anchor.count
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 4 || d > 30) {
          add(issues, 'INVALID_DURATION_ANCHOR', 'Anchor duration must be an integer from 4 to 30', path)
        }
        if (typeof c !== 'number' || !Number.isInteger(c) || c < minimum || (maximum !== null && c > maximum)) {
          add(issues, 'INVALID_DURATION_ANCHOR', 'Anchor count must be inside min_count/max_count', path)
        }
        durations.push(d)
      })
      if (new Set(durations).size !== durations.length) add(issues, 'DUPLICATE_DURATION_ANCHOR', 'Duration lookup anchors must be unique', path)
    } else if (lookup.length > 0) {
      add(issues, 'UNEXPECTED_DURATION_LOOKUP', 'Only duration_lookup rules may contain anchors', path)
    }
    if (!['source_explicit', 'curator_default', 'user_approved_inference'].includes(String(rule.provenance))) {
      add(issues, 'INVALID_COUNT_PROVENANCE', 'Unsupported count_rule provenance', path)
    }
    if (!['high', 'medium', 'low'].includes(String(rule.confidence))) add(issues, 'INVALID_COUNT_CONFIDENCE', 'Unsupported count_rule confidence', path)
    if (String(rule.rationale ?? '').length < 8) add(issues, 'COUNT_RATIONALE_TOO_SHORT', 'count_rule rationale must explain the pacing decision', path)
  })
  if (minimumTotal < 1) add(issues, 'ZERO_MINIMUM_REFERENCES', 'The contract must require at least one reference asset', 'contract.json')

  const video = contract.video as Record<string, unknown> | undefined
  if (!video || typeof video !== 'object' || JSON.stringify(Object.keys(video).sort()) !== JSON.stringify(['reference_required', 'allowed_modes'].sort())) {
    add(issues, 'INVALID_VIDEO_CONTRACT', 'video must contain only reference_required and allowed_modes', 'contract.json')
  } else {
    if (video.reference_required !== true) add(issues, 'REFERENCE_NOT_REQUIRED', 'video.reference_required must be true', 'contract.json')
    const modes = video.allowed_modes
    if (!Array.isArray(modes) || modes.length === 0) {
      add(issues, 'MISSING_VIDEO_MODE', 'At least one reference-based video mode is required', 'contract.json')
    } else if (new Set(modes as string[]).size !== modes.length || modes.some((m) => !ALLOWED_VIDEO_MODES.includes(m as string))) {
      add(issues, 'INVALID_VIDEO_MODE', `Allowed modes are: ${[...ALLOWED_VIDEO_MODES].sort().join(', ')}`, 'contract.json')
    }
  }

  const authoring = contract.authoring as Record<string, unknown> | undefined
  const authoringFields = ['primary_language', 'preserve_professional_english', 'user_instruction_priority', 'timing_strategy', 'transition_strategy', 'requires_prompt_confirmation', 'requires_reference_binding']
  if (!authoring || typeof authoring !== 'object' || JSON.stringify(Object.keys(authoring).sort()) !== JSON.stringify([...authoringFields].sort())) {
    add(issues, 'INVALID_AUTHORING_CONTRACT', `authoring fields must be exactly: ${[...authoringFields].sort().join(', ')}`, 'contract.json')
  } else {
    const expected: Record<string, unknown> = {
      primary_language: 'zh-CN',
      preserve_professional_english: true,
      user_instruction_priority: 'highest',
      requires_prompt_confirmation: true,
      requires_reference_binding: true,
    }
    for (const [key, value] of Object.entries(expected)) {
      if (authoring[key] !== value) add(issues, 'INVALID_AUTHORING_POLICY', `authoring.${key} must equal ${JSON.stringify(value)}`, 'contract.json')
    }
    if (!['user_defined', 'skill_defined', 'adaptive', 'even_fallback'].includes(String(authoring.timing_strategy))) {
      add(issues, 'INVALID_TIMING_STRATEGY', 'Unsupported timing_strategy', 'contract.json')
    }
    if (!['user_defined', 'skill_defined', 'adaptive', 'unspecified'].includes(String(authoring.transition_strategy))) {
      add(issues, 'INVALID_TRANSITION_STRATEGY', 'Unsupported transition_strategy', 'contract.json')
    }
  }

  const knowledge = contract.knowledge
  if (JSON.stringify(knowledge) !== JSON.stringify(REQUIRED_KNOWLEDGE)) {
    add(issues, 'INVALID_KNOWLEDGE_PATHS', `knowledge must equal ${JSON.stringify(REQUIRED_KNOWLEDGE)}`, 'contract.json')
  }

  const routingPath = join(root, 'routing.json')
  let routing: Record<string, unknown> = {}
  try {
    routing = JSON.parse(readFileSync(routingPath, 'utf8'))
  } catch (error: any) {
    add(issues, 'INVALID_ROUTING_JSON', String(error?.message ?? error), 'routing.json')
  }
  if (routing && typeof routing === 'object') {
    const allowedRouting = ['schema_version', 'skill_id', 'priority', ...ROUTING_LIST_FIELDS]
    const unsupported = Object.keys(routing).filter((key) => !allowedRouting.includes(key))
    if (unsupported.length > 0) add(issues, 'INVALID_ROUTING_FIELDS', `routing.json contains unsupported fields: ${unsupported.sort().join(', ')}`, 'routing.json')
    if (routing.schema_version !== 1 || routing.skill_id !== skillId) {
      add(issues, 'INVALID_ROUTING_IDENTITY', 'routing schema_version must be 1 and skill_id must match the package', 'routing.json')
    }
    const priority = routing.priority
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 100) {
      add(issues, 'INVALID_ROUTING_PRIORITY', 'routing priority must be an integer from 0 to 100', 'routing.json')
    }
    for (const field of ROUTING_LIST_FIELDS) {
      const values = routing[field]
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())) {
        add(issues, 'INVALID_ROUTING_TERMS', `routing ${field} must be an array of non-empty strings`, 'routing.json')
      }
    }
  }

  try {
    const ui = parseOpenaiYaml(readFileSync(join(root, 'agents/openai.yaml'), 'utf8'))
    if (ui.display_name !== contract.display_name) add(issues, 'UI_DISPLAY_NAME_MISMATCH', 'agents/openai.yaml display_name must match contract display_name', 'agents/openai.yaml')
    const short = ui.short_description ?? ''
    if (short.length < 25 || short.length > 64) add(issues, 'INVALID_UI_SHORT_DESCRIPTION', 'short_description must contain 25-64 characters', 'agents/openai.yaml')
    if (!String(ui.default_prompt ?? '').includes(`$${skillId}`)) {
      add(issues, 'INVALID_UI_DEFAULT_PROMPT', 'default_prompt must explicitly mention the Skill as $skill-id', 'agents/openai.yaml')
    }
  } catch (error: any) {
    add(issues, 'INVALID_UI_YAML', String(error?.message ?? error), 'agents/openai.yaml')
  }

  for (const path of listFiles(root)) {
    const relative = path.replaceAll('\\', '/').replace(root.replaceAll('\\', '/'), '').replace(/^\//, '')
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
    if (!['.md', '.json', '.yaml', '.yml', '.txt'].includes(ext)) continue
    const text = readFileSync(path, 'utf8')
    if (PLACEHOLDER_MARKERS.some((marker) => text.includes(marker))) add(issues, 'UNRESOLVED_PLACEHOLDER', 'Template placeholder remains in the package', relative)
    if (TERMINAL_METADATA.test(text)) add(issues, 'TERMINAL_METADATA', 'Terminal output is not allowed in a business Skill package', relative)
    if (WINDOWS_ABSOLUTE_PATH.test(text)) add(issues, 'ABSOLUTE_PATH', 'Machine-local absolute paths are not allowed', relative)
    if (SECRET_PATTERN.test(text)) add(issues, 'POSSIBLE_SECRET', 'Possible credential or authorization value detected', relative)
    if ((relative === 'SKILL.md' || relative === 'contract.json') && FORBIDDEN_EXECUTION.test(text)) {
      add(issues, 'EXECUTION_LAYER_LEAK', 'Provider, model, CLI, polling, or router internals are not allowed in the execution contract', relative)
    }
    if ((relative === 'SKILL.md' || relative === 'contract.json') && TEXT2VIDEO.test(text)) {
      add(issues, 'TEXT2VIDEO_FORBIDDEN', 'Video business Skills must require reference media', relative)
    }
  }

  const receiptPath = join(root, 'intake-receipt.json')
  let receiptExists = false
  try {
    statSync(receiptPath)
    receiptExists = true
  } catch {
    /* missing */
  }
  if (requireReceipt || receiptExists) {
    if (!receiptExists) {
      add(issues, 'MISSING_RECEIPT', 'Published packages require intake-receipt.json', 'intake-receipt.json')
    } else {
      let receipt: Record<string, unknown> = {}
      try {
        receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      } catch (error: any) {
        add(issues, 'INVALID_RECEIPT', String(error?.message ?? error), 'intake-receipt.json')
      }
      const receiptFields = ['schema_version', 'skill_id', 'status', 'validator_version', 'approved_by', 'validated_at', 'sources', 'package_sha256']
      if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([...receiptFields].sort())) {
        add(issues, 'INVALID_RECEIPT_FIELDS', `Receipt fields must be exactly: ${[...receiptFields].sort().join(', ')}`, 'intake-receipt.json')
      }
      if (receipt.schema_version !== 1 || receipt.skill_id !== skillId || receipt.status !== 'published' || receipt.approved_by !== 'user') {
        add(issues, 'INVALID_RECEIPT_IDENTITY', 'Receipt identity or approval fields are invalid', 'intake-receipt.json')
      }
      const sources = receipt.sources
      if (!Array.isArray(sources) || sources.length === 0) {
        add(issues, 'MISSING_RECEIPT_SOURCES', 'Receipt must contain at least one source hash', 'intake-receipt.json')
      } else if (sources.some((item: any) => !item || typeof item !== 'object' || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(['name', 'sha256']) || !/^[a-f0-9]{64}$/.test(String(item.sha256 ?? '')))) {
        add(issues, 'INVALID_RECEIPT_SOURCES', 'Every receipt source requires name and SHA-256', 'intake-receipt.json')
      }
      if (receipt.package_sha256 !== packageSha256(root)) {
        add(issues, 'STALE_RECEIPT', 'Package content changed after publication receipt generation', 'intake-receipt.json')
      }
    }
  }

  return issues
}

/** Create an intake receipt binding the package hash and source provenance. */
export function buildIntakeReceipt(root: string, sources: Array<{ name: string; sha256: string }>): Record<string, unknown> {
  return {
    schema_version: 1,
    skill_id: basename(root),
    status: 'published',
    validator_version: VALIDATOR_VERSION,
    approved_by: 'user',
    validated_at: new Date().toISOString(),
    sources,
    package_sha256: packageSha256(root),
  }
}

/** Validate scaffold inputs (scaffold_business_skill.py port). */
export function validateScaffoldInput(skillId: string, displayName: string, description: string, shortDescription?: string): void {
  if (!SKILL_ID_PATTERN.test(skillId) || skillId.length > 64) {
    throw new Error('skill-id must be lowercase hyphen-case and at most 64 characters')
  }
  if (String(description ?? '').trim().length < 20) {
    throw new Error('description must contain at least 20 characters')
  }
  const short = (shortDescription || `根据已确认素材与专业规则生成${displayName}视频提示词`).trim()
  if (short.length < 25 || short.length > 64) {
    throw new Error('short-description must contain 25-64 characters')
  }
}
