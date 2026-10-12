/**
 * Multi-panel sheet detection tests (`grid-detect`). A review page may only be
 * allowed to shred an image when the geometry is unambiguous, so these tests
 * pin both directions: real 2×2/3×3/2×3 sheets are recognized and cut exactly,
 * and ordinary images (step edges, bright bands, single-axis lines) are refused.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { detectGridLayout, splitGridPanels, rowsColsLabel, parseGridSpec } from '../src/shared/grid-detect.ts'

/** One textured tile (a flat colour would be rejected as a blank panel). */
async function tile(w, h, base, ink) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<rect width="100%" height="100%" fill="${base}"/>
<circle cx="${Math.round(w * 0.3)}" cy="${Math.round(h * 0.4)}" r="${Math.round(Math.min(w, h) * 0.18)}" fill="${ink}"/>
<rect x="${Math.round(w * 0.6)}" y="${Math.round(h * 0.55)}" width="${Math.round(w * 0.25)}" height="${Math.round(h * 0.3)}" fill="${ink}"/>
</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** Compose a rows×cols sheet with crisp gutters at the exact fractions. */
async function makeSheet({ w = 1200, h = 900, rows = 2, cols = 2, lineColor = '#ffffff', lineWidth = 8 } = {}) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
  const overlays = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x0 = Math.round((c * w) / cols)
      const x1 = Math.round(((c + 1) * w) / cols)
      const y0 = Math.round((r * h) / rows)
      const y1 = Math.round(((r + 1) * h) / rows)
      const i = r * cols + c
      const base = `rgb(${clamp(50 + i * 12)},${clamp(70 + i * 9)},${clamp(150 - i * 7)})`
      const ink = `rgb(${clamp(225 - i * 11)},${clamp(85 + i * 9)},${clamp(55 + i * 13)})`
      overlays.push({ input: await tile(x1 - x0, y1 - y0, base, ink), left: x0, top: y0 })
    }
  }
  const half = Math.floor(lineWidth / 2)
  for (let r = 1; r < rows; r += 1) overlays.push({ input: await sharp({ create: { width: w, height: lineWidth, channels: 3, background: lineColor } }).png().toBuffer(), left: 0, top: Math.round((r * h) / rows) - half })
  for (let c = 1; c < cols; c += 1) overlays.push({ input: await sharp({ create: { width: lineWidth, height: h, channels: 3, background: lineColor } }).png().toBuffer(), left: Math.round((c * w) / cols) - half, top: 0 })
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite(overlays).png().toBuffer()
}

function tmpRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grid-detect-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a 2×2 sheet is detected as 四宫格 with cuts on the gutter outsides', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  await sharp(await makeSheet({ rows: 2, cols: 2 })).toFile(sheet)

  const grid = await detectGridLayout(sheet, { minPanels: 4 })
  assert.ok(grid, 'a 2×2 sheet must be detected')
  assert.equal(grid.rows, 2)
  assert.equal(grid.cols, 2)
  assert.equal(grid.rowRanges.length, 2)
  assert.equal(grid.colRanges.length, 2)
  // Gutter centre is at the halfway mark; cuts sit outside the 8 px band.
  assert.ok(Math.abs(grid.horizontal[0] - 450) <= 2, `gutter near 450, got ${grid.horizontal[0]}`)
  assert.ok(Math.abs(grid.vertical[0] - 600) <= 2, `gutter near 600, got ${grid.vertical[0]}`)
})

test('a 3×3 sheet is detected as 九宫格 and never as 4×4 / 2×2', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  await sharp(await makeSheet({ w: 1440, h: 1440, rows: 3, cols: 3 })).toFile(sheet)

  const grid = await detectGridLayout(sheet, { minPanels: 4 })
  assert.ok(grid, 'a 3×3 sheet must be detected')
  assert.equal(grid.rows, 3)
  assert.equal(grid.cols, 3)
  assert.deepEqual(grid.horizontal.length, 2)
})

