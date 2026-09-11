import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { splitGridSheet, splitGridSheets, parseRatio, normalizeCrop } from '../src/shared/grid-split-core.ts'

/** Solid-colour PNG buffer helper used to compose synthetic grid sheets. */
const solid = (w, h, color) =>
  sharp({ create: { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), channels: 3, background: color } })
    .png()
    .toBuffer()

/**
 * Compose a synthetic 3×3 sheet: nine panels of increasing luminance, gutter
 * lines at the requested rows/cols, plus optional extra overlays (used to
 * simulate bright *content* bands that must not be mistaken for gutters).
 */
async function makeSheet({
  w = 900,
  h = 600,
  rows = [200, 400],
  cols = [300, 600],
  lineColor = { r: 255, g: 255, b: 255 },
  lineWidth = 6,
  extras = [],
} = {}) {
  const overlays = []
  const xs = [0, ...cols, w]
  const ys = [0, ...rows, h]
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const lum = 40 + (r * 3 + c) * 12
      overlays.push({ input: await solid(xs[c + 1] - xs[c], ys[r + 1] - ys[r], { r: lum, g: lum, b: lum }), left: xs[c], top: ys[r] })
    }
  }
  for (const e of extras) overlays.push({ input: await solid(e.w, e.h, e.color), left: e.left, top: e.top })
  const half = Math.floor(lineWidth / 2)
  for (const y of rows) overlays.push({ input: await solid(w, lineWidth, lineColor), left: 0, top: y - half })
  for (const x of cols) overlays.push({ input: await solid(lineWidth, h, lineColor), left: x - half, top: 0 })
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite(overlays).png().toBuffer()
}

/** Mean luminance of one pixel row of a saved panel (regression check for
 *  gutter pixels leaking into a crop). */
async function rowMean(path, rowIndex) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true })
  const ch = info.channels
  const y = rowIndex < 0 ? info.height + rowIndex : rowIndex
  let sum = 0
  for (let x = 0; x < info.width; x++) sum += data[(y * info.width + x) * ch]
  return sum / info.width
}

function tmpRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grid-split-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('ratio helpers keep their contract', () => {
  assert.deepEqual(parseRatio('16:9'), { w: 16, h: 9 })
  assert.equal(parseRatio('16x9'), null)
  const warnings = []
  const box = normalizeCrop(1000, 1000, { w: 16, h: 9 }, warnings, 'r1c1')
  assert.equal(box.height, 563, 'landscape keeps width and crops height')
  assert.equal(warnings.length, 0)
})

test('crisp white gutters are detected morphologically at their true position', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  await sharp(await makeSheet()).toFile(sheet)
  const r = await splitGridSheet(sheet, join(dir, 'out'), { reviewPage: false })
  assert.equal(r.ok, true)
  assert.equal(r.method, 'morphological_lines')
  assert.equal(r.panels.length, 9)
  assert.deepEqual(r.lines.horizontal, [200, 400])
  assert.deepEqual(r.lines.vertical, [300, 600])
})

test('uneven row heights are detected instead of being evenly thirds-split', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  await sharp(await makeSheet({ rows: [180, 460], cols: [250, 650] })).toFile(sheet)
  const r = await splitGridSheet(sheet, join(dir, 'out'), { reviewPage: false })
  assert.equal(r.ok, true)
  assert.deepEqual(r.lines.horizontal, [180, 460], 'must not fall back to 200/400')
  assert.deepEqual(r.lines.vertical, [250, 650])
})

test('soft light-grey gutters are found by the luminance-profile detector', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  // 170 < the loosest morphological threshold (200): the old code fell back
  // to an even split here and clipped gutter pixels into the panels.
  await sharp(await makeSheet({ lineColor: { r: 170, g: 170, b: 170 } })).toFile(sheet)
  const r = await splitGridSheet(sheet, join(dir, 'out'), { reviewPage: false })
  assert.equal(r.ok, true)
  assert.equal(r.method, 'profile_peaks')
  assert.deepEqual(r.lines.horizontal, [200, 400])
  assert.deepEqual(r.lines.vertical, [300, 600])
})

