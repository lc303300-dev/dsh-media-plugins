/**
 * DT review-page pure-helper tests. Guards the two regressions this domain
 * owned: (BUG-04) review page preview `src` must be `../previews/<basename>`
 * (not a repo-root `dt/<batch>/previews/` path), and (BUG-05) a segment with
 * multiple reference images must render every image, not just one primary.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { previewSrc, buildReviewItems, buildReviewHtml } from '../src/shared/dt-core.ts'

test('previewSrc maps an absolute preview path to ../previews/<basename>', () => {
  assert.equal(previewSrc('D:\\priv\\dt\\20260826-1000-batch\\previews\\input-01-preview.png'), '../previews/input-01-preview.png')
  assert.equal(previewSrc('/mnt/dt/batch/previews/a.png'), '../previews/a.png')
  assert.equal(previewSrc(''), '')
  assert.equal(previewSrc(undefined), '')
})

test('buildReviewHtml emits ../previews/ (never dt/<batch>/previews/) and escapes prompt text', () => {
  const manifest = { batch_id: 'b1', duration: 8, ratio: '16:9', model: 'seedance2.5', materials: [{ path: 'D:/m/a.png', hash: 'h' }], prompts: [{ material: 'D:/m/a.png', prompt: '镜头推进<测试>&' }] }
  const items = buildReviewItems(manifest, [{ material: 'D:/m/a.png', preview: 'D:/priv/dt/b1/previews/a-preview.png' }])
  const html = buildReviewHtml(manifest, items)
  assert.ok(html.includes('../previews/a-preview.png'), 'uses relative ../previews path')
  assert.ok(!html.includes('dt/b1/previews/'), 'never emits repo-root dt/<batch>/previews/ path')
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
