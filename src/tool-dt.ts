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
import { copyFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { makePreview } from './shared/image-ops.ts'
import { atomicWriteJson, ensureDir, readJsonSafe, resolvePrivateRoot, sha256File, newTaskId } from './shared/private-runtime.ts'
import { VIDEO_RATIOS } from './shared/project-core.ts'
import { searchCorpus } from './shared/corpus-core.ts'
import { buildReviewHtml, buildReviewItems } from './shared/dt-core.ts'
import { normalizeReferenceLabels, classifyVideoPromptCompleteness } from './shared/video-pipeline.ts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Stable batch id: YYYYMMDD-HHMM-<name> (Codex_DT new_batch convention). */
function newBatchId(name: string): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  const safe = String(name ?? 'batch').trim().replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'batch'
  return `${stamp}-${safe}`
}

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
'DT 批次工作台（Codex_DT 的 DSH 重建）：创建隔离批次（new_batch 文本/图片优先，批次 id 为 YYYYMMDD-HHMM-名称）、对话附件导入（import_images 等待文件稳定后复制）、生成 1024px 预览、初始化 manifest（时长/比例/模型选择证据/用户要求/素材路径/photo_type/surface/mode/resolution）、set_visuals 逐素材写入拍摄信息（photo_type/visual/motion_plan/images，images 支持每段多图）、逐素材写入可执行中文提示词（set_prompts 按 material 合并、自动把 @图片N/参考图片N 规范为裸标签 图片N，且**写作前必须先 prompt_revision search_corpus + authoring_gate，缺 图片N 裸标签绑定的提示词会被拒绝写入**）、生成 review/index.html 逐段列出全部参考图供用户逐项确认、确认后生成提交计划（run_batch，含 asset_manifest 标签绑定，每段 tasks[].images 绑定全部参考图）、语料匹配写回 manifest（update_forge_matches）。set_prompts 写作前若对应业务 Skill 存在，先读取其 references（含 examples 提示词范例）对照组织方式，范例不改变素材契约、不覆盖用户指令。最终执行只调用统一媒体工具，不直接调用供应商。',
      parameters: {
        command: {
          type: 'string',
          enum: [
            'init_batch', 'new_batch', 'import_images', 'prepare_previews', 'set_visuals', 'set_prompts',
            'finalize_review', 'pipeline_status', 'run_batch', 'update_forge_matches', 'get_manifest', 'list',
          ],
          required: true,
          description: '操作命令。',
        },
        batch_id: { type: 'string', description: '批次 id（new_batch 用 YYYYMMDD-HHMM-名称；init 缺省自动生成）。' },
        name: { type: 'string', description: 'new_batch 用：短描述后缀（YYYYMMDD-HHMM-<name>）。' },
        duration: { type: 'integer', description: 'init/new_batch 用：视频时长 4-30 秒。' },
        ratio: { type: 'string', description: 'init/new_batch 用：视频比例。' },
        model: { type: 'string', description: 'init/new_batch 用：模型选择证据（如 seedance2.5）。' },
        model_selection_evidence: { type: 'string', description: 'init/new_batch 用：模型选择的证据说明（如 cli_option）。' },
        model_user_text: { type: 'string', description: 'init/new_batch 用：用户点名模型的原文（selection_source=user_explicit 时记录）。' },
        photo_types: { type: 'array', items: { type: 'string' }, description: 'init/new_batch 用：按素材顺序的 photo_type（如 main_scene / reference / first_frame）。' },
        user_requirements: { type: 'string', description: 'init/new_batch 用：用户运镜/镜头/时长要求。' },
        user_request: { type: 'string', description: 'new_batch 用：原始用户请求（写入 request.json）。' },
        auto_generate: { type: 'boolean', description: 'new_batch 用：记录全自动生成意图（审阅后跳过人工确认）。' },
        materials: { type: 'array', items: { type: 'string' }, description: 'init/new_batch 用：本地素材路径列表（顺序即素材编号）。' },
        images: { type: 'array', items: { type: 'string' }, description: 'import_images 用：对话附件路径列表（等待稳定后复制）。' },
        prompts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'set_prompts 用：[{material, prompt}] 逐素材中文提示词。按 material 合并（非整体替换）：只传部分条目不会覆盖未传条目；非规范引用标签（@图片N/参考图片N/@Image N）会自动规范为裸标签 图片N；**缺少 图片N 裸标签绑定的条目会被整次拒绝**（先 prompt_revision search_corpus + authoring_gate 再写）。' },
        items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'set_visuals 用：[{material, photo_type?, visual?, motion_plan?, images?}] 逐素材写入拍摄信息；images 为该段绑定的额外参考图（每段可多图，顺序即 --image 顺序）。' },
        confirm: { type: 'boolean', description: 'run_batch 用：确认所有提示词后生成提交计划。' },
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
            materials: { type: 'array' },
            tasks: { type: 'array' },
            matches: { type: 'array' },
            plan: { type: 'array' },
            submission: { type: 'object', additionalProperties: true },
            summary: { type: 'object', additionalProperties: true },
            diagnostics: { type: 'array' },
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
        if (command === 'init_batch' || command === 'new_batch') {
          batchId = batchId || (command === 'new_batch' ? newBatchId(args.name ?? 'batch') : `dt-${newTaskId().slice(0, 10)}`)
          const dir = await ensureDir(join(dtRoot, batchId))
          const ratio = args.ratio ?? '16:9'
          if (!VIDEO_RATIOS.includes(ratio as any)) return { ok: false, message: `unsupported ratio ${ratio}` }
          const materials: Array<{ path: string; hash: string; photo_type?: string; visual?: unknown; motion_plan?: unknown; preview?: string }> = []
          const inputDir = await ensureDir(join(dir, 'inputs'))
          const photoTypes = Array.isArray(args.photo_types) ? args.photo_types.map((p: unknown) => String(p)) : []
          for (let i = 0; i < (args.materials ?? []).length; i += 1) {
            const p = (args.materials as string[])[i]
            const abs = isAbsolute(p) ? p : join(workspaceRoot, p)
            materials.push({ path: abs, hash: await sha256File(abs), photo_type: photoTypes[i] ?? undefined })
          }
          const manifest = {
            schema_version: 1,
            batch_id: batchId,
            duration: Number(args.duration ?? 5),
            ratio,
            model: args.model ?? 'seedance2.5',
            model_evidence: args.model ?? 'seedance2.5',
            model_selection: {
              requested: args.model ?? 'seedance2.5',
              selection_source: args.model ? 'user_explicit' : 'default',
              selection_evidence: args.model_selection_evidence ?? '',
              user_text: args.model_user_text ?? '',
            },
            user_requirements: args.user_requirements ?? '',
            surface: 'jimeng-zh',
            mode: 'first-frame',
            preview_max_long_edge: 1024,
            video_resolution: '480p',
            materials,
            prompts: [] as Array<{ material: string; prompt: string }>,
            created_at: new Date().toISOString(),
          }
          await atomicWriteJson(join(dir, 'manifest.json'), manifest)
          await atomicWriteJson(join(dir, 'request.json'), {
            user_request: args.user_request ?? '',
            auto_generate: Boolean(args.auto_generate),
            image_drop_dir: inputDir,
          })
          if (command === 'new_batch' && materials.length > 0) {
            const dir2 = join(dtRoot, batchId, 'inputs')
            await ensureDir(dir2)
            for (let i = 0; i < materials.length; i += 1) {
              const ext = materials[i].path.slice(materials[i].path.lastIndexOf('.')) || '.png'
              await copyFile(materials[i].path, join(dir2, `input-${String(i + 1).padStart(2, '0')}${ext}`))
            }
          }
          return { ok: true, message: `batch ${batchId} initialized (${materials.length} material(s))`, batch_id: batchId, manifest }
        }

        if (!batchId) return { ok: false, message: 'batch_id is required' }
        const dir = join(dtRoot, batchId)
        const manifest = await readJsonSafe(join(dir, 'manifest.json'))
        if (!manifest) return { ok: false, message: `batch not found: ${batchId}` }

        switch (command) {
          case 'import_images': {
            const paths = (args.images ?? []).map((p: unknown) => String(p).trim()).filter(Boolean)
            if (paths.length === 0) return { ok: false, message: 'images is required' }
            const inputDir = await ensureDir(join(dir, 'inputs'))
            const added: Array<{ path: string; hash: string }> = []
            for (const p of paths) {
              const abs = isAbsolute(p) ? p : join(workspaceRoot, p)
              // stability wait: the file must exist and its size stay constant across polls
              let stable = false
              let lastSize = -1
              for (let attempt = 0; attempt < 10 && !stable; attempt += 1) {
                try {
                  const current = (await stat(abs)).size
                  if (current === lastSize && current > 0) stable = true
                  else lastSize = current
                } catch {
                  /* not landed yet */
                }
                if (!stable) await sleep(500)
              }
              if (!stable) return { ok: false, message: `attachment not stable after retries: ${abs}` }
              const ext = abs.slice(abs.lastIndexOf('.')) || '.png'
              const dest = join(inputDir, `input-${String(manifest.materials.length + added.length + 1).padStart(2, '0')}${ext}`)
              await copyFile(abs, dest)
              added.push({ path: dest, hash: await sha256File(dest) })
            }
            manifest.materials = [...manifest.materials, ...added]
            await atomicWriteJson(join(dir, 'manifest.json'), manifest)
            return { ok: true, message: `${added.length} image(s) imported into ${inputDir}`, batch_id: batchId, materials: added }
          }
          case 'pipeline_status': {
            const confirmed = manifest.prompts.filter((p: any) => p.prompt?.trim()).length
            const ready = (manifest.materials ?? []).filter((m: any) => (manifest.prompts ?? []).some((p: any) => p.material === m.path && p.prompt?.trim())).length
            return {
              ok: true,
              message: `batch ${batchId}: ${manifest.materials.length} material(s), ${confirmed}/${manifest.materials.length} prompt(s) ready`,
              summary: { materials: manifest.materials.length, prompts: confirmed, ready, forge_matches: (manifest.forge?.matches ?? []).length },
            }
          }
          case 'run_batch': {
            // submission plan only; actual paid calls go through the unified generate_video tool
            const plan = (manifest.materials ?? []).map((m: any) => {
              const prompt = (manifest.prompts ?? []).find((p: any) => p.material === m.path)?.prompt ?? ''
              const images = [m.path, ...(Array.isArray(m.images) ? m.images : [])].filter(Boolean)
              return { material: m.path, images, hash: m.hash, photo_type: m.photo_type, visual: m.visual, motion_plan: m.motion_plan, prompt, ready: Boolean(prompt.trim()) }
            })
            const ready = plan.filter((item: any) => item.ready).length
            if (!args.confirm) return { ok: false, message: `run_batch requires confirm=true; ${ready}/${plan.length} ready`, plan }
            const missing = plan.filter((item: any) => !item.ready)
            if (missing.length > 0) return { ok: false, message: `${missing.length} material(s) lack a confirmed prompt`, plan }
            const shared = {
              duration: manifest.duration,
              ratio: manifest.ratio,
              model_version: manifest.model,
              video_resolution: manifest.video_resolution ?? '480p',
              video_confirmation_model: manifest.model,
              video_confirmation_resolution: manifest.video_resolution ?? '480p',
              video_confirmation_duration: manifest.duration,
              surface: manifest.surface ?? 'jimeng-zh',
              mode: manifest.mode ?? 'first-frame',
              model_selection: manifest.model_selection,
            }
            // 统一管线：一次 generate_video 调用，tasks 数组逐素材，设置项在调用级共享
            const submission: Record<string, unknown> = {
              ...shared,
              tasks: plan.map((item: any) => ({
                images: item.images,
                prompt: item.prompt,
                asset_manifest: {
                  assets: item.images.map((img: string, i: number) => ({
                    modality: 'image',
                    index: i + 1,
                    tag: `图片${i + 1}`,
                    source: img,
                    transport_role: 'reference_image',
                    primary_role: i === 0 ? 'first_frame_reference' : 'reference_image',
                  })),
                },
              })),
            }
            return {
              ok: true,
              message: `submission plan ready (${plan.length} task(s)): call generate_video ONCE with the shared settings below (tasks + duration/ratio/model_version/video_resolution + video_confirmation_*)`,
              submission,
              plan: submission.tasks,
            }
          }
          case 'update_forge_matches': {
            const queries: string[] = []
            const matches: Array<Record<string, unknown>> = []
            for (const p of manifest.prompts ?? []) {
              const query = String(p.prompt ?? '').slice(0, 60)
              if (!query.trim()) continue
              const hits = searchCorpus(query, 3)
              queries.push(query)
              for (const hit of hits) {
                matches.push({ material: p.material, query, id: hit.id, portable_pattern: hit.portable_pattern, source_metadata: hit.source_metadata })
              }
            }
            manifest.forge = { queries, matches, updated_at: new Date().toISOString() }
            await atomicWriteJson(join(dir, 'manifest.json'), manifest)
            return { ok: true, message: `forge matches updated (${matches.length} match(es), cap 3/item)`, batch_id: batchId, matches }
          }
          case 'prepare_previews': {
            const previewsDir = await ensureDir(join(dir, 'previews'))
            const mapping: Array<{ material: string; preview: string; width: number; height: number }> = []
            for (const m of manifest.materials) {
              const all = [m.path, ...(Array.isArray(m.images) ? m.images : [])].filter(Boolean)
              const previews: string[] = []
              for (const img of all) {
                const prev = await makePreview(img, previewsDir, 1024)
                mapping.push({ material: img, preview: prev.path, width: prev.width, height: prev.height })
                previews.push(prev.path)
              }
              m.preview = previews[0]
            }
            await atomicWriteJson(join(dir, 'previews.json'), mapping)
            await atomicWriteJson(join(dir, 'manifest.json'), manifest)
            return { ok: true, message: `${mapping.length} preview(s) ready (≤1024px)`, batch_id: batchId }
          }
          case 'set_visuals': {
            const items = (args.items ?? []).map((v: any) => ({
              material: String(v.material),
              photo_type: v.photo_type !== undefined ? String(v.photo_type) : undefined,
              visual: v.visual !== undefined ? v.visual : undefined,
              motion_plan: v.motion_plan !== undefined ? v.motion_plan : undefined,
              images: Array.isArray(v.images) ? v.images.map((p: unknown) => String(p)).filter(Boolean) : undefined,
            }))
            if (items.length === 0) return { ok: false, message: 'items is required: [{material, photo_type?, visual?, motion_plan?, images?}]' }
            for (const item of items) {
              const m = manifest.materials.find((x: any) => x.path === item.material)
              if (!m) return { ok: false, message: `unknown material ${item.material}` }
              if (item.photo_type !== undefined) m.photo_type = item.photo_type
              if (item.visual !== undefined) m.visual = item.visual
              if (item.motion_plan !== undefined) m.motion_plan = item.motion_plan
              if (item.images !== undefined) {
                m.images = item.images.map((p: string) => (isAbsolute(p) ? p : join(workspaceRoot, p)))
              }
            }
            await atomicWriteJson(join(dir, 'manifest.json'), manifest)
            return { ok: true, message: `visuals updated for ${items.length} material(s)`, batch_id: batchId }
          }
          case 'set_prompts': {
            const incoming = (args.prompts ?? []).map((p: any) => ({ material: String(p.material), prompt: String(p.prompt ?? '') }))
            if (incoming.some((p: any) => !p.prompt.trim())) return { ok: false, message: 'every prompt must be non-empty' }
            // Merge by material — NEVER wholesale-replace. A partial write must
            // not destroy prompts already recorded for other materials (BUG-01).
            const byMaterial = new Map<string, { material: string; prompt: string }>()
            for (const p of manifest.prompts ?? []) byMaterial.set(String(p.material), { material: String(p.material), prompt: String(p.prompt ?? '') })
            let added = 0
            let updated = 0
            const diagnostics: Array<Record<string, unknown>> = []
            const media = { images: 1, videos: 0, audios: 0 } // every material binds at least its primary image
            const blocked: Array<{ material: string; prompt: string }> = []
            for (const p of incoming) {
              // Normalize non-conforming reference labels to bare 图片N form (BUG-03).
              const norm = normalizeReferenceLabels(p.prompt)
              const finalPrompt = norm.prompt.trim()
              const verdict = classifyVideoPromptCompleteness(finalPrompt, media)
              diagnostics.push({
                material: p.material,
                completeness: verdict.verdict,
                reasons: verdict.reasons,
                label_normalizations: norm.changed,
              })
              // Hard authoring gate (BUG-02): every dt_batch material is an image
              // reference, so the prompt MUST bind it with a bare 图片N label.
              // Refuse to write (fail the whole call, no partial write) when missing.
              if (!/图片\s*\d+/.test(finalPrompt)) {
                blocked.push({ material: p.material, prompt: finalPrompt })
                continue
              }
              if (byMaterial.has(p.material)) updated += 1
              else added += 1
              byMaterial.set(p.material, { material: p.material, prompt: finalPrompt })
            }
            if (blocked.length > 0) {
              const list = blocked.map((b: any) => `${b.material}: ${b.prompt.slice(0, 60)}`).join(' | ')
              return {
                ok: false,
                message: `${blocked.length} prompt(s) rejected — missing bare 图片N reference binding. Run prompt_revision search_corpus + authoring_gate first, then bind every material with 图片N. ${list}`,
                batch_id: batchId,
                diagnostics,
              }
            }
            manifest.prompts = [...byMaterial.values()]
            await atomicWriteJson(join(dir, 'manifest.json'), manifest)
            const incomplete = diagnostics.filter((d: any) => d.completeness === 'incomplete')
            const normalized = diagnostics.filter((d: any) => (d.label_normalizations ?? []).length > 0)
            const notes: string[] = []
            if (normalized.length > 0) notes.push(`${normalized.length} prompt(s) reference labels normalized to bare 图片N form`)
            if (incomplete.length > 0) notes.push(`${incomplete.length} prompt(s) incomplete — run prompt_revision search_corpus + authoring_gate and rewrite before submit`)
            return {
              ok: true,
              message: `${added} added, ${updated} updated (${manifest.prompts.length} total)${notes.length ? ' — ' + notes.join('; ') : ''}`,
              batch_id: batchId,
              diagnostics,
            }
          }
          case 'finalize_review': {
            const previews = (await readJsonSafe(join(dir, 'previews.json'))) ?? []
            const reviewDir = await ensureDir(join(dir, 'review'))
            const items = buildReviewItems(manifest, previews)
            const html = buildReviewHtml(manifest, items)
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

export { apply }
