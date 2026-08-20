/**
 * Codex_Flow skill-package format support (port of the upstream
 * packages/Codex_Flow platform: skill_package.py + approval.py).
 *
 * A governed package is now `SKILL.md` + `meta.yaml` (+ `workflow.yaml` for
 * staged profiles) + `references/` declared in `meta.references` with
 * `load-at` stages. The platform owns provider/execution/approval; business
 * skills only describe creative intent.
 *
 * This module is standalone (no DSH imports) so curator/registry/image tools
 * can share one validator and one review-card shape.
 *
 * @module dsh-media-plugins/shared/flow-format
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/* ------------------------------------------------------------------ */
/* Minimal YAML subset parser (flat scalars, lists, nested dicts)      */
/* ------------------------------------------------------------------ */

interface YamlLine {
  indent: number
  text: string
  lineNo: number
}

function prepareYaml(text: string): YamlLine[] {
  const lines: YamlLine[] = []
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const trimmed = raw.replace(/\s+$/, '')
    const content = trimmed.trim()
    if (content.length === 0 || content.startsWith('#')) continue
    const indent = trimmed.match(/^\s*/)![0].length
    lines.push({ indent, text: content, lineNo: index + 1 })
  }
  return lines
}

function parseScalar(raw: string): unknown {
  const value = raw.trim()
  if (value === '[]' || value === '{}') return []
  if (value === 'null' || value === '~' || value === '') return null
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function parseList(lines: YamlLine[], index: number, indent: number): { value: unknown[]; next: number } {
  const items: unknown[] = []
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent || !line.text.startsWith('- ')) {
      i += 1
      continue
    }
    const rest = line.text.slice(2).trim()
    const colon = rest.indexOf(':')
    if (colon > 0 && colon < rest.length - 1) {
      // dict-in-list: first key:value, then deeper-indented sibling fields
      const item: Record<string, unknown> = {
        [rest.slice(0, colon).trim()]: parseScalar(rest.slice(colon + 1)),
      }
      i += 1
      if (i < lines.length && lines[i].indent > line.indent) {
        const sub = parseBlock(lines, i, lines[i].indent)
        Object.assign(item, sub.value)
        i = sub.next
      }
      items.push(item)
      continue
    }
    if (colon < 0) {
      // bare scalar item
      items.push(parseScalar(rest))
      i += 1
      continue
    }
    // "- key:" with deeper nested block
    const item: Record<string, unknown> = {}
    const key = rest.slice(0, colon).trim()
    i += 1
    if (i < lines.length && lines[i].indent > line.indent) {
      const nextLine = lines[i]
      if (nextLine.text.startsWith('- ')) {
        const child = parseList(lines, i, nextLine.indent)
        item[key] = child.value
        i = child.next
      } else {
        const child = parseBlock(lines, i, nextLine.indent)
        item[key] = child.value
        i = child.next
      }
    } else {
      item[key] = null
    }
    items.push(item)
  }
  return { value: items, next: i }
}

function parseBlock(lines: YamlLine[], index: number, indent: number): { value: Record<string, unknown>; next: number } {
  const result: Record<string, unknown> = {}
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent || line.text.startsWith('- ')) {
      i += 1
      continue
    }
    const colon = line.text.indexOf(':')
    if (colon < 0) {
      i += 1
      continue
    }
    const key = line.text.slice(0, colon).trim()
    const rest = line.text.slice(colon + 1).trim()
    if (rest.length > 0) {
      result[key] = parseScalar(rest)
      i += 1
      continue
    }
    if (i + 1 < lines.length && lines[i + 1].indent > line.indent) {
      const nextLine = lines[i + 1]
      if (nextLine.text.startsWith('- ')) {
        const child = parseList(lines, i + 1, nextLine.indent)
        result[key] = child.value
        i = child.next
      } else {
        const child = parseBlock(lines, i + 1, nextLine.indent)
        result[key] = child.value
        i = child.next
      }
      continue
    }
    result[key] = null
    i += 1
  }
  return { value: result, next: i }
}

