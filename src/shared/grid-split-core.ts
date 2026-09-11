/**
 * Grid-sheet split core (Codex_IS community-revision port): split a 3×3
 * grid-sheet image into nine independent panels by locating the grid lines,
 * cropping with a small inset, and validating the result. Falls back to an
 * even split when line detection fails. No upscaling is performed — this is
 * extraction only, per the community consensus that enlarging is not
 * redrawing.
 *
 * Two detection strategies run in order:
 *
 *  1. `morphological_lines` — threshold + full-width white-run band grouping.
 *     Fast and exact for sheets with crisp pure-white gutters.
 *  2. `profile_peaks` — row/column mean-luminance profile with a peak
 *     prominence test. Handles soft / light-grey gutters and uneven row or
 *     column heights, and refuses to lock onto a large bright *content* band
 *     (sky, snow, white walls) that the morphological scan would misread.
 *
 * Both strategies cut on the **outside** of the detected gutter band, so no
 * gutter pixel leaks into a panel — this is what fixes off-by-N crops when a
 * model renders rows of unequal height.
 *
 * @module dsh-media-plugins/shared/grid-split-core
 */

import sharp from 'sharp'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

export type SplitMethod = 'morphological_lines' | 'profile_peaks' | 'fallback_even'

export interface SplitPanel {
  id: string
  row: number
  col: number
  path: string
  width: number
  height: number
  whiteRatio: number
}

export interface SplitResult {
  ok: boolean
  method: SplitMethod
  sheet_path: string
  /** Resolution actually read from the file, as "WxH". Every cut below is
   *  computed against THIS, never against an assumed canvas size. */
  source_resolution: string
  width: number
  height: number
  lines: { horizontal: number[]; vertical: number[] }
  gutter_bands: { horizontal: Array<{ start: number; end: number }>; vertical: Array<{ start: number; end: number }> }
  normalized_ratio: string | null
  inset_percent: number
  panels: SplitPanel[]
  review_page: string
  warnings: string[]
  message: string
}

/** Threshold ladder: try strict white first, loosen only if nothing found. */
const THRESHOLDS = [235, 250, 220, 200]

/** White-line row/column flag: fraction of white pixels along the axis. */
const ROW_FRACTION = 0.85
/** Longest contiguous white run must span this share of the axis (kills
 *  sky-only rows inside one panel, which only span ~1/3 of the width). */
const RUN_FRACTION = 0.6
/** Bands whose centers lie within [INNER_MIN, INNER_MAX] of the axis are
 *  candidates for the two inner gutter lines (outer borders excluded). */
const INNER_MIN = 0.15
const INNER_MAX = 0.85

/** Profile detector: a gutter must be at least this bright. */
const PROFILE_MIN_PEAK = 110
/** Search window around the expected 1/3 & 2/3 positions, as a share of the
 *  axis (a model may render unequal rows, so this is deliberately generous). */
const PROFILE_TOL_FRACTION = 0.14
/** Half-maximum band wider than this share of the axis is treated as content,
 *  not as a gutter, and the next-nearest peak is tried instead. */
const PROFILE_MAX_BAND_FRACTION = 0.04
/** A detection whose gutters stray further than this from the expected 1/3 &
 *  2/3 positions is judged unreliable: the even split is safer. */
const PROFILE_MAX_DEVIATION = 0.2
/** Pixels of extra safety margin kept inside a detected gutter band edge. */
const DEFAULT_INSET_PX = 2

interface Band {
  start: number
  end: number
}

/** Group 1-D flagged indices into bands, merging gaps of at most `gap`. */
function groupBands(flags: number[], gap: number): Band[] {
  const bands: Band[] = []
  for (const idx of flags) {
    const last = bands[bands.length - 1]
    if (last && idx <= last.end + gap) last.end = idx
    else bands.push({ start: idx, end: idx })
  }
  return bands
}

/**
 * Pick the two bands closest to the expected 1/3 and 2/3 positions, in order.
 * Being lenient here (instead of demanding exactly two bands) keeps a stray
 * false positive — or one clipped by the inner-window filter — from throwing
 * the whole detection away.
 */
