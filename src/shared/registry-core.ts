/**
 * Skill Registry domain (Codex_CS rebuild, all-JS): node:sqlite + FTS5
 * (trigram tokenizer for CJK) with ingest / search / get / publish /
 * deprecate / list, contract validation, dedupe by (name, version) and
 * content-hash change detection. Pure domain — no DSH imports.
 *
 * @module dsh-media-plugins/shared/registry-core
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { existsSync, statSync } from 'node:fs'

export type SkillStatus = 'draft' | 'published' | 'deprecated'

export interface SlotContract {
  id: string
  label?: string
  min?: number
  max?: number
  planned_count?: number
  count_rule?: 'per_second' | 'fixed' | 'range' | string
  /**
   * References-style fields carried through on flow-synthesized contracts
   * (project-core planSlots reads min_count / max_count; max_count null = no
   * upper bound). Optional so legacy SlotContracts stay unchanged.
   */
  media_type?: string
  min_count?: number
  max_count?: number | null
}

export interface FlowContract {
  capabilities: string[]
  exclude_intents: string[]
  primary_output: string
  display_name: string
  workflow_profile: string
  interaction_profile: string
  release_tier: string
  package_sha256: string
  references: Record<string, { path: string; load_at: string[] }>
  entry: string
  source: string
}

export interface SkillContract {
  name: string
  version: string
  description?: string
  taxonomy?: string[]
  video?: {
    ratios?: string[]
    duration_min?: number
    duration_max?: number
  }
  image?: {
    input_mode?: 'text_only' | 'reference_conditioned'
    supported_ratios?: string[]
    scene_count?: { min: number; max: number | null }
    candidate_count_per_scene?: { min: number; max: number | null }
    batch_allowed?: boolean
  }
  slots?: SlotContract[]
  prompt?: {
    lang?: string
    corpus_policy?: 'no_corpus' | 'up_to_10_examples'
  }
  /** Codex_Flow format metadata (present for packages with meta.yaml). */
  flow?: FlowContract
}

export interface SkillRecord {
  id: string
  name: string
  version: string
  description: string
  status: SkillStatus
  taxonomy: string[]
  contract: SkillContract
  routing: Record<string, unknown>
  packageRoot: string
  provenance: string
  sha256: string
  createdAt: string
  updatedAt: string
}

export interface SearchHit {
  id: string
  name: string
  version: string
  description: string
  status: SkillStatus
  taxonomy: string[]
  score: number
  matched_reasons?: string[]
  negative_hits?: string[]
  material_guidance?: Array<Record<string, unknown>>
}

/** Taxonomy (ported from Codex_CS skill-registry/config/taxonomy.json). */
export const ROUTING_FIELDS = ['aliases', 'user_intents', 'subjects', 'styles', 'narrative_patterns', 'negative_intents'] as const

export const TAXONOMY: { categories: Record<string, string[]>; synonyms: Record<string, string[]> } = {
  categories: {
    intents: ['宣传片', '品牌展示', '城市形象', '地产宣传', '地标巡游', '建筑展示', '动态组装', '提示词'],
    subjects: ['城市', '地产', '楼盘', '建筑', '地标', 'Logo', '品牌', 'IP', '角色', '人居'],
    styles: ['科幻', '未来感', '晨曦', '云雾', '高奢', '写实', '电影感', '巨型', '3D'],
    narrative_patterns: ['巡游', '硬切', '一镜到底', '航拍', '穿梭', '组装', '拆解', '特写', '全貌', '多场景'],
  },
  synonyms: {
    logo: ['Logo', 'LOGO', '标志', '品牌标识'],
    ip: ['IP', '角色', '吉祥物'],
    地产: ['地产', '房地产', '楼盘', '住宅', '人居'],
    科幻: ['科幻', '未来', '赛博', '科技感'],
    宣传片: ['宣传片', '宣传视频', '形象片', '推广片'],
  },
}

/** Normalize a string: strip non-alphanumeric/CJK, casefold (registry.py port). */
export function normalizeTerm(value: string): string {
  return String(value ?? '').replace(/[^0-9a-z\u4e00-\u9fff]+/gi, '').toLowerCase()
}