test('a 2×3 (六宫格) sheet wins over the 2×2 subset', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  await sharp(await makeSheet({ w: 1800, h: 1200, rows: 2, cols: 3 })).toFile(sheet)

  const grid = await detectGridLayout(sheet, { minPanels: 4 })
  assert.ok(grid, 'a 2×3 sheet must be detected')
  assert.equal(grid.rows, 2)
  assert.equal(grid.cols, 3, 'the vertical 1/2 line must not be mistaken for a 2×2 layout')
})

test('a 4×4 sheet prefers 16 panels over the 2×2 subset', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  await sharp(await makeSheet({ w: 1600, h: 1600, rows: 4, cols: 4 })).toFile(sheet)

  const grid = await detectGridLayout(sheet, { minPanels: 4 })
  assert.ok(grid, 'a 4×4 sheet must be detected')
  assert.equal(grid.rows * grid.cols, 16, 'a genuine 16-panel sheet must not be cut into 4 tiles')
})

test('a dark-seam sheet is detected through the dark polarity', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  await sharp(await makeSheet({ w: 1200, h: 1200, rows: 2, cols: 2, lineColor: '#000000', lineWidth: 10 })).toFile(sheet)

  const grid = await detectGridLayout(sheet, { minPanels: 4 })
  assert.ok(grid, 'black gutters must be found too')
  assert.equal(grid.rows, 2)
  assert.equal(grid.cols, 2)
  assert.equal(grid.polarity.rows, 'dark')
})

test('an ordinary photo is never shredded into panels', async (t) => {
  const dir = tmpRoot(t)
  const photo = join(dir, 'photo.png')
  // Bright upper half / dark lower half: a step edge, not a thin gutter. The
  // band-width test has to reject it.
  const sky = await sharp({ create: { width: 1200, height: 450, channels: 3, background: { r: 235, g: 240, b: 250 } } }).png().toBuffer()
  const ground = await sharp({ create: { width: 1200, height: 450, channels: 3, background: { r: 55, g: 60, b: 45 } } }).png().toBuffer()
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: sky, left: 0, top: 0 }, { input: ground, left: 0, top: 450 }])
    .png()
    .toFile(photo)

  assert.equal(await detectGridLayout(photo, { minPanels: 4 }), null, 'a horizon is not a sheet')
})

test('a single-axis line set is refused (no 3×1 / 1×3 layout below four panels)', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  const rowA = await tile(1200, 300, 'rgb(70,110,150)', 'rgb(200,80,90)')
  const rowB = await tile(1200, 300, 'rgb(120,160,90)', 'rgb(40,60,180)')
  const rowC = await tile(1200, 300, 'rgb(180,140,60)', 'rgb(60,200,140)')
  const line = await sharp({ create: { width: 1200, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer()
  await sharp({ create: { width: 1200, height: 916, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: rowA, left: 0, top: 0 },
      { input: line, left: 0, top: 296 },
      { input: rowB, left: 0, top: 304 },
      { input: line, left: 0, top: 600 },
      { input: rowC, left: 0, top: 608 },
    ])
    .png()
    .toFile(sheet)

  assert.equal(await detectGridLayout(sheet, { minPanels: 4 }), null)
})

test('splitGridPanels writes every panel as a real named file', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'G1-02.png')
  await sharp(await makeSheet({ rows: 2, cols: 2 })).toFile(sheet)
  const out = join(dir, 'panels')

  const result = await splitGridPanels(sheet, out, { minPanels: 4 })
  assert.ok(result, 'the sheet must split')
  assert.equal(result.panels.length, 4)
  assert.equal(readdirSync(out).filter((f) => f.endsWith('.png')).length, 4)
  for (const panel of result.panels) {
    assert.ok(existsSync(panel.path))
    assert.match(panel.path, /G1-02-r\d+c\d+\.png$/)
    // Cuts are on the outside of the gutter: each panel stays a quarter of the sheet.
    const meta = await sharp(panel.path).metadata()
    assert.ok(Math.abs(meta.width - 600) <= 8, `panel width ~600, got ${meta.width}`)
    assert.ok(Math.abs(meta.height - 450) <= 8, `panel height ~450, got ${meta.height}`)
  }
  assert.equal(result.message.includes('2×2'), true)
})