function pickTwoGutters(bands: Band[], len: number): Band[] | null {
  if (bands.length < 2) return null
  const targets = [len / 3, (2 * len) / 3]
  const centre = (b: Band): number => (b.start + b.end) / 2
  const first = bands
    .map((b) => ({ b, d: Math.abs(centre(b) - targets[0]) }))
    .sort((p, q) => p.d - q.d)[0]
  if (!first) return null
  const second = bands
    .filter((b) => b !== first.b)
    .map((b) => ({ b, d: Math.abs(centre(b) - targets[1]) }))
    .sort((p, q) => p.d - q.d)[0]
  if (!second) return null
  const chosen = [first.b, second.b].sort((p, q) => p.start - q.start)
  if (chosen[1].start - chosen[0].end < len * 0.1) return null
  return chosen
}

/** Strategy 1: morphological scan — rows/columns that are almost entirely
 *  white and contain a long full-width white run. */
function detectMorphological(gray: Uint8Array, w: number, h: number, threshold: number): { h: Band[]; v: Band[] } | null {
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < bin.length; i++) bin[i] = gray[i] >= threshold ? 1 : 0

  const rowFlags: number[] = []
  for (let y = 0; y < h; y++) {
    let sum = 0
    let run = 0
    let maxRun = 0
    for (let x = 0; x < w; x++) {
      const v = bin[y * w + x]
      sum += v
      if (v) {
        run++
        if (run > maxRun) maxRun = run
      } else run = 0
    }
    if (sum / w > ROW_FRACTION && maxRun / w > RUN_FRACTION) rowFlags.push(y)
  }
  const hBands = groupBands(rowFlags, 2).filter((b) => {
    const c = (b.start + b.end) / 2 / h
    return c >= INNER_MIN && c <= INNER_MAX
  })

  const colFlags: number[] = []
  for (let x = 0; x < w; x++) {
    let sum = 0
    let run = 0
    let maxRun = 0
    for (let y = 0; y < h; y++) {
      const v = bin[y * w + x]
      sum += v
      if (v) {
        run++
        if (run > maxRun) maxRun = run
      } else run = 0
    }
    if (sum / h > ROW_FRACTION && maxRun / h > RUN_FRACTION) colFlags.push(x)
  }
  const vBands = groupBands(colFlags, 2).filter((b) => {
    const c = (b.start + b.end) / 2 / w
    return c >= INNER_MIN && c <= INNER_MAX
  })

  const hPick = pickTwoGutters(hBands, h)
  const vPick = pickTwoGutters(vBands, w)
  if (!hPick || !vPick) return null
  return { h: hPick, v: vPick }
}

/** Mean luminance of every row of a working-scale gray buffer. */
function rowProfile(gray: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(h)
  for (let y = 0; y < h; y++) {
    let sum = 0
    for (let x = 0; x < w; x++) sum += gray[y * w + x]
    out[y] = sum / w
  }
  return out
}

/** Mean luminance of every column of a working-scale gray buffer. */
function colProfile(gray: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = 0; y < h; y++) sum += gray[y * w + x]
    out[x] = sum / h
  }
  return out
}

/**
 * Locate one gutter band around an expected position on a luminance profile.
 * Accepts soft/light-grey gutters (lower absolute bar than the morphological
 * scan) but demands a clear local peak, and degrades an over-wide half-max
 * band — the signature of a bright content region — to a narrow band.
 */