test('a bright content band does not steal the gutter pick', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  // A near-white band at y=130..170 sits inside the search window for the
  // first gutter (200 ± 84) and is brighter than the gutter itself.
  await sharp(await makeSheet({
    lineColor: { r: 170, g: 170, b: 170 },
    extras: [{ w: 900, h: 40, color: { r: 245, g: 245, b: 245 }, left: 0, top: 130 }],
  })).toFile(sheet)
  const r = await splitGridSheet(sheet, join(dir, 'out'), { reviewPage: false })
  assert.equal(r.ok, true)
  assert.deepEqual(r.lines.horizontal, [200, 400], 'must lock onto the nearest real gutter, not the brighter content band')
})

test('no gutter pixel leaks into a panel (regression for the white stripe)', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  await sharp(await makeSheet({ rows: [180, 460], cols: [250, 650], lineColor: { r: 200, g: 200, b: 200 } })).toFile(sheet)
  const out = join(dir, 'out')
  const r = await splitGridSheet(sheet, out, { reviewPage: false })
  assert.equal(r.ok, true)
  const p = r.panels.find((x) => x.id === 'r1c1')
  // Rows 0..179 hold panel 1; the gutter starts at 177 (180 - half width).
  const bottom = await rowMean(p.path, -1)
  const top = await rowMean(p.path, 0)
  assert.ok(bottom < 120, `panel bottom row mean ${bottom.toFixed(0)} still looks like a gutter`)
  assert.ok(top < 120, `panel top row mean ${top.toFixed(0)} still looks like a gutter`)
})

test('a sheet with no detectable gutter falls back to an even split', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  const gradient = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 70, g: 70, b: 70 } } }).png().toBuffer()
  await sharp(gradient).toFile(sheet)
  const r = await splitGridSheet(sheet, join(dir, 'out'), { reviewPage: false })
  assert.equal(r.ok, true)
  assert.equal(r.method, 'fallback_even')
  assert.equal(r.panels.length, 9)
  assert.ok(r.warnings.some((w) => w.includes('等比分割')))
})

test('batched groups write every panel flat into one folder per group', async (t) => {
  const dir = tmpRoot(t)
  const a = join(dir, 'a.png')
  const b = join(dir, 'b.png')
  const c = join(dir, 'c.png')
  const buf = await makeSheet()
  await sharp(buf).toFile(a)
  await sharp(buf).toFile(b)
  await sharp(buf).toFile(c)
  const outRoot = join(dir, 'shots')
  const r = await splitGridSheets(
    [
      { group: '场景1-盲盒开场', images: [a, b] },
      { group: '场景2-金席入席', images: [c] },
    ],
    outRoot,
    {},
  )
  assert.equal(r.ok, true)
  assert.equal(r.group_count, 2)
  assert.equal(r.image_count, 3)
  assert.equal(r.panel_count, 27)
  assert.equal(r.failed, 0)

  const g1 = join(outRoot, '场景1-盲盒开场')
  assert.ok(existsSync(g1))
  const entries = readdirSync(g1)
  assert.equal(entries.filter((f) => f.endsWith('.png')).length, 18, 'two sheets × nine panels')
  assert.equal(entries.filter((f) => statSync(join(g1, f)).isDirectory()).length, 0, 'panels must be flat, no nested folders')
  assert.equal(readdirSync(join(outRoot, '场景2-金席入席')).filter((f) => f.endsWith('.png')).length, 9)
})

test('normalize_ratio center-crops every panel to the requested ratio', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  await sharp(await makeSheet()).toFile(sheet)
  const r = await splitGridSheet(sheet, join(dir, 'out'), { reviewPage: false, normalizeRatio: '16:9' })
  assert.equal(r.ok, true)
  for (const p of r.panels) {
    const ratio = p.width / p.height
    assert.ok(Math.abs(ratio - 16 / 9) < 0.02, `${p.id} ratio ${ratio.toFixed(3)} should be 16:9`)
  }
})
