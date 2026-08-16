/**
 * Image Skill domain (Codex_IS rebuild, all-JS): the governed image
 * business-Skill layer. Ports `packages/Codex_IS` from the
 * lc303300-dev/Codex_Wsstudio repo — image contract / routing / report /
 * receipt schema validation, canonical package hashing
 * (codex-is-package-sha256-v2), intake audit & approval, atomic publish and
 * upgrade, scaffold template rendering, and registry-contract conversion.
 * Pure domain — no DSH imports, no provider/model selection, no paid media.
 *
 * @module dsh-media-plugins/shared/image-skill-core
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

export const IMAGE_VALIDATOR_VERSION = '2.0.0'
export const IMAGE_HASH_ALGORITHM = 'codex-is-package-sha256-v2'
export const IMAGE_TEXT_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml', '.txt'])
export const IMAGE_RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16']
export const IMAGE_SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const IMAGE_SHA256_PATTERN = /^[a-f0-9]{64}$/
export const IMAGE_TEMPLATE_MARKERS = /(\{\{[^}]+\}\}|CURATOR-REQUIRED|\bTODO\b|\bTBD\b|START OF FILE)/i
export const IMAGE_FORBIDDEN = /(API[_ -]?KEY|authorization\s*header|cookie\s*=|dreamina\s*cli|provider adapter|polling|download loop)/i

/** Schema-level issue prefixes used by the Codex_IS validator. */
export type ImagePackageIssue = string

/** SHA-256 of a file's raw bytes. */
export function imageFileSha256(path: string): string {
  const data = readFileSync(path)
  return createHash('sha256').update(data).digest('hex')
}

/** Canonical bytes for hashing: text files are BOM-stripped and CRLF/CR
 *  normalized to LF (skill_package.py canonical_bytes); binary hashes raw. */
export function imageCanonicalBytes(path: string): Buffer {
  const data = readFileSync(path)
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (!IMAGE_TEXT_EXTENSIONS.has(ext)) return data
  try {
    let text = data.toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    return Buffer.from(text, 'utf8')
  } catch {
    return data
  }
}

function int64(value: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(value))
  return buf
}

function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isFile()) out.push(path)
      else walk(path)
    }
  }
  walk(root)
  return out.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
}

/** Length-prefixed canonical package hash; excludes intake-receipt.json by
 *  default (skill_package.package_sha256 port). */
export function imagePackageSha256(root: string, exclude: Set<string> = new Set(['intake-receipt.json'])): string {
  const digest = createHash('sha256')
  const files = listFiles(root).filter((path) => !exclude.has(basename(path)))
  for (const path of files) {
    const rel = relative(resolve(root), resolve(path)).split('\\').join('/')
    const relBuf = Buffer.from(rel, 'utf8')
    const data = imageCanonicalBytes(path)
    digest.update(int64(relBuf.length))
    digest.update(relBuf)
    digest.update(int64(data.length))
    digest.update(data)
  }
  return digest.digest('hex')
}

/** Core hash: excludes both intake-report.json and intake-receipt.json. */
export function imageCoreSha256(root: string): string {
  return imagePackageSha256(root, new Set(['intake-receipt.json', 'intake-report.json']))
}

/** Parse the YAML frontmatter of a SKILL.md; only name/description matter. */
export function imageParseFrontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\s*\r?\n(.*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/s)
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter')
  const metadata: Record<string, string> = {}
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim()) continue
    const field = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/)
    if (!field) throw new Error(`invalid frontmatter line: ${raw}`)
    metadata[field[1].trim()] = field[2].trim().replace(/^["']|["']$/g, '')
  }
  return metadata
}

// ---------------------------------------------------------------------------
// Schema-level structural validation (contract.schema.json / routing.schema.json
// / intake-report.schema.json / intake-receipt.schema.json ports).
// ---------------------------------------------------------------------------

