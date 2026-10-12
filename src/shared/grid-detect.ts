/**
 * Generic multi-panel grid-sheet detection (the sibling of `grid-split-core`'s
 * fixed 3×3 splitter).
 *
 * `batch_image` candidates are sometimes ONE image holding several shots —
 * 四宫格 (2×2), 九宫格 (3×3), 六宫格 (2×3), 八宫格 (2×4) … — and a review page
 * that shows the sheet as a single thumbnail makes the user pick a sheet when
 * what they actually want to pick is one panel inside it. This module finds the
 * gutter geometry and cuts the sheet so the review page can list real, named
 * panel files.
 *
 * Detection is deliberately conservative, because a false positive silently
 * shreds a perfectly good image:
 *
 *  1. every internal gutter must be a **narrow** luminance peak *or* trough
 *     (≤ 3 % of the axis, so a bright sky / dark hair band is rejected),
 *  2. it must run across the **whole** axis (≥ 80 % of its pixels on the
 *     gutter side of the half-height level),
 *  3. it must sit within ±4.5 % of an exact fraction (1/4, 1/3, 1/2, 2/3, 3/4),
 *  4. every panel of the resulting layout must carry content (not a blank or
 *     flat-colour tile) and be at least `minPanelPx` on a side,
 *  5. the layout with the most panels that still satisfies all of the above
 *     wins — 4×4 is preferred over 2×2 on a genuine 16-panel sheet, while a real
 *     2×2 sheet can never satisfy 3×3 (its 1/3 lines do not exist).
 *
 * No upscaling is performed: panels are exact crops of the source resolution.
 *
 * @module dsh-media-plugins/shared/grid-detect
 */

import sharp from 'sharp'
import { basename, extname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'

export interface GridPanel {
  id: string
  row: number
  col: number
  path: string
  width: number
  height: number
}

export type GridMethod = 'gutter_profile' | 'declared_even'

export interface DetectedGrid {
  rows: number
  cols: number
  /** Detector that produced the geometry (kept for the review page/notes). */
  method: GridMethod
  /** Internal gutter centres, full-resolution px, top-to-bottom / left-to-right. */
  horizontal: number[]
  vertical: number[]
  /** Panel bounds, full-resolution px: `[top, bottom]` / `[left, right]` per row/column. */
  rowRanges: Array<[number, number]>
  colRanges: Array<[number, number]>
  /** Gutter polarity actually used for the rows/columns. */
  polarity: { rows: 'bright' | 'dark'; cols: 'bright' | 'dark' }
}

export interface GridSplitResult {
  sheet: string
  grid: DetectedGrid
  panels: GridPanel[]
  warnings: string[]
  message: string
}

export interface GridDetectOptions {
  /** Longest edge of the working scan image (default 1024). */
  workEdge?: number
  /** Reject layouts with fewer panels than this (default 4 — 四宫格 and up). */
  minPanels?: number
  /** Reject panels smaller than this on either side, full-resolution px (default 96). */
  minPanelPx?: number
  /** Extra margin kept inside a detected gutter band, full-resolution px (default 2). */
  insetPx?: number
  /**
   * Layout the caller declares (e.g. the batch manifest said "3x3"). When the
   * detector agrees, its exact gutter geometry is used; otherwise the sheet is
   * split evenly — the only safe answer for a borderless sheet.
   */
  layout?: { rows: number; cols: number } | null
}

interface Band {
  start: number
  end: number
}

interface LineHit {
  band: Band
  polarity: 'bright' | 'dark'
}

/** Candidate internal gutter positions, as exact fractions of the axis. */
const LINE_FRACTIONS: Array<[number, number]> = [
  [1, 4],
  [1, 3],
  [1, 2],
  [2, 3],
  [3, 4],
]

/** Relative search window around a candidate fraction (±4.5 % of the axis). */
const FRACTION_TOL = 0.045
/** Max half-height band width, as a share of the axis: a gutter is thin. */
const MAX_BAND_FRACTION = 0.03
/** Min luminance difference between the gutter and its surroundings. */
const MIN_CONTRAST = 20
/** Share of the axis that must sit on the gutter side of the half-height level. */
const MIN_SPAN_COVERAGE = 0.8

/** Panels smaller than this many full-resolution px on a side are refused. */
const DEFAULT_MIN_PANEL_PX = 96
/** Smallest source edge worth scanning (a thumbnail is never a sheet). */
const MIN_SOURCE_EDGE = 256
/** Clamp for the working-scale scan edge. */
const MIN_WORK_EDGE = 256
const MAX_WORK_EDGE = 2400
const DEFAULT_WORK_EDGE = 1024

/** `2/4` must compare equal to `1/2` so layouts share their gutters. */
function simplifyFraction(num: number, den: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const g = gcd(num, den)
  return `${num / g}/${den / g}`
}

/** Every layout from `minPanels` up to 4×4, most panels first (square wins ties). */
function candidateLayouts(minPanels: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let rows = 1; rows <= 4; rows += 1) {
    for (let cols = 1; cols <= 4; cols += 1) {
      if (rows * cols >= minPanels) out.push([rows, cols])
    }
  }
  return out.sort((a, b) => b[0] * b[1] - a[0] * a[1] || Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]))
}

