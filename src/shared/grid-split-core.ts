/**
 * Grid-sheet split core (Codex_IS community-revision port): split a 3×3
 * grid-sheet image into nine independent panels by locating the grid lines
 * with a morphological-style line scan (threshold + full-width white-run
 * band grouping), cropping with a small inset, and validating the result.
 * Falls back to an even split when line detection fails. No upscaling is
 * performed — this is extraction only, per the community consensus that
 * enlarging is not redrawing.
 *
 * @module dsh-media-plugins/shared/grid-split-core
 */

import sharp from 'sharp'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

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
  method: 'morphological_lines' | 'fallback_even'
  sheet_path: string
  width: number
  height: number
  lines: { horizontal: number[]; vertical: number[] }
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

/** Group 1-D flagged indices into bands, merging gaps of at most `gap`. */
function groupBands(flags: number[], gap: number): Array<{ start: number; end: number }> {
  const bands: Array<{ start: number; end: number }> = []
  for (const idx of flags) {
    const last = bands[bands.length - 1]
    if (last && idx <= last.end + gap) last.end = idx
    else bands.push({ start: idx, end: idx })
  }
  return bands
}

/** Detect the two inner horizontal/vertical gutter lines on a downscaled
 *  grayscale buffer. Returns line positions (in working-scale pixels) or
 *  null when the sheet does not look like a clean 3×3 grid. */
function detectGridLines(
  gray: Uint8Array,
  w: number,
  h: number,
  threshold: number,
): { h: number[]; v: number[] } | null {
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < bin.length; i++) bin[i] = gray[i] >= threshold ? 1 : 0

  // Horizontal gutters: rows that are almost entirely white with a
  // long contiguous white run (full width), grouped into bands.
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

  // Vertical gutters: same scan transposed.
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

  if (hBands.length !== 2 || vBands.length !== 2) return null

  const hPos = hBands.map((b) => Math.round((b.start + b.end) / 2))
  const vPos = vBands.map((b) => Math.round((b.start + b.end) / 2))
  // Sanity: the two gutters must actually separate three panels.
  if (Math.abs(hPos[1] - hPos[0]) < 0.2 * h) return null
  if (Math.abs(vPos[1] - vPos[0]) < 0.2 * w) return null
  return { h: hPos, v: vPos }
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

/**
 * Split a 3×3 grid sheet into nine panels.
 *
 * @param image    sheet image path (PNG/JPEG/WEBP)
 * @param outputDir directory for the nine panels + review page
 * @param opts.insetPx  full-res margin cut inside each grid line (default 2)
 * @param opts.workEdge longest edge of the working scan image (default 1024)
 */
