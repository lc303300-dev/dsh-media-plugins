/**
 * Shared review-UI tests. Three review tables (batch_image contact sheet,
 * grid-split panel page, prompt_batch reference page) share this widget, so its
 * contract — a named checkbox per image, a copy bar, a clipboard fallback and a
 * script that actually parses — is pinned here once.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeReviewHtml,
  reviewPickHtml,
  reviewToolbarHtml,
  reviewUiScriptHtml,
  reviewUiStyleHtml,
} from '../src/shared/review-ui.ts'

test('pick labels escape the name and keep the copy payload in data attributes', () => {
  const html = reviewPickHtml({ name: 'a&b<c>"d".png', path: 'D:/x/a&b<c>.png', tag: 'r1c1' })
  assert.match(html, /data-rv-name="a&amp;b&lt;c&gt;&quot;d&quot;\.png"/)
  assert.match(html, /data-rv-path="D:\/x\/a&amp;b&lt;c&gt;\.png"/)
  assert.match(html, /type="checkbox"/)
  assert.match(html, /r1c1/)
  assert.doesNotMatch(html, /<script/i)
})

test('escapeReviewHtml neutralises every HTML metacharacter', () => {
  assert.equal(escapeReviewHtml(`<img src="x" onerror='y'>&`), `&lt;img src=&quot;x&quot; onerror='y'&gt;&amp;`)
})

test('the toolbar carries the count, all four actions and the fallback box', () => {
  const html = reviewToolbarHtml({ hint: '勾选后复制', flat: true })
  assert.match(html, /data-rv-count/)
  assert.match(html, /data-rv-act="copy-name"/)
  assert.match(html, /data-rv-act="copy-path"/)
  assert.match(html, /data-rv-act="all"/)
  assert.match(html, /data-rv-act="none"/)
  assert.match(html, /data-rv-fallback hidden/)
  assert.match(html, /data-rv-clip/)
  assert.match(html, /rv-flat/)
})

test('the inline script parses and implements the clipboard ladder', () => {
  const html = reviewUiScriptHtml()
  const body = html.replace(/^<script>/, '').replace(/<\/script>$/, '')
  // Compile without running: a syntax error here would break every review page.
  assert.doesNotThrow(() => new Function(body))
  assert.match(body, /navigator\.clipboard\.writeText/)
  assert.match(body, /execCommand/)
  assert.match(body, /data-rv-name/)
  assert.match(body, /join\('\\n'\)/, 'copies one name per line')
})

test('the stylesheet defines the bar, the pick row and the selected outline', () => {
  const css = reviewUiStyleHtml()
  assert.match(css, /^<style>/)
  assert.match(css, /\.rv-bar\{/)
  assert.match(css, /\.rv-pick/)
  assert.match(css, /\.rv-on/)
  assert.match(css, /\.rv-fallback\[hidden\]/)
})