/** Mean luminance of every row/column of the working-scale gray buffer. */
function meanProfile(gray: Uint8Array, w: number, h: number, axis: 'row' | 'col'): Float64Array {
  const len = axis === 'row' ? h : w
  const other = axis === 'row' ? w : h
  const out = new Float64Array(len)
  for (let i = 0; i < len; i += 1) {
    let sum = 0
    for (let j = 0; j < other; j += 1) sum += axis === 'row' ? gray[i * w + j] : gray[j * w + i]
    out[i] = sum / other
  }
  return out
}

/**
 * Locate one narrow gutter around `expect`. `polarity` selects a bright line
 * (white gutter) or a dark line (black seam); both are validated for contrast,
 * thinness and full-axis coverage so neither a sky band nor a shadow is
 * mistaken for a separator.
 */
function findGutter(
  prof: Float64Array,
  gray: Uint8Array,
  w: number,
  h: number,
  axis: 'row' | 'col',
  expect: number,
  polarity: 'bright' | 'dark',
): LineHit | null {
  const len = prof.length
  const tol = Math.max(6, Math.round(len * FRACTION_TOL))
  const lo = Math.max(0, Math.floor(expect - tol))
  const hi = Math.min(len - 1, Math.ceil(expect + tol))
  if (hi <= lo) return null

  let base = polarity === 'bright' ? Infinity : -Infinity
  for (let i = lo; i <= hi; i += 1) {
    if (polarity === 'bright' ? prof[i] < base : prof[i] > base) base = prof[i]
  }

  const isPeak = (i: number): boolean => {
    const v = prof[i]
    const left = i === 0 ? (polarity === 'bright' ? -Infinity : Infinity) : prof[i - 1]
    const right = i === len - 1 ? (polarity === 'bright' ? -Infinity : Infinity) : prof[i + 1]
    return polarity === 'bright' ? v >= left && v >= right : v <= left && v <= right
  }
  const peaks: number[] = []
  for (let i = lo; i <= hi; i += 1) if (isPeak(i)) peaks.push(i)
  if (!peaks.length) return null
  peaks.sort((a, b) => Math.abs(a - expect) - Math.abs(b - expect))

  const maxBand = Math.max(6, Math.round(len * MAX_BAND_FRACTION))
  for (const p of peaks) {
    const contrast = polarity === 'bright' ? prof[p] - base : base - prof[p]
    if (contrast < MIN_CONTRAST) continue
    const half = polarity === 'bright' ? base + contrast / 2 : base - contrast / 2
    let s = p
    let e = p
    while (s > lo && (polarity === 'bright' ? prof[s - 1] >= half : prof[s - 1] <= half)) s -= 1
    while (e < hi && (polarity === 'bright' ? prof[e + 1] >= half : prof[e + 1] <= half)) e += 1
    if (e - s + 1 > maxBand) continue
    // The gutter must span the whole axis: a local bright/dark blob inside one
    // panel never does, so this is what keeps content out of the pick.
    const total = axis === 'row' ? w : h
    let covered = 0
    for (let j = 0; j < total; j += 1) {
      const v = axis === 'row' ? gray[p * w + j] : gray[j * w + p]
      if (polarity === 'bright' ? v >= half : v <= half) covered += 1
    }
    if (total === 0 || covered / total < MIN_SPAN_COVERAGE) continue
    return { band: { start: s, end: e }, polarity }
  }
  return null
}