/** Match a query against routing terms with synonym expansion. */
export function matchedTerms(
  query: string,
  routing: Record<string, unknown>,
): { positive: string[]; negative: string[] } {
  const queryNorm = normalizeTerm(query)
  const positive: string[] = []
  const negative: string[] = []
  const synonymHits = new Set<string>()
  for (const [canonical, forms] of Object.entries(TAXONOMY.synonyms)) {
    if (forms.some((form) => queryNorm.includes(normalizeTerm(form)))) synonymHits.add(canonical.toLowerCase())
  }
  for (const field of ROUTING_FIELDS) {
    const values = Array.isArray(routing[field]) ? routing[field] : []
    for (const term of values) {
      const key = String(term).toLowerCase()
      const hit = queryNorm.includes(normalizeTerm(String(term))) || synonymHits.has(key)
      if (hit) {
        if (field === 'negative_intents') negative.push(String(term))
        else positive.push(String(term))
      }
    }
  }
  return { positive, negative }
}

/** Material guidance from the contract references (registry.py material_summary). */
export function materialGuidance(contractJson: string): Array<Record<string, unknown>> {
  try {
    const contract = JSON.parse(contractJson)
    const refs = Array.isArray(contract.references) ? contract.references : Array.isArray(contract.slots) ? contract.slots : []
    return refs.map((item: Record<string, unknown>) => ({
      id: String(item.id ?? ''),
      media_type: String(item.media_type ?? ''),
      description: String(item.description ?? ''),
      required: item.required ?? null,
      min_count: item.min_count ?? null,
      max_count: item.max_count ?? null,
      ordered: item.ordered ?? null,
    }))
  } catch {
    return []
  }
}

/** Supported video ratios (project pipeline contract). */
import { VIDEO_RATIOS, IMAGE_RATIOS } from './ratios.ts'

export { VIDEO_RATIOS, IMAGE_RATIOS }

