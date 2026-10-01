import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { buildContactSheetHtml, computeDeadline } from '../src/shared/batch-core.ts'

// The batch review page is a fixed post-settle output of batch_image. Its
// contract: every image is embedded (a file:// or relative src renders as a
// broken image in sandboxed viewers), the layout is responsive, labels are
// escaped, and never-landed slots are shown explicitly.

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
