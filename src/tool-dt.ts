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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
import { makePreview } from './shared/image-ops.ts'
import { atomicWriteJson, ensureDir, readJsonSafe, resolvePrivateRoot, sha256File, newTaskId } from './shared/private-runtime.ts'
import { VIDEO_RATIOS } from './shared/project-core.ts'
import { searchCorpus } from './shared/corpus-core.ts'
import { buildReviewHtml, buildReviewItems } from './shared/dt-core.ts'

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

/** Load/create the subagent job record for a batch. */
async function loadJobs(dir: string): Promise<Record<string, any>> {
  return (await readJsonSafe(join(dir, 'jobs.json'))) ?? { tasks: {} }
}

/** Aggregate task status counts for wait_batch / pipeline_status. */
function aggregateJobs(tasks: Record<string, any>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const task of Object.values(tasks ?? {})) {
    const key = task?.status ?? 'unknown'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-dt'
export const inject = ['tools']

export interface Config {
  privateDir?: string
  outputDir?: string
  dreaminaPath?: string
}

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

export const Config: z<Config> = z.object({
  privateDir: z.string().default(''),
  outputDir: z.string().default('outputs'),
  dreaminaPath: z.string().default(join(PACKAGE_ROOT, 'bin', 'dreamina.exe')),
})

type ResolvedConfig = Required<Config>

function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'dt_batch',
      description:
        'DT 批次工作台（Codex_DT 的 DSH 重建）：创建隔离批次（new_batch 文本/图片优先，批次 id 为 YYYYMMDD-HHMM-名称）、对话附件导入（import_images 等待文件稳定后复制）、生成 1024px 预览、初始化 manifest（时长/比例/模型选择证据/用户要求/素材路径）、子代理任务清单（subagent_tasks）与分发/结果记录（record_dispatch/record_result）、逐素材写入可执行中文提示词、生成 review/index.html 供用户逐项确认、确认后生成提交计划（run_batch）、语料匹配写回 manifest（update_forge_matches）。最终执行只调用统一媒体工具，不直接调用供应商。',
      parameters: {
        command: {
          type: 'string',
          enum: [
            'init_batch', 'new_batch', 'import_images', 'prepare_previews', 'set_prompts',
            'finalize_review', 'subagent_tasks', 'record_dispatch', 'record_result',
            'pipeline_status', 'run_batch', 'wait_batch', 'update_forge_matches', 'get_manifest', 'list',
          ],
          required: true,
          description: '操作命令。',
        },
        batch_id: { type: 'string', description: '批次 id（new_batch 用 YYYYMMDD-HHMM-名称；init 缺省自动生成）。' },
        name: { type: 'string', description: 'new_batch 用：短描述后缀（YYYYMMDD-HHMM-<name>）。' },
        duration: { type: 'integer', description: 'init/new_batch 用：视频时长 4-30 秒。' },
        ratio: { type: 'string', description: 'init/new_batch 用：视频比例。' },
        model: { type: 'string', description: 'init/new_batch 用：模型选择证据（如 seedance2.5）。' },
        user_requirements: { type: 'string', description: 'init/new_batch 用：用户运镜/镜头/时长要求。' },
        user_request: { type: 'string', description: 'new_batch 用：原始用户请求（写入 request.json）。' },
        auto_generate: { type: 'boolean', description: 'new_batch 用：记录全自动生成意图（审阅后跳过人工确认）。' },
        materials: { type: 'array', items: { type: 'string' }, description: 'init/new_batch 用：本地素材路径列表（顺序即素材编号）。' },
        images: { type: 'array', items: { type: 'string' }, description: 'import_images 用：对话附件路径列表（等待稳定后复制）。' },
        prompts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'set_prompts 用：[{material, prompt}] 逐素材中文提示词。' },
        task_id: { type: 'string', description: 'record_dispatch/record_result 用：子代理任务 id。' },
        agent_id: { type: 'string', description: 'record_dispatch 用：子代理会话 id。' },
        prompt: { type: 'string', description: 'record_result 用：该素材生成的中文提示词。' },
        submit_id: { type: 'string', description: 'record_result 用：该素材视频任务的 submit_id（wait_batch 轮询用）。' },
        timeout_seconds: { type: 'integer', description: 'wait_batch 用：批次级等待上限（默认 600 秒）。' },
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
            summary: { type: 'object', additionalProperties: true },
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
          const materials: Array<{ path: string; hash: string }> = []
          const inputDir = await ensureDir(join(dir, 'inputs'))
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
          await atomicWriteJson(join(dir, 'request.json'), {
            user_request: args.user_request ?? '',
            auto_generate: Boolean(args.auto_generate),
            image_drop_dir: inputDir,
          })
          await atomicWriteJson(join(dir, 'jobs.json'), { tasks: {} })
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
          case 'subagent_tasks': {
            const taskDir = await ensureDir(join(dir, 'subagent-tasks'))
            const jobs = await loadJobs(dir)
            const tasks: Array<{ task_id: string; image: string; prompt: string }> = []
            for (let i = 0; i < manifest.materials.length; i += 1) {
              const m = manifest.materials[i]
              const taskId = `task-${String(i + 1).padStart(3, '0')}`
              const task = {
                task_id: taskId,
                image: m.path,
                material_index: i + 1,
                duration: manifest.duration,
                ratio: manifest.ratio,
                model: manifest.model,
                user_requirements: manifest.user_requirements,
                instruction: '为这张素材编写一段可执行中文视频提示词：导演知识负责场面、镜头、表演、光色与声音；最终输出纯中文提示词，不要包含平台标签。',
              }
              await atomicWriteJson(join(taskDir, `${taskId}.task.json`), task)
              jobs.tasks[taskId] = { image: m.path, status: 'pending', agent_id: null, prompt: null }
              tasks.push(task)
            }
            await atomicWriteJson(join(dir, 'jobs.json'), jobs)
            return { ok: true, message: `${tasks.length} subagent task(s) written to ${taskDir}`, batch_id: batchId, tasks }
          }
          case 'record_dispatch': {
            const taskId = String(args.task_id ?? '')
            const jobs = await loadJobs(dir)
            if (!jobs.tasks[taskId]) return { ok: false, message: `unknown task ${taskId}` }
            jobs.tasks[taskId].status = 'dispatched'
            jobs.tasks[taskId].agent_id = String(args.agent_id ?? '')
            jobs.tasks[taskId].dispatched_at = new Date().toISOString()
            await atomicWriteJson(join(dir, 'jobs.json'), jobs)
            return { ok: true, message: `dispatched ${taskId}`, batch_id: batchId }
          }
          case 'record_result': {
            const taskId = String(args.task_id ?? '')
            const jobs = await loadJobs(dir)
            if (!jobs.tasks[taskId]) return { ok: false, message: `unknown task ${taskId}` }
            const imagePath = jobs.tasks[taskId].image
            const prompt = String(args.prompt ?? '').trim()
            if (!prompt) return { ok: false, message: 'prompt is required' }
            jobs.tasks[taskId].status = 'recorded'
            jobs.tasks[taskId].prompt = prompt
            if (args.submit_id) jobs.tasks[taskId].submit_id = String(args.submit_id)
            jobs.tasks[taskId].recorded_at = new Date().toISOString()
            await atomicWriteJson(join(dir, 'jobs.json'), jobs)
            manifest.prompts = [...(manifest.prompts ?? []).filter((p: any) => p.material !== imagePath), { material: imagePath, prompt }]
            await atomicWriteJson(join(dir, 'manifest.json'), manifest)
            return { ok: true, message: `recorded ${taskId}${jobs.tasks[taskId].submit_id ? ` (submit_id=${jobs.tasks[taskId].submit_id})` : ''}`, batch_id: batchId }
          }
          case 'wait_batch': {
            // 批次级 wait/collect（wait_seedance_batch 等价）：轮询所有已记录 submit_id 的任务
            const jobs = await loadJobs(dir)
            const pending = Object.entries(jobs.tasks as Record<string, any>).filter(([, t]) => t.submit_id && t.status !== 'success' && t.status !== 'failed')
            if (pending.length === 0) {
              const all = Object.values(jobs.tasks as Record<string, any>)
              return { ok: true, message: `no pending submit_id tasks (${all.length} task(s) total)`, summary: aggregateJobs(jobs.tasks) }
            }
            const deadline = Date.now() + (Number(args.timeout_seconds ?? 600) * 1000)
            const videosDir = join(workspaceRoot, config.outputDir, 'dt', batchId)
            await mkdir(videosDir, { recursive: true })
            const parseJson = (stdout: string): any => {
              const start = stdout.indexOf('{')
              if (start < 0) return undefined
              try {
                return JSON.parse(stdout.slice(start))
              } catch {
                return undefined
              }
            }
            const query = async (submitId: string): Promise<any> => {
              try {
                const { stdout } = await execFileAsync(config.dreaminaPath, ['query_result', `--submit_id=${submitId}`, `--download_dir=${videosDir}`], { timeout: 90000, windowsHide: true })
                return parseJson(stdout)
              } catch {
                return undefined
              }
            }
            while (Date.now() < deadline) {
              let allTerminal = true
              for (const [taskId, task] of pending) {
                if (task.status === 'success' || task.status === 'failed') continue
                const result = await query(task.submit_id)
                if (result?.gen_status === 'fail') {
                  task.status = 'failed'
                  task.fail_reason = String(result.fail_reason ?? 'unknown')
                } else if (result?.gen_status === 'success') {
                  task.status = 'success'
                  task.finished_at = new Date().toISOString()
                  task.output = result.video_url ?? result.output ?? `已下载到 ${videosDir}`
                } else {
                  allTerminal = false
                }
              }
              await atomicWriteJson(join(dir, 'jobs.json'), jobs)
              if (allTerminal) break
              await sleep(5000)
            }
            const summary = aggregateJobs(jobs.tasks)
            return { ok: summary.failed === 0, message: `batch wait done: ${JSON.stringify(summary)}`, summary }
          }
          case 'pipeline_status': {
            const jobs = await loadJobs(dir)
            const statuses: Record<string, number> = {}
            for (const task of Object.values(jobs.tasks) as any[]) statuses[task.status] = (statuses[task.status] ?? 0) + 1
            const confirmed = manifest.prompts.filter((p: any) => p.prompt?.trim()).length
            return {
              ok: true,
              message: `batch ${batchId}: ${manifest.materials.length} material(s), ${confirmed} prompt(s), tasks ${JSON.stringify(statuses)}`,
              summary: { materials: manifest.materials.length, prompts: confirmed, tasks: statuses, total: Object.keys(jobs.tasks).length },
            }
          }
          case 'run_batch': {
            // submission plan only; actual paid calls go through the unified generate_video tool
            const plan = (manifest.materials ?? []).map((m: any) => {
              const prompt = (manifest.prompts ?? []).find((p: any) => p.material === m.path)?.prompt ?? ''
              return { material: m.path, hash: m.hash, prompt, ready: Boolean(prompt.trim()) }
            })
            const ready = plan.filter((item: any) => item.ready).length
            if (!args.confirm) return { ok: false, message: `run_batch requires confirm=true; ${ready}/${plan.length} ready`, plan }
            const missing = plan.filter((item: any) => !item.ready)
            if (missing.length > 0) return { ok: false, message: `${missing.length} material(s) lack a confirmed prompt`, plan }
            return {
              ok: true,
              message: `submission plan ready (${plan.length} item(s)): call generate_video per item with images=[material], prompt, duration=${manifest.duration}, ratio=${manifest.ratio}, model_version=${manifest.model}`,
              plan: plan.map((item: any) => ({ images: [item.material], prompt: item.prompt, duration: manifest.duration, ratio: manifest.ratio, model_version: manifest.model })),
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