/** Structural validation of a Skill contract; throws on violation. */
export function validateContract(raw: unknown): SkillContract {
  const c = (raw ?? {}) as SkillContract
  if (typeof c.name !== 'string' || c.name.trim().length === 0) throw new Error('contract.name is required')
  if (typeof c.version !== 'string' || c.version.trim().length === 0) throw new Error('contract.version is required')
  if (c.video !== undefined) {
    if (c.video.duration_min !== undefined && !Number.isInteger(c.video.duration_min)) throw new Error('contract.video.duration_min must be an integer')
    if (c.video.duration_max !== undefined && !Number.isInteger(c.video.duration_max)) throw new Error('contract.video.duration_max must be an integer')
    if (Array.isArray(c.video.ratios)) {
      for (const r of c.video.ratios) {
        if (!VIDEO_RATIOS.includes(r as any)) throw new Error(`contract.video.ratios contains unsupported ratio: ${r}`)
      }
    }
  }
  if (c.image !== undefined) {
    if (c.image.input_mode !== undefined && c.image.input_mode !== 'text_only' && c.image.input_mode !== 'reference_conditioned') throw new Error('contract.image.input_mode must be text_only or reference_conditioned')
    if (Array.isArray(c.image.supported_ratios)) {
      for (const r of c.image.supported_ratios) {
        if (!IMAGE_RATIOS.includes(r as any)) throw new Error(`contract.image.supported_ratios contains unsupported ratio: ${r}`)
      }
    }
    for (const key of ['scene_count', 'candidate_count_per_scene'] as const) {
      const range = c.image[key]
      if (range !== undefined) {
        if (!Number.isInteger(range.min) || range.min < 1) throw new Error(`contract.image.${key}.min must be an integer >= 1`)
        if (range.max !== null && range.max !== undefined && (!Number.isInteger(range.max) || range.max < 1)) throw new Error(`contract.image.${key}.max must be null or an integer >= 1`)
        if (range.max !== null && range.max !== undefined && range.min > range.max) throw new Error(`contract.image.${key}: min > max`)
      }
    }
    if (c.image.batch_allowed !== undefined && typeof c.image.batch_allowed !== 'boolean') throw new Error('contract.image.batch_allowed must be boolean')
  }
  if (c.slots !== undefined) {
    if (!Array.isArray(c.slots)) throw new Error('contract.slots must be an array')
    const ids = new Set<string>()
    for (const slot of c.slots) {
      if (typeof slot.id !== 'string' || slot.id.trim().length === 0) throw new Error('each slot requires an id')
      if (ids.has(slot.id)) throw new Error(`duplicate slot id: ${slot.id}`)
      ids.add(slot.id)
      if (slot.min !== undefined && (!Number.isInteger(slot.min) || slot.min < 0)) throw new Error(`slot ${slot.id}: min must be a non-negative integer`)
      if (slot.max !== undefined && (!Number.isInteger(slot.max) || slot.max < 0)) throw new Error(`slot ${slot.id}: max must be a non-negative integer`)
      if (slot.min !== undefined && slot.max !== undefined && slot.min > slot.max) throw new Error(`slot ${slot.id}: min > max`)
      if (slot.planned_count !== undefined && (!Number.isInteger(slot.planned_count) || slot.planned_count < 0)) throw new Error(`slot ${slot.id}: planned_count must be a non-negative integer`)
    }
  }
  if (c.flow !== undefined) {
    if (!Array.isArray(c.flow.capabilities)) throw new Error('contract.flow.capabilities must be an array')
    if (!Array.isArray(c.flow.exclude_intents)) throw new Error('contract.flow.exclude_intents must be an array')
    if (typeof c.flow.primary_output !== 'string' || c.flow.primary_output.trim().length === 0) throw new Error('contract.flow.primary_output is required')
    if (typeof c.flow.package_sha256 !== 'string' || c.flow.package_sha256.length === 0) throw new Error('contract.flow.package_sha256 is required')
  }
  return {
    name: c.name.trim(),
    version: c.version.trim(),
    description: typeof c.description === 'string' ? c.description : '',
    taxonomy: Array.isArray(c.taxonomy) ? c.taxonomy.map(String) : [],
    video: c.video,
    image: c.image,
    slots: c.slots,
    prompt: c.prompt,
    flow: c.flow,
  }
}

/** Content hash of a skill package for change detection. */
export function skillSha256(name: string, version: string, contractJson: string, routingJson: string): string {
  return createHash('sha256').update(JSON.stringify({ name, version, contract: contractJson, routing: routingJson })).digest('hex')
}

