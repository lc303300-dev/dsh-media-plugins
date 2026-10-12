import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { buildContactSheetHtml, computeDeadline } from '../src/shared/batch-core.ts'
import { writeReviewPage } from '../src/tool-batch-image.ts'

// The batch review page is a fixed post-settle output of batch_image. Its
// contract: every image is embedded (a file:// or relative src renders as a
// broken image in sandboxed viewers), the layout is responsive, labels are
// escaped, and never-landed slots are shown explicitly.

/** One textured tile, so a synthetic sheet is not a flat colour. */
async function tile(w, h, base, ink) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<rect width="100%" height="100%" fill="${base}"/>
<circle cx="${Math.round(w * 0.35)}" cy="${Math.round(h * 0.4)}" r="${Math.round(Math.min(w, h) * 0.16)}" fill="${ink}"/>
</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** A crisp 3×3 sheet (white gutters) used as a review-page candidate. */
async function make3x3Sheet(path) {
  const w = 1440
  const h = 1440
  const overlays = []
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      const i = r * 3 + c
      overlays.push({
        input: await tile(w / 3, h / 3, `rgb(${40 + i * 14},${70 + i * 9},${150 - i * 8})`, `rgb(${220 - i * 10},${80 + i * 8},${60 + i * 12})`),
        left: (c * w) / 3,
        top: (r * h) / 3,
      })
    }
  }
  for (const at of [480, 960]) {
    overlays.push({ input: await sharp({ create: { width: w, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer(), left: 0, top: at - 4 })
    overlays.push({ input: await sharp({ create: { width: 8, height: h, channels: 3, background: '#ffffff' } }).png().toBuffer(), left: at - 4, top: 0 })
  }
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite(overlays).png().toFile(path)
}

test('batch review page: images embedded as data URIs (no external src)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-'))
  try {
    const img = join(dir, 'a.png')
    await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: 200, g: 120, b: 60 } } })
      .png()
      .toFile(img)

    const groups = [{ id: 'G1', candidates: 2, image_ratio: '16:9' }]
    const plan = computeDeadline({ groups: [{ id: 'G1', prompt: 'p', candidates: 2, image_ratio: '16:9' }] }, 0)
    const html = await buildContactSheetHtml(plan, groups, [{ groupId: 'G1', slot: 1, path: img }])

    assert.match(html, /data:image\/jpeg;base64,[A-Za-z0-9+/=]+/, 'landed image must be embedded as a data URI')
    assert.doesNotMatch(html, /<img src="(?!data:)/, 'no external/relative img src may survive')
    assert.match(html, /auto-fit/, 'layout must be responsive')
    assert.match(html, /#1 ✓/, 'landed slot is marked')
    assert.match(html, /∅ 未落地/, 'never-landed slot is shown explicitly')
    assert.match(html, /landed 1/, 'summary reports landed count')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('batch review page: reference/original image is never rendered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-ref-'))
  try {
    const produced = join(dir, 'produced.png')
    const reference = join(dir, 'reference.png')
    for (const p of [produced, reference]) {
      await sharp({ create: { width: 32, height: 18, channels: 3, background: { r: 10, g: 90, b: 160 } } })
        .png()
        .toFile(p)
    }

    const groups = [{ id: 'G1', candidates: 1, image_ratio: '16:9', original_image: reference }]
    const plan = computeDeadline({ groups: [{ id: 'G1', prompt: 'p', candidates: 1, image_ratio: '16:9' }] }, 0)
    const html = await buildContactSheetHtml(plan, groups, [{ groupId: 'G1', slot: 1, path: produced }])

    assert.doesNotMatch(html, /原始／参考图/, 'reference image label must not appear')
    const embedded = html.match(/data:image\/jpeg;base64,/g) ?? []
    assert.equal(embedded.length, 1, 'exactly one image (the produced one) may be embedded')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('batch review page: group labels are HTML-escaped', async () => {
  const groups = [{ id: 'G<1>&"x"', candidates: 1, image_ratio: '16:9' }]
  const plan = computeDeadline({ groups: [{ id: 'G<1>&"x"', prompt: 'p', candidates: 1, image_ratio: '16:9' }] }, 0)
  const html = await buildContactSheetHtml(plan, groups, [])

  assert.match(html, /G&lt;1&gt;&amp;&quot;x&quot;/)
  assert.doesNotMatch(html, /<h2>G<1>/)
})

test('batch review page: unreadable image path degrades to a placeholder', async () => {
  const groups = [{ id: 'G1', candidates: 1, image_ratio: '16:9' }]
  const plan = computeDeadline({ groups: [{ id: 'G1', prompt: 'p', candidates: 1, image_ratio: '16:9' }] }, 0)
  const html = await buildContactSheetHtml(plan, groups, [
    { groupId: 'G1', slot: 1, path: join(tmpdir(), 'definitely-missing-image-xyz.png') },
  ])

  assert.match(html, /class="miss"/)
  assert.match(html, /无法读取/)
  assert.match(html, /#1 ✓/, 'the slot still reports that a file was produced')
})

// --- picking widget -------------------------------------------------------

test('batch review page: every image is pickable and the names can be copied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-pick-'))
  try {
    const img = join(dir, 'G1-01.png')
    await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toFile(img)
    const groups = [{ id: 'G1', candidates: 1, image_ratio: '16:9' }]
    const plan = computeDeadline({ groups: [{ id: 'G1', prompt: 'p', candidates: 1, image_ratio: '16:9' }] }, 0)
    const html = await buildContactSheetHtml(plan, groups, [{ groupId: 'G1', slot: 1, path: img }])

    assert.match(html, /<input type="checkbox" data-rv-name="G1-01\.png"/, 'each image carries a named checkbox')
    assert.match(html, /data-rv-act="copy-name"/, 'the bar offers copy-name')
    assert.match(html, /data-rv-act="copy-path"/, 'the bar offers copy-path')
    assert.match(html, /data-rv-bar/, 'the sticky picking bar is rendered')
    assert.match(html, /navigator\.clipboard/, 'the copy script is inlined')
    assert.match(html, /data-rv-fallback/, 'a clipboard fallback textarea exists')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('batch review page: split panels are listed as individual pickable entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-panels-'))
  try {
    const sheet = join(dir, 'G1-01.png')
    const p1 = join(dir, 'G1-01-r1c1.png')
    const p2 = join(dir, 'G1-01-r1c2.png')
    for (const p of [sheet, p1, p2]) {
      await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toFile(p)
    }
    const groups = [{ id: 'G1', candidates: 1, image_ratio: '1:1' }]
    const plan = computeDeadline({ groups: [{ id: 'G1', prompt: 'p', candidates: 1, image_ratio: '1:1' }] }, 0)
    const html = await buildContactSheetHtml(plan, groups, [
      { groupId: 'G1', slot: 1, path: sheet, grid: { rows: 1, cols: 2 }, panels: [{ id: 'r1c1', path: p1 }, { id: 'r1c2', path: p2 }] },
    ])

    assert.match(html, /data-rv-name="G1-01-r1c1\.png"/, 'panel 1 is pickable by its own file name')
    assert.match(html, /data-rv-name="G1-01-r1c2\.png"/, 'panel 2 is pickable by its own file name')
    assert.doesNotMatch(html, /data-rv-name="G1-01\.png"/, 'the pre-split sheet is not listed again')
    assert.doesNotMatch(html, /整张母图/, 'no "whole sheet" pick either')
    assert.match(html, /class="rv-panels"/, 'panels render in their own sub-grid')
    assert.match(html, /1×2 双联/, 'the detected layout is named')
    const embedded = html.match(/data:image\/jpeg;base64,/g) ?? []
    assert.equal(embedded.length, 2, 'only the panels are embedded — never the sheet that was split')
    assert.doesNotMatch(html, /<img src="(?!data:)/, 'panels are embedded too, never an external src')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- end to end: a landed 九宫格 candidate is split before the page is built --

test('writeReviewPage cuts a landed 3×3 sheet and lists the nine panels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-grid-'))
  try {
    const jobKey = 'gridjob1'
    const sheet = join(dir, 'G1-01.png')
    await make3x3Sheet(sheet)

    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE tasks (job_key TEXT, group_id TEXT, slot INTEGER, status TEXT, output_path TEXT)')
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)').run(jobKey, 'G1', 1, 'success', sheet)

    const manifest = { groups: [{ id: 'G1', prompt: 'p', candidates: 1, image_ratio: '1:1' }] }
    const review = await writeReviewPage(db, jobKey, manifest, dir, 'out', dir)
    db.close()

    assert.equal(review.sheets, 1, 'the 3×3 sheet is recognized')
    assert.equal(review.panels, 9)
    const html = await (await import('node:fs/promises')).readFile(review.path, 'utf8')
    assert.match(html, /data-rv-name="G1-01-r1c1\.png"/)
    assert.match(html, /data-rv-name="G1-01-r3c3\.png"/)
    assert.doesNotMatch(html, /data-rv-name="G1-01\.png"/, 'the split 九宫格 itself must not be rendered again')
    assert.equal((html.match(/data:image\/jpeg;base64,/g) ?? []).length, 9, 'exactly the nine panels are embedded')
    assert.match(html, /九宫格/, 'the note names the detected layout')
    assert.match(html, /data-rv-act="copy-name"/)
    const panels = await (await import('node:fs/promises')).readdir(join(dir, 'out', jobKey, '_panels'))
    assert.equal(panels.filter((f) => f.endsWith('.png')).length, 9, 'nine panel files are written to disk')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeReviewPage honors a manifest-declared grid even without a gutter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-declared-'))
  try {
    const jobKey = 'gridjob2'
    const sheet = join(dir, 'G1-01.png')
    // Four butted tiles, no gutter: only the manifest declaration can split this.
    const tiles = []
    for (let i = 0; i < 4; i += 1) {
      tiles.push(await tile(400, 400, `rgb(${60 + i * 40},${90 - i * 15},${160 - i * 25})`, `rgb(${230 - i * 40},${80 + i * 30},${50 + i * 40})`))
    }
    await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite([
        { input: tiles[0], left: 0, top: 0 },
        { input: tiles[1], left: 400, top: 0 },
        { input: tiles[2], left: 0, top: 400 },
        { input: tiles[3], left: 400, top: 400 },
      ])
      .png()
      .toFile(sheet)

    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE tasks (job_key TEXT, group_id TEXT, slot INTEGER, status TEXT, output_path TEXT)')
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)').run(jobKey, 'G1', 1, 'success', sheet)

    const manifest = { groups: [{ id: 'G1', prompt: 'p', candidates: 1, image_ratio: '1:1', grid: '2x2' }] }
    const review = await writeReviewPage(db, jobKey, manifest, dir, 'out', dir)
    db.close()

    assert.equal(review.sheets, 1, 'the declaration splits a borderless sheet')
    assert.equal(review.panels, 4)
    const html = await (await import('node:fs/promises')).readFile(review.path, 'utf8')
    assert.match(html, /data-rv-name="G1-01-r2c2\.png"/)
    assert.match(html, /等比分割/, 'the even fallback is spelled out in the note')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
