/**
 * DT batch tool (Codex_DT rebuild): creation manifests, 1024 px previews
 * and a review page for per-material prompt confirmation. Prompt authoring
 * itself stays with the agent (LLM); this tool owns the artifacts and the
 * human review surface.
 *
 * @module @deepseek-ai/dsh-tool-dt
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, isAbsolute, basename } from 'node:path'
import { makePreview } from './shared/image-ops.ts'
import { atomicWriteJson, ensureDir, readJsonSafe, resolvePrivateRoot, sha256File, newTaskId } from './shared/private-runtime.ts'
import { VIDEO_RATIOS } from './shared/project-core.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-dt'
export const inject = ['tools']

export interface Config {
  privateDir?: string
  outputDir?: string
}

export const Config: z<Config> = z.object({
  privateDir: z.string().default(''),
  outputDir: z.string().default('outputs'),
})

type ResolvedConfig = Required<Config>

function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'dt_batch',
      description:
        'DT 批次工作台（Codex_DT 的 DSH 重建）：创建隔离批次、生成 1024px 预览、初始化 manifest（时长/比例/模型选择证据/用户运镜与镜头要求/素材路径）、逐素材写入可执行中文提示词并生成 review/index.html 供用户逐项确认。最终脚本只调用统一媒体工具，不直接调用供应商。',
      parameters: {
        command: {
          type: 'string',
          enum: ['init_batch', 'prepare_previews', 'set_prompts', 'finalize_review', 'get_manifest', 'list'],
          required: true,
          description: '操作命令。',
        },
        batch_id: { type: 'string', description: '批次 id（init 缺省自动生成）。' },
        duration: { type: 'integer', description: 'init_batch 用：视频时长 4-30 秒。' },
        ratio: { type: 'string', description: 'init_batch 用：视频比例。' },
        model: { type: 'string', description: 'init_batch 用：模型选择证据（如 seedance2.5）。' },
        user_requirements: { type: 'string', description: 'init_batch 用：用户运镜/镜头/时长要求。' },
        materials: { type: 'array', items: { type: 'string' }, description: 'init_batch 用：本地素材路径列表（顺序即素材编号）。' },
        prompts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'set_prompts 用：[{material, prompt}] 逐素材中文提示词。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string' },
            batch_id: { type: 'string' },
            manifest: { type: 'object', additionalProperties: true },
            review_path: { type: 'string' },
            batches: { type: 'array' },
          },
        },
        render(_args: unknown, value: any) {
          return [{ type: 'text', text: value.message ?? JSON.stringify(value) }]
        },
      },
      async execute(args: any, exec: any) {
        const command = args.command as string
        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)
        const dtRoot = join(privateRoot, 'dt')

        if (command === 'list') {
          const { readdir } = await import('node:fs/promises')
          const ids = await readdir(dtRoot).catch(() => [] as string[])
          return { ok: true, message: `${ids.length} batch(es)`, batches: ids }
        }

        let batchId = (args.batch_id ?? '').toString().trim()
        if (command === 'init_batch') {
          batchId = batchId || `dt-${newTaskId().slice(0, 10)}`
          const dir = await ensureDir(join(dtRoot, batchId))
          const ratio = args.ratio ?? '16:9'
          if (!VIDEO_RATIOS.includes(ratio as any)) return { ok: false, message: `unsupported ratio ${ratio}` }
          const materials: Array<{ path: string; hash: string }> = []
          for (const p of args.materials ?? []) {
            const abs = isAbsolute(p) ? p : join(workspaceRoot, p)
            materials.push({ path: abs, hash: await sha256File(abs) })
          }
          const manifest = {
            schema_version: 1,
            batch_id: batchId,
            duration: Number(args.duration ?? 5),
            ratio,
            model: args.model ?? 'seedance2.5',
            model_evidence: args.model ?? 'seedance2.5',
            user_requirements: args.user_requirements ?? '',
            materials,
            prompts: [] as Array<{ material: string; prompt: string }>,
            created_at: new Date().toISOString(),
          }
          await atomicWriteJson(join(dir, 'manifest.json'), manifest)
          return { ok: true, message: `batch ${batchId} initialized (${materials.length} material(s))`, batch_id: batchId, manifest }
        }

        if (!batchId) return { ok: false, message: 'batch_id is required' }
        const dir = join(dtRoot, batchId)
        const manifest = await readJsonSafe(join(dir, 'manifest.json'))
        if (!manifest) return { ok: false, message: `batch not found: ${batchId}` }

        switch (command) {
          case 'prepare_previews': {
            const previewsDir = await ensureDir(join(dir, 'previews'))
            const mapping: Array<{ material: string; preview: string; width: number; height: number }> = []
            for (const m of manifest.materials) {
              const prev = await makePreview(m.path, previewsDir, 1024)
              mapping.push({ material: m.path, preview: prev.path, width: prev.width, height: prev.height })
            }
            await atomicWriteJson(join(dir, 'previews.json'), mapping)
            return { ok: true, message: `${mapping.length} preview(s) ready (≤1024px)`, batch_id: batchId }
          }
          case 'set_prompts': {
            const prompts = (args.prompts ?? []).map((p: any) => ({ material: String(p.material), prompt: String(p.prompt ?? '') }))
            if (prompts.some((p: any) => !p.prompt.trim())) return { ok: false, message: 'every prompt must be non-empty' }
            manifest.prompts = prompts
            await atomicWriteJson(join(dir, 'manifest.json'), manifest)
            return { ok: true, message: `${prompts.length} prompt(s) written`, batch_id: batchId }
          }
          case 'finalize_review': {
            const previews = (await readJsonSafe(join(dir, 'previews.json'))) ?? []
            const reviewDir = await ensureDir(join(dir, 'review'))
            const items: Array<{ index: number; material: string; preview: string; prompt: string }> = []
            for (let i = 0; i < manifest.materials.length; i += 1) {
              const m = manifest.materials[i]
              const prev = previews.find((p: any) => p.material === m.path)
              const prompt = manifest.prompts.find((p: any) => String(p.material) === m.path)?.prompt ?? ''
              items.push({ index: i + 1, material: m.path, preview: prev?.preview ?? '', prompt })
            }
            const rows = items
              .map(
                (it) =>
                  `<tr><td>#${it.index}</td><td>${it.preview ? `<img src="${it.preview.split('\\').join('/').replace(/^.*\/dt\//, 'dt/')}" width="240">` : '—'}</td><td style="max-width:480px">${escapeHtml(it.prompt)}</td></tr>`,
              )
              .join('\n')
            const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>DT 审阅 ${batchId}</title><style>body{font-family:system-ui;margin:24px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:10px;vertical-align:top}</style></head><body><h1>审阅批次 ${batchId}</h1><p>时长 ${manifest.duration}s · 比例 ${manifest.ratio} · 模型 ${manifest.model}</p><table><thead><tr><th>#</th><th>素材预览</th><th>中文提示词</th></tr></thead><tbody>${rows}</tbody></table></body></html>`
            await writeFile(join(reviewDir, 'index.html'), html, 'utf8')
            await atomicWriteJson(join(dir, 'review.json'), items)
            return { ok: true, message: `review page ready: ${join(reviewDir, 'index.html')}`, batch_id: batchId, review_path: join(reviewDir, 'index.html') }
          }
          case 'get_manifest':
            return { ok: true, message: `manifest for ${batchId}`, manifest }
          default:
            return { ok: false, message: `unknown command: ${command}` }
        }
      },
    }),
  )
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export { apply }
