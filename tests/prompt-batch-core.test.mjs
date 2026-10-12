/**
 * Prompt-batch review-page pure-helper tests. Guards the two regressions this
 * domain owned: (BUG-04) review page preview `src` must be `../previews/<basename>`
 * (not a repo-root path), and (BUG-05) a segment with multiple reference images
 * must render every image, not just one primary.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { previewSrc, buildReviewItems, buildReviewHtml, reviewImageNames } from '../src/shared/prompt-batch-core.ts'

test('previewSrc maps an absolute preview path to ../previews/<basename>', () => {
  assert.equal(previewSrc('D:\\priv\\batches\\20260826-1000-batch\\previews\\input-01-preview.png'), '../previews/input-01-preview.png')
  assert.equal(previewSrc('/mnt/batches/batch/previews/a.png'), '../previews/a.png')
  assert.equal(previewSrc(''), '')
  assert.equal(previewSrc(undefined), '')
})

test('buildReviewHtml emits ../previews/ (never a repo-root batch path) and escapes prompt text', () => {
  const manifest = { batch_id: 'b1', duration: 8, ratio: '16:9', model: 'seedance2.5', materials: [{ path: 'D:/m/a.png', hash: 'h' }], prompts: [{ material: 'D:/m/a.png', prompt: '镜头推进<测试>&' }] }
  const items = buildReviewItems(manifest, [{ material: 'D:/m/a.png', preview: 'D:/priv/batches/b1/previews/a-preview.png' }])
  const html = buildReviewHtml(manifest, items)
  assert.ok(html.includes('../previews/a-preview.png'), 'uses relative ../previews path')
  assert.ok(!html.includes('batches/b1/previews/'), 'never emits a repo-root batch preview path')
  assert.ok(html.includes('镜头推进&lt;测试&gt;&amp;'), 'escapes HTML in the prompt cell')
})

test('buildReviewItems: single-image material yields one image entry (backward compatible)', () => {
  const manifest = { batch_id: 'b', duration: 5, ratio: '16:9', model: 'seedance2.5', materials: [{ path: 'D:/a.png', hash: 'h' }], prompts: [] }
  const items = buildReviewItems(manifest, [{ material: 'D:/a.png', preview: 'D:/p/a-preview.png' }])
  assert.equal(items.length, 1)
  assert.equal(items[0].images.length, 1)
  assert.equal(items[0].preview, 'D:/p/a-preview.png')
  assert.equal(items[0].images[0].preview, 'D:/p/a-preview.png')
})

test('buildReviewItems: multi-image material renders primary + extras in --image order', () => {
  const manifest = {
    batch_id: 'b', duration: 5, ratio: '16:9', model: 'seedance2.5',
    materials: [{ path: 'D:/a.png', hash: 'h', images: ['D:/b.png', 'D:/c.png'] }],
    prompts: [{ material: 'D:/a.png', prompt: '绑定图片1 与图片2 与图片3' }],
  }
  const previews = [
    { material: 'D:/a.png', preview: 'D:/p/a-preview.png' },
    { material: 'D:/b.png', preview: 'D:/p/b-preview.png' },
    { material: 'D:/c.png', preview: 'D:/p/c-preview.png' },
  ]
  const items = buildReviewItems(manifest, previews)
  assert.equal(items[0].images.length, 3)
  assert.deepEqual(items[0].images.map((i) => i.preview), ['D:/p/a-preview.png', 'D:/p/b-preview.png', 'D:/p/c-preview.png'])
  const html = buildReviewHtml(manifest, items)
  assert.ok(html.includes('图片1'))
  assert.ok(html.includes('图片2'))
  assert.ok(html.includes('图片3'))
  assert.ok(html.includes('../previews/b-preview.png'))
})

test('buildReviewHtml: an embedded data URI wins over the relative preview path', () => {
  const manifest = {
    batch_id: 'b', duration: 5, ratio: '16:9', model: 'seedance2.5',
    materials: [{ path: 'D:/a.png', hash: 'h', images: ['D:/b.png'] }],
    prompts: [{ material: 'D:/a.png', prompt: '绑定图片1 与图片2' }],
  }
  const items = buildReviewItems(manifest, [
    { material: 'D:/a.png', preview: 'D:/p/a-preview.png' },
    { material: 'D:/b.png', preview: 'D:/p/b-preview.png' },
  ])
  items[0].images[0].dataUri = 'data:image/jpeg;base64,AAA'
  items[0].images[1].dataUri = 'data:image/jpeg;base64,BBB'
  const html = buildReviewHtml(manifest, items)
  assert.ok(html.includes('data:image/jpeg;base64,AAA'), 'primary image embedded')
  assert.ok(html.includes('data:image/jpeg;base64,BBB'), 'extra reference embedded too')
  assert.ok(!html.includes('../previews/'), 'no external preview paths once every image is embedded')
})

test('buildReviewHtml: a bound reference without a preview renders "—" (never a broken img)', () => {
  const manifest = {
    batch_id: 'b', duration: 5, ratio: '16:9', model: 'seedance2.5',
    materials: [{ path: 'D:/a.png', hash: 'h', images: ['D:/b.png'] }],
    prompts: [{ material: 'D:/a.png', prompt: '绑定图片1 与图片2' }],
  }
  const items = buildReviewItems(manifest, [{ material: 'D:/a.png', preview: 'D:/p/a-preview.png' }])
  const html = buildReviewHtml(manifest, items)
  assert.equal(items[0].images[1].preview, '')
  assert.ok(html.includes('图片2'))
  assert.ok(!html.includes('<img src=""'), 'no empty-src img tag')
})

test('buildReviewHtml: each reference image is pickable and carries its file name', () => {
  const manifest = {
    batch_id: 'b', duration: 5, ratio: '16:9', model: 'seedance2.5',
    materials: [{ path: 'D:/m/shot-a.png', hash: 'h', images: ['D:/m/shot-b.png'] }],
    prompts: [{ material: 'D:/m/shot-a.png', prompt: '绑定图片1 与图片2' }],
  }
  const items = buildReviewItems(manifest, [
    { material: 'D:/m/shot-a.png', preview: 'D:/p/a-preview.png' },
    { material: 'D:/m/shot-b.png', preview: 'D:/p/b-preview.png' },
  ])
  const html = buildReviewHtml(manifest, items)
  assert.ok(html.includes('data-rv-name="shot-a.png"'), 'primary image is pickable by file name')
  assert.ok(html.includes('data-rv-name="shot-b.png"'), 'extra reference is pickable too')
  assert.ok(html.includes('data-rv-act="copy-name"'), 'the copy bar is rendered')
  assert.ok(html.includes('data-rv-path="D:/m/shot-b.png"'), 'the absolute path is the copy-path payload')
})

test('reviewImageNames disambiguates equal file names from different folders', () => {
  assert.deepEqual(reviewImageNames(['D:/a/x.png', 'D:/b/y.png']), ['x.png', 'y.png'])
  assert.deepEqual(reviewImageNames(['D:/a/x.png', 'D:/b/x.png']), ['a/x.png', 'b/x.png'])
  assert.deepEqual(reviewImageNames(['D:\\a\\x.png', 'D:\\b\\x.png']), ['a/x.png', 'b/x.png'])
  assert.deepEqual(reviewImageNames([]), [])
})