const REFERENCE_REQUIRED = ['id', 'media_type', 'role', 'scope', 'required', 'min_count', 'max_count', 'ordered', 'observation_required', 'send_to_generation', 'description']
const REFERENCE_POLICY_REQUIRED = ['allowed_slot_ids', 'reject_uncontracted_images', 'maximum_reference_images_per_scene', 'preserve_reference_order']
const WORKLOAD_REQUIRED = ['scene_count', 'candidate_count_per_scene', 'batch_allowed']
const COUNT_RANGE_REQUIRED = ['min', 'max']
const OUTPUT_REQUIRED = ['media_type', 'requires_ratio_confirmation', 'supported_ratios']
const AUTHORING_REQUIRED = ['primary_language', 'requires_reference_binding', 'requires_prompt_confirmation', 'user_instruction_priority']
const EXECUTION_REQUIRED = ['provider_neutral', 'single_candidate_entry', 'batch_entry', 'requires_paid_batch_confirmation', 'automatic_retry', 'automatic_visual_ranking']
const KNOWLEDGE_REQUIRED = ['creative_guidance', 'failure_cases', 'examples']
const CONTRACT_REQUIRED = ['schema_version', 'skill_id', 'display_name', 'description', 'input_mode', 'references', 'reference_policy', 'workload', 'output', 'authoring', 'execution', 'knowledge', 'business_constraints']
const ROUTING_REQUIRED = ['schema_version', 'skill_id', 'aliases', 'user_intents', 'subjects', 'styles', 'narrative_patterns', 'negative_intents', 'priority']
const REPORT_REQUIRED = ['schema_version', 'status', 'skill_id', 'display_name', 'sources', 'duplicate_check', 'extraction_summary', 'reference_summary', 'output_summary', 'isolated_content', 'contract_conflicts', 'blocking_questions', 'validation_issues', 'experience_preservation', 'reviewed_core_sha256', 'user_approval']
const RECEIPT_REQUIRED = ['schema_version', 'hash_algorithm', 'skill_id', 'status', 'validator_version', 'approved_by', 'validated_at', 'sources', 'intake_report_sha256', 'reviewed_core_sha256', 'package_sha256']
const REPORT_STATUSES = ['needs_review', 'ready_for_approval', 'approved', 'published', 'rejected']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function exactKeys(instance: Record<string, unknown>, required: string[], label: string, issues: string[], prefix = ''): boolean {
  const keys = Object.keys(instance).sort()
  if (JSON.stringify(keys) !== JSON.stringify([...required].sort())) {
    issues.push(`${prefix}${label} fields must be exactly: ${[...required].sort().join(', ')}`)
    return false
  }
  return true
}

