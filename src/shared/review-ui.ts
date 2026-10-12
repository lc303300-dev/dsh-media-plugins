/**
 * Shared review-page UI (pure string builders — no DSH imports).
 *
 * Every Studio review table — `batch_image`'s contact sheet, the grid-split
 * panel page and `prompt_batch`'s reference page — renders the same picking
 * widget:
 *
 *  - a checkbox per image,
 *  - a sticky bar showing `已选 N / 共 M` with **复制名称** / **复制路径** /
 *    全选 / 清空,
 *  - a clipboard fallback: when the browser refuses a scripted copy (a
 *    locked-down `file://` viewer is the normal case) the selected text is
 *    dropped into a pre-selected textarea so `Ctrl+C` still works.
 *
 * The page opts in purely through markup, so each builder keeps its own layout:
 *
 * ```html
 * <input type="checkbox" data-rv-name="G1-01.png" data-rv-path="outputs/…/G1-01.png">
 * ```
 *
 * `reviewUiStyleHtml()` goes in `<head>`, `reviewToolbarHtml()` where the bar
 * belongs and `reviewUiScriptHtml()` at the end of `<body>`.
 *
 * @module dsh-media-plugins/shared/review-ui
 */

/** Minimal HTML text escaping for values interpolated into a page. */
export function escapeReviewHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Pick widget styles. Dark by default and light-page friendly (opacity-free). */
export const REVIEW_UI_CSS = `*{box-sizing:border-box}
.rv-bar{position:sticky;bottom:0;z-index:9;display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:20px 0 0;padding:10px 12px;background:rgba(20,22,26,.96);border:1px solid #2a2d33;border-radius:10px;box-shadow:0 -6px 18px rgba(0,0,0,.28);font-size:13px;color:#e9e9ec}
.rv-bar.rv-flat{background:#f6f7f9;border-color:#d8dbe0;color:#22252a;box-shadow:none}
.rv-bar .rv-count{font-weight:600;color:#7fc4ff}
.rv-bar.rv-flat .rv-count{color:#0b63c4}
.rv-bar button{cursor:pointer;font:inherit;font-size:12.5px;padding:6px 11px;border-radius:8px;border:1px solid #3a3f47;background:#23262c;color:#e9e9ec}
.rv-bar.rv-flat button{background:#fff;border-color:#c8ccd3;color:#22252a}
.rv-bar button:hover{background:#2f343c}
.rv-bar.rv-flat button:hover{background:#eef1f5}
.rv-bar button.rv-primary{border-color:#3d6ea8;background:#20456e;color:#eaf3ff}
.rv-bar.rv-flat button.rv-primary{border-color:#0b63c4;background:#0b63c4;color:#fff}
.rv-bar .rv-msg{color:#8bd48b}
.rv-bar .rv-hint{color:#98a0a8}
.rv-bar.rv-flat .rv-msg{color:#1d7a34}
.rv-bar .rv-msg.rv-warn{color:#ffbf6b}
.rv-bar.rv-flat .rv-msg.rv-warn{color:#a35a00}
.rv-pick{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12.5px;color:#c6cad0;border-bottom:1px solid #2a2d33;cursor:pointer;user-select:none}
.rv-flat-page .rv-pick{color:#333;border-bottom-color:#e2e5ea}
.rv-pick:hover{background:rgba(127,196,255,.07)}
.rv-pick input{width:16px;height:16px;margin:0;accent-color:#4a9eff;cursor:pointer;flex:0 0 auto}
.rv-pick .rv-name{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12px;overflow-wrap:anywhere}
.rv-pick .rv-tag{color:#8f979f;font-size:11.5px}
.rv-card.rv-on,figure.rv-on{outline:2px solid #4a9eff;outline-offset:-2px}
.rv-fallback{margin:10px 0 0;padding:10px 12px;border:1px solid #7a5a1e;border-radius:10px;background:#2a2418}
.rv-fallback[hidden]{display:none}
.rv-fallback textarea{width:100%;min-height:96px;font-family:ui-monospace,Consolas,monospace;font-size:12px;background:#14161a;color:#e9e9ec;border:1px solid #3a3f47;border-radius:8px;padding:8px}
.rv-fallback p{margin:0 0 6px;font-size:12.5px;color:#ffbf6b}`

/** Stylesheet tag for `<head>`. */
export function reviewUiStyleHtml(): string {
  return `<style>\n${REVIEW_UI_CSS}\n</style>`
}

/**
 * Sticky picking bar + clipboard fallback. `hint` renders before the buttons;
 * `flat` switches the bar/checkbox theme to a light palette (used by pages
 * that keep a light background).
 */