/**
 * Every panel of the layout must look like content: not a blank white tile and
 * not a flat colour. Sampled in working-scale space so this stays cheap even on
 * a 4K sheet.
 */
function panelsHaveContent(gray: Uint8Array, w: number, h: number, rows: number, cols: number): boolean {
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x0 = Math.round((c * w) / cols)
      const x1 = Math.max(x0 + 1, Math.round(((c + 1) * w) / cols))
      const y0 = Math.round((r * h) / rows)
      const y1 = Math.max(y0 + 1, Math.round(((r + 1) * h) / rows))
      const stepX = Math.max(1, Math.floor((x1 - x0) / 32))
      const stepY = Math.max(1, Math.floor((y1 - y0) / 32))
      let n = 0
      let sum = 0
      let sumSq = 0
      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) {
          const v = gray[y * w + x]
          n += 1
          sum += v
          sumSq += v * v
        }
      }
      if (n === 0) return false
      const mean = sum / n
      const variance = Math.max(0, sumSq / n - mean * mean)
      if (Math.sqrt(variance) < 6) return false
      if (mean > 252) return false
    }
  }
  return true
}

/** One detection pass at a given working scale. */
async function scanForLayout(
  image: string,
  fullW: number,
  fullH: number,
  workEdge: number,
  minPanels: number,
  minPanelPx: number,
  insetPx: number,
): Promise<DetectedGrid | null> {
  const scale = Math.min(1, workEdge / Math.max(fullW, fullH))
  const ww = Math.max(1, Math.round(fullW * scale))
  const wh = Math.max(1, Math.round(fullH * scale))
  let gray: Uint8Array
  try {
    const { data } = await sharp(image, { failOn: 'none' })
      .rotate()
      .resize({ width: ww, height: wh, fit: 'fill' })
      .removeAlpha()
      .toColourspace('b-w')
      .raw()
      .toBuffer({ resolveWithObject: true })
    gray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  } catch {
    return null
  }

  const rowProf = meanProfile(gray, ww, wh, 'row')
  const colProf = meanProfile(gray, ww, wh, 'col')

  // Every plausible gutter position is probed once, in both polarities; a
  // layout is satisfied when each of its internal lines has a hit.
  const rowHits = new Map<string, LineHit>()
  const colHits = new Map<string, LineHit>()
  for (let i = 0; i < LINE_FRACTIONS.length; i += 1) {
    const key = simplifyFraction(LINE_FRACTIONS[i][0], LINE_FRACTIONS[i][1])
    const num = LINE_FRACTIONS[i][0]
    const den = LINE_FRACTIONS[i][1]
    const rHit = findGutter(rowProf, gray, ww, wh, 'row', (wh * num) / den, 'bright') ?? findGutter(rowProf, gray, ww, wh, 'row', (wh * num) / den, 'dark')
    if (rHit) rowHits.set(key, rHit)
    const cHit = findGutter(colProf, gray, ww, wh, 'col', (ww * num) / den, 'bright') ?? findGutter(colProf, gray, ww, wh, 'col', (ww * num) / den, 'dark')
    if (cHit) colHits.set(key, cHit)
  }

  const inv = 1 / scale
  for (const [rows, cols] of candidateLayouts(minPanels)) {
    const rowKeys: string[] = []
    for (let r = 1; r < rows; r += 1) rowKeys.push(simplifyFraction(r, rows))
    const colKeys: string[] = []
    for (let c = 1; c < cols; c += 1) colKeys.push(simplifyFraction(c, cols))
    if (!rowKeys.every((k) => rowHits.has(k)) || !colKeys.every((k) => colHits.has(k))) continue

    const hBands = rowKeys.map((k) => rowHits.get(k)!.band).sort((a, b) => a.start - b.start)
    const vBands = colKeys.map((k) => colHits.get(k)!.band).sort((a, b) => a.start - b.start)

    // Cut on the OUTSIDE of each gutter band (plus a hair of safety margin), so
    // no gutter pixel can leak into a panel.
    const rowRanges: Array<[number, number]> = []
    for (let r = 0; r < rows; r += 1) {
      const top = r === 0 ? 0 : Math.round(hBands[r - 1].end * inv) + 1 + insetPx
      const bottom = r === rows - 1 ? fullH : Math.round(hBands[r].start * inv) - insetPx
      rowRanges.push([top, bottom])
    }
    const colRanges: Array<[number, number]> = []
    for (let c = 0; c < cols; c += 1) {
      const left = c === 0 ? 0 : Math.round(vBands[c - 1].end * inv) + 1 + insetPx
      const right = c === cols - 1 ? fullW : Math.round(vBands[c].start * inv) - insetPx
      colRanges.push([left, right])
    }

    // Degenerate geometry (a band that ate a whole panel) is not a sheet.
    const floor = Math.min(minPanelPx, 32)
    if (rowRanges.some(([a, b]) => b - a < floor)) continue
    if (colRanges.some(([a, b]) => b - a < floor)) continue
    if (!panelsHaveContent(gray, ww, wh, rows, cols)) continue

    return {
      rows,
      cols,
      method: 'gutter_profile',
      horizontal: hBands.map((b) => Math.round(((b.start + b.end) / 2) * inv)),
      vertical: vBands.map((b) => Math.round(((b.start + b.end) / 2) * inv)),
      rowRanges,
      colRanges,
      polarity: {
        rows: rowKeys.length ? rowHits.get(rowKeys[0])!.polarity : 'bright',
        cols: colKeys.length ? colHits.get(colKeys[0])!.polarity : 'bright',
      },
    }
  }
  return null
}

