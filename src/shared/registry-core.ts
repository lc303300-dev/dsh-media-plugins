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
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type SkillStatus = 'draft' | 'published' | 'deprecated'

export interface SlotContract {
  id: string
  label?: string
  min?: number
  max?: number
  planned_count?: number
  count_rule?: 'per_second' | 'fixed' | 'range' | string
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
  slots?: SlotContract[]
  prompt?: {
    lang?: string
    corpus_policy?: 'no_corpus' | 'up_to_3_examples'
  }
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
}

/** Supported video ratios (project pipeline contract). */
export const VIDEO_RATIOS = ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'] as const

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
  return {
    name: c.name.trim(),
    version: c.version.trim(),
    description: typeof c.description === 'string' ? c.description : '',
    taxonomy: Array.isArray(c.taxonomy) ? c.taxonomy.map(String) : [],
    video: c.video,
    slots: c.slots,
    prompt: c.prompt,
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
   *  CJK-friendly tokenization (short 2-char intent terms like 巨型/巡游). */
  search(query: string, limit = 10, status: SkillStatus | 'any' = 'published'): SearchHit[] {
    const q = (query ?? '').trim()
    if (q.length === 0) return []
    const terms = tokenizeSearchTerms(q)
    let rows: any[] = []

    // 1) FTS5 trigram MATCH on terms long enough for trigram indexing (>= 3 chars)
    try {
      const longTerms = terms.filter((t) => [...t].length >= 3)
      if (longTerms.length > 0) {
        const expression = longTerms.map((t) => `"${t.replaceAll('"', ' ')}"`).join(' OR ')
        rows = this.db
          .prepare(
            `SELECT s.id, s.name, s.version, s.description, s.status, s.taxonomy, bm25(skills_fts) AS score
             FROM skills_fts JOIN skills s ON s.id = skills_fts.skill_id
             WHERE skills_fts MATCH ?
             ORDER BY score LIMIT ?`,
          )
          .all(expression, Math.max(limit, 20))
      }
    } catch {
      rows = []
    }

    // 2) per-term LIKE scoring (handles short CJK and mixed queries) when FTS misses
    if (rows.length === 0) {
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
        for (const term of terms) {
          const key = term.toLowerCase()
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
      rows = scored.slice(0, limit)
    }

    return rows
      .filter((r) => status === 'any' || r.status === status)
      .map((r) => ({
        id: r.id as string,
        name: r.name as string,
        version: r.version as string,
        description: r.description as string,
        status: r.status as SkillStatus,
        taxonomy: safeJson(r.taxonomy, []),
        score: Math.round(Math.abs(Number(r.score ?? 0)) * 100) / 100,
      }))
  }

  setStatus(name: string, version: string, status: SkillStatus): SkillRecord {
    const existing = this.get(name, version)
    if (!existing) throw new Error(`skill not found: ${name}@${version}`)
    this.db
      .prepare('UPDATE skills SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), existing.id)
    return this.get(name, version)!
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

/** Split a search query into CJK-friendly terms (whitespace + punctuation). */
export function tokenizeSearchTerms(query: string): string[] {
  return String(query ?? '')
    .split(/[\s，。！？、,.;:：'"_\-()（）]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}