export class SkillRegistry {
  readonly db: DatabaseSync
  readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        taxonomy TEXT NOT NULL DEFAULT '[]',
        contract_json TEXT NOT NULL DEFAULT '{}',
        routing_json TEXT NOT NULL DEFAULT '{}',
        package_root TEXT NOT NULL DEFAULT '',
        provenance TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name_version ON skills(name, version);
      CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
        skill_id UNINDEXED, name, description, taxonomy, contract, tokenize='trigram'
      );
    `)
  }

  private rowToRecord(row: any): SkillRecord {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      status: row.status as SkillStatus,
      taxonomy: safeJson(row.taxonomy, []),
      contract: safeJson(row.contract_json, {}),
      routing: safeJson(row.routing_json, {}),
      packageRoot: row.package_root,
      provenance: row.provenance,
      sha256: row.sha256,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** Ingest a skill package; re-ingest with changed content fails unless force. */
  ingest(
    input: { contract: SkillContract; routing?: Record<string, unknown>; packageRoot?: string; provenance?: string },
    options: { force?: boolean } = {},
  ): SkillRecord {
    const contract = validateContract(input.contract)
    const routing = input.routing ?? {}
    const now = new Date().toISOString()
    const id = `${contract.name}@${contract.version}`
    const sha = skillSha256(contract.name, contract.version, JSON.stringify(contract), JSON.stringify(routing))

    const existing = this.get(contract.name, contract.version)
    if (existing) {
      if (existing.sha256 !== sha && !options.force) {
        throw new Error(`skill ${id} already exists with different content; pass force=true to overwrite`)
      }
      this.db
        .prepare(
          `UPDATE skills SET description=?, status=?, taxonomy=?, contract_json=?, routing_json=?, package_root=?, provenance=?, sha256=?, updated_at=? WHERE id=?`,
        )
        .run(
          contract.description ?? '',
          existing.status,
          JSON.stringify(contract.taxonomy ?? []),
          JSON.stringify(contract),
          JSON.stringify(routing),
          input.packageRoot ?? existing.packageRoot,
          input.provenance ?? existing.provenance,
          sha,
          now,
          id,
        )
      this.syncFts(id)
      return this.get(contract.name, contract.version)!
    }

    this.db
      .prepare(
        `INSERT INTO skills (id, name, version, description, status, taxonomy, contract_json, routing_json, package_root, provenance, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        contract.name,
        contract.version,
        contract.description ?? '',
        JSON.stringify(contract.taxonomy ?? []),
        JSON.stringify(contract),
        JSON.stringify(routing),
        input.packageRoot ?? '',
        input.provenance ?? '',
        sha,
        now,
        now,
      )
    this.syncFts(id)
    return this.get(contract.name, contract.version)!
  }

  private syncFts(id: string): void {
    const rec = this.rowToRecord(this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id))
    this.db.prepare('DELETE FROM skills_fts WHERE skill_id = ?').run(id)
    this.db
      .prepare('INSERT INTO skills_fts (skill_id, name, description, taxonomy, contract) VALUES (?, ?, ?, ?, ?)')
      .run(id, rec.name, rec.description, rec.taxonomy.join(' '), JSON.stringify(rec.contract))
  }

  get(name: string, version?: string): SkillRecord | undefined {
    const row = version
      ? this.db.prepare('SELECT * FROM skills WHERE name = ? AND version = ?').get(name, version)
      : this.db.prepare('SELECT * FROM skills WHERE name = ? ORDER BY created_at DESC LIMIT 1').get(name)
    return row ? this.rowToRecord(row) : undefined
  }

  /** FTS5 trigram search over name/description/taxonomy/contract, with
   *  CJK-friendly tokenization: trigram grams + latin words + per-term LIKE,
   *  then semantic scoring (synonyms, negative weighting, alias boost). */
  search(query: string, limit = 10, status: SkillStatus | 'any' = 'published'): SearchHit[] {
    const q = (query ?? '').trim()
    if (q.length === 0) return []
    const terms = tokenizeSearchTerms(q)
    let rows: any[] = []

    // 1) FTS5 trigram MATCH over trigram grams of the normalized query + latin words
    //    (registry.py query_terms port: unsegmented CJK sentences still retrieve).
    try {
      const compact = normalizeTerm(q)
      const grams: string[] = []
      for (let i = 0; i < Math.max(0, compact.length - 2); i += 1) grams.push(compact.slice(i, i + 3))
      const words = (q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(Boolean)
      const ftsTerms = [...new Set([...grams, ...words])].slice(0, 64)
      if (ftsTerms.length > 0) {
        const expression = ftsTerms.map((t) => `"${t.replaceAll('"', ' ')}"`).join(' OR ')
        rows = this.db
          .prepare(
            `SELECT s.id, s.name, s.version, s.description, s.status, s.taxonomy, s.routing_json, s.contract_json, bm25(skills_fts) AS score
             FROM skills_fts JOIN skills s ON s.id = skills_fts.skill_id
             WHERE skills_fts MATCH ?
             ORDER BY score LIMIT ?`,
          )
          .all(expression, Math.max(limit, 20))
      }
    } catch {
      rows = []
    }

    // 2) per-term LIKE scoring (CJK bigrams) — ALWAYS runs and merges with FTS rows,
    //    so 2-char intent fragments (巨型/巡游/地标) surface even when FTS found others.
    {
      const scored: Array<Record<string, unknown>> = []
      const all = this.db.prepare('SELECT * FROM skills').all() as Array<Record<string, unknown>>
      for (const row of all) {
        const haystacks = [
          String(row.name ?? ''),
          String(row.description ?? ''),
          String(row.taxonomy ?? ''),
          String(row.contract_json ?? ''),
          String(row.routing_json ?? ''),
        ]
        let score = 0
        // LIKE keys: tokenized terms + CJK bigrams (2-char intent fragments like 巨型/巡游/地标)
        const likeKeys = new Set<string>()
        for (const term of terms) {
          likeKeys.add(term.toLowerCase())
          const cjk = term.match(/[\u4e00-\u9fff]+/g) ?? []
          for (const run of cjk) {
            if (run.length >= 2) {
              for (let i = 0; i < run.length - 1; i += 1) likeKeys.add(run.slice(i, i + 2).toLowerCase())
            }
          }
        }
        for (const key of likeKeys) {
          for (const haystack of haystacks) {
            const lower = haystack.toLowerCase()
            let idx = lower.indexOf(key)
            while (idx >= 0) {
              score += 1
              idx = lower.indexOf(key, idx + key.length)
            }
          }
        }
        if (score > 0) scored.push({ ...row, score: -score })
      }
      scored.sort((a, b) => Number(a.score) - Number(b.score))
      // merge LIKE results into FTS rows (dedupe by id, keep the higher base score)
      const byId = new Map<string, Record<string, unknown>>()
      for (const r of rows) byId.set(String(r.id), r)
      for (const s of scored) {
        const existing = byId.get(String(s.id))
        if (!existing || Math.abs(Number(s.score)) > Math.abs(Number(existing.score))) byId.set(String(s.id), s)
      }
      rows = [...byId.values()]
    }

    // 3) semantic-only retrieval: synonyms/category terms matched against routing
    //    fields surface even when FTS/LIKE grams miss (e.g. 地产/楼盘 synonyms).
    if (rows.length === 0) {
      const all = this.db.prepare('SELECT * FROM skills').all() as Array<Record<string, unknown>>
      const semantic: Array<Record<string, unknown>> = []
      for (const row of all) {
        const routing = safeJson(row.routing_json, {})
        const { positive } = matchedTerms(q, routing)
        if (positive.length > 0) semantic.push({ ...row, score: -1 })
      }
      semantic.sort((a, b) => Number(a.score) - Number(b.score))
      rows = semantic.slice(0, limit)
    }

    return rows
      .filter((r) => status === 'any' || r.status === status)
      .map((r) => {
        const routing = safeJson(r.routing_json, {})
        const taxonomy = safeJson(r.taxonomy, [])
        const aliases = Array.isArray(routing.aliases)
          ? routing.aliases.map(String)
          : Array.isArray(taxonomy)
            ? taxonomy.map(String)
            : []
        const queryNorm = normalizeTerm(q)
        const exactAlias = aliases.some((alias) => normalizeTerm(alias) === queryNorm) || normalizeTerm(String(r.name ?? '')) === queryNorm
        const { positive, negative } = matchedTerms(q, routing)
        const base = Math.abs(Number(r.score ?? 0))
        const score = base + positive.length * 12 - negative.length * 20 + Number(routing.priority ?? 50) * 0.1 + (exactAlias ? 100 : 0)
        const reasons: string[] = []
        if (exactAlias) reasons.push('名称或别名精确命中')
        for (const term of positive) reasons.push(`意图命中：${term}`)
        if (reasons.length === 0) reasons.push('全文意图相似')
        return {
          id: r.id as string,
          name: r.name as string,
          version: r.version as string,
          description: r.description as string,
          status: r.status as SkillStatus,
          taxonomy: safeJson(r.taxonomy, []),
          score: Math.round(score * 100) / 100,
          matched_reasons: reasons,
          negative_hits: negative,
          material_guidance: materialGuidance(String(r.contract_json ?? '')),
        }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  setStatus(name: string, version: string, status: SkillStatus): SkillRecord {
    const existing = this.get(name, version)
    if (!existing) throw new Error(`skill not found: ${name}@${version}`)
    this.db
      .prepare('UPDATE skills SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), existing.id)
    return this.get(name, version)!
  }

  /**
   * Fast-path routing (port of upstream Codex_Flow registry.route): one
   * decision without loading Skill bodies or reference files. Candidates are
   * filtered by capability and exclude-intents, scored by weighted phrase
   * matching (skill_id 70 / display_name 80 / aliases 80 / tags 60 / token 4).
   * A best score >= 60 yields `specialized_skill`; otherwise the platform
   * fallback `generic-image` is returned for image capabilities (upstream
   * contract). `generic-image` itself is never a candidate.
   */
  route(query: string, capability = 'image.generate', limit = 3): {
    query: string
    capability: string
    decision: Record<string, unknown>
    candidates: Array<Record<string, unknown>>
  } {
    const q = (query ?? '').trim()
    const rows = this.db.prepare("SELECT * FROM skills WHERE status = 'published'").all() as Array<Record<string, unknown>>
    const candidates: Array<Record<string, unknown>> = []
    for (const row of rows) {
      const contract = safeJson(row.contract_json, {}) as SkillContract
      const caps = contract.flow?.capabilities ?? []
      if (caps.length > 0 && !caps.includes(capability)) continue
      if (String(row.name ?? '') === 'generic-image') continue
      const excluded = (contract.flow?.exclude_intents ?? []).map((value) => String(value).toLowerCase())
      if (excluded.some((value) => value.length > 0 && q.toLowerCase().includes(value))) continue
      const score = routeScore(q, {
        skill_id: String(row.name ?? ''),
        display_name: String(contract.flow?.display_name ?? row.name ?? ''),
        description: String(row.description ?? ''),
        aliases: (contract.taxonomy ?? []).map(String),
        tags: (contract.taxonomy ?? []).map(String),
        capabilities: caps,
      })
      if (score > 0) {
        candidates.push({ skill_id: row.name, display_name: contract.flow?.display_name ?? row.name, description: row.description, source: contract.flow?.source ?? 'codex-flow', score })
      }
    }
    candidates.sort((a, b) => Number(b.score) - Number(a.score))
    const best = candidates[0] as Record<string, unknown> | undefined
    let decision: Record<string, unknown>
    if (best && Number(best.score) >= 60) {
      decision = { mode: 'specialized_skill', skill_id: best.skill_id, confidence: 'high', score: best.score, source: best.source }
    } else if (capability.startsWith('image.')) {
      decision = {
        mode: 'generic_image',
        skill_id: 'generic-image',
        confidence: 'fallback',
        style_library: shouldConsultStyleLibrary(q) ? 'recommended' : 'not_needed',
        case_corpus: shouldConsultStyleLibrary(q) ? 'recommended' : 'not_needed',
      }
    } else {
      decision = { mode: 'no_match', confidence: 'fallback' }
    }
    return { query, capability, decision, candidates: candidates.slice(0, limit) }
  }

  /** Resolve a compact record to its executable runtime descriptor (port of registry.resolve). */
  resolve(name: string, version?: string): { record: SkillRecord; runtime: Record<string, unknown>; available: boolean } {
    const record = this.get(name, version)
    if (!record) throw new Error(`skill is not registered: ${name}${version ? `@${version}` : ''}`)
    const flow = (record.contract as SkillContract).flow
    const runtime: Record<string, unknown> = flow
      ? {
          source: flow.source,
          version: record.version,
          package_hash: flow.package_sha256,
          entry: flow.entry,
          references: flow.references,
          intermediate_outputs: [],
          workflow_profile: flow.workflow_profile,
          interaction_profile: flow.interaction_profile,
          primary_output: flow.primary_output,
          exclude_intents: flow.exclude_intents,
          capabilities: flow.capabilities,
        }
      : {
          source: 'legacy',
          version: record.version,
          package_root: record.packageRoot,
          contract: record.contract,
        }
    return { record, runtime, available: flow ? fileExists(flow.entry) : true }
  }

  /** Compile the published registry to a registry.json (schema codex-flow-registry/v2) in the private runtime. */
  compile(registryPath: string): { indexed: number; rejected: string[]; registry: string } {
    const rows = this.db.prepare("SELECT * FROM skills WHERE status = 'published'").all() as Array<Record<string, unknown>>
    const skills: Array<Record<string, unknown>> = []
    const rejected: string[] = []
    for (const row of rows) {
      const contract = safeJson(row.contract_json, {}) as SkillContract
      const flow = contract.flow
      if (flow) {
        skills.push({
          skill_id: row.name,
          source: flow.source,
          version: row.version,
          description: row.description,
          display_name: flow.display_name,
          category: flow.primary_output,
          styles: contract.taxonomy ?? [],
          scenes: [],
          use_when: row.description,
          guidance: [],
          pitfalls: flow.exclude_intents,
          example_cases: [],
          aliases: contract.taxonomy ?? [],
          tags: contract.taxonomy ?? [],
          capabilities: flow.capabilities,
          release_tier: flow.release_tier,
          record_type: 'skill',
        })
      } else {
        rejected.push(String(row.name))
      }
    }
    const registry = {
      schema: 'codex-flow-registry/v2',
      indexed: skills.length,
      skills,
      runtime: Object.fromEntries(
        skills.map((skill) => [
          skill.skill_id,
          { source: skill.source, version: skill.version, package_hash: (this.get(String(skill.skill_id))?.contract as SkillContract)?.flow?.package_sha256 ?? '', entry: (this.get(String(skill.skill_id))?.contract as SkillContract)?.flow?.entry ?? '', references: (this.get(String(skill.skill_id))?.contract as SkillContract)?.flow?.references ?? {}, primary_output: skill.category, exclude_intents: skill.pitfalls, capabilities: skill.capabilities },
        ]),
      ),
      rejected,
    }
    mkdirSync(dirname(registryPath), { recursive: true })
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8')
    return { indexed: skills.length, rejected, registry: registryPath }
  }

  list(status?: SkillStatus, limit = 100): SkillRecord[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM skills WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM skills ORDER BY updated_at DESC LIMIT ?').all(limit)
    return rows.map((r) => this.rowToRecord(r))
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

function safeJson(raw: unknown, fallback: unknown): any {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** Port of upstream registry.route_score (weighted phrase matching). */
function routeScore(
  query: string,
  skill: { skill_id: string; display_name: string; description: string; aliases: string[]; tags: string[]; capabilities: string[] },
): number {
  const folded = (query ?? '').trim().toLowerCase()
  if (!folded) return 0
  let score = 0
  const weightedFields: Array<[string[], number]> = [
    [[skill.skill_id], 70],
    [[skill.display_name], 80],
    [skill.aliases, 80],
    [skill.tags, 60],
  ]
  for (const [values, weight] of weightedFields) {
    for (const value of values) {
      const phrase = String(value).toLowerCase().trim()
      if (phrase.length >= 2 && folded.includes(phrase)) {
        score += weight
        continue
      }
      const tokens = phrase.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((t) => t.length > 1)
      if (tokens.length > 0 && tokens.some((token) => folded.includes(token))) {
        score += Math.max(8, Math.floor(weight / 2))
      }
    }
  }
  const haystack = [skill.skill_id, skill.display_name, skill.description, ...skill.aliases, ...skill.tags, ...skill.capabilities]
    .join(' ')
    .toLowerCase()
  score += folded
    .split(/\s+/)
    .filter((token) => token.length > 1 && haystack.includes(token))
    .length * 4
  return score
}

const IMAGE_STYLE_LIBRARY_TERMS = [
  'style', 'style transfer', 'reference image', 'redraw', '风格', '风格迁移', '参考图', '重绘', '版式', '视觉语言',
]

/** Port of upstream registry.should_consult_style_library. */
function shouldConsultStyleLibrary(query: string): boolean {
  const folded = query.toLowerCase()
  return IMAGE_STYLE_LIBRARY_TERMS.some((term) => folded.includes(term) || query.includes(term))
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Split a search query into CJK-friendly terms (whitespace + punctuation). */
export function tokenizeSearchTerms(query: string): string[] {
  return String(query ?? '')
    .split(/[\s，。！？、,.;:：'"_\-()（）]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}