/** Detect the best-supported layout and its cut geometry, or null. */
export async function detectGridLayout(image: string, opts: GridDetectOptions = {}): Promise<DetectedGrid | null> {
  const minPanels = Math.max(2, Math.round(opts.minPanels ?? 4))
  const minPanelPx = Math.max(16, Math.round(opts.minPanelPx ?? DEFAULT_MIN_PANEL_PX))
  const insetPx = Math.max(0, Math.min(64, Math.round(opts.insetPx ?? 2)))
  const workEdge = Math.max(MIN_WORK_EDGE, Math.round(opts.workEdge ?? DEFAULT_WORK_EDGE))

  const meta = await sharp(image, { failOn: 'none' }).rotate().metadata().catch(() => null)
  if (!meta) return null
  const fullW = meta.width ?? 0
  const fullH = meta.height ?? 0
  if (fullW < MIN_SOURCE_EDGE || fullH < MIN_SOURCE_EDGE) return null

  // Thin (1 px) gutters get smeared away by an aggressive downscale, so a miss
  // at the fast default scale is retried near native resolution before the
  // image is declared "not a sheet".
  const hiEdge = Math.min(MAX_WORK_EDGE, Math.max(fullW, fullH))
  const attempts = hiEdge > workEdge * 1.5 ? [workEdge, hiEdge] : [workEdge]
  for (const edge of attempts) {
    const found = await scanForLayout(image, fullW, fullH, edge, minPanels, minPanelPx, insetPx)
    if (found) return found
  }
  return null
}

/** Cut the panels of an already-detected grid into `outputDir`. */
export async function cropGridPanels(image: string, grid: DetectedGrid, outputDir: string): Promise<GridPanel[]> {
  await mkdir(outputDir, { recursive: true })
  const base = basename(image, extname(image)).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'sheet'
  const meta = await sharp(image, { failOn: 'none' }).rotate().metadata()
  const fullW = meta.width ?? 0
  const fullH = meta.height ?? 0
  const panels: GridPanel[] = []
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.cols; c += 1) {
      const [rawLeft, rawRight] = grid.colRanges[c]
      const [rawTop, rawBottom] = grid.rowRanges[r]
      const left = Math.max(0, Math.min(fullW - 1, rawLeft))
      const top = Math.max(0, Math.min(fullH - 1, rawTop))
      const width = Math.max(1, Math.min(fullW - left, Math.max(1, rawRight - left)))
      const height = Math.max(1, Math.min(fullH - top, Math.max(1, rawBottom - top)))
      const id = `r${r + 1}c${c + 1}`
      const path = join(outputDir, `${base}-${id}.png`)
      const out = await sharp(image, { failOn: 'none' })
        .rotate()
        .extract({ left, top, width, height })
        .png()
        .toFile(path)
      panels.push({ id, row: r + 1, col: c + 1, path, width: out.width, height: out.height })
    }
  }
  return panels
}

/**
 * Detect a multi-panel sheet and cut it. Returns null when the image is not a
 * grid sheet (or the layout is smaller than `minPanels`) — callers then keep the
 * original image as the single review entry.
 *
 * With `opts.layout` the caller's declaration wins: a matching detection
 * supplies the exact gutter geometry, and a borderless sheet (where no gutter
 * exists to find) falls back to an even split of the declared layout.
 */