/** Structural validation of the Codex_IS image contract (contract.schema.json). */
export function validateImageContractShape(contract: unknown): string[] {
  const issues: string[] = []
  if (!isPlainObject(contract)) {
    issues.push('CONTRACT_SCHEMA: contract must be an object')
    return issues
  }
  const label = (path: string) => `CONTRACT_SCHEMA:${path}:`
  if (!exactKeys(contract, CONTRACT_REQUIRED, 'contract', issues, 'CONTRACT_SCHEMA:')) return issues
  if (contract.schema_version !== 1) issues.push(`${label('schema_version')}must be 1`)
  if (typeof contract.skill_id !== 'string' || !IMAGE_SKILL_ID_PATTERN.test(contract.skill_id) || contract.skill_id.length > 63) issues.push(`${label('skill_id')}must match lowercase hyphen-case and be at most 63 characters`)
  if (typeof contract.display_name !== 'string' || contract.display_name.length < 2) issues.push(`${label('display_name')}must be at least 2 characters`)
  if (typeof contract.description !== 'string' || contract.description.length < 8) issues.push(`${label('description')}must be at least 8 characters`)
  if (contract.input_mode !== 'text_only' && contract.input_mode !== 'reference_conditioned') issues.push(`${label('input_mode')}must be text_only or reference_conditioned`)
  if (!Array.isArray(contract.references)) {
    issues.push(`${label('references')}must be an array`)
    return issues
  }
  contract.references.forEach((item, index) => {
    const path = `references[${index}]`
    if (!isPlainObject(item)) {
      issues.push(`${label(path)}must be an object`)
      return
    }
    if (!exactKeys(item, REFERENCE_REQUIRED, path, issues, 'CONTRACT_SCHEMA:')) return
    const refId = item.id
    if (typeof refId !== 'string' || !IMAGE_SKILL_ID_PATTERN.test(refId)) issues.push(`${label(path + '.id')}must be lowercase hyphen-case`)
    if (item.media_type !== 'image') issues.push(`${label(path + '.media_type')}must be image`)
    if (typeof item.role !== 'string' || item.role.length < 1) issues.push(`${label(path + '.role')}must be a non-empty string`)
    if (item.scope !== 'project' && item.scope !== 'scene') issues.push(`${label(path + '.scope')}must be project or scene`)
    for (const field of ['required', 'ordered', 'observation_required', 'send_to_generation']) if (typeof item[field] !== 'boolean') issues.push(`${label(path + '.' + field)}must be boolean`)
    if (typeof item.min_count !== 'number' || !Number.isInteger(item.min_count) || item.min_count < 0) issues.push(`${label(path + '.min_count')}must be a non-negative integer`)
    if (item.max_count !== null && (typeof item.max_count !== 'number' || !Number.isInteger(item.max_count) || item.max_count < 0)) issues.push(`${label(path + '.max_count')}must be null or a non-negative integer`)
    if (typeof item.description !== 'string' || item.description.length < 1) issues.push(`${label(path + '.description')}must be a non-empty string`)
  })
  const policy = contract.reference_policy
  if (!isPlainObject(policy)) issues.push(`${label('reference_policy')}must be an object`)
  else {
    if (!exactKeys(policy, REFERENCE_POLICY_REQUIRED, 'reference_policy', issues, 'CONTRACT_SCHEMA:')) return issues
    if (!Array.isArray(policy.allowed_slot_ids) || !isStringArray(policy.allowed_slot_ids) || new Set(policy.allowed_slot_ids).size !== policy.allowed_slot_ids.length) issues.push(`${label('reference_policy.allowed_slot_ids')}must be an array of unique strings`)
    if (policy.reject_uncontracted_images !== true) issues.push(`${label('reference_policy.reject_uncontracted_images')}must be true`)
    if (policy.maximum_reference_images_per_scene !== null && (typeof policy.maximum_reference_images_per_scene !== 'number' || !Number.isInteger(policy.maximum_reference_images_per_scene) || policy.maximum_reference_images_per_scene < 0)) issues.push(`${label('reference_policy.maximum_reference_images_per_scene')}must be null or a non-negative integer`)
    if (policy.preserve_reference_order !== true) issues.push(`${label('reference_policy.preserve_reference_order')}must be true`)
  }
  const workload = contract.workload
  if (!isPlainObject(workload)) issues.push(`${label('workload')}must be an object`)
  else {
    if (!exactKeys(workload, WORKLOAD_REQUIRED, 'workload', issues, 'CONTRACT_SCHEMA:')) return issues
    for (const key of ['scene_count', 'candidate_count_per_scene']) {
      const range = workload[key]
      if (!isPlainObject(range)) {
        issues.push(`${label(`workload.${key}`)}must be an object`)
        continue
      }
      if (!exactKeys(range, COUNT_RANGE_REQUIRED, `workload.${key}`, issues, 'CONTRACT_SCHEMA:')) continue
      if (typeof range.min !== 'number' || !Number.isInteger(range.min) || range.min < 1) issues.push(`${label(`workload.${key}.min`)}must be an integer >= 1`)
      if (range.max !== null && (typeof range.max !== 'number' || !Number.isInteger(range.max) || range.max < 1)) issues.push(`${label(`workload.${key}.max`)}must be null or an integer >= 1`)
    }
    if (typeof workload.batch_allowed !== 'boolean') issues.push(`${label('workload.batch_allowed')}must be boolean`)
  }
  const output = contract.output
  if (!isPlainObject(output)) issues.push(`${label('output')}must be an object`)
  else {
    if (!exactKeys(output, OUTPUT_REQUIRED, 'output', issues, 'CONTRACT_SCHEMA:')) return issues
    if (output.media_type !== 'image') issues.push(`${label('output.media_type')}must be image`)
    if (output.requires_ratio_confirmation !== true) issues.push(`${label('output.requires_ratio_confirmation')}must be true`)
    if (!Array.isArray(output.supported_ratios) || output.supported_ratios.length < 1 || !output.supported_ratios.every((ratio) => IMAGE_RATIOS.includes(String(ratio))) || new Set(output.supported_ratios.map(String)).size !== output.supported_ratios.length) issues.push(`${label('output.supported_ratios')}must be a non-empty unique subset of the 8 supported ratios`)
  }
  const authoring = contract.authoring
  if (!isPlainObject(authoring)) issues.push(`${label('authoring')}must be an object`)
  else {
    if (!exactKeys(authoring, AUTHORING_REQUIRED, 'authoring', issues, 'CONTRACT_SCHEMA:')) return issues
    if (typeof authoring.primary_language !== 'string' || authoring.primary_language.length < 2) issues.push(`${label('authoring.primary_language')}must be at least 2 characters`)
    if (typeof authoring.requires_reference_binding !== 'boolean') issues.push(`${label('authoring.requires_reference_binding')}must be boolean`)
    if (authoring.requires_prompt_confirmation !== true) issues.push(`${label('authoring.requires_prompt_confirmation')}must be true`)
    if (authoring.user_instruction_priority !== 'highest') issues.push(`${label('authoring.user_instruction_priority')}must be highest`)
  }
  const execution = contract.execution
  if (!isPlainObject(execution)) issues.push(`${label('execution')}must be an object`)
  else {
    if (!exactKeys(execution, EXECUTION_REQUIRED, 'execution', issues, 'CONTRACT_SCHEMA:')) return issues
    if (execution.provider_neutral !== true) issues.push(`${label('execution.provider_neutral')}must be true`)
    if (execution.single_candidate_entry !== 'generate_image') issues.push(`${label('execution.single_candidate_entry')}must be generate_image`)
    if (execution.batch_entry !== 'batch-image-generation') issues.push(`${label('execution.batch_entry')}must be batch-image-generation`)
    if (execution.requires_paid_batch_confirmation !== true) issues.push(`${label('execution.requires_paid_batch_confirmation')}must be true`)
    if (execution.automatic_retry !== false) issues.push(`${label('execution.automatic_retry')}must be false`)
    if (execution.automatic_visual_ranking !== false) issues.push(`${label('execution.automatic_visual_ranking')}must be false`)
  }
  const knowledge = contract.knowledge
  if (!isPlainObject(knowledge)) issues.push(`${label('knowledge')}must be an object`)
  else {
    if (!exactKeys(knowledge, KNOWLEDGE_REQUIRED, 'knowledge', issues, 'CONTRACT_SCHEMA:')) return issues
    for (const key of KNOWLEDGE_REQUIRED) if (typeof knowledge[key] !== 'string') issues.push(`${label(`knowledge.${key}`)}must be a string`)
    if ('community_experience' in knowledge && typeof knowledge.community_experience !== 'string') issues.push(`${label('knowledge.community_experience')}must be a string`)
  }
  if (!isPlainObject(contract.business_constraints)) issues.push(`${label('business_constraints')}must be an object`)
  return issues
}