function findGutterBand(prof: Float64Array, len: number, expect: number): Band | null {
  const tol = Math.max(8, Math.round(len * PROFILE_TOL_FRACTION))
  const lo = Math.max(0, Math.floor(expect - tol))
  const hi = Math.min(len - 1, Math.ceil(expect + tol))
  let base = Infinity
  for (let i = lo; i <= hi; i++) if (prof[i] < base) base = prof[i]

  // Prefer the significant LOCAL peak closest to the expected position: a
  // gutter sits at ~1/3 or ~2/3 by construction, whereas a bright content
  // band (sky, snow, a white wall) can sit anywhere and may well be brighter
  // than the gutter — picking the global maximum would lock onto it.
  const localPeaks: number[] = []
  for (let i = lo; i <= hi; i++) {
    const v = prof[i]
    const left = i === 0 ? -Infinity : prof[i - 1]
    const right = i === len - 1 ? -Infinity : prof[i + 1]
    if (v >= left && v >= right && v >= PROFILE_MIN_PEAK) localPeaks.push(i)
  }
  if (localPeaks.length === 0) return null
  localPeaks.sort((a, b) => Math.abs(a - expect) - Math.abs(b - expect))
  const maxBand = Math.max(10, Math.round(len * PROFILE_MAX_BAND_FRACTION))
  // Take the nearest narrow peak. An absolute-prominence bar is deliberately
  // NOT used here: on an image whose upper half is a bright sky or water,
  // every row up there clears any prominence bar — so a prominence test
  // rejects the real (dimmer, but far narrower) gutter and hands the pick to
  // a wide bright band further from the expected position. Shape is the
  // discriminator that actually holds: a gutter is a thin line, a content
  // band is broad.
  for (const best of localPeaks) {
    const half = base + (prof[best] - base) / 2
    let s = best
    while (s > lo && prof[s - 1] >= half) s--
    let e = best
    while (e < hi && prof[e + 1] >= half) e++
    if (e - s + 1 <= maxBand) return { start: s, end: e }
  }
  return null
}

/** Strategy 2: luminance-profile peak detection (soft / grey gutters,
 *  unequal panel heights, bright-content rejection). */
function detectByProfile(gray: Uint8Array, w: number, h: number): { h: Band[]; v: Band[] } | null {  const rows = rowProfile(gray, w, h)
  const cols = colProfile(gray, w, h)
  const hBands: Band[] = []
  for (const expect of [h / 3, (2 * h) / 3]) {
    const b = findGutterBand(rows, h, expect)
    if (!b) return null
    hBands.push(b)
  }
  const vBands: Band[] = []
  for (const expect of [w / 3, (2 * w) / 3]) {
    const b = findGutterBand(cols, w, expect)
    if (!b) return null
    vBands.push(b)
  }
  if (hBands[1].start - hBands[0].end < h * 0.1) return null
  if (vBands[1].start - vBands[0].end < w * 0.1) return null
  return { h: hBands, v: vBands }
}

/** Normalised deviation of a detected gutter pair from the expected 1/3 and
 *  2/3 positions. Used to arbitrate between the two detectors. */
function gutterDeviation(bands: { h: Band[]; v: Band[] }, w: number, h: number): number {
  const mid = (b: Band): number => (b.start + b.end) / 2
  const devH = Math.abs(mid(bands.h[0]) - h / 3) + Math.abs(mid(bands.h[1]) - (2 * h) / 3)
  const devV = Math.abs(mid(bands.v[0]) - w / 3) + Math.abs(mid(bands.v[1]) - (2 * w) / 3)
  return (devH / h + devV / w) / 2
}

/** White share of a working-scale region; used for validation only. */
function regionWhiteRatio(bin: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  let white = 0
  let total = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++
      if (bin[y * w + x] === 1) white++
    }
  }
  return total === 0 ? 1 : white / total
}

function safeExtract(width: number, height: number, left: number, top: number, w: number, h: number): { left: number; top: number; width: number; height: number } {
  const L = Math.max(0, Math.min(width - 1, left))
  const T = Math.max(0, Math.min(height - 1, top))
  const W = Math.max(1, Math.min(width - L, w))
  const H = Math.max(1, Math.min(height - T, h))
  return { left: L, top: T, width: W, height: H }
}

/** Parse a "W:H" aspect-ratio string into { w, h }; null when malformed. */
export function parseRatio(s: string): { w: number; h: number } | null {
  const m = String(s ?? '').trim().match(/^(\d+)\s*:\s*(\d+)$/)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
  return { w, h }
}

/**
 * Center-crop a panel of pw×ph to the target ratio. Rule per user:
 * portrait (w < h) → keep height, crop width; landscape (w >= h) → keep
 * width, crop height. When the panel is already narrower/taller than the
 * target (cropping the preferred axis cannot reach the ratio), fall back to
 * cropping the other axis and report it via `warnings`.
 */
