/**
 * Batch image scheduler domain (Codex_Batch_Image rebuild, all-JS):
 * manifest validation, stable job keys, deadline math and contact-sheet
 * HTML. Deterministic — no paid calls here; the tool orchestrates.
 *
 * Contract (guide §3.4 / §4.3):
 * - manifest UTF-8 JSON; image_ratio required; group ids unique;
 *   each group prompt non-empty, candidates >= 1;
 * - concurrency 1..10 (default 10), real submissions >= 1 s apart;
 * - default deadline = ceil(planned candidates / concurrency) * 90 s, where
 *   90 s is the per-candidate basis (`IMAGE_SECONDS_PER_CANDIDATE`, identical
 *   to the default provider timeout) and there is no extra multiplier;
 *   overridable via explicit deadline_seconds;
 * - after deadline, unfinished tasks are permanently abandoned (no query,
 *   no retry); only landed successes are collected;
 * - stable job key prevents re-submitting the same candidate.
 *
 * @module dsh-media-plugins/shared/batch-core
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import sharp from 'sharp'
import { IMAGE_SECONDS_PER_CANDIDATE } from './media-client.ts'
import { reviewPickHtml, reviewToolbarHtml, reviewUiScriptHtml, reviewUiStyleHtml } from './review-ui.ts'
import { parseGridSpec, rowsColsLabel } from './grid-detect.ts'
import {
  SUPPORTED_RATIOS,
  RATIO_SIZES,
  SUPPORTED_RESOLUTIONS,
  SUPPORTED_IMAGE_PROVIDERS,
  ADAPTER_ALIASES,
  normalizeRatio,
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
  /**
   * Declared multi-panel layout of this group's output, e.g. `"3x3"` (九宫格) or
   * `"2x2"` (四宫格). The review page splits each landed candidate into panels;
   * a declaration also covers borderless sheets where no gutter can be
   * detected, in which case the panels are cut evenly.
   */
  grid?: string
}