/** Structural validation of routing.json (routing.schema.json port). */
export function validateImageRoutingShape(routing: unknown): string[] {
  const issues: string[] = []
  if (!isPlainObject(routing)) {
    issues.push('ROUTING_SCHEMA: routing must be an object')
    return issues
  }
  if (!exactKeys(routing, ROUTING_REQUIRED, 'routing', issues, 'ROUTING_SCHEMA:')) return issues
  if (routing.schema_version !== 1) issues.push('ROUTING_SCHEMA:schema_version:must be 1')
  if (typeof routing.skill_id !== 'string' || !IMAGE_SKILL_ID_PATTERN.test(routing.skill_id)) issues.push('ROUTING_SCHEMA:skill_id:must be lowercase hyphen-case')
  for (const field of ['aliases', 'user_intents', 'subjects', 'styles', 'narrative_patterns', 'negative_intents']) {
    const value = routing[field]
    if (!Array.isArray(value) || !isStringArray(value) || new Set(value).size !== value.length) issues.push(`ROUTING_SCHEMA:${field}:must be an array of unique strings`)
  }
  if (typeof routing.priority !== 'number' || !Number.isInteger(routing.priority) || routing.priority < 0 || routing.priority > 100) issues.push('ROUTING_SCHEMA:priority:must be an integer from 0 to 100')
  return issues
}

/** Structural validation of intake-report.json (intake-report.schema.json port). */
export function validateImageReportShape(report: unknown): string[] {
  const issues: string[] = []
  if (!isPlainObject(report)) return ['REPORT_SCHEMA:report must be an object']
  if (!exactKeys(report, REPORT_REQUIRED, 'report', issues, 'REPORT_SCHEMA:')) return issues
  if (report.schema_version !== 1) issues.push('REPORT_SCHEMA:schema_version:must be 1')
  if (!REPORT_STATUSES.includes(String(report.status))) issues.push(`REPORT_SCHEMA:status:must be one of ${REPORT_STATUSES.join(', ')}`)
  if (typeof report.skill_id !== 'string') issues.push('REPORT_SCHEMA:skill_id:must be a string')
  if (typeof report.display_name !== 'string') issues.push('REPORT_SCHEMA:display_name:must be a string')
  if (!Array.isArray(report.sources) || report.sources.length < 1) issues.push('REPORT_SCHEMA:sources:must contain at least one source')
  if (typeof report.reviewed_core_sha256 !== 'string' || !IMAGE_SHA256_PATTERN.test(report.reviewed_core_sha256)) issues.push('REPORT_SCHEMA:reviewed_core_sha256:must be a 64-char hex string')
  const approval = report.user_approval
  if (!isPlainObject(approval) || !exactKeys(approval, ['required', 'approved', 'approved_by', 'approved_at'], 'user_approval', issues, 'REPORT_SCHEMA:')) return issues
  if (approval.required !== true) issues.push('REPORT_SCHEMA:user_approval.required:must be true')
  if (typeof approval.approved !== 'boolean') issues.push('REPORT_SCHEMA:user_approval.approved:must be boolean')
  if (approval.approved_by !== null && typeof approval.approved_by !== 'string') issues.push('REPORT_SCHEMA:user_approval.approved_by:must be a string or null')
  if (approval.approved_at !== null && typeof approval.approved_at !== 'string') issues.push('REPORT_SCHEMA:user_approval.approved_at:must be a string or null')
  return issues
}

