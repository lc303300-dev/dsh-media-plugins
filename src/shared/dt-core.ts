/**
 * DT review-page generation (pure domain — no DSH imports). Shared by the
 * `dt_batch` tool and the offline acceptance script so the HTML contract is
 * tested in both places.
 *
 * @module dsh-media-plugins/shared/dt-core
 */

export interface DtReviewItem {
  index: number
  material: string
  preview: string
  prompt: string
}

export interface DtManifestLike {
  batch_id: string
  duration: number
  ratio: string
  model: string
  materials: Array<{ path: string; hash: string }>
  prompts: Array<{ material: string; prompt: string }>
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Build review/index.html: per-material preview + Chinese prompt, numbered. */
export function buildReviewHtml(manifest: DtManifestLike, items: DtReviewItem[]): string {
  const rows = items
    .map(
      (it) =>
        `<tr><td>#${it.index}</td><td>${it.preview ? `<img src="${it.preview.split('\\').join('/').replace(/^.*\/dt\//, 'dt/')}" width="240">` : '—'}</td><td style="max-width:480px">${escapeHtml(it.prompt)}</td></tr>`,
    )
    .join('\n')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>DT 审阅 ${manifest.batch_id}</title><style>body{font-family:system-ui;margin:24px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:10px;vertical-align:top}</style></head><body><h1>审阅批次 ${manifest.batch_id}</h1><p>时长 ${manifest.duration}s · 比例 ${manifest.ratio} · 模型 ${manifest.model}</p><table><thead><tr><th>#</th><th>素材预览</th><th>中文提示词</th></tr></thead><tbody>${rows}</tbody></table></body></html>`
}

/** Build the review items (index/material/preview/prompt) from a manifest. */
export function buildReviewItems(manifest: DtManifestLike, previews: Array<{ material: string; preview: string }>): DtReviewItem[] {
  const items: DtReviewItem[] = []
  for (let i = 0; i < manifest.materials.length; i += 1) {
    const m = manifest.materials[i]
    const prev = previews.find((p) => p.material === m.path)
    const prompt = manifest.prompts.find((p) => String(p.material) === m.path)?.prompt ?? ''
    items.push({ index: i + 1, material: m.path, preview: prev?.preview ?? '', prompt })
  }
  return items
}
