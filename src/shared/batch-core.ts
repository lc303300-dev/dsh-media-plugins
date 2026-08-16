/**
 * Batch image scheduler domain (Codex_Batch_Image rebuild, all-JS):
 * manifest validation, stable job keys, deadline math and contact-sheet
 * HTML. Deterministic — no paid calls here; the tool orchestrates.
 *
 * Contract (guide §3.4 / §4.3):
 * - manifest UTF-8 JSON; image_ratio required; group ids unique;
 *   each group prompt non-empty, candidates >= 1;
 * - concurrency 1..10 (default 10), real submissions >= 1 s apart;
 * - default deadline = ceil(planned candidates / concurrency) * 60 s * 1.5,
 *   overridable via explicit deadline_seconds;
 * - after deadline, unfinished tasks are permanently abandoned (no query,
 *   no retry); only landed successes are collected;
 * - stable job key prevents re-submitting the same candidate.
 *
 * @module dsh-media-plugins/shared/batch-core
 */

import { createHash } from 'node:crypto'
import {
  SUPPORTED_RATIOS,
  RATIO_SIZES,
  SUPPORTED_RESOLUTIONS,
  SUPPORTED_IMAGE_PROVIDERS,
  ADAPTER_ALIASES,
} from './adapters.ts'

export interface BatchGroup {
  id: string
  prompt: string
  candidates: number
  image_ratio: string
  slot_prefix?: string
  /** Optional ordered reference images for every candidate in this group. */
  reference_images?: string[]
  /** Explicit material/style reference for contact-sheet slot 0 (recommended with multiple references). */
  original_image?: string
}

export interface BatchManifest {
  schema_version?: number
  groups: BatchGroup[]
  /** Optional global ratio when all groups share one. */
  image_ratio?: string
  /** Optional batch-wide explicit resolution class (1K/2K/4K). */
  image_resolution?: string
  /** Optional batch-wide user-explicit image route (single-route, no fallback). */
  image_provider?: string
  concurrency?: number
  /** Explicit dispatch cutoff in seconds; overrides the auto estimate. */
  deadline_seconds?: number
  /** Completion grace after the dispatch deadline, in seconds (> 0, <= 120, default 120). */
  completion_grace_seconds?: number
}

export interface BatchPlan {
  jobKey: string
  total: number
  concurrency: number
  estimateSeconds: number
  deadlineSeconds: number
  completionGraceSeconds: number
  maxRuntimeSeconds: number
  deadlineAtMs: number
}

/** Default completion grace after the dispatch deadline (contract: default and maximum 120 s). */
export const DEFAULT_COMPLETION_GRACE_SECONDS = 120

/** Structural validation; throws with a precise message. */
export function validateManifest(raw: unknown): BatchManifest {
  const m = (raw ?? {}) as BatchManifest
  if (!Array.isArray(m.groups) || m.groups.length === 0) {
    throw new Error('manifest.groups must be a non-empty array')
  }
  const ids = new Set<string>()
  let total = 0
  for (const g of m.groups) {
    if (typeof g.id !== 'string' || g.id.trim().length === 0) throw new Error('each group requires a unique id')
    if (ids.has(g.id)) throw new Error(`duplicate group id: ${g.id}`)
    ids.add(g.id)
    if (typeof g.prompt !== 'string' || g.prompt.trim().length === 0) throw new Error(`group ${g.id}: prompt must be non-empty`)
    if (!Number.isInteger(g.candidates) || g.candidates < 1) throw new Error(`group ${g.id}: candidates must be an integer >= 1`)
    const ratio = g.image_ratio ?? m.image_ratio
    if (!ratio || !SUPPORTED_RATIOS.includes(ratio)) {
      throw new Error(`group ${g.id}: image_ratio is required and must be one of ${SUPPORTED_RATIOS.join(', ')}`)
    }
    if (g.reference_images !== undefined) {
      if (!Array.isArray(g.reference_images) || g.reference_images.some((p) => typeof p !== 'string' || p.trim().length === 0)) {
        throw new Error(`group ${g.id}: reference_images must be a non-empty array of paths`)
      }
    }
    if (g.original_image !== undefined && (typeof g.original_image !== 'string' || g.original_image.trim().length === 0)) {
      throw new Error(`group ${g.id}: original_image must be a path string`)
    }
    total += g.candidates
  }
  const concurrency = m.concurrency ?? 10
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new Error(`concurrency must be an integer 1..10, got ${concurrency}`)
  }
  if (m.image_resolution !== undefined && !SUPPORTED_RESOLUTIONS.includes(m.image_resolution)) {
    throw new Error(`image_resolution must be one of ${SUPPORTED_RESOLUTIONS.join(', ')}, got ${m.image_resolution}`)
  }
  if (m.image_provider !== undefined) {
    const canonical = ADAPTER_ALIASES[m.image_provider] ?? m.image_provider
    if (!SUPPORTED_IMAGE_PROVIDERS.includes(canonical)) {
      throw new Error(`image_provider must be a supported unified image route, got ${m.image_provider}`)
    }
  }
  if (m.completion_grace_seconds !== undefined) {
    const grace = m.completion_grace_seconds
    if (!Number.isFinite(grace) || grace <= 0 || grace > DEFAULT_COMPLETION_GRACE_SECONDS) {
      throw new Error(`completion_grace_seconds must be > 0 and <= ${DEFAULT_COMPLETION_GRACE_SECONDS}, got ${grace}`)
    }
  }
  return m
}