/** Structural validation of intake-receipt.json (intake-receipt.schema.json port). */
export function validateImageReceiptShape(receipt: unknown): string[] {
  const issues: string[] = []
  if (!isPlainObject(receipt)) return ['RECEIPT_SCHEMA:receipt must be an object']
  if (!exactKeys(receipt, RECEIPT_REQUIRED, 'receipt', issues, 'RECEIPT_SCHEMA:')) return issues
  if (receipt.schema_version !== 2) issues.push('RECEIPT_SCHEMA:schema_version:must be 2')
  if (receipt.hash_algorithm !== IMAGE_HASH_ALGORITHM) issues.push(`RECEIPT_SCHEMA:hash_algorithm:must be ${IMAGE_HASH_ALGORITHM}`)
  if (typeof receipt.skill_id !== 'string') issues.push('RECEIPT_SCHEMA:skill_id:must be a string')
  if (receipt.status !== 'published') issues.push('RECEIPT_SCHEMA:status:must be published')
  if (typeof receipt.validator_version !== 'string') issues.push('RECEIPT_SCHEMA:validator_version:must be a string')
  if (receipt.approved_by !== 'user') issues.push('RECEIPT_SCHEMA:approved_by:must be user')
  if (typeof receipt.validated_at !== 'string') issues.push('RECEIPT_SCHEMA:validated_at:must be a string')
  if (!Array.isArray(receipt.sources) || receipt.sources.length < 1) issues.push('RECEIPT_SCHEMA:sources:must contain at least one source')
  for (const field of ['intake_report_sha256', 'reviewed_core_sha256', 'package_sha256']) {
    const value = receipt[field]
    if (typeof value !== 'string' || !IMAGE_SHA256_PATTERN.test(value)) issues.push(`RECEIPT_SCHEMA:${field}:must be a 64-char hex string`)
  }
  return issues
}

/** Semantic validation of a governed image Skill package
 *  (skill_package.validate_package port). */