export function normalizeCrop(
  pw: number,
  ph: number,
  ratio: { w: number; h: number },
  warnings: string[],
  label: string,
): { left: number; top: number; width: number; height: number } | null {
  const r = ratio.w / ratio.h
  const prefer = r >= 1 ? 'landscape' : 'portrait'
  if (prefer === 'landscape') {
    // Keep width, crop height.
    const targetH = Math.round(pw / r)
    if (targetH <= ph) {
      return safeExtract(pw, ph, 0, Math.floor((ph - targetH) / 2), pw, targetH)
    }
    // Panel already wider-shorter than the target: fall back to keeping
    // height and cropping width.
    const targetW = Math.round(ph * r)
    if (targetW <= pw) {
      warnings.push(`${label} 已比目标比例更扁（${pw}×${ph}），改用高不变、裁宽度`)
      return safeExtract(pw, ph, Math.floor((pw - targetW) / 2), 0, targetW, ph)
    }
    warnings.push(`${label} 无法裁剪到 ${ratio.w}:${ratio.h}（${pw}×${ph}），保持原样`)
    return null
  }
  // Portrait: keep height, crop width.
  const targetW = Math.round(ph * r)
  if (targetW <= pw) {
    return safeExtract(pw, ph, Math.floor((pw - targetW) / 2), 0, targetW, ph)
  }
  // Panel already taller-narrower than the target: fall back to keeping
  // width and cropping height.
  const targetH = Math.round(pw / r)
  if (targetH <= ph) {
    warnings.push(`${label} 已比目标比例更瘦高（${pw}×${ph}），改用宽不变、裁高度`)
    return safeExtract(pw, ph, 0, Math.floor((ph - targetH) / 2), pw, targetH)
  }
  warnings.push(`${label} 无法裁剪到 ${ratio.w}:${ratio.h}（${pw}×${ph}），保持原样`)
  return null
}

export interface SplitOptions {
  workEdge?: number
  normalizeRatio?: string | null
  insetPercent?: number
  /** Extra safety margin (full-res px) kept inside a *detected* gutter band edge. */
  insetPx?: number
  /** Emit the self-contained review page next to the panels (default true). */
  reviewPage?: boolean
  /** Optional "WxH" the sheet is expected to have. A mismatch is reported as a
   *  warning — the split still runs against the real, identified resolution. */
  expectedSize?: string | null
}

