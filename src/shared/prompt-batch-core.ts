/**
 * Prompt-batch review-page generation (pure domain — no DSH imports). Shared by
 * the `prompt_batch` tool and the offline acceptance script so the HTML contract
 * is tested in both places.
 *
 * @module dsh-media-plugins/shared/prompt-batch-core
 */

import { reviewPickHtml, reviewToolbarHtml, reviewUiScriptHtml, reviewUiStyleHtml } from './review-ui.ts'

export interface ReviewImage {
  path: string
  preview: string
  /**
   * Embedded thumbnail (`data:image/jpeg;base64,…`). Preferred over `preview`:
   * the sandboxed viewer blocks `file://` and relative `<img src>` (same
   * contract as batch_image's contact sheet), so a relative path shows as a
   * broken image.
   */
  dataUri?: string
}

export interface ReviewItem {
  index: number
  material: string
  /** Primary preview path (kept for backward compatibility with older callers). */
  preview: string
  prompt: string
  /** All segment images in order (primary first) — one segment may bind several references. */
  images: ReviewImage[]
}

export interface ManifestLike {
  batch_id: string
  duration: number
  ratio: string
  model: string
  materials: Array<{ path: string; hash: string; images?: string[] }>
  prompts: Array<{ material: string; prompt: string }>
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Compute the `src` for a preview from its absolute path. The review page
 * lives in `<batch>/review/index.html` while previews live in
 * `<batch>/previews/`, so the correct relative reference is
 * `../previews/<basename>` — never a repo-root-relative path, which would
 * resolve to `<batch>/review/…` and break every thumbnail.
 */
export function previewSrc(previewPath: string): string {
  const name = String(previewPath ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  return name ? `../previews/${name}` : ''
}

/**
 * Copy-friendly names for a set of image paths: the file name, prefixed with its
 * parent folder only when the bare name is ambiguous inside this batch (two
 * `a.png` from different folders must not copy out as the same string).
 */
export function reviewImageNames(paths: Array<string | undefined>): string[] {
  const normalized = paths.map((p) => String(p ?? '').replace(/\\/g, '/'))
  const bases = normalized.map((p) => p.split('/').pop() ?? '')
  const counts = new Map<string, number>()
  for (const b of bases) counts.set(b, (counts.get(b) ?? 0) + 1)
  return normalized.map((p, i) => {
    const parts = p.split('/').filter(Boolean)
    if ((counts.get(bases[i]) ?? 0) > 1 && parts.length >= 2) return `${parts[parts.length - 2]}/${bases[i]}`
    return bases[i]
  })
}

/**
 * Build review/index.html: every segment renders ALL of its reference images
 * (primary + extras, in `--image` order) labelled 图片1..图片N, followed by
 * the Chinese prompt. Relative preview paths point at `../previews/`.
 *
 * Every image carries a checkbox with its copy-friendly name, so a binding can
 * be confirmed (and quoted back) without retyping file names.
 */
export function buildReviewHtml(manifest: ManifestLike, items: ReviewItem[]): string {
  const allPaths: string[] = []
  for (const it of items) {
    const imgs = it.images && it.images.length > 0 ? it.images : [{ path: it.material, preview: it.preview }]
    for (const img of imgs) allPaths.push(img.path)
  }
  const names = reviewImageNames(allPaths)
  let cursor = 0
  const rows = items
    .map((it) => {
      const imgs = it.images && it.images.length > 0 ? it.images : [{ path: it.material, preview: it.preview }]
      const cells = imgs
        .map((img, i) => {
          const src = img.dataUri && img.dataUri.length > 0 ? img.dataUri : previewSrc(img.preview)
          const imgTag = src ? `<img src="${src}" width="240" loading="lazy" alt="图片${i + 1}" title="${escapeHtml(img.path)}">` : '—'
          const pick = reviewPickHtml({ name: names[cursor++] ?? '', path: img.path, tag: `图片${i + 1}` })
          return `<figure class="rv-card" style="margin:0 10px 6px 0">${pick}${imgTag}<figcaption style="font-size:12px;color:#777">图片${i + 1}</figcaption></figure>`
        })
        .join('')
      return `<tr><td>#${it.index}</td><td>${cells}</td><td style="max-width:480px">${escapeHtml(it.prompt)}</td></tr>`
    })
    .join('\n')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>批次审阅 ${manifest.batch_id}</title>${reviewUiStyleHtml()}<style>body{font-family:system-ui;margin:24px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:10px;vertical-align:top}figure{display:inline-block}</style></head><body class="rv-flat-page"><h1>审阅批次 ${manifest.batch_id}</h1><p>时长 ${manifest.duration}s · 比例 ${manifest.ratio} · 模型 ${manifest.model}</p><p style="font-size:12.5px;color:#555">勾选要绑定的素材 → 点“复制勾选名称”，把名称贴回对话即可核对绑定。</p><table><thead><tr><th>#</th><th>素材预览</th><th>中文提示词</th></tr></thead><tbody>${rows}</tbody></table>${reviewToolbarHtml({ hint: '勾选后复制名称/路径', flat: true })}${reviewUiScriptHtml()}</body></html>`
}

/**
 * Build the review items (index/material/all-images/prompt) from a manifest.
 * A material may carry an `images` array of additional reference images; the
 * primary `path` is always first so the numbering matches `--image` order.
 */
export function buildReviewItems(manifest: ManifestLike, previews: Array<{ material: string; preview: string }>): ReviewItem[] {
  const previewByPath = new Map<string, string>()
  for (const p of previews ?? []) previewByPath.set(p.material, p.preview)
  const items: ReviewItem[] = []
  for (let i = 0; i < manifest.materials.length; i += 1) {
    const m = manifest.materials[i]
    const paths = [m.path, ...(Array.isArray(m.images) ? m.images : [])].filter((p): p is string => typeof p === 'string' && p.length > 0)
    const images: ReviewImage[] = paths.map((p) => ({ path: p, preview: previewByPath.get(p) ?? '' }))
    const prompt = manifest.prompts.find((p) => String(p.material) === m.path)?.prompt ?? ''
    items.push({ index: i + 1, material: m.path, preview: images[0]?.preview ?? '', prompt, images })
  }
  return items
}