export function validateImagePackage(root: string, options: { requireReport?: boolean; requireReceipt?: boolean } = {}): string[] {
  const issues: ImagePackageIssue[] = []
  const required = ['SKILL.md', 'contract.json', 'routing.json', 'references/creative-guidance.md', 'references/failure-cases.md', 'references/examples.md']
  if (options.requireReport) required.push('intake-report.json')
  if (options.requireReceipt) required.push('intake-receipt.json')
  for (const relative of required) {
    if (!existsSync(join(root, relative))) issues.push(`MISSING:${relative}`)
  }
  if (issues.length > 0) return issues
  let metadata: Record<string, string> = {}
  let contract: Record<string, unknown> = {}
  let routing: Record<string, unknown> = {}
  try {
    metadata = imageParseFrontmatter(readFileSync(join(root, 'SKILL.md'), 'utf8'))
    contract = JSON.parse(readFileSync(join(root, 'contract.json'), 'utf8'))
    routing = JSON.parse(readFileSync(join(root, 'routing.json'), 'utf8'))
  } catch (error) {
    return [`INVALID:${String(error instanceof Error ? error.message : error)}`]
  }
  issues.push(...validateImageContractShape(contract))
  issues.push(...validateImageRoutingShape(routing))
  const skillId = basename(root)
  const frontmatterKeys = Object.keys(metadata).sort()
  if (JSON.stringify(frontmatterKeys) !== JSON.stringify(['description', 'name']) || metadata.name !== skillId || contract.skill_id !== skillId || routing.skill_id !== skillId) issues.push('IDENTITY_MISMATCH')
  const references = Array.isArray(contract.references) ? (contract.references as Array<Record<string, unknown>>) : []
  const ids = references.map((item) => String(item.id ?? ''))
  if (new Set(ids).size !== ids.length) issues.push('REFERENCE_ORDER_MISMATCH')
  const policy = isPlainObject(contract.reference_policy) ? contract.reference_policy : {}
  const allowed = Array.isArray(policy.allowed_slot_ids) ? policy.allowed_slot_ids.map(String) : []
  if (JSON.stringify(allowed) !== JSON.stringify(ids)) issues.push('REFERENCE_ORDER_MISMATCH')
  if (contract.input_mode === 'text_only' && references.length > 0) issues.push('TEXT_ONLY_MUST_NOT_DECLARE_REFERENCES')
  if (contract.input_mode === 'reference_conditioned' && references.length === 0) issues.push('REFERENCE_CONDITIONED_REQUIRES_SLOTS')
  for (const reference of references) {
    const refId = String(reference.id ?? '')
    const requiredBool = reference.required === true
    const minCount = typeof reference.min_count === 'number' ? reference.min_count : 0
    const maxCount = reference.max_count === null ? null : typeof reference.max_count === 'number' ? reference.max_count : null
    if (requiredBool && minCount < 1) issues.push(`REQUIRED_SLOT_MIN:${refId}`)
    if (!requiredBool && minCount !== 0) issues.push(`OPTIONAL_SLOT_MIN:${refId}`)
    if (maxCount !== null && maxCount < minCount) issues.push(`SLOT_COUNT:${refId}`)
  }
  const workload = isPlainObject(contract.workload) ? contract.workload : {}
  for (const key of ['scene_count', 'candidate_count_per_scene']) {
    const bounds = isPlainObject(workload[key]) ? workload[key] as Record<string, unknown> : {}
    const min = typeof bounds.min === 'number' ? bounds.min : 1
    const max = bounds.max === null ? null : typeof bounds.max === 'number' ? bounds.max : null
    if (max !== null && max < min) issues.push(`WORKLOAD_RANGE:${key}`)
  }
  if (workload.batch_allowed !== true) {
    const sceneMax = isPlainObject(workload.scene_count) ? workload.scene_count.max : null
    const candidateMax = isPlainObject(workload.candidate_count_per_scene) ? workload.candidate_count_per_scene.max : null
    if (((typeof sceneMax === 'number' ? sceneMax : 2) > 1) || ((typeof candidateMax === 'number' ? candidateMax : 2) > 1)) issues.push('BATCH_RANGE_CONFLICT')
  }
  const knowledge = isPlainObject(contract.knowledge) ? contract.knowledge : {}
  for (const value of Object.values(knowledge)) {
    if (typeof value !== 'string') continue
    const target = resolve(root, value)
    const rootResolved = resolve(root)
    const rel = relative(rootResolved, target)
    if (rel.startsWith('..') || isAbsolute(rel)) issues.push(`KNOWLEDGE_PATH_ESCAPE:${value}`)
    else if (!existsSync(target)) issues.push(`MISSING_KNOWLEDGE:${value}`)
  }
  const packageText = listFiles(root)
    .filter((path) => IMAGE_TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase()))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
  if (IMAGE_TEMPLATE_MARKERS.test(packageText)) issues.push('UNRESOLVED_TEMPLATE_MARKER')
  if (IMAGE_FORBIDDEN.test(packageText)) issues.push('FORBIDDEN_EXECUTION_OR_SECRET_CONTENT')
  if (options.requireReport) {
    let report: Record<string, unknown> = {}
    try {
      report = JSON.parse(readFileSync(join(root, 'intake-report.json'), 'utf8'))
    } catch (error) {
      issues.push(`REPORT_SCHEMA:${String(error instanceof Error ? error.message : error)}`)
      return issues
    }
    issues.push(...validateImageReportShape(report))
    if (report.skill_id !== skillId) issues.push('REPORT_IDENTITY_MISMATCH')
  }
  if (options.requireReceipt) {
    let receipt: Record<string, unknown> = {}
    try {
      receipt = JSON.parse(readFileSync(join(root, 'intake-receipt.json'), 'utf8'))
    } catch (error) {
      issues.push(`RECEIPT_SCHEMA:${String(error instanceof Error ? error.message : error)}`)
      return issues
    }
    issues.push(...validateImageReceiptShape(receipt))
    if (receipt.skill_id !== skillId || receipt.package_sha256 !== imagePackageSha256(root)) issues.push('STALE_RECEIPT')
  }
  return [...new Set(issues)]
}

/** Validate an intake-receipt against a package directory
 *  (package_integrity.validate_receipt port). */
export function validateImageReceipt(root: string, expectedSkillId?: string): { receipt: Record<string, unknown> | null; issues: string[] } {
  const path = join(root, 'intake-receipt.json')
  if (!existsSync(path)) return { receipt: null, issues: ['MISSING_RECEIPT'] }
  let receipt: Record<string, unknown>
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { receipt: null, issues: ['INVALID_RECEIPT'] }
  }
  const issues: string[] = []
  if (receipt.schema_version !== 2 || receipt.hash_algorithm !== IMAGE_HASH_ALGORITHM) issues.push('UNSUPPORTED_RECEIPT_SCHEMA')
  if (receipt.status !== 'published' || receipt.approved_by !== 'user' || (expectedSkillId && receipt.skill_id !== expectedSkillId)) issues.push('INVALID_RECEIPT_IDENTITY')
  const hash = String(receipt.package_sha256 ?? '')
  if (!IMAGE_SHA256_PATTERN.test(hash)) issues.push('INVALID_RECEIPT_FIELDS')
  else if (hash !== imagePackageSha256(root)) issues.push('STALE_RECEIPT')
  return { receipt, issues: [...new Set(issues)] }
}