/** Parse a "WxH" size string into { width, height }; null when malformed. */
export function parseSize(s: string): { width: number; height: number } | null {
  const m = String(s ?? '').trim().match(/^(\d+)\s*[x×*]\s*(\d+)$/i)
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

interface ScanResult {
  gray: Uint8Array
  workW: number
  workH: number
  scale: number
  detected: { h: Band[]; v: Band[] } | null
  method: 'morphological_lines' | 'profile_peaks' | null
}

/**
 * Split a 3×3 grid sheet into nine panels.
 *
 * @param image    sheet image path (PNG/JPEG/WEBP)
 * @param outputDir directory for the nine panels + review page
 * @param opts.insetPercent  fallback-split margin, percent of the full sheet (default 2)
 * @param opts.insetPx       extra margin inside a detected gutter band, full-res px (default 2)
 * @param opts.workEdge      longest edge of the working scan image (default 1024)
 */
export async function splitGridSheet(
  image: string,
  outputDir: string,
  opts: SplitOptions = {},
): Promise<SplitResult> {
  const insetPercent = Math.max(0, Math.min(10, Math.round(opts.insetPercent ?? 2)))
  const insetPx = Math.max(0, Math.min(64, Math.round(opts.insetPx ?? DEFAULT_INSET_PX)))
  const workEdge = Math.max(256, Math.round(opts.workEdge ?? 1024))
  const wantReview = opts.reviewPage !== false
  const warnings: string[] = []
  const ratio = opts.normalizeRatio && String(opts.normalizeRatio).trim().length > 0 ? parseRatio(String(opts.normalizeRatio)) : null
  const emptyLines = { horizontal: [] as number[], vertical: [] as number[] }
  const emptyBands = { horizontal: [] as Band[], vertical: [] as Band[] }
  if (opts.normalizeRatio && String(opts.normalizeRatio).trim().length > 0 && !ratio) {
    return { ok: false, method: 'fallback_even', sheet_path: image, source_resolution: '0x0', width: 0, height: 0, lines: emptyLines, gutter_bands: emptyBands, normalized_ratio: null, inset_percent: insetPercent, panels: [], review_page: '', warnings: [`无效比例：${opts.normalizeRatio}（应为 W:H，如 16:9 / 9:16 / 21:9）`], message: `invalid normalize_ratio: ${opts.normalizeRatio}` }
  }
  const normalizedRatioLabel = ratio ? `${ratio.w}:${ratio.h}` : null

  // ---- Step 1: identify the sheet's REAL resolution ----------------------
  // Nothing downstream may assume a canvas size: AI sheets come back at
  // 3840x2160, 5504x3072, 2752x1536 … and a hard-coded size silently cuts the
  // wrong pixels. Every gutter position and cut below is derived from these.
  const meta = await sharp(image, { failOn: 'none' }).rotate().metadata()
  const fullW = meta.width ?? 0
  const fullH = meta.height ?? 0
  const sourceResolution = `${fullW}x${fullH}`
  if (fullW === 0 || fullH === 0) return { ok: false, method: 'fallback_even', sheet_path: image, source_resolution: sourceResolution, width: 0, height: 0, lines: emptyLines, gutter_bands: emptyBands, normalized_ratio: null, inset_percent: insetPercent, panels: [], review_page: '', warnings: ['cannot read image dimensions'], message: `cannot read image: ${image}` }
  if (opts.expectedSize && String(opts.expectedSize).trim().length > 0) {
    const want = parseSize(String(opts.expectedSize))
    if (!want) {
      warnings.push(`expected_size 格式无效：${opts.expectedSize}（应为 WxH，如 3840x2160），已忽略该参数`)
    } else if (want.width !== fullW || want.height !== fullH) {
      warnings.push(`源图实际分辨率 ${sourceResolution} 与预期 ${want.width}x${want.height} 不一致；已按**实际分辨率**拆解，请确认是否为目标文件`)
    }
  }

  // Scan-and-detect at a given working scale. Thin (1 px) gutter lines get
  // smeared away by aggressive downscaling, so the scan is retried at a
  // higher resolution when nothing is found at the fast default scale.
  const tryDetectAt = async (targetScale: number): Promise<ScanResult> => {
    const s = Math.min(1, targetScale)
    const ww = Math.max(1, Math.round(fullW * s))
    const wh = Math.max(1, Math.round(fullH * s))
    const { data } = await sharp(image, { failOn: 'none' })
      .rotate()
      .resize({ width: ww, height: wh, fit: 'fill' })
      .removeAlpha()
      .toColourspace('b-w')
      .raw()
      .toBuffer({ resolveWithObject: true })
    const g = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

    // Both detectors run and the candidate whose gutters sit closest to the
    // expected 1/3 & 2/3 positions wins. Trusting a single detector is what
    // made the old code lock onto bright content: the morphological scan
    // happily reports a full-width white sky/water row as a "gutter".
    const candidates: Array<{ method: 'morphological_lines' | 'profile_peaks'; bands: { h: Band[]; v: Band[] }; dev: number }> = []
    for (const T of THRESHOLDS) {
      const d = detectMorphological(g, ww, wh, T)
      if (d) {
        candidates.push({ method: 'morphological_lines', bands: d, dev: gutterDeviation(d, ww, wh) })
        break
      }
    }
    const p = detectByProfile(g, ww, wh)
    if (p) candidates.push({ method: 'profile_peaks', bands: p, dev: gutterDeviation(p, ww, wh) })
    if (candidates.length === 0) return { gray: g, workW: ww, workH: wh, scale: s, detected: null, method: null }
    candidates.sort((a, b) => a.dev - b.dev)
    const win = candidates[0]
    return { gray: g, workW: ww, workH: wh, scale: s, detected: win.bands, method: win.method }
  }

  const fastScale = Math.min(1, workEdge / Math.max(fullW, fullH))
  let scan = await tryDetectAt(fastScale)
  if (!scan.detected && fastScale < 1) {
    // Retry near native resolution so hairline gutters survive.
    const hiScale = Math.min(1, 2400 / Math.max(fullW, fullH))
    if (hiScale > fastScale + 0.05) {
      scan = await tryDetectAt(hiScale)
    }
  }
  const { gray, workW, workH, scale } = scan

  let method: SplitMethod
  let rowRanges: Array<[number, number]> = []
  let colRanges: Array<[number, number]> = []
  let hLinesFull: number[] = []
  let vLinesFull: number[] = []
  const bandOut = { horizontal: [] as Band[], vertical: [] as Band[] }
  const insetW = Math.max(0, Math.round((fullW * insetPercent) / 100))
  const insetH = Math.max(0, Math.round((fullH * insetPercent) / 100))

  // A detection that strays far from the expected 1/3 & 2/3 layout is not
  // trustworthy — that is the "bright sky hijacked the gutter" case the old
  // build silently accepted and cut with. The even split is the safer answer.
  if (scan.detected && scan.method) {
    const preDev = gutterDeviation(scan.detected, scan.workW, scan.workH)
    if (preDev > PROFILE_MAX_DEVIATION) {
      warnings.push(`检测到的格线偏离标准三等分 ${(preDev * 100).toFixed(0)}%，判定不可靠，已回退等比分割`)
      scan = { ...scan, detected: null, method: null }
    }
  }

  if (scan.detected && scan.method) {
    method = scan.method
    const inv = 1 / scale
    const hb = scan.detected.h.map((b) => ({ start: Math.round(b.start * inv), end: Math.round(b.end * inv) }))
    const vb = scan.detected.v.map((b) => ({ start: Math.round(b.start * inv), end: Math.round(b.end * inv) }))
    bandOut.horizontal = hb
    bandOut.vertical = vb
    hLinesFull = hb.map((b) => Math.round((b.start + b.end) / 2))
    vLinesFull = vb.map((b) => Math.round((b.start + b.end) / 2))
    const dev = gutterDeviation(scan.detected, scan.workW, scan.workH)
    if (dev > 0.12) warnings.push(`格线位置与标准三等分偏差较大（${(dev * 100).toFixed(0)}%），请核对面板边界`)
    // Cut on the OUTSIDE of each gutter band (plus a hair of safety margin),
    // so no gutter pixel can leak into a panel.
    rowRanges = [
      [0, hb[0].start - 1 - insetPx],
      [hb[0].end + 1 + insetPx, hb[1].start - 1 - insetPx],
      [hb[1].end + 1 + insetPx, fullH - 1],
    ]
    colRanges = [
      [0, vb[0].start - 1 - insetPx],
      [vb[0].end + 1 + insetPx, vb[1].start - 1 - insetPx],
      [vb[1].end + 1 + insetPx, fullW - 1],
    ]
    // Guard against a degenerate band eating a whole panel.
    const tooSmall = [...rowRanges, ...colRanges].some(([a, b]) => b - a + 1 < 64)
    if (tooSmall) {
      warnings.push('检测到的格线带过宽或位置异常，已回退为等比分割')
      scan = { ...scan, detected: null, method: null }
      bandOut.horizontal = []
      bandOut.vertical = []
      hLinesFull = []
      vLinesFull = []
    }
  }

  if (!scan.detected) {
    method = 'fallback_even'
    warnings.push(`未检测到清晰格线，已启用等比分割（每侧内缩 ${insetPercent}%，即 ${insetW}px / ${insetH}px）；请核对面板边界`)
    const hCuts = [0, Math.round(fullH / 3), Math.round((2 * fullH) / 3), fullH]
    const vCuts = [0, Math.round(fullW / 3), Math.round((2 * fullW) / 3), fullW]
    rowRanges = [0, 1, 2].map((r) => [hCuts[r] + insetH, hCuts[r + 1] - insetH - 1] as [number, number])
    colRanges = [0, 1, 2].map((c) => [vCuts[c] + insetW, vCuts[c + 1] - insetW - 1] as [number, number])
  }

  await mkdir(outputDir, { recursive: true })
  const base = basename(image, extname(image)).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'grid'
  const panels: SplitPanel[] = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const id = `r${row + 1}c${col + 1}`
      const [y0, y1] = rowRanges[row]
      const [x0, x1] = colRanges[col]
      const box = safeExtract(fullW, fullH, x0, y0, Math.max(1, x1 - x0 + 1), Math.max(1, y1 - y0 + 1))
      // Optional ratio normalization: center-crop inside the panel (portrait
      // keeps height, landscape keeps width; the other axis gets cropped).
      let finalBox = box
      if (ratio) {
        const inner = normalizeCrop(box.width, box.height, ratio, warnings, id)
        if (inner) {
          finalBox = safeExtract(fullW, fullH, box.left + inner.left, box.top + inner.top, inner.width, inner.height)
        }
      }
      const dest = join(outputDir, `${base}-${id}.png`)
      const out = await sharp(image, { failOn: 'none' })
        .rotate()
        .extract(finalBox)
        .png()
        .toFile(dest)
      // white ratio from the working-scale binary (validation only)
      const wx0 = Math.round((finalBox.left / fullW) * workW)
      const wy0 = Math.round((finalBox.top / fullH) * workH)
      const wx1 = Math.max(wx0 + 1, Math.round(((finalBox.left + finalBox.width) / fullW) * workW))
      const wy1 = Math.max(wy0 + 1, Math.round(((finalBox.top + finalBox.height) / fullH) * workH))
      let whiteRatio = 0
      try {
        const bin = new Uint8Array(gray.length)
        for (let i = 0; i < gray.length; i++) bin[i] = gray[i] >= THRESHOLDS[THRESHOLDS.length - 1] ? 1 : 0
        whiteRatio = regionWhiteRatio(bin, workW, wx0, wy0, Math.min(workW, wx1), Math.min(workH, wy1))
      } catch {
        /* validation is best-effort */
      }
      panels.push({ id, row: row + 1, col: col + 1, path: dest, width: out.width, height: out.height, whiteRatio })
    }
  }

  // Validation: 9 panels, none mostly blank (mis-cropped gutter).
  for (const p of panels) {
    if (p.whiteRatio > 0.55) warnings.push(`${p.id} 大面积空白（白占比 ${(p.whiteRatio * 100).toFixed(0)}%），疑似格线检测偏移`)
  }
  const reviewPage = wantReview
    ? await buildReviewPage(image, panels, method, hLinesFull, vLinesFull, fullW, fullH, warnings, outputDir, base)
    : ''
  const lines = { horizontal: hLinesFull, vertical: vLinesFull }
  const ratioNote = normalizedRatioLabel ? `，比例已规范为 ${normalizedRatioLabel}` : ''
  const message = `拆格完成（${method}，源图已识别为 ${sourceResolution}${ratioNote}）：9 张面板 → ${outputDir}${reviewPage ? `；审阅页 → ${reviewPage}` : ''}`
  return { ok: true, method, sheet_path: image, source_resolution: sourceResolution, width: fullW, height: fullH, lines, gutter_bands: bandOut, normalized_ratio: normalizedRatioLabel, inset_percent: insetPercent, panels, review_page: reviewPage, warnings, message }
}