export async function splitGridPanels(image: string, outputDir: string, opts: GridDetectOptions = {}): Promise<GridSplitResult | null> {
  try {
    const declared = opts.layout ?? null
    const floorPanels = declared ? Math.max(2, declared.rows * declared.cols) : Math.max(2, Math.round(opts.minPanels ?? 4))
    const grid = await detectGridLayout(image, { ...opts, minPanels: floorPanels })
    let effective: DetectedGrid | null = null
    const warnings: string[] = []
    if (declared) {
      if (grid && grid.rows === declared.rows && grid.cols === declared.cols) {
        effective = grid
      } else {
        const meta = await sharp(image, { failOn: 'none' }).rotate().metadata().catch(() => null)
        const fullW = meta?.width ?? 0
        const fullH = meta?.height ?? 0
        if (fullW < MIN_SOURCE_EDGE || fullH < MIN_SOURCE_EDGE) return null
        effective = evenSplitGrid(fullW, fullH, declared.rows, declared.cols, opts.insetPx ?? 2)
        warnings.push(`未检测到匹配的 ${declared.rows}×${declared.cols} 格线，已按声明等比分割，请核对面板边界`)
      }
    } else {
      effective = grid
    }
    if (!effective) return null
    const panels = await cropGridPanels(image, effective, outputDir)
    if (panels.length < 2) return null
    return {
      sheet: image,
      grid: effective,
      panels,
      warnings,
      message: `${rowsColsLabel(effective.rows, effective.cols)}（${panels.length} 张面板）`,
    }
  } catch {
    // Detection is best-effort: a sheet that cannot be read or cut must never
    // break the review page it was going to be embedded into.
    return null
  }
}

/**
 * Parse a declared layout spec: `3x3`, `3×3`, `3*3` or `3:3` (case-insensitive).
 * Returns null for anything else, so a malformed manifest field is rejected
 * instead of silently splitting an image the wrong way.
 */
export function parseGridSpec(spec: unknown): { rows: number; cols: number } | null {
  const m = String(spec ?? '').trim().match(/^([1-4])\s*[x×*:]\s*([1-4])$/i)
  if (!m) return null
  const rows = Number(m[1])
  const cols = Number(m[2])
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows * cols < 2) return null
  return { rows, cols }
}

/** Even split geometry for a sheet with no detectable gutter (borderless). */
export function evenSplitGrid(fullW: number, fullH: number, rows: number, cols: number, insetPx = 2): DetectedGrid {
  const inset = Math.max(0, Math.min(64, Math.round(insetPx)))
  const rowRanges: Array<[number, number]> = []
  for (let r = 0; r < rows; r += 1) {
    const top = Math.round((r * fullH) / rows) + (r === 0 ? 0 : inset)
    const bottom = Math.round(((r + 1) * fullH) / rows) - (r === rows - 1 ? 0 : inset)
    rowRanges.push([top, bottom])
  }
  const colRanges: Array<[number, number]> = []
  for (let c = 0; c < cols; c += 1) {
    const left = Math.round((c * fullW) / cols) + (c === 0 ? 0 : inset)
    const right = Math.round(((c + 1) * fullW) / cols) - (c === cols - 1 ? 0 : inset)
    colRanges.push([left, right])
  }
  const horizontal: number[] = []
  for (let r = 1; r < rows; r += 1) horizontal.push(Math.round((r * fullH) / rows))
  const vertical: number[] = []
  for (let c = 1; c < cols; c += 1) vertical.push(Math.round((c * fullW) / cols))
  return { rows, cols, method: 'declared_even', horizontal, vertical, rowRanges, colRanges, polarity: { rows: 'bright', cols: 'bright' } }
}

/** Human label for a layout: 3×3 九宫格 / 2×2 四宫格 / … */
export function rowsColsLabel(rows: number, cols: number): string {
  const total = rows * cols
  const alias: Record<number, string> = { 2: '双联', 3: '三联', 4: '四宫格', 6: '六宫格', 8: '八宫格', 9: '九宫格', 12: '十二宫格', 16: '十六宫格' }
  return `${rows}×${cols} ${alias[total] ?? `${total} 分格`}`
}