// ---------------------------------------------------------------------------
// Intake audit / approval / publish / upgrade / scaffold (curator scripts ports).
// ---------------------------------------------------------------------------

export function utcNow(): string {
  return new Date().toISOString()
}

/** Seal source provenance (audit_skill.py): name + SHA-256 per file. */
export function sealImageSources(paths: string[]): Array<{ name: string; sha256: string }> {
  return paths.map((path) => ({ name: basename(path), sha256: imageFileSha256(path) }))
}

/** Run the intake audit and build the intake-report object
 *  (audit_skill.py port; file writing happens in the tool layer). */
export function auditImageSkill(packageDir: string, sourcePaths: string[]): Record<string, unknown> {
  const contract = JSON.parse(readFileSync(join(packageDir, 'contract.json'), 'utf8')) as Record<string, unknown>
  const issues = validateImagePackage(packageDir)
  const sources = sealImageSources(sourcePaths)
  const references = Array.isArray(contract.references) ? (contract.references as Array<Record<string, unknown>>) : []
  const report: Record<string, unknown> = {
    schema_version: 1,
    status: issues.length > 0 ? 'needs_review' : 'ready_for_approval',
    skill_id: contract.skill_id,
    display_name: contract.display_name,
    sources,
    duplicate_check: { status: 'manual_review_required', checked_at: utcNow() },
    extraction_summary: {
      contract_facts: 'reviewed',
      workflow_rules: 'reviewed',
      creative_guidance: 'reviewed',
      examples_define_contract: false,
    },
    reference_summary: references.map((item) => ({
      id: item.id,
      role: item.role,
      scope: item.scope,
      required: item.required,
      min_count: item.min_count,
      max_count: item.max_count,
    })),
    output_summary: {
      supported_ratios: isPlainObject(contract.output) ? contract.output.supported_ratios : [],
      business_constraints: isPlainObject(contract.business_constraints) ? contract.business_constraints : {},
    },
    isolated_content: [],
    contract_conflicts: [],
    blocking_questions: [],
    validation_issues: issues,
    experience_preservation: { creative_guidance: true, failure_cases: true, examples: true },
    reviewed_core_sha256: imageCoreSha256(packageDir),
    user_approval: { required: true, approved: false, approved_by: null, approved_at: null },
  }
  return report
}

/** Approve a ready intake report (approve_intake_report.py port).
 *  Throws when the report is not ready or the package changed after review. */
export function approveImageIntakeReport(packageDir: string): Record<string, unknown> {
  const path = join(packageDir, 'intake-report.json')
  if (!existsSync(path)) throw new Error('intake-report.json is missing; run audit first')
  const report = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (report.status !== 'ready_for_approval' || (Array.isArray(report.blocking_questions) && report.blocking_questions.length > 0) || (Array.isArray(report.contract_conflicts) && report.contract_conflicts.length > 0) || (Array.isArray(report.validation_issues) && report.validation_issues.length > 0)) {
    throw new Error('Report is not ready for approval')
  }
  if (report.reviewed_core_sha256 !== imageCoreSha256(packageDir)) throw new Error('Core package changed after review')
  report.status = 'approved'
  report.user_approval = { required: true, approved: true, approved_by: 'user', approved_at: utcNow() }
  return report
}

/** Build the published intake receipt (publish_skill.py receipt port). */
export function buildImageIntakeReceipt(skillId: string, sources: Array<{ name: string; sha256: string }>, stagingDir: string, reviewedCoreSha256: string): Record<string, unknown> {
  return {
    schema_version: 2,
    hash_algorithm: IMAGE_HASH_ALGORITHM,
    skill_id: skillId,
    status: 'published',
    validator_version: IMAGE_VALIDATOR_VERSION,
    approved_by: 'user',
    validated_at: utcNow(),
    sources,
    intake_report_sha256: imageFileSha256(join(stagingDir, 'intake-report.json')),
    reviewed_core_sha256: reviewedCoreSha256,
    package_sha256: imagePackageSha256(stagingDir),
  }
}

function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src)) {
    const from = join(src, entry)
    const to = join(dst, entry)
    if (statSync(from).isDirectory()) copyTree(from, to)
    else copyFileSync(from, to)
  }
}

/** Publish an approved package into the library (publish_skill.py port).
 *  Stages under `<stagingRoot>/<skill_id>` (the directory name participates
 *  in identity validation) and returns the staging path before the atomic
 *  rename — the tool layer moves it into place and updates the registry.
 *  Throws on validation/approval gaps. */