/** Parse the YAML subset used by meta.yaml / workflow.yaml. */
export function parseYamlLite(text: string): Record<string, unknown> {
  const lines = prepareYaml(text)
  if (lines.length === 0) return {}
  if (lines[0].text.startsWith('- ')) {
    return { items: parseList(lines, 0, lines[0].indent).value }
  }
  return parseBlock(lines, 0, lines[0].indent).value
}

export function readYamlFile(path: string): Record<string, unknown> {
  return parseYamlLite(readFileSync(path, 'utf8'))
}

/** Parse the SKILL.md YAML frontmatter; returns {metadata, body}. BOM-tolerant (upstream reads utf-8-sig). */
export function parseFlowFrontmatter(text: string): { metadata: Record<string, string>; body: string } {
  const cleaned = text.replace(/^\uFEFF/, '')
  const match = cleaned.match(/^---\s*\r?\n(.*?)\r?\n---(?:\r?\n|$)/s)
  if (!match) return { metadata: {}, body: cleaned }
  const metadata: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/)
    if (kv) metadata[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { metadata, body: cleaned.slice(match[0].length) }
}

/* ------------------------------------------------------------------ */
/* Package validation (mirrors upstream skill_package.py)              */
/* ------------------------------------------------------------------ */

export const FLOW_REQUIRED_META_FIELDS = [
  'schema',
  'name',
  'version',
  'primary-output',
  'workflow-profile',
  'interaction-profile',
] as const

export const FLOW_WORKFLOW_PROFILES = new Set(['simple', 'staged'])
export const FLOW_INTERACTION_PROFILES = new Set(['conversation', 'gui', 'hybrid'])
export const FLOW_GATES = new Set(['none', 'decision', 'approval', 'paid-execution', 'batch-approval'])

const POLLUTION_PATTERNS: Array<[string, RegExp]> = [
  ['PROVIDER_POLLUTION', /\b(Nano Banana|MiniMax|Kling|Seedance|Dreamina|Jimeng|ComfyUI|Gemini)\b/i],
  ['MODEL_POLLUTION', /\b(seedance\s*2(?:\.0|\.5)?|gpt-image|gemini-\d|kling|h3)\b/i],
  ['DAG_POLLUTION', /\b(DAG[_ -]?ID|workflow[_ -]?id|gateway protocol)\b/i],
  ['CREDENTIAL_POLLUTION', /\b(API[_-]?KEY|Authorization|Bearer\s+[A-Za-z0-9._-]+|Cookie:)\b/i],
  ['LOCAL_PATH_POLLUTION', /[A-Za-z]:\\|\/Users\/|\/home\//i],
  ['DANGEROUS_COMMAND', /\b(rm\s+-rf|Remove-Item\s+.*-Recurse|git\s+reset\s+--hard)\b/i],
]

function flowIssue(code: string): string {
  return code
}

/** Mirror upstream package_sha256: all files (posix relative path + bytes),
 *  skipping `.codex-flow-private` and the receipt itself (the receipt is the
 *  credential that binds this hash — it must not change the value it binds). */
export function flowPackageSha256(root: string): string {
  const digest = createHash('sha256')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (full.includes(`${sep}.codex-flow-private`)) continue
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (entry === 'intake-receipt.json' || entry === 'intake-sources.json') continue
      files.push(full)
    }
  }
  walk(root)
  for (const path of files.sort()) {
    const rel = relative(root, path).split(sep).join('/')
    digest.update(rel, 'utf8')
    digest.update('\0', 'utf8')
    digest.update(readFileSync(path))
    digest.update('\0', 'utf8')
  }
  return digest.digest('hex')
}

/** Collect declared reference paths from meta.references (dict or list shape). */
export function collectDeclaredReferencePaths(meta: Record<string, unknown>): Set<string> {
  const declared = new Set<string>()
  const references = meta.references
  if (references === null || references === undefined) return declared
  if (Array.isArray(references)) {
    for (const value of references) {
      if (value && typeof value === 'object' && 'path' in (value as Record<string, unknown>)) {
        declared.add(String((value as Record<string, unknown>).path).replace(/\\/g, '/'))
      } else if (typeof value === 'string') {
        declared.add(value.replace(/\\/g, '/'))
      }
    }
    return declared
  }
  if (typeof references === 'object') {
    for (const value of Object.values(references as Record<string, unknown>)) {
      if (value && typeof value === 'object' && 'path' in (value as Record<string, unknown>)) {
        declared.add(String((value as Record<string, unknown>).path).replace(/\\/g, '/'))
      }
    }
  }
  return declared
}