export async function splitGridSheet(
  image: string,
  outputDir: string,
  opts: { workEdge?: number; normalizeRatio?: string | null; insetPercent?: number } = {},
): Promise<SplitResult> {
  // Uniform inset: both detection-based and fallback splits inset each side
  // by a percentage of the full sheet dimension (default 2 %).
  const insetPercent = Math.max(0, Math.min(10, Math.round(opts.insetPercent ?? 2)))
  const workEdge = Math.max(256, Math.round(opts.workEdge ?? 1024))
  const warnings: string[] = []
  const ratio = opts.normalizeRatio && String(opts.normalizeRatio).trim().length > 0 ? parseRatio(String(opts.normalizeRatio)) : null
  if (opts.normalizeRatio && String(opts.normalizeRatio).trim().length > 0 && !ratio) {
    return { ok: false, method: 'fallback_even', sheet_path: image, width: 0, height: 0, lines: { horizontal: [], vertical: [] }, normalized_ratio: null, inset_percent: insetPercent, panels: [], review_page: '', warnings: [`无效比例：${opts.normalizeRatio}（应为 W:H，如 16:9 / 9:16 / 21:9）`], message: `invalid normalize_ratio: ${opts.normalizeRatio}` }
  }
  const normalizedRatioLabel = ratio ? `${ratio.w}:${ratio.h}` : null

  const meta = await sharp(image, { failOn: 'none' }).rotate().metadata()
  const fullW = meta.width ?? 0
  const fullH = meta.height ?? 0
  if (fullW === 0 || fullH === 0) return { ok: false, method: 'fallback_even', sheet_path: image, width: 0, height: 0, lines: { horizontal: [], vertical: [] }, normalized_ratio: null, inset_percent: insetPercent, panels: [], review_page: '', warnings: ['cannot read image dimensions'], message: `cannot read image: ${image}` }

  // Scan-and-detect at a given working scale. Thin (1 px) gutter lines get
  // smeared away by aggressive downscaling, so the scan is retried at a
  // higher resolution when nothing is found at the fast default scale.
  const tryDetectAt = async (targetScale: number): Promise<{ gray: Uint8Array; workW: number; workH: number; scale: number; detected: { h: number[]; v: number[] } | null }> => {
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
    let found: { h: number[]; v: number[] } | null = null
    for (const T of THRESHOLDS) {
      const d = detectGridLines(g, ww, wh, T)
      if (d) {
        found = d
        break
      }
    }
    return { gray: g, workW: ww, workH: wh, scale: s, detected: found }
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
  const detected = scan.detected

  let method: 'morphological_lines' | 'fallback_even'
  let hCuts: number[]
  let vCuts: number[]
  let hLinesFull: number[] = []
  let vLinesFull: number[] = []
  // Uniform inset per axis (percent of the full sheet dimension), used by
  // both the detection-based split and the fallback even split.
  const insetW = Math.max(0, Math.round((fullW * insetPercent) / 100))
  const insetH = Math.max(0, Math.round((fullH * insetPercent) / 100))
  if (detected) {
    method = 'morphological_lines'
    const inv = 1 / scale
    hLinesFull = detected.h.map((y) => Math.round(y * inv))
    vLinesFull = detected.v.map((x) => Math.round(x * inv))
    hCuts = [0, hLinesFull[0], hLinesFull[1], fullH]
    vCuts = [0, vLinesFull[0], vLinesFull[1], fullW]
  } else {
    method = 'fallback_even'
    warnings.push(`未检测到清晰的横/纵格线，已启用方案2 等比分割（每侧内缩 ${insetPercent}%，即 ${insetW}px / ${insetH}px）；请核对面板边界`)
    hCuts = [0, Math.round(fullH / 3), Math.round((2 * fullH) / 3), fullH]
    vCuts = [0, Math.round(fullW / 3), Math.round((2 * fullW) / 3), fullW]
  }

  await mkdir(outputDir, { recursive: true })
  const base = basename(image, extname(image)).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'grid'
  const panels: SplitPanel[] = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const id = `r${row + 1}c${col + 1}`
      const x0 = vCuts[col] + insetW
      const x1 = vCuts[col + 1] - insetW
      const y0 = hCuts[row] + insetH
      const y1 = hCuts[row + 1] - insetH
      const box = safeExtract(fullW, fullH, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0))
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
        whiteRatio = regionWhiteRatio(gray, workW, wx0, wy0, wx1, wy1)
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
  const reviewPage = await buildReviewPage(image, panels, method, hLinesFull, vLinesFull, fullW, fullH, warnings, outputDir, base)
  const lines = { horizontal: hLinesFull, vertical: vLinesFull }
  const ratioNote = normalizedRatioLabel ? `，比例已规范为 ${normalizedRatioLabel}` : ''
  const message = `拆格完成（${method}${ratioNote}）：9 张面板 → ${outputDir}；审阅页 → ${reviewPage}`
  return { ok: true, method, sheet_path: image, width: fullW, height: fullH, lines, normalized_ratio: normalizedRatioLabel, inset_percent: insetPercent, panels, review_page: reviewPage, warnings, message }
}

/** Self-contained review page: original thumbnail + 3×3 panel grid, all
 *  images embedded as data URIs so the file opens anywhere. */
async function buildReviewPage(
  sheet: string,
  panels: SplitPanel[],
  method: 'morphological_lines' | 'fallback_even',
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
  const lineInfo = method === 'morphological_lines'
    ? `横格线(px): ${hLines.join(', ')}；纵格线(px): ${vLines.join(', ')}`
    : '等分均分（未检测到格线）'
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
