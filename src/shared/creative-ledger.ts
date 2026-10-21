/**
 * Creative-writing ledger (pure domain — no DSH imports, no filesystem).
 *
 * Makes "the creative text was produced by `creative_writer`" a verifiable
 * fact instead of a self-reported claim:
 *
 *   creative_writer  → appends a `cw-xxxxxxxx` record (kind/brief/output hashes)
 *   prompt_batch set_prompts → refuses to write prompts unless a recent
 *                    creative record of the required kind exists (or the write
 *                    explicitly opts out via `allow_manual_prompts`)
 *
 * The plugin layer cannot intercept free text the model writes by itself, so
 * the gate sits at the first downstream tool that accepts that text. This is
 * the same shape as the corpus credential gate (`corpus-ledger.ts`).
 *
 * @module dsh-media-plugins/shared/creative-ledger
 */

import { createHash } from 'node:crypto'

export interface CreativeRecord {
  /** Ledger id, `cw-<8 hex>`. */
  id: string
  /** Genre passed to `creative_writer` (prompt/script/copy/story/article/other). */
  kind: string
  /** Model actually used (e.g. `gemini-4-argon-thinking-high`). */
  model: string
  /** sha256 of the trimmed brief (audit: what was asked). */
  brief_sha256: string
  /** sha256 of the trimmed output (audit: what came back). */
  output_sha256: string
  /** Output length in characters. */
  chars: number
  at: string
}

export interface CreativeLedger {
  schema_version: number
  records: CreativeRecord[]
}

export const CREATIVE_LEDGER_SCHEMA_VERSION = 1

/** Bounded: oldest records are dropped first. */
export const CREATIVE_LEDGER_MAX_ENTRIES = 500

/** Kinds that count as "creative text written for production". */
export const CREATIVE_KINDS = ['prompt', 'script', 'story', 'copy'] as const

export function emptyCreativeLedger(): CreativeLedger {
  return { schema_version: CREATIVE_LEDGER_SCHEMA_VERSION, records: [] }
}

/** Stable text hash used for audit fields. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Issue an unpredictable record id. */
export function newCreativeId(seed: string): string {
  const material = `${seed}|${Date.now()}|${Math.random()}`
  return `cw-${createHash('sha256').update(material).digest('hex').slice(0, 8)}`
}

function isRecord(value: unknown): value is CreativeRecord {
  const v = value as Partial<CreativeRecord> | null
  return Boolean(
    v
    && typeof v.id === 'string'
    && typeof v.kind === 'string'
    && typeof v.model === 'string'
    && typeof v.at === 'string',
  )
}

/** Parse a persisted ledger defensively (corrupt entries are dropped). */
export function parseCreativeLedger(value: unknown): CreativeLedger {
  const raw = value as Partial<CreativeLedger> | null
  if (!raw || !Array.isArray(raw.records)) return emptyCreativeLedger()
  const records = raw.records.filter(isRecord).map((r) => ({
    id: r.id,
    kind: r.kind,
    model: r.model,
    brief_sha256: typeof r.brief_sha256 === 'string' ? r.brief_sha256 : '',
    output_sha256: typeof r.output_sha256 === 'string' ? r.output_sha256 : '',
    chars: typeof r.chars === 'number' ? r.chars : 0,
    at: r.at,
  }))
  return { schema_version: CREATIVE_LEDGER_SCHEMA_VERSION, records }
}

/** Append a record; keeps the ledger bounded by dropping the oldest entries. */
export function appendCreativeRecord(ledger: CreativeLedger, record: CreativeRecord): CreativeLedger {
  const records = [...ledger.records, record]
  const kept = records.length > CREATIVE_LEDGER_MAX_ENTRIES
    ? records.slice(records.length - CREATIVE_LEDGER_MAX_ENTRIES)
    : records
  return { schema_version: CREATIVE_LEDGER_SCHEMA_VERSION, records: kept }
}

export interface RecentCreativeQuery {
  /** Accepted kinds; empty/undefined means any. */
  kinds?: readonly string[]
  /** Require the record to be no older than this many milliseconds. */
  maxAgeMs?: number
  /** Clock injection (tests). */
  now?: number
  /** Optional cutoff ISO string (e.g. a batch creation time). */
  since?: string
}