/** One output group: a named folder holding the panels of every sheet in it. */
export interface SplitGroupSpec {
  /** Folder name under the output root. Panels are written flat inside it. */
  group: string
  /** Sheet images belonging to this group. */
  images: string[]
}

export interface BatchSplitItem {
  group: string
  image: string
  ok: boolean
  method: SplitMethod | null
  panels: number
  /** Resolution identified from the file itself (step 1 of the split flow). */
  source_resolution: string
  warnings: string[]
  message: string
}

export interface BatchSplitResult {
  ok: boolean
  output_root: string
  group_count: number
  image_count: number
  panel_count: number
  failed: number
  /** How many sheets came back at each resolution — pair this with
   *  `expected_size` to catch a stray file before it is cut. */
  resolution_summary: Array<{ resolution: string; count: number }>
  results: BatchSplitItem[]
  message: string
}

/**
 * Batch split: every sheet in a group is split into its own folder, panels
 * written **flat** (no per-sheet sub-folders) — the layout required by the
 * "9 shots per scene, all in one folder" workflow.
 */
export async function splitGridSheets(
  specs: SplitGroupSpec[],
  outputRoot: string,
  opts: SplitOptions = {},
): Promise<BatchSplitResult> {
  const clean = specs
    .map((s) => ({ group: String(s?.group ?? '').trim() || 'group', images: (s?.images ?? []).map((i) => String(i ?? '').trim()).filter(Boolean) }))
    .filter((s) => s.images.length > 0)
  const results: BatchSplitItem[] = []
  let panelCount = 0
  let failed = 0
  await mkdir(outputRoot, { recursive: true })
  for (const spec of clean) {
    const dir = join(outputRoot, spec.group)
    await mkdir(dir, { recursive: true })
    for (const image of spec.images) {
      const r = await splitGridSheet(image, dir, { ...opts, reviewPage: false })
      panelCount += r.panels.length
      if (!r.ok || r.panels.length !== 9) failed++
      results.push({ group: spec.group, image, ok: r.ok && r.panels.length === 9, method: r.method, panels: r.panels.length, source_resolution: r.source_resolution, warnings: r.warnings, message: r.message })
    }
  }
  const byResolution = new Map<string, number>()
  for (const it of results) byResolution.set(it.source_resolution, (byResolution.get(it.source_resolution) ?? 0) + 1)
  const resolutionSummary = [...byResolution.entries()]
    .map(([resolution, count]) => ({ resolution, count }))
    .sort((a, b) => b.count - a.count)
  const imageTotal = clean.reduce((n, s) => n + s.images.length, 0)
  const resNote = resolutionSummary.map((r) => `${r.resolution}×${r.count}`).join('、')
  return {
    ok: failed === 0,
    output_root: outputRoot,
    group_count: clean.length,
    image_count: imageTotal,
    panel_count: panelCount,
    failed,
    resolution_summary: resolutionSummary,
    results,
    message: `批量拆格完成：${clean.length} 组 / ${imageTotal} 张图 → ${panelCount} 张面板（失败 ${failed}）；源图分辨率分布 ${resNote} → ${outputRoot}`,
  }
}