/** Reference routes keyed by name: {path, load-at} (for the registry runtime layer). */
export function flowReferenceRoutes(meta: Record<string, unknown>): Record<string, { path: string; load_at: string[] }> {
  const result: Record<string, { path: string; load_at: string[] }> = {}
  const references = meta.references
  if (!references || typeof references !== 'object' || Array.isArray(references)) return result
  for (const [name, value] of Object.entries(references as Record<string, unknown>)) {
    if (value && typeof value === 'object' && 'path' in (value as Record<string, unknown>)) {
      const record = value as Record<string, unknown>
      result[name] = {
        path: String(record.path).replace(/\\/g, '/'),
        load_at: Array.isArray(record['load-at']) ? (record['load-at'] as unknown[]).map(String) : [],
      }
    }
  }
  return result
}

function validateFlowReferences(root: string, meta: Record<string, unknown>): string[] {
  const issues: string[] = []
  const declared = collectDeclaredReferencePaths(meta)
  for (const relativePath of [...declared].sort()) {
    if (!statSafe(join(root, relativePath))) issues.push(flowIssue(`MISSING_REFERENCE:${relativePath}`))
  }
  const referencesRoot = join(root, 'references')
  if (statSafe(referencesRoot)) {
    for (const path of walkFiles(referencesRoot)) {
      const rel = relative(root, path).split(sep).join('/')
      if (!declared.has(rel)) issues.push(flowIssue(`UNREFERENCED_RESOURCE:${rel}`))
    }
  }
  const seen = new Map<string, string>()
  for (const path of walkFiles(root)) {
    const name = path.split(sep).pop()
    if (name === 'SKILL.md' || name === 'meta.yaml' || name === 'workflow.yaml') continue
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
    const rel = relative(root, path).split(sep).join('/')
    if (seen.has(digest)) {
      issues.push(flowIssue(`DUPLICATE_RESOURCE:${seen.get(digest)}:${rel}`))
    } else {
      seen.set(digest, rel)
    }
  }
  return issues
}

function validateFlowWorkflow(root: string): string[] {
  const issues: string[] = []
  const path = join(root, 'workflow.yaml')
  if (!statSafe(path)) return issues
  const workflow = readYamlFile(path)
  const stages = workflow.stages
  if (!Array.isArray(stages) || stages.length === 0) return [flowIssue('MISSING_WORKFLOW_STAGES')]
  const ids = new Set<string>()
  const dependencies: Record<string, string[]> = {}
  for (const stage of stages) {
    if (!stage || typeof stage !== 'object') {
      issues.push(flowIssue('INVALID_STAGE'))
      continue
    }
    const record = stage as Record<string, unknown>
    const stageId = record.id
    if (!stageId) {
      issues.push(flowIssue('MISSING_STAGE_ID'))
      continue
    }
    const id = String(stageId)
    if (ids.has(id)) issues.push(flowIssue(`DUPLICATE_STAGE:${id}`))
    ids.add(id)
    const gate = record.gate ?? 'none'
    if (!FLOW_GATES.has(String(gate))) issues.push(flowIssue(`INVALID_GATE:${id}:${gate}`))
    const dependsOn = record['depends-on']
    dependencies[id] = dependsOn === undefined ? [] : Array.isArray(dependsOn) ? dependsOn.map(String) : [String(dependsOn)]
  }
  for (const [stageId, deps] of Object.entries(dependencies)) {
    for (const dep of deps) {
      if (!ids.has(dep)) issues.push(flowIssue(`UNKNOWN_DEPENDENCY:${stageId}:${dep}`))
    }
  }
  for (const stageId of Object.keys(dependencies)) {
    if (hasFlowCycle(stageId, dependencies, new Set(), new Set())) {
      issues.push(flowIssue('WORKFLOW_CYCLE'))
      break
    }
  }
  return issues
}