export function reviewToolbarHtml(opts: { hint?: string; flat?: boolean } = {}): string {
  const hint = opts.hint ? `<span class="rv-hint">${escapeReviewHtml(opts.hint)}</span>` : ''
  return `<div class="rv-bar${opts.flat ? ' rv-flat' : ''}" data-rv-bar>
<span class="rv-count" data-rv-count>已选 0 / 共 0</span>
${hint}
<button type="button" class="rv-primary" data-rv-act="copy-name">复制勾选名称</button>
<button type="button" data-rv-act="copy-path">复制勾选路径</button>
<button type="button" data-rv-act="all">全选</button>
<button type="button" data-rv-act="none">清空</button>
<span class="rv-msg" data-rv-msg></span>
</div>
<div class="rv-fallback" data-rv-fallback hidden><p>浏览器拦截了自动复制：文本已放入下面的框并全选，请按 Ctrl+C（⌘C）复制。</p><textarea readonly data-rv-clip></textarea></div>`
}

/**
 * One pickable label. `name` is what "复制名称" emits (usually the file name);
 * `path` is what "复制路径" emits (usually the absolute path).
 */
export function reviewPickHtml(opts: { name: string; path?: string; tag?: string; id?: string }): string {
  const id = opts.id ? ` id="${escapeReviewHtml(opts.id)}"` : ''
  const path = opts.path ? ` data-rv-path="${escapeReviewHtml(opts.path)}"` : ''
  const tag = opts.tag ? `<span class="rv-tag">${escapeReviewHtml(opts.tag)}</span>` : ''
  return `<label class="rv-pick"${id}><input type="checkbox" data-rv-name="${escapeReviewHtml(opts.name)}"${path}><span class="rv-name">${escapeReviewHtml(opts.name)}</span>${tag}</label>`
}

/**
 * Behaviour for the widget: selection count, select-all/clear, and copy with a
 * two-step fallback (`navigator.clipboard` → hidden textarea + `execCommand`,
 * then a pre-selected textarea). Emits a `<script>` tag; place it at the end of
 * `<body>`.
 */
export function reviewUiScriptHtml(): string {
  return `<script>
(function () {
  var boxes = Array.prototype.slice.call(document.querySelectorAll('input[data-rv-name]'));
  var bar = document.querySelector('[data-rv-bar]');
  if (!boxes.length) { if (bar) bar.style.display = 'none'; return; }
  var countEl = document.querySelector('[data-rv-count]');
  var msgEl = document.querySelector('[data-rv-msg]');
  var fbEl = document.querySelector('[data-rv-fallback]');
  var clipEl = document.querySelector('[data-rv-clip]');
  var msgTimer = null;

  function say(text, warn) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = 'rv-msg' + (warn ? ' rv-warn' : '');
    if (msgTimer) clearTimeout(msgTimer);
    if (text) msgTimer = setTimeout(function () { msgEl.textContent = ''; }, 6000);
  }
  function refresh() {
    var n = boxes.filter(function (b) { return b.checked; }).length;
    if (countEl) countEl.textContent = '已选 ' + n + ' / 共 ' + boxes.length;
    boxes.forEach(function (b) {
      var card = b.closest ? b.closest('figure, .rv-card, tr') : null;
      if (card) card.classList.toggle('rv-on', !!b.checked);
    });
  }
  function picked(attr) {
    var out = [];
    boxes.forEach(function (b) {
      if (!b.checked) return;
      var v = (attr && b.getAttribute(attr)) || b.getAttribute('data-rv-name') || '';
      if (v && out.indexOf(v) === -1) out.push(v);
    });
    return out;
  }
  function manual(text) {
    if (!fbEl || !clipEl) { say('复制失败：请手动选中名称', true); return; }
    fbEl.hidden = false;
    clipEl.value = text;
    clipEl.focus();
    clipEl.select();
    say('已放入下方文本框，请按 Ctrl+C', true);
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }
  function copy(text) {
    if (!text) { say('未勾选任何图片', true); return; }
    var done = function (ok) {
      if (ok) { if (fbEl) fbEl.hidden = true; say('已复制 ' + text.split('\\n').length + ' 项'); }
      else manual(text);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
        return;
      }
    } catch (e) { /* fall through to the legacy path */ }
    done(legacyCopy(text));
  }

  boxes.forEach(function (b) { b.addEventListener('change', refresh); });
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document && !(t.getAttribute && t.getAttribute('data-rv-act'))) t = t.parentNode;
    if (!t || t === document || !t.getAttribute) return;
    var act = t.getAttribute('data-rv-act');
    if (act === 'copy-name') copy(picked('data-rv-name').join('\\n'));
    else if (act === 'copy-path') copy(picked('data-rv-path').join('\\n'));
    else if (act === 'all') { boxes.forEach(function (b) { b.checked = true; }); refresh(); }
    else if (act === 'none') { boxes.forEach(function (b) { b.checked = false; }); refresh(); }
  });
  refresh();
})();
</script>`
}