/** Self-contained review page: original thumbnail + 3×3 panel grid, all
 *  images embedded as data URIs so the file opens anywhere. */
async function buildReviewPage(
  sheet: string,
  panels: SplitPanel[],
  method: SplitMethod,
  hLines: number[],
  vLines: number[],
  fullW: number,
  fullH: number,
  warnings: string[],
  outputDir: string,
  base: string,
): Promise<string> {
  const thumb = async (p: string, edge: number): Promise<string> => {
    const buf = await sharp(p, { failOn: 'none' }).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  }
  const sheetThumb = await thumb(sheet, 720)
  const cells: string[] = []
  for (const p of panels) {
    const t = await thumb(p.path, 360)
    cells.push(`<td><img src="${t}" alt="${p.id}"><div class="slot">${p.id} · ${p.width}×${p.height} · 白占比 ${(p.whiteRatio * 100).toFixed(0)}%</div></td>`)
  }
  const warnHtml = warnings.length
    ? `<p style="color:#b06000">⚠ ${warnings.map((w) => ` ${w}`).join('；')}</p>`
    : '<p style="color:#2a7a2a">✓ 无异常</p>'
  const lineInfo = method === 'fallback_even'
    ? '等分均分（未检测到格线）'
    : `横格线(px): ${hLines.join(', ')}；纵格线(px): ${vLines.join(', ')}`
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>拆格审阅 ${base}</title>
<style>body{font-family:system-ui;margin:24px}table{border-collapse:collapse;margin:12px 0}td{border:1px solid #ccc;padding:6px;text-align:center;vertical-align:top}img{max-width:320px;width:100%;height:auto;display:block}.slot{font-size:12px;color:#555;margin-top:4px}h3{margin-bottom:4px}</style>
</head><body>
<h1>拆格审阅：${base}</h1>
<p>方法：${method} · 原图 ${fullW}×${fullH} · ${lineInfo}</p>
${warnHtml}
<h3>原图</h3><img src="${sheetThumb}" style="max-width:640px">
<h3>九宫格面板（r行c列：行1=上/全景行，行3=下/近景行；列1=左，列3=右）</h3>
<table>${cells.slice(0, 3).join('')}</table>
<table>${cells.slice(3, 6).join('')}</table>
<table>${cells.slice(6, 9).join('')}</table>
</body></html>`
  const pagePath = join(outputDir, `${base}-review.html`)
  await writeFile(pagePath, html, 'utf8')
  return pagePath
}

/** Resolve a possibly-relative path against the workspace root. */
export function resolvePath(p: string, workspaceRoot: string): string {
  return isAbsolute(p) ? p : join(workspaceRoot, p)
}
