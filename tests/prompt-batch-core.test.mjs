/**
 * Prompt-batch review-page pure-helper tests. Guards the regressions this
 * domain owned: (BUG-04) a review-page thumbnail must NEVER be referenced by a
 * path — the DSH sidebar HTML preview does not load relative image resources
 * (its static renderer keeps only inline styles and `data:` images, its
 * interactive renderer resolves only relative `.js`/`.css`), so `<img
 * src="../previews/…">` shows as a broken image; a thumbnail is either an
 * embedded data URI or an explicit placeholder. And (BUG-05) a segment with
 * multiple reference images must render every image, not just one primary.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewItems, buildReviewHtml, reviewImageNames } from '../src/shared/prompt-batch-core.ts'

test('buildReviewHtml embeds every reference as a data URI', () => {
  const manifest = {
    batch_id: 'b1', duration: 8, ratio: '16:9', model: 'seedance2.5',
    materials: [{ path: 'D:/m/a.png', hash: 'h', images: ['D:/m/b.png'] }],
    prompts: [{ material: 'D:/m/a.png', prompt: '镜头推进<测试>&' }],
  }
  const items = buildReviewItems(manifest, [
    { material: 'D:/m/a.png', preview: 'D:/priv/batches/b1/previews/a-preview.png' },
    { material: 'D:/m/b.png', preview: 'D:/priv/batches/b1/previews/b-preview.png' },
  ])
  items[0].images[0].dataUri = 'data:image/jpeg;base64,AAA'
  items[0].images[1].dataUri = 'data:image/jpeg;base64,BBB'
  const html = buildReviewHtml(manifest, items)
  assert.ok(html.includes('data:image/jpeg;base64,AAA'), 'primary image embedded')
  assert.ok(html.includes('data:image/jpeg;base64,BBB'), 'extra reference embedded too')
  assert.ok(!html.includes('../previews/'), 'never emits a relative preview path')
  assert.ok(!html.includes('batches/b1/previews/'), 'never emits a repo-root batch preview path')
  assert.ok(html.includes('镜头推进&lt;测试&gt;&amp;'), 'escapes HTML in the prompt cell')
})

test('buildReviewHtml decays to an explicit placeholder, never a broken relative img', () => {
  const manifest = {
    batch_id: 'b2', duration: 8, ratio: '16:9', model: 'seedance2.5',
    materials: [{ path: 'D:/m/a.png', hash: 'h', images: ['D:/m/b.png'] }],
    prompts: [{ material: 'D:/m/a.png', prompt: '绑定图片1 与图片2' }],
  }
  const items = buildReviewItems(manifest, [
    { material: 'D:/m/a.png', preview: 'D:/priv/batches/b2/previews/a-preview.png' },
    { material: 'D:/m/b.png', preview: 'D:/priv/batches/b2/previews/b-preview.png' },
  ])
  // Nothing embedded (embedding failed / preview missing): the page must not
  // fall back to a path the sidebar preview cannot load.
  const html = buildReviewHtml(manifest, items)
  assert.ok(!html.includes('../previews/'), 'no relative preview path')
  assert.ok(!/<img[^>]+src="\.\.\//.test(html), 'no relative img src at all')
  assert.ok(!html.includes('<img src=""'), 'no empty-src img tag')
  assert.ok(html.includes('预览缺失'), 'renders the placeholder text')
  assert.ok(html.includes('rv-miss'), 'placeholder uses the shared miss style hook')
  assert.ok(html.includes('图片1') && html.includes('图片2'), 'slots still labelled')
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
  assert.ok(!html.includes('../previews/'), 'multi-image page still emits no relative preview path')
})

test('buildReviewHtml: an embedded data URI is the only image source (wins over the preview path)', () => {
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
  // second image left without dataUri → placeholder, not a path
  const html = buildReviewHtml(manifest, items)
  assert.ok(html.includes('data:image/jpeg;base64,AAA'), 'embedded image rendered')
  assert.ok(!html.includes('../previews/'), 'no relative preview path once embedded')
  assert.ok(html.includes('预览缺失'), 'the non-embedded image is a placeholder')
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