/** Stable job key: sha256 of the normalized manifest (order-insensitive groups). */
export function jobKeyFor(manifest: BatchManifest): string {
  const normalized = {
    groups: [...manifest.groups]
      .map((g) => ({
        id: g.id,
        prompt: g.prompt.trim(),
        candidates: g.candidates,
        image_ratio: g.image_ratio ?? manifest.image_ratio,
        reference_images: g.reference_images ?? null,
        original_image: g.original_image ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    image_resolution: manifest.image_resolution ?? null,
    image_provider: manifest.image_provider ?? null,
    concurrency: manifest.concurrency ?? 10,
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 24)
}

/** Deadline math: dispatch cutoff = ceil(total/concurrency)*60s*1.5 (or explicit
 *  override); completion grace follows it (default 120 s, max 120 s). */
export function computeDeadline(manifest: BatchManifest, now = Date.now()): BatchPlan {
  const total = manifest.groups.reduce((acc, g) => acc + g.candidates, 0)
  const concurrency = manifest.concurrency ?? 10
  const estimateSeconds = Math.ceil(total / concurrency) * 60
  const deadlineSeconds = manifest.deadline_seconds ?? Math.ceil(estimateSeconds * 1.5)
  const completionGraceSeconds = manifest.completion_grace_seconds ?? DEFAULT_COMPLETION_GRACE_SECONDS
  return {
    jobKey: jobKeyFor(manifest),
    total,
    concurrency,
    estimateSeconds,
    deadlineSeconds,
    completionGraceSeconds,
    maxRuntimeSeconds: deadlineSeconds + completionGraceSeconds,
    deadlineAtMs: now + deadlineSeconds * 1000,
  }
}

/** Contact sheet HTML: slot 0 shows the group's original/reference image, then fixed numbered candidate slots. */
export function buildContactSheetHtml(
  plan: BatchPlan,
  groups: Array<Pick<BatchGroup, 'id' | 'candidates' | 'image_ratio' | 'original_image'>>,
  landed: Array<{ groupId: string; slot: number; path: string; width?: number; height?: number }>,
): string {
  const byGroup = new Map<string, Map<number, (typeof landed)[number]>>()
  for (const item of landed) {
    if (!byGroup.has(item.groupId)) byGroup.set(item.groupId, new Map())
    byGroup.get(item.groupId)!.set(item.slot, item)
  }
  const rows: string[] = []
  rows.push('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Batch contact sheet</title>')
  rows.push('<style>body{font-family:system-ui;margin:24px}table{border-collapse:collapse;margin-bottom:24px}td{border:1px solid #ccc;padding:8px;text-align:center;vertical-align:top}img{max-width:180px;max-height:180px;display:block}.slot{font-size:12px;color:#666;margin-top:4px}</style>')
  rows.push('</head><body>')
  rows.push(`<h1>Batch ${plan.jobKey}</h1><p>total ${plan.total} · concurrency ${plan.concurrency} · deadline ${plan.deadlineSeconds}s · landed ${landed.length}</p>`)
  for (const group of groups) {
    const items = byGroup.get(group.id) ?? new Map()
    const cells: string[] = []
    if (group.original_image !== undefined) {
      cells.push(
        `<td><img src="${relPath(group.original_image)}" alt="original"><div class="slot">${group.id} · 原始图</div></td>`,
      )
    }
    for (let slot = 1; slot <= group.candidates; slot += 1) {
      const item = items.get(slot)
      cells.push(
        item
          ? `<td><img src="${relPath(item.path)}" alt="slot ${slot}"><div class="slot">${group.id} · #${slot} ✓</div></td>`
          : `<td style="color:#bbb"><div>—</div><div class="slot">${group.id} · #${slot} ∅</div></td>`,
      )
    }
    rows.push(`<h2>${group.id} (${group.image_ratio ?? ''}, ${group.candidates} 张)</h2><table><tr>${cells.join('')}</tr></table>`)
  }
  rows.push('</body></html>')
  return rows.join('\n')
}

/** Relative path from the HTML file's directory (forward slashes); the sheet
 *  lives in <outputDir>/contact-<key>.html and outputs sit under
 *  <outputDir>/<jobKey>/..., so strip the workspace-root "outputs" segment. */
function relPath(p: string): string {
  return p.split('\\').join('/').replace(/^.*\/outputs\//, '')
}

/** Flatten the manifest into one task descriptor per candidate. */
export function flattenTasks(
  manifest: BatchManifest,
): Array<{ groupId: string; slot: number; prompt: string; ratio: string; resolution?: string; imageProvider?: string; references?: string[] }> {
  const tasks: Array<{ groupId: string; slot: number; prompt: string; ratio: string; resolution?: string; imageProvider?: string; references?: string[] }> = []
  for (const g of manifest.groups) {
    const ratio = g.image_ratio ?? manifest.image_ratio!
    for (let i = 1; i <= g.candidates; i += 1) {
      tasks.push({
        groupId: g.id,
        slot: i,
        prompt: g.prompt.trim(),
        ratio,
        resolution: manifest.image_resolution,
        imageProvider: manifest.image_provider,
        references: g.reference_images ?? undefined,
      })
    }
  }
  return tasks
}

/** Resolve a ratio to the pixel size the scheduler submits with. */
export function ratioToSizeForBatch(ratio: string): string {
  const size = RATIO_SIZES[ratio]
  if (!size) throw new Error(`unsupported ratio ${ratio}`)
  return size
}