function hasFlowCycle(node: string, graph: Record<string, string[]>, visiting: Set<string>, visited: Set<string>): boolean {
  if (visited.has(node)) return false
  if (visiting.has(node)) return true
  visiting.add(node)
  for (const dep of graph[node] ?? []) {
    if (hasFlowCycle(dep, graph, visiting, visited)) return true
  }
  visiting.delete(node)
  visited.add(node)
  return false
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function walkFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (full.includes(`${sep}.codex-flow-private`)) continue
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * Validate a Codex_Flow skill package. Returns issue codes (upstream-compatible
 * names). Empty array means valid. With `published=true`, the intake-receipt
 * audit chain is enforced: receipt must exist and its package_hash must equal
 * the current package hash (STALE_RECEIPT binding, mirroring the CS/IS
 * receipt contract).
 */
export function validateCodexFlowPackage(root: string, published = false): string[] {
  const issues: string[] = []
  const skillPath = join(root, 'SKILL.md')
  const metaPath = join(root, 'meta.yaml')
  if (!statSafe(skillPath)) issues.push(flowIssue('MISSING_SKILL_MD'))
  if (!statSafe(metaPath)) issues.push(flowIssue('MISSING_META_YAML'))
  if (issues.length > 0) return issues

  const { metadata: frontmatter, body } = parseFlowFrontmatter(readFileSync(skillPath, 'utf8'))
  const meta = readYamlFile(metaPath)
  const name = meta.name ?? frontmatter.name
  if (!frontmatter.name) issues.push(flowIssue('MISSING_FRONTMATTER_NAME'))
  if (!frontmatter.description) issues.push(flowIssue('MISSING_FRONTMATTER_DESCRIPTION'))
  for (const field of [...FLOW_REQUIRED_META_FIELDS].sort()) {
    if (!(field in meta)) issues.push(flowIssue(`MISSING_META_${field.toUpperCase().replace(/-/g, '_')}`))
  }
  if (name && frontmatter.name && meta.name && frontmatter.name !== meta.name) {
    issues.push(flowIssue('NAME_MISMATCH'))
  }
  if (name && root.split(sep).pop() !== name) issues.push(flowIssue('DIRECTORY_NAME_MISMATCH'))
  if (!FLOW_WORKFLOW_PROFILES.has(String(meta['workflow-profile'] ?? ''))) issues.push(flowIssue('INVALID_WORKFLOW_PROFILE'))
  if (!FLOW_INTERACTION_PROFILES.has(String(meta['interaction-profile'] ?? ''))) issues.push(flowIssue('INVALID_INTERACTION_PROFILE'))
  if (meta['workflow-profile'] === 'staged' && !statSafe(join(root, 'workflow.yaml'))) {
    issues.push(flowIssue('MISSING_WORKFLOW_YAML'))
  }
  if (statSafe(join(root, 'ui', 'dist'))) issues.push(flowIssue('UI_DIST_PRESENT_DO_NOT_LOAD'))

  const textToScan = [JSON.stringify(frontmatter), JSON.stringify(meta), body].join('\n')
  for (const [code, pattern] of POLLUTION_PATTERNS) {
    if (pattern.test(textToScan)) issues.push(flowIssue(code))
  }

  issues.push(...validateFlowReferences(root, meta))
  issues.push(...validateFlowWorkflow(root))
  if (published) {
    const receiptPath = join(root, 'intake-receipt.json')
    if (!statSafe(receiptPath)) {
      issues.push(flowIssue('MISSING_INTAKE_RECEIPT'))
    } else {
      try {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
        if (receipt.package_hash !== flowPackageSha256(root)) {
          issues.push(flowIssue('STALE_RECEIPT'))
        }
      } catch {
        issues.push(flowIssue('INVALID_INTAKE_RECEIPT'))
      }
    }
  }
  return [...new Set(issues)].sort()
}

/** Build the Codex_Flow intake receipt (audit chain: sources + package hash). */
export function buildFlowIntakeReceipt(
  root: string,
  sources: Array<{ name: string; sha256: string }>,
  options: { validator?: string; approved_by?: string; version?: string } = {},
): Record<string, unknown> {
  return {
    schema: 'codex-flow-receipt/v1',
    skill_id: String(readYamlFile(join(root, 'meta.yaml')).name ?? ''),
    version: String(options.version ?? readYamlFile(join(root, 'meta.yaml')).version ?? '1.0.0'),
    validator: options.validator ?? 'flow-1.0',
    approved_by: options.approved_by ?? 'user',
    sources,
    package_hash: flowPackageSha256(root),
    created_at: new Date().toISOString(),
    validation: 'passed',
  }
}

/* ------------------------------------------------------------------ */
/* Review card + registry record shapes (mirrors approval.py/discover) */
/* ------------------------------------------------------------------ */

/** Paid points = workflow stage ids whose gate is paid-execution or batch-approval. */
export function flowPaidPoints(root: string): string[] {
  const path = join(root, 'workflow.yaml')
  if (!statSafe(path)) return []
  const workflow = readYamlFile(path)
  const points: string[] = []
  for (const stage of (workflow.stages as unknown[]) ?? []) {
    if (stage && typeof stage === 'object') {
      const record = stage as Record<string, unknown>
      if (record.gate === 'paid-execution' || record.gate === 'batch-approval') points.push(String(record.id))
    }
  }
  return points
}

/** Build the audit review card shown to the user before publish (mirrors approval.build_review_card). */
export function buildFlowReviewCard(root: string): Record<string, unknown> {
  const issues = validateCodexFlowPackage(root)
  if (issues.length > 0) {
    throw new Error(`package has blocking issues: ${issues.join(', ')}`)
  }
  const { metadata: frontmatter } = parseFlowFrontmatter(readFileSync(join(root, 'SKILL.md'), 'utf8'))
  const meta = readYamlFile(join(root, 'meta.yaml'))
  return {
    skill_id: meta.name,
    version: String(meta.version ?? '1.0.0'),
    description: frontmatter.description ?? '',
    display_name: meta['display-name-zh'] ?? meta.name,
    primary_output: meta['primary-output'],
    intermediate_outputs: meta['intermediate-outputs'] ?? [],
    workflow_profile: meta['workflow-profile'],
    interaction_profile: meta['interaction-profile'],
    capabilities: meta.capabilities ?? [],
    paid_points: flowPaidPoints(root),
    package_hash: flowPackageSha256(root),
  }
}

/**
 * Map a validated package to a registry ingest contract (name/version/
 * description/taxonomy + `flow` metadata). Mirrors the compact record of
 * upstream registry.discover.
 */
export function flowMetaToRegistryShape(
  root: string,
): { name: string; version: string; description: string; taxonomy: string[]; flow: Record<string, unknown> } {
  const { metadata: frontmatter } = parseFlowFrontmatter(readFileSync(join(root, 'SKILL.md'), 'utf8'))
  const meta = readYamlFile(join(root, 'meta.yaml'))
  const taxonomy = [...((meta.aliases as unknown[]) ?? []), ...((meta.tags as unknown[]) ?? [])].map(String)
  return {
    name: String(meta.name),
    version: String(meta.version ?? '1.0.0'),
    description: frontmatter.description ?? '',
    taxonomy,
    flow: {
      capabilities: ((meta.capabilities as unknown[]) ?? []).map(String),
      exclude_intents: ((meta['exclude-intents'] as unknown[]) ?? []).map(String),
      primary_output: String(meta['primary-output'] ?? ''),
      display_name: String(meta['display-name-zh'] ?? meta.name),
      workflow_profile: String(meta['workflow-profile'] ?? ''),
      interaction_profile: String(meta['interaction-profile'] ?? ''),
      release_tier: String(meta['release-tier'] ?? 'experimental'),
      package_sha256: flowPackageSha256(root),
      references: flowReferenceRoutes(meta),
      entry: join(root, 'SKILL.md'),
      source: String(meta.source ?? 'codex-flow'),
    },
  }
}