export interface BatchManifest {
  schema_version?: number
  groups: BatchGroup[]
  /** Optional global ratio when all groups share one. */
  image_ratio?: string
  /** Optional batch-wide explicit resolution class (1K/2K/4K); single-class routes clamp it (GPT 4K, Gemini 2K). */
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

/**
 * Bounded drain window after the completion grace aborts the runners.
 *
 * The batch contract is a HARD maximum wait: once the grace elapses the job
 * stops waiting, collects what landed, writes the review page and reports. A
 * runner that ignores its abort signal (a hung socket, a stuck CLI) therefore
 * gets this short window to unwind — it can never extend the job indefinitely.
 */
export const SHUTDOWN_DRAIN_MS = 5000

/**
 * Wait for `work`, but never longer than `graceMs + drainMs`.
 *
 * `onGraceElapsed` fires exactly once when the grace is up (the caller aborts
 * its runners there). Returns `'settled'` when the work finished on its own and
 * `'stopped'` when the hard stop won — in both cases the caller owns whatever
 * state the work left behind and must collect results from its own store, not
 * from this promise.
 */
export async function waitWithHardStop(
  work: Promise<unknown>,
  graceMs: number,
  drainMs: number,
  onGraceElapsed: () => void,
): Promise<'settled' | 'stopped'> {
  const graceTimer = setTimeout(onGraceElapsed, Math.max(0, graceMs))
  try {
    return await Promise.race([
      work.then(() => 'settled' as const),
      new Promise<'stopped'>((resolve) => setTimeout(() => resolve('stopped'), Math.max(0, graceMs) + Math.max(0, drainMs))),
    ])
  } finally {
    clearTimeout(graceTimer)
  }
}

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
    if (typeof ratio !== 'string' || ratio.trim().length === 0) {
      throw new Error(`group ${g.id}: image_ratio is required and must be one of ${SUPPORTED_RATIOS.join(', ')}`)
    }
    try {
      normalizeRatio(ratio)
    } catch {
      throw new Error(`group ${g.id}: image_ratio must be one of ${SUPPORTED_RATIOS.join(', ')} or a pixel size such as 1920x1080, got ${ratio}`)
    }
    if (g.reference_images !== undefined) {
      if (!Array.isArray(g.reference_images) || g.reference_images.some((p) => typeof p !== 'string' || p.trim().length === 0)) {
        throw new Error(`group ${g.id}: reference_images must be a non-empty array of paths`)
      }
    }
    if (g.original_image !== undefined && (typeof g.original_image !== 'string' || g.original_image.trim().length === 0)) {
      throw new Error(`group ${g.id}: original_image must be a path string`)
    }
    if (g.grid !== undefined && !parseGridSpec(g.grid)) {
      throw new Error(`group ${g.id}: grid must be a layout like "3x3" / "2x2" (rows and cols 1..4, at least 2 panels), got ${JSON.stringify(g.grid)}`)
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
        image_ratio: normalizeRatio(g.image_ratio ?? manifest.image_ratio),
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

/**
 * Deadline math: one candidate is budgeted the 90 s per-candidate basis
 * (`IMAGE_SECONDS_PER_CANDIDATE`, the same basis as the default provider
 * timeout), so the dispatch cutoff is `ceil(candidates / concurrency)` waves of
 * that basis plus `concurrency` seconds — the extra covers the enforced >= 1 s
 * spacing between the real submissions inside the last wave (they never start
 * simultaneously) and the slot-pool hand-off between waves. Completion grace
 * follows the cutoff (default/max 120 s).
 */
export function computeDeadline(manifest: BatchManifest, now = Date.now()): BatchPlan {
  const total = manifest.groups.reduce((acc, g) => acc + g.candidates, 0)
  const concurrency = manifest.concurrency ?? 10
  const estimateSeconds = Math.ceil(total / concurrency) * IMAGE_SECONDS_PER_CANDIDATE + concurrency
  const deadlineSeconds = manifest.deadline_seconds ?? estimateSeconds
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

/** One extracted panel of a multi-panel sheet, as embedded in the review page. */
export interface ContactSheetPanel {
  id: string
  path: string
}

/** One landed candidate, optionally carrying the panels it was split into. */
export interface ContactSheetLanding {
  groupId: string
  slot: number
  path: string
  width?: number
  height?: number
  /** Set when the produced image was recognized as a multi-panel sheet. */
  grid?: { rows: number; cols: number }
  panels?: ContactSheetPanel[]
  /** Why the sheet was not split (kept as a note); optional. */
  gridNote?: string
}

/**
 * Review-page HTML for a batch job.
 *
 * Self-contained and responsive by design: every image is embedded as a data
 * URI (a `file://`/relative `src` is blocked by sandboxed viewers and renders
 * as a broken image), and the layout is a CSS grid so the page never needs
 * horizontal scrolling. Built automatically once a job settles — see
 * `tool-batch-image.ts`.
 *
 * Every image carries a checkbox: the user ticks the shots they want and copies
 * their names/paths in one click instead of retyping file names. A candidate
 * that was recognized as a multi-panel sheet (四宫格/九宫格/…) renders its
 * panels as individual pickable entries, so a single panel can be selected
 * without splitting the file by hand.
 */
export async function buildContactSheetHtml(
  plan: BatchPlan,
  groups: Array<Pick<BatchGroup, 'id' | 'candidates' | 'image_ratio' | 'original_image'>>,
  landed: ContactSheetLanding[],
): Promise<string> {
  const byGroup = new Map<string, Map<number, ContactSheetLanding>>()
  for (const item of landed) {
    if (!byGroup.has(item.groupId)) byGroup.set(item.groupId, new Map())
    byGroup.get(item.groupId)!.set(item.slot, item)
  }

  const cache = new Map<string, string>()
  const embed = async (p: string, edge: number): Promise<string> => {
    const key = `${p}@${edge}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let uri = ''
    try {
      const buf = await sharp(p, { failOn: 'none' })
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 84 })
        .toBuffer()
      uri = `data:image/jpeg;base64,${buf.toString('base64')}`
    } catch {
      uri = ''
    }
    cache.set(key, uri)
    return uri
  }

  const shot = (uri: string, label: string, alt: string, pick: string, cls = ''): string => {
    const caption = `<figcaption>${escapeHtml(label)}</figcaption>`
    return uri
      ? `<figure class="rv-card${cls ? ` ${cls}` : ''}">${pick}<img src="${uri}" alt="${escapeHtml(alt)}">${caption}</figure>`
      : `<figure class="miss${cls ? ` ${cls}` : ''}">${pick}<div class="ph">无法读取</div>${caption}</figure>`
  }

  // NOTE: a group's original/reference image is deliberately NOT rendered. A
  // review page lists only what this task produced — mixing inputs in makes it
  // impossible to tell produced images from references at a glance.
  //
  // Every slot is embedded CONCURRENTLY: decoding a 4K PNG down to a 900 px
  // JPEG costs ~100 ms, so the previous serial loop made a 16-image page spend
  // ~1.6 s in the post-settle step (parallel: ~0.5 s, identical output). Panels
  // are smaller (420 px), so a 9-panel sheet costs a third of one full-size
  // embed each — and when a candidate WAS split, only its panels are embedded:
  // the sheet itself is deliberately not rendered, because showing the whole
  // 九宫格 next to its nine panels is exactly the duplicate the user asked to
  // drop (the split file still exists on disk next to the panels).
  const slotPlans: Array<{ group: (typeof groups)[number]; slot: number; item?: ContactSheetLanding }> = []
  for (const group of groups) {
    const items = byGroup.get(group.id) ?? new Map()
    for (let slot = 1; slot <= group.candidates; slot += 1) {
      slotPlans.push({ group, slot, item: items.get(slot) })
    }
  }
  const uris = await Promise.all(
    slotPlans.map((plan) => (plan.item && (plan.item.panels?.length ?? 0) === 0 ? embed(plan.item.path, 900) : Promise.resolve(''))),
  )
  const panelUris = new Map<string, string>()
  await Promise.all(
    slotPlans
      .flatMap((plan) => plan.item?.panels ?? [])
      .map(async (panel) => {
        panelUris.set(panel.path, await embed(panel.path, 420))
      }),
  )

  const figuresByGroup = new Map<string, string[]>()
  slotPlans.forEach((plan, index) => {
    const figures = figuresByGroup.get(plan.group.id) ?? []
    if (plan.item) {
      const item = plan.item
      const label = `${plan.group.id} · #${plan.slot} ✓`
      const sheetName = basename(item.path)
      const panels = item.panels ?? []
      if (panels.length === 0) {
        figures.push(shot(uris[index] ?? '', label, sheetName, reviewPickHtml({ name: sheetName, path: item.path })))
      } else {
        const rows = item.grid?.rows ?? 1
        const cols = item.grid?.cols ?? panels.length
        const cells = panels
          .map((panel) =>
            shot(
              panelUris.get(panel.path) ?? '',
              panel.id,
              basename(panel.path),
              reviewPickHtml({ name: basename(panel.path), path: panel.path, tag: panel.id }),
            ),
          )
          .join('')
        const note = item.gridNote ?? `检测到 ${rowsColsLabel(rows, cols)}，已拆分为 ${panels.length} 张独立面板（勾选想要的那一格即可）`
        figures.push(`<article class="rv-group"><p class="rv-note">${escapeHtml(note)}</p><div class="rv-panels">${cells}</div></article>`)
      }
    } else {
      figures.push(
        `<figure class="rv-card miss"><div class="ph">∅ 未落地</div><figcaption>${escapeHtml(`${plan.group.id} · #${plan.slot}`)}</figcaption></figure>`,
      )
    }
    figuresByGroup.set(plan.group.id, figures)
  })
  const sections: string[] = groups.map(
    (group) =>
      `<section><h2>${escapeHtml(group.id)} <span class="meta">${escapeHtml(group.image_ratio ?? '')} · ${group.candidates} 张</span></h2><div class="grid">${(figuresByGroup.get(group.id) ?? []).join('')}</div></section>`,
  )

  const abandoned = plan.total - landed.length
  const splitSheets = landed.filter((item) => (item.panels?.length ?? 0) > 0).length
  const splitPanels = landed.reduce((n, item) => n + (item.panels?.length ?? 0), 0)
  const splitNote = splitSheets > 0 ? ` · 多宫格母图 ${splitSheets} 张已拆分为 ${splitPanels} 张面板` : ''
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>批量审阅页 ${escapeHtml(plan.jobKey)}</title>
${reviewUiStyleHtml()}
<style>
*{box-sizing:border-box}
body{margin:0;padding:16px;background:#0f1013;color:#e9e9ec;font-family:system-ui,"Microsoft YaHei",sans-serif}
h1{font-size:17px;margin:0 0 6px}
h2{font-size:14px;margin:18px 0 8px}
.meta{font-weight:400;font-size:12.5px;color:#98a0a8}
.hint{font-size:12.5px;color:#98a0a8;margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px}
figure{margin:0;background:#191b1f;border:1px solid #2a2d33;border-radius:10px;overflow:hidden}
figure img{display:block;width:100%;height:auto}
figcaption{padding:6px 10px;font-size:12.5px;color:#c6cad0;border-top:1px solid #2a2d33}
figure.miss .ph{padding:48px 10px;text-align:center;color:#ff8f8f;font-size:13px}
figure .ph{padding:48px 10px;text-align:center;color:#ff8f8f;font-size:13px}
.rv-group{grid-column:1/-1;background:#191b1f;border:1px solid #2a2d33;border-radius:10px;overflow:hidden}
.rv-group .rv-card{background:transparent;border:0;border-radius:0}
.rv-note{margin:0;padding:8px 10px;font-size:12px;color:#ffd08a;background:rgba(255,193,94,.06);border-top:1px solid #2a2d33}
.rv-panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;padding:8px 10px 10px;border-top:1px solid #2a2d33}
</style></head><body>
<h1>批量审阅页 ${escapeHtml(plan.jobKey)}</h1>
<p class="hint">total ${plan.total} · landed ${landed.length} · 未落地 ${abandoned} · concurrency ${plan.concurrency} · deadline ${plan.deadlineSeconds}s${escapeHtml(splitNote)}｜图片已内嵌，窗口自适应</p>
<p class="hint">到点即收摊：只收集已落地的成功图，未落地的槽位不会自动重试。要不要补跑由你决定 —— 确认后换一个新的组 id 重新排队即可（同一 manifest 会被 job key 拒绝）。勾选想要的图 → 点“复制勾选名称”，把名称贴回对话即可。</p>
${sections.join('\n')}
${reviewToolbarHtml({ hint: '勾选后复制名称/路径' })}
${reviewUiScriptHtml()}
</body></html>`
}

/** Minimal HTML text escaping for labels interpolated into the page. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Flatten the manifest into one task descriptor per candidate. */
export function flattenTasks(
  manifest: BatchManifest,
): Array<{ groupId: string; slot: number; prompt: string; ratio: string; resolution?: string; imageProvider?: string; references?: string[] }> {
  const tasks: Array<{ groupId: string; slot: number; prompt: string; ratio: string; resolution?: string; imageProvider?: string; references?: string[] }> = []
  for (const g of manifest.groups) {
    const ratio = normalizeRatio(g.image_ratio ?? manifest.image_ratio!)
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
  const size = RATIO_SIZES[normalizeRatio(ratio)]
  if (!size) throw new Error(`unsupported ratio ${ratio}`)
  return size
}