/** Find the newest record matching the query. */
export function findRecentCreative(
  ledger: CreativeLedger,
  query: RecentCreativeQuery = {},
): CreativeRecord | undefined {
  const now = query.now ?? Date.now()
  const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null
  const sinceMs = query.since ? Date.parse(query.since) : Number.NaN
  let best: CreativeRecord | undefined
  let bestMs = -Infinity
  for (const record of ledger.records) {
    if (kinds && !kinds.has(record.kind)) continue
    const at = Date.parse(record.at)
    if (!Number.isFinite(at)) continue
    if (Number.isFinite(sinceMs) && at < sinceMs) continue
    if (query.maxAgeMs !== undefined && query.maxAgeMs >= 0 && now - at > query.maxAgeMs) continue
    if (at > bestMs) { best = record; bestMs = at }
  }
  return best
}

/** Human-readable rejection message for a missing creative credential. */
export function creativeGateMessage(missingSince: string | undefined): string {
  const window = missingSince ? ` since ${missingSince}` : ''
  return (
    `No creative_writer record${window}. This workspace requires creative text to be produced by `
    + '`creative_writer` (default gemini-4-argon) before it can be written into a batch, a project, '
    + 'or submitted for production. Call creative_writer (kind=prompt or kind=script) and retry; '
    + 'to write by hand instead (user-supplied/normalize-only, or Agent fallback after a Gemini '
    + 'failure), pass allow_manual_prompts=true with manual_prompts_reason.'
  )
}

/** On-disk ledger file name under the private root (writer and gate must agree). */
export const CREATIVE_LEDGER_FILE = 'creative-ledger.json'

/** A creative record older than this no longer counts as a credential. */
export const CREATIVE_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000

export interface CreativeRecordInput {
  /** Genre accepted by the gate (prompt/script/story/copy; others are recorded but never satisfy it). */
  kind: string
  /** Model actually used. */
  model: string
  /** Brief as sent to the model (hashed for audit). */
  brief: string
  /** Output text returned to the caller (hashed for audit). */
  output: string
  /** Clock injection (tests). */
  now?: number
}

/**
 * Build the audit record for one successful `creative_writer` call.
 * Pure: the caller owns persistence.
 */
export function buildCreativeRecord(input: CreativeRecordInput): CreativeRecord {
  const brief = String(input.brief ?? '').trim()
  const output = String(input.output ?? '').trim()
  const at = new Date(input.now ?? Date.now()).toISOString()
  return {
    id: newCreativeId(`${input.kind}|${brief}|${at}`),
    kind: String(input.kind ?? 'other'),
    model: String(input.model ?? ''),
    brief_sha256: sha256Text(brief),
    output_sha256: sha256Text(output),
    chars: output.length,
    at,
  }
}

export interface CreativeGateOptions extends RecentCreativeQuery {
  /** Caller explicitly opts out of the gate (it must state why in chat). */
  allowManual?: boolean
}

export interface CreativeGateDecision {
  allowed: boolean
  /** True only when allowed because of `allowManual`. */
  bypassed: boolean
  record?: CreativeRecord
  message?: string
}

/**
 * Decide whether prompt authoring may proceed in this workspace.
 *
 * Defaults: any of `CREATIVE_KINDS`, no older than `CREATIVE_CREDENTIAL_TTL_MS`.
 * Callers pass `allowManual: true` only for an explicit opt-out.
 */
export function decideCreativeGate(
  ledger: CreativeLedger,
  options: CreativeGateOptions = {},
): CreativeGateDecision {
  const record = findRecentCreative(ledger, {
    kinds: options.kinds ?? CREATIVE_KINDS,
    maxAgeMs: options.maxAgeMs ?? CREATIVE_CREDENTIAL_TTL_MS,
    now: options.now,
    since: options.since,
  })
  if (record) return { allowed: true, bypassed: false, record }
  if (options.allowManual) return { allowed: true, bypassed: true }
  return { allowed: false, bypassed: false, message: creativeGateMessage(options.since) }
}
