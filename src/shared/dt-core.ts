/**
 * DT review-page generation (pure domain — no DSH imports). Shared by the
 * `dt_batch` tool and the offline acceptance script so the HTML contract is
 * tested in both places.
 *
 * @module dsh-media-plugins/shared/dt-core
 */

export interface DtReviewImage {
  path: string
  preview: string
}

export interface DtReviewItem {
  index: number
  material: string
  /** Primary preview path (kept for backward compatibility with older callers). */
  preview: string
  prompt: string
  /** All segment images in order (primary first) — one segment may bind several references. */
  images: DtReviewImage[]
}

export interface DtManifestLike {
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
 * `../previews/<basename>` — NOT a repo-root `dt/<batch>/previews/...` path
 * that would resolve to `<batch>/review/dt/...` and break every thumbnail.
 */
export function previewSrc(previewPath: string): string {
  const name = String(previewPath ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  return name ? `../previews/${name}` : ''
}

/**
 * Build review/index.html: every segment renders ALL of its reference images
 * (primary + extras, in `--image` order) labelled 图片1..图片N, followed by
 * the Chinese prompt. Relative preview paths point at `../previews/`.
 */
export function buildReviewHtml(manifest: DtManifestLike, items: DtReviewItem[]): string {
  const rows = items
    .map((it) => {
      const imgs = it.images && it.images.length > 0 ? it.images : [{ path: it.material, preview: it.preview }]
      const cells = imgs
        .map((img, i) => {
          const src = previewSrc(img.preview)
          const imgTag = src ? `<img src="${src}" width="240" alt="图片${i + 1}" title="${escapeHtml(img.path)}">` : '—'
          return `<figure style="display:inline-block;margin:0 10px 6px 0"><figcaption style="font-size:12px;color:#888">图片${i + 1}</figcaption>${imgTag}</figure>`
        })
        .join('')
      return `<tr><td>#${it.index}</td><td>${cells}</td><td style="max-width:480px">${escapeHtml(it.prompt)}</td></tr>`
    })
    .join('\n')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>DT 审阅 ${manifest.batch_id}</title><style>body{font-family:system-ui;margin:24px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:10px;vertical-align:top}</style></head><body><h1>审阅批次 ${manifest.batch_id}</h1><p>时长 ${manifest.duration}s · 比例 ${manifest.ratio} · 模型 ${manifest.model}</p><table><thead><tr><th>#</th><th>素材预览</th><th>中文提示词</th></tr></thead><tbody>${rows}</tbody></table></body></html>`
}

/**
 * Build the review items (index/material/all-images/prompt) from a manifest.
 * A material may carry an `images` array of additional reference images; the
 * primary `path` is always first so the numbering matches `--image` order.
 */
export function buildReviewItems(manifest: DtManifestLike, previews: Array<{ material: string; preview: string }>): DtReviewItem[] {
  const previewByPath = new Map<string, string>()
  for (const p of previews ?? []) previewByPath.set(p.material, p.preview)
  const items: DtReviewItem[] = []
  for (let i = 0; i < manifest.materials.length; i += 1) {
    const m = manifest.materials[i]
    const paths = [m.path, ...(Array.isArray(m.images) ? m.images : [])].filter((p): p is string => typeof p === 'string' && p.length > 0)
    const images: DtReviewImage[] = paths.map((p) => ({ path: p, preview: previewByPath.get(p) ?? '' }))
    const prompt = manifest.prompts.find((p) => String(p.material) === m.path)?.prompt ?? ''
    items.push({ index: i + 1, material: m.path, preview: images[0]?.preview ?? '', prompt, images })
  }
  return items
}
