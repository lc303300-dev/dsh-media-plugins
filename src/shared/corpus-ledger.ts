/**
 * Corpus retrieval ledger (pure domain — no DSH imports, no filesystem).
 *
 * Every `prompt_revision search_corpus` call issues a **single-use credential**
 * so that "one corpus search per segment" is a verifiable fact instead of a
 * self-reported number:
 *
 *   search_corpus  → issues `sq-xxxxxxxx` (consumed_by = null)
 *   authoring_gate → validates the credential, then CONSUMES it bound to a
 *                    segment (material path) — the same credential cannot be
 *                    presented twice
 *   prompt_batch set_prompts → refuses to write any segment that has no
 *                    consumed credential of its own
 *
 * Reusing one retrieval across eight segments is therefore rejected by code,
 * not by convention. Hit counts are recorded for audit; a zero-hit search is
 * still a valid credential (whether the corpus covers a topic is a different
 * question from whether a search was performed).
 *
 * @module dsh-media-plugins/shared/corpus-ledger
 */

import { createHash } from 'node:crypto'

export interface CorpusQueryRecord {
  /** Single-use credential id, `sq-<8 hex>`. */
  id: string
  query: string
  /** Number of corpus matches returned for this query (may legitimately be 0). */
  hits: number
  /** Ids of the matched corpus entries (audit trail, capped by the caller). */
  top_ids: string[]
  at: string
  /** Segment that consumed this credential; `null` while unused. */
  consumed_by: string | null
  consumed_at: string | null
}

export interface CorpusLedger {
  schema_version: number
  queries: CorpusQueryRecord[]
}

export const LEDGER_SCHEMA_VERSION = 1

/** The ledger is bounded; oldest consumed credentials are dropped first. */
export const LEDGER_MAX_ENTRIES = 500

export function emptyLedger(): CorpusLedger {
  return { schema_version: LEDGER_SCHEMA_VERSION, queries: [] }
}

/** Issue an unpredictable single-use credential id. */
export function newSearchId(seed: string): string {
  const material = `${seed}|${Date.now()}|${Math.random()}`
  return `sq-${createHash('sha256').update(material).digest('hex').slice(0, 8)}`
}

function isQueryRecord(value: unknown): value is CorpusQueryRecord {
  const v = value as Partial<CorpusQueryRecord> | null
  // Only the id is structurally required: a record without a query string is
  // still a usable credential, so tolerant parsing keeps it.
  return Boolean(v && typeof v.id === 'string' && v.id.length > 0)
}

/** Tolerant parse: an unknown/garbage ledger reads as empty rather than throwing. */
export function parseLedger(raw: unknown): CorpusLedger {
  const obj = (raw ?? {}) as Partial<CorpusLedger>
  const queries = Array.isArray(obj.queries) ? obj.queries.filter(isQueryRecord) : []
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    queries: queries.map((q) => ({
      id: String(q.id),
      query: String(q.query ?? ''),
      hits: Number.isFinite(Number(q.hits)) ? Number(q.hits) : 0,
      top_ids: Array.isArray(q.top_ids) ? q.top_ids.map((t) => String(t)) : [],
      at: String(q.at ?? ''),
      consumed_by: q.consumed_by == null ? null : String(q.consumed_by),
      consumed_at: q.consumed_at == null ? null : String(q.consumed_at),
    })),
  }
}

/** Keep only the newest `max` entries, discarding consumed ones first. */
export function pruneLedger(ledger: CorpusLedger, max: number = LEDGER_MAX_ENTRIES): CorpusLedger {
  if (ledger.queries.length <= max) return ledger
  const overflow = ledger.queries.length - max
  const droppable = ledger.queries.filter((q) => q.consumed_by !== null).slice(0, overflow)
  const dropped = new Set(droppable.map((q) => q.id))
  const kept = ledger.queries.filter((q) => !dropped.has(q.id))
  return { ...ledger, queries: kept.length > max ? kept.slice(kept.length - max) : kept }
}

export interface IssueInput {
  id: string
  query: string
  hits: number
  top_ids?: string[]
  at: string
}

export function issueCredential(ledger: CorpusLedger, input: IssueInput): { ledger: CorpusLedger; record: CorpusQueryRecord } {
  const record: CorpusQueryRecord = {
    id: input.id,
    query: input.query,
    hits: Number(input.hits) || 0,
    top_ids: (input.top_ids ?? []).map((t) => String(t)),
    at: input.at,
    consumed_by: null,
    consumed_at: null,
  }
  return { ledger: pruneLedger({ ...ledger, queries: [...ledger.queries, record] }), record }
}

export function findCredential(ledger: CorpusLedger, searchId: string | undefined): CorpusQueryRecord | undefined {
  const id = String(searchId ?? '').trim()
  if (!id) return undefined
  return ledger.queries.find((q) => q.id === id)
}

/**
 * Authoring gate: the director+corpus path must present a fresh single-use
 * credential. Self-reported hit counts are no longer accepted — the credential
 * proves a real retrieval happened, and one-per-segment consumption is what
 * makes "8 segments = 8 searches" enforceable.
 */
export function gateCredentialError(record: CorpusQueryRecord | undefined, searchId: string | undefined): string | null {
  if (!String(searchId ?? '').trim()) {
    return 'authoring gate requires search_id issued by prompt_revision search_corpus (one single-use credential per segment)'
  }
  if (!record) {
    return `unknown search_id "${searchId}" — run prompt_revision search_corpus first`
  }
  if (record.consumed_by) {
    return `search_id "${searchId}" was already consumed by ${record.consumed_by}; every segment needs its own corpus search`
  }
  return null
}

export interface ConsumeResult {
  ok: boolean
  ledger: CorpusLedger
  record?: CorpusQueryRecord
  error?: string
}

/** Validate then consume a credential, binding it to `segment` (typically a material path). */
export function consumeCredential(ledger: CorpusLedger, searchId: string, segment: string, at: string): ConsumeResult {
  const record = findCredential(ledger, searchId)
  const error = gateCredentialError(record, searchId)
  if (error || !record) return { ok: false, ledger, error: error ?? 'unknown search_id' }
  const consumed: CorpusQueryRecord = { ...record, consumed_by: segment, consumed_at: at }
  return {
    ok: true,
    ledger: { ...ledger, queries: ledger.queries.map((q) => (q.id === record.id ? consumed : q)) },
    record: consumed,
  }
}

/** Evidence lookup used by batch writes: the credential consumed for this segment. */
export function segmentEvidence(ledger: CorpusLedger, segment: string): CorpusQueryRecord | undefined {
  const key = String(segment ?? '')
  for (let i = ledger.queries.length - 1; i >= 0; i -= 1) {
    if (ledger.queries[i].consumed_by === key) return ledger.queries[i]
  }
  return undefined
}

export function ledgerStats(ledger: CorpusLedger): { total: number; consumed: number; available: number } {
  const consumed = ledger.queries.filter((q) => q.consumed_by !== null).length
  return { total: ledger.queries.length, consumed, available: ledger.queries.length - consumed }
}