export function stageImagePublish(packageDir: string, stagingRoot: string, sources: Array<{ name: string; sha256: string }>): { skillId: string; report: Record<string, unknown>; receipt: Record<string, unknown>; stagingPath: string } {
  const issues = validateImagePackage(packageDir, { requireReport: true })
  if (issues.length > 0) throw new Error(`Package is invalid: ${issues.join('; ')}`)
  const report = JSON.parse(readFileSync(join(packageDir, 'intake-report.json'), 'utf8')) as Record<string, unknown>
  if (report.status !== 'approved' || !isPlainObject(report.user_approval) || report.user_approval.approved !== true || report.reviewed_core_sha256 !== imageCoreSha256(packageDir)) {
    throw new Error('Package is not bound to a current user approval')
  }
  const skillId = String(report.skill_id)
  const stagingDir = join(stagingRoot, skillId)
  if (existsSync(stagingDir)) throw new Error(`Staging path already exists: ${stagingDir}`)
  copyTree(packageDir, stagingDir)
  const stagedReportPath = join(stagingDir, 'intake-report.json')
  const stagedReport = JSON.parse(readFileSync(stagedReportPath, 'utf8')) as Record<string, unknown>
  stagedReport.status = 'published'
  writeFileSync(stagedReportPath, JSON.stringify(stagedReport, null, 2) + '\n', 'utf8')
  const receipt = buildImageIntakeReceipt(skillId, sources, stagingDir, String(report.reviewed_core_sha256))
  writeFileSync(join(stagingDir, 'intake-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8')
  const post = validateImagePackage(stagingDir, { requireReport: true, requireReceipt: true })
  if (post.length > 0) throw new Error(`Invalid after receipt: ${post.join('; ')}`)
  return { skillId, report: stagedReport, receipt, stagingPath: stagingDir }
}

/** Scaffold a draft image business Skill from the template
 *  (scaffold_business_skill.py port). Returns the destination. */
export function scaffoldImageSkill(templateRoot: string, skillId: string, outputRoot: string, displayName?: string): string {
  if (!IMAGE_SKILL_ID_PATTERN.test(skillId) || skillId.length > 63) throw new Error('skill_id must be lowercase hyphen-case and at most 63 characters')
  const destination = join(outputRoot, skillId)
  if (existsSync(destination)) throw new Error(`Refusing to overwrite: ${destination}`)
  copyTree(templateRoot, destination)
  const display = displayName || '{{display_name}}'
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
      if (!['.md', '.json', '.yaml', '.yml'].includes(ext)) continue
      let text = readFileSync(path, 'utf8')
      text = text.split('{{skill_id}}').join(skillId).split('{{display_name}}').join(display)
      writeFileSync(path, text, 'utf8')
    }
  }
  walk(destination)
  return destination
}

/** Convert a governed image contract + routing into the shared registry
 *  contract shape (name/version/slots + image block). */
export function imageContractToRegistryContract(contract: Record<string, unknown>, routing: Record<string, unknown>, version: string): Record<string, unknown> {
  const references = Array.isArray(contract.references) ? (contract.references as Array<Record<string, unknown>>) : []
  const workload = isPlainObject(contract.workload) ? contract.workload : {}
  const output = isPlainObject(contract.output) ? contract.output : {}
  const taxonomy = [...(Array.isArray(routing.user_intents) ? routing.user_intents : []), ...(Array.isArray(routing.aliases) ? routing.aliases : [])].map(String)
  return {
    name: String(contract.skill_id),
    version,
    description: String(contract.description ?? ''),
    taxonomy,
    image: {
      input_mode: contract.input_mode,
      supported_ratios: Array.isArray(output.supported_ratios) ? output.supported_ratios.map(String) : [],
      scene_count: isPlainObject(workload.scene_count) ? workload.scene_count : { min: 1, max: 1 },
      candidate_count_per_scene: isPlainObject(workload.candidate_count_per_scene) ? workload.candidate_count_per_scene : { min: 1, max: 1 },
      batch_allowed: workload.batch_allowed === true,
    },
    slots: references.map((reference) => ({
      id: String(reference.id),
      label: String(reference.role ?? reference.id),
      min: typeof reference.min_count === 'number' ? reference.min_count : 0,
      max: reference.max_count === null ? void 0 : typeof reference.max_count === 'number' ? reference.max_count : void 0,
    })),
    prompt: {
      lang: String(isPlainObject(contract.authoring) && contract.authoring.primary_language ? contract.authoring.primary_language : 'zh'),
      corpus_policy: 'skill_references_only',
    },
  }
}
