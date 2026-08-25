/**
 * Corpus search (seedance-forge port, all-JS): ranking mirrors the Codex_DT
 * `native_score` (title×4 + category×3 + description×2 + content×1), results
 * keep full provenance, and source model/version is metadata only — it must
 * never select the runtime generation model. Revision usage caps at 10.
 *
 * @module dsh-media-plugins/shared/corpus-core
 */

import { readFileSync } from 'node:fs'
import { accessSync } from 'node:fs'
import { join } from 'node:path'
import { packageRootOf } from './pkg-root.ts'

export interface CorpusRow {
  id: string
  title?: string
  category?: string
  description?: string
  content?: string
  author?: unknown
  sourceLink?: string
  sourcePublishedAt?: string
  source_project?: string
  seedance_version?: string
  source_repo?: string
  source_license?: string
  [key: string]: unknown
}

export interface CorpusMatch {
  id: string
  title: string
  description: string
  score: number
  length: number
  content_preview: string
  author: { name: string; link: string }
  sourceLink: string
  sourcePublishedAt: string
  source_model: string
  source_metadata: { model: string; repository: string; license: string }
  portable_pattern: string
}

let cachedRows: CorpusRow[] | null = null

/** Locate the bundled corpus index (relative to the package root). */
export function resolveIndexPath(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit
  const here = packageRootOf(import.meta.url)
  const candidates = [
    join(here, 'refs', 'forge-index.jsonl'),
    join(here, '..', '..', 'refs', 'forge-index.jsonl'),
  ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate)
      return candidate
    } catch {
      /* try next */
    }
  }
  return candidates[0]
}

/** Load corpus rows (cached); JSONL, id-keyed, tolerant of blank lines. */
export function loadCorpus(indexPath?: string): CorpusRow[] {
  if (cachedRows) return cachedRows
  const path = resolveIndexPath(indexPath)
  const rows: CorpusRow[] = []
  const raw = readFileSync(path, 'utf8')
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as CorpusRow
      if (row && typeof row.id === 'string' && row.id.length > 0) rows.push(row)
    } catch {
      /* skip malformed line */
    }
  }
  cachedRows = rows
  return rows
}

/** Reset the cache (tests). */
export function resetCorpusCache(): void {
  cachedRows = null
}

/** CJK bigrams of a token (2-char sliding windows over CJK runs). */
export function cjkBigrams(token: string): string[] {
  const cjk = token.match(/[\u4e00-\u9fff]+/g) ?? []
  const bigrams: string[] = []
  for (const run of cjk) {
    if (run.length === 1) bigrams.push(run)
    for (let i = 0; i < run.length - 1; i += 1) bigrams.push(run.slice(i, i + 2))
  }
  return bigrams
}

/** Ranking mirrors seedance-forge native scoring, with CJK bigram tokenization. */
export function scoreCorpusRow(row: CorpusRow, query: string): number {
  const title = String(row.title ?? '').toLowerCase()
  const category = String(row.category ?? '').toLowerCase()
  const description = String(row.description ?? '').toLowerCase()
  const content = String(row.content ?? '').toLowerCase()
  let score = 0
  for (const raw of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const keywords = raw.length > 2 && /[\u4e00-\u9fff]/.test(raw) ? [raw, ...cjkBigrams(raw)] : [raw]
    for (const keyword of keywords) {
      score += (title.split(keyword).length - 1) * 4
      score += (category.split(keyword).length - 1) * 3
      score += (description.split(keyword).length - 1) * 2
      score += content.split(keyword).length - 1
    }
  }
  return score
}

/** Compact text to a preview. */
export function compactPreview(text: string, limit: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= limit) return clean
  return clean.slice(0, Math.max(0, limit - 1)).trimEnd() + '…'
}

/** A transferable structural hint extracted from a corpus entry (never copied wholesale). */
export function portablePatternOf(row: CorpusRow): string {
  const content = String(row.content ?? '').trim()
  const description = String(row.description ?? '').trim()
  if (content.length > 0) return compactPreview(content, 200)
  if (description.length > 0) return compactPreview(description, 200)
  return String(row.title ?? '')
}

function parseAuthor(raw: unknown): { name: string; link: string } {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    return { name: String(obj.name ?? ''), link: String(obj.link ?? '') }
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        return { name: String(parsed.name ?? ''), link: String(parsed.link ?? '') }
      }
    } catch {
      /* plain string name */
    }
    return { name: raw, link: '' }
  }
  return { name: '', link: '' }
}

/** Convert a row into the revision-result match shape (provenance preserved). */
export function toCorpusMatch(row: CorpusRow, previewChars = 500): CorpusMatch {
  const sourceModel = String(row.seedance_version ?? '')
  return {
    id: row.id,
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    score: 0,
    length: String(row.content ?? '').length,
    content_preview: compactPreview(String(row.content ?? row.description ?? ''), previewChars),
    author: parseAuthor(row.author),
    sourceLink: String(row.sourceLink ?? ''),
    sourcePublishedAt: String(row.sourcePublishedAt ?? ''),
    source_model: sourceModel,
    source_metadata: {
      model: sourceModel,
      repository: String(row.source_repo ?? ''),
      license: String(row.source_license ?? ''),
    },
    portable_pattern: portablePatternOf(row),
  }
}

/** Search the corpus; `top` capped at 10 for revision usage by contract. */
export function searchCorpus(query: string, top = 10, indexPath?: string): CorpusMatch[] {
  const clean = (query ?? '').trim()
  if (!clean) return []
  const rows = loadCorpus(indexPath)
  const scored = rows
    .map((row) => ({ row, score: scoreCorpusRow(row, clean) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(1, Math.min(top, 10))).map((entry) => ({ ...toCorpusMatch(entry.row), score: entry.score }))
}

/** Count of bundled corpus entries (readiness reporting). */
export function corpusSize(indexPath?: string): number {
  return loadCorpus(indexPath).length
}