test('a thumbnail or unreadable file is skipped without throwing', async (t) => {
  const dir = tmpRoot(t)
  const tiny = join(dir, 'tiny.png')
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toFile(tiny)
  assert.equal(await splitGridPanels(tiny, join(dir, 'o1'), { minPanels: 4 }), null)
  assert.equal(await splitGridPanels(join(dir, 'missing.png'), join(dir, 'o2'), { minPanels: 4 }), null)
})

test('a borderless sheet is left alone unless the layout is declared', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'flat.png')
  // Four textured tiles butted together with NO gutter: the detector must not
  // guess, while a declared 2x2 still splits it evenly.
  const tiles = [
    await tile(600, 600, 'rgb(200,60,60)', 'rgb(20,20,90)'),
    await tile(600, 600, 'rgb(60,180,90)', 'rgb(120,30,200)'),
    await tile(600, 600, 'rgb(70,90,200)', 'rgb(240,180,40)'),
    await tile(600, 600, 'rgb(210,190,60)', 'rgb(30,120,150)'),
  ]
  await sharp({ create: { width: 1200, height: 1200, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: tiles[0], left: 0, top: 0 },
      { input: tiles[1], left: 600, top: 0 },
      { input: tiles[2], left: 0, top: 600 },
      { input: tiles[3], left: 600, top: 600 },
    ])
    .png()
    .toFile(sheet)

  assert.equal(await splitGridPanels(sheet, join(dir, 'auto'), { minPanels: 4 }), null, 'no gutter, no guessing')

  const declared = await splitGridPanels(sheet, join(dir, 'declared'), { layout: { rows: 2, cols: 2 } })
  assert.ok(declared, 'a declared layout still splits a borderless sheet')
  assert.equal(declared.grid.method, 'declared_even')
  assert.equal(declared.panels.length, 4)
  assert.ok(declared.warnings.some((w) => w.includes('等比分割')), 'the fallback is reported')
  for (const panel of declared.panels) {
    const meta = await sharp(panel.path).metadata()
    assert.ok(Math.abs(meta.width - 600) <= 4 && Math.abs(meta.height - 600) <= 4, `${panel.id} is a quarter tile`)
  }
})

test('a declared layout reuses the detected geometry when the detector agrees', async (t) => {
  const dir = tmpRoot(t)
  const sheet = join(dir, 'sheet.png')
  await sharp(await makeSheet({ rows: 2, cols: 2 })).toFile(sheet)

  const result = await splitGridPanels(sheet, join(dir, 'out'), { layout: { rows: 2, cols: 2 } })
  assert.ok(result)
  assert.equal(result.grid.method, 'gutter_profile', 'the real gutter geometry wins over the even fallback')
  assert.equal(result.warnings.length, 0)
  assert.equal(result.panels.length, 4)
})

test('parseGridSpec accepts the documented spellings and refuses everything else', () => {
  assert.deepEqual(parseGridSpec('3x3'), { rows: 3, cols: 3 })
  assert.deepEqual(parseGridSpec(' 2×2 '), { rows: 2, cols: 2 })
  assert.deepEqual(parseGridSpec('2*3'), { rows: 2, cols: 3 })
  assert.deepEqual(parseGridSpec('1:2'), { rows: 1, cols: 2 })
  assert.equal(parseGridSpec('1x1'), null)
  assert.equal(parseGridSpec('5x5'), null)
  assert.equal(parseGridSpec('3x'), null)
  assert.equal(parseGridSpec('banana'), null)
  assert.equal(parseGridSpec(undefined), null)
})

test('layout labels name the common grids', () => {
  assert.equal(rowsColsLabel(2, 2), '2×2 四宫格')
  assert.equal(rowsColsLabel(3, 3), '3×3 九宫格')
  assert.equal(rowsColsLabel(2, 3), '2×3 六宫格')
  assert.equal(rowsColsLabel(2, 5), '2×5 10 分格')
})
