/**
 * Batch image scheduler tool (Codex_Batch_Image rebuild): deterministic
 * grouped candidate generation with a stable job key, SQLite task state,
 * bounded concurrency (1..10), >=1 s real-submit spacing, a hard deadline
 * (default ceil(total/concurrency)*60s*1.5) after which unfinished tasks
 * are permanently abandoned (never queried/retried), and a numbered
 * contact sheet for human review. All paid calls go through the unified
 * media router; the same candidate is never submitted twice.
 *
 * @module @deepseek-ai/dsh-tool-batch-image
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, isAbsolute, dirname } from 'node:path'
import {
  buildContactSheetHtml,
  computeDeadline,
  flattenTasks,
  validateManifest,
  type BatchManifest,
} from './shared/batch-core.ts'
import { runImageRouter, type RouterConfig } from './shared/adapters.ts'
import { appendSafeLog, ensureDir, resolvePrivateRoot, sha256Text } from './shared/private-runtime.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-batch-image'
export const inject = ['tools']

export interface Config {
  privateDir?: string
  outputDir?: string
  comflyBaseURL?: string
  comflyApiKeyEnv?: string
  apimartBaseURL?: string
  apimartApiKeyEnv?: string
  geminiApiURL?: string
  geminiApiKeyEnv?: string
  dreaminaPath?: string
  proxyUrl?: string
  maxConcurrency?: number
  providerTimeoutMs?: number
  taskTimeoutMs?: number
  enabled?: string[]
}

export const Config: z<Config> = z.object({
  privateDir: z.string().default(''),
  outputDir: z.string().default('outputs'),
  comflyBaseURL: z.string().default('https://ai.comfly.org/v1'),
  comflyApiKeyEnv: z.string().default('COMFLY_API_KEY'),
  apimartBaseURL: z.string().default('https://api.apimart.ai/v1'),
  apimartApiKeyEnv: z.string().default('APIMART_API_KEY'),
  geminiApiURL: z.string().default('https://generativelanguage.googleapis.com/v1beta/interactions'),
  geminiApiKeyEnv: z.string().default('GEMINI_API_KEY'),
  dreaminaPath: z.string().default('dreamina'),
  proxyUrl: z.string().default(''),
  maxConcurrency: z.number().default(6),
  providerTimeoutMs: z.number().default(120000),
  taskTimeoutMs: z.number().default(300000),
  enabled: z.array(z.string()).default([]),
})

type ResolvedConfig = Required<Config>

interface TaskRow {
  task_id: string
  group_id: string
  slot: number
  prompt: string
  ratio: string
  status: string
}

function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_key TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, status TEXT NOT NULL,
      total INTEGER NOT NULL, concurrency INTEGER NOT NULL, estimate_seconds INTEGER NOT NULL,
      deadline_seconds INTEGER NOT NULL, landed INTEGER DEFAULT 0, abandoned INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      job_key TEXT NOT NULL, task_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, slot INTEGER NOT NULL,
      prompt TEXT NOT NULL, ratio TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT, finished_at TEXT, output_path TEXT, error TEXT, provider TEXT, model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_key);
  `)
  return db
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function apply(ctx: Context, config: ResolvedConfig): void {
  const routerConfig: RouterConfig = {
    comflyBaseURL: config.comflyBaseURL,
    comflyApiKeyEnv: config.comflyApiKeyEnv,
    apimartBaseURL: config.apimartBaseURL,
    apimartApiKeyEnv: config.apimartApiKeyEnv,
    geminiApiURL: config.geminiApiURL,
    geminiApiKeyEnv: config.geminiApiKeyEnv,
    dreaminaPath: config.dreaminaPath,
    proxyUrl: config.proxyUrl,
    maxConcurrency: config.maxConcurrency,
    providerTimeoutMs: config.providerTimeoutMs,
    taskTimeoutMs: config.taskTimeoutMs,
    outputDir: config.outputDir,
    enabled: config.enabled,
  }

  ctx.tools.register(
    defineTool({
      name: 'batch_image',
      description:
        '确定性批量图片调度器（Codex_Batch_Image 的 DSH 重建）：manifest（组 id 唯一、每组 prompt 非空、candidates ≥ 1、image_ratio 必填 8 值之一）→ 稳定 job key → SQLite 状态 → 最多 10 路并发、真实提交间隔 ≥ 1 秒 → 硬截止（默认 ceil(总数÷并发)×60 秒×1.5，可用 deadline_seconds 覆盖）→ 截止后未完成任务永久 abandoned（不查询、不重试），只收集已落地成功 → 生成固定槽位编号联系表供人工选图。付费执行全部走统一媒体路由器；同一候选绝不重复提交（job key + 任务 id 幂等）。',
      parameters: {
        command: {
          type: 'string',
          enum: ['start', 'status', 'contact_sheet', 'list'],
          required: true,
          description: '操作命令。',
        },
        manifest: {
          type: 'object',
          additionalProperties: true,
          description: 'start 用：{groups: [{id, prompt, candidates, image_ratio}], concurrency?, deadline_seconds?}；或传 manifest_path。',
        },
        manifest_path: { type: 'string', description: 'start 用：manifest JSON 文件路径（UTF-8）。' },
        job_key: { type: 'string', description: 'status/contact_sheet 用：稳定 job key。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string' },
            job_key: { type: 'string' },
            plan: { type: 'object', additionalProperties: true },
            summary: { type: 'object', additionalProperties: true },
            contact_sheet_path: { type: 'string' },
            jobs: { type: 'array' },
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
        const db = openDb(join(privateRoot, 'batch', 'batch.db'))

        try {
          if (command === 'list') {
            const rows = db.prepare('SELECT job_key, status, total, landed, abandoned, created_at, finished_at FROM jobs ORDER BY created_at DESC LIMIT 50').all()
            return { ok: true, message: `${rows.length} job(s)`, jobs: rows }
          }

          if (command === 'start') {
            let raw: unknown
            if (args.manifest_path) {
              const path = isAbsolute(args.manifest_path) ? args.manifest_path : join(workspaceRoot, args.manifest_path)
              const { readFile } = await import('node:fs/promises')
              raw = JSON.parse(await readFile(path, 'utf8'))
            } else {
              raw = args.manifest
            }
            const manifest: BatchManifest = validateManifest(raw)
            const plan = computeDeadline(manifest)
            const existing = db.prepare('SELECT * FROM jobs WHERE job_key = ?').get(plan.jobKey)
            if (existing) {
              return { ok: false, message: `job ${plan.jobKey} already exists (${existing.status}); stable job key prevents duplicate submission`, job_key: plan.jobKey, summary: existing }
            }
            const now = new Date().toISOString()
            db.prepare('INSERT INTO jobs (job_key, manifest_json, status, total, concurrency, estimate_seconds, deadline_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(plan.jobKey, JSON.stringify(manifest), 'running', plan.total, plan.concurrency, plan.estimateSeconds, plan.deadlineSeconds, now)
            const insertTask = db.prepare('INSERT OR IGNORE INTO tasks (job_key, task_id, group_id, slot, prompt, ratio, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
            for (const t of flattenTasks(manifest)) {
              insertTask.run(plan.jobKey, `${plan.jobKey}-${t.groupId}-${t.slot}`, t.groupId, t.slot, t.prompt, t.ratio, 'pending')
            }
            // detached scheduler loop: runs in the host process, writes state only
            runScheduler(db, plan.jobKey, manifest, plan.deadlineAtMs, privateRoot, routerConfig, config.outputDir, workspaceRoot).catch((error: any) => {
              db.prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE job_key = ?").run(new Date().toISOString(), plan.jobKey)
              void appendSafeLog(privateRoot, 'batch_image', { jobKey: plan.jobKey, event: 'scheduler_crashed', detail: String(error?.message ?? error).slice(0, 300) })
            })
            return {
              ok: true,
              message: `batch ${plan.jobKey} started: ${plan.total} candidate(s), concurrency ${plan.concurrency}, estimate ${plan.estimateSeconds}s, deadline ${plan.deadlineSeconds}s; scheduler runs in background, poll status`,
              job_key: plan.jobKey,
              plan: { ...plan, deadlineAtMs: undefined },
            }
          }

          if (!args.job_key) return { ok: false, message: 'job_key is required' }
          const job = db.prepare('SELECT * FROM jobs WHERE job_key = ?').get(args.job_key) as any
          if (!job) return { ok: false, message: `job not found: ${args.job_key}` }

          if (command === 'status') {
            const tasks = db.prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE job_key = ? GROUP BY status').all(args.job_key)
            const summary: Record<string, number> = {}
            for (const t of tasks) summary[t.status] = t.n
            const landed = db.prepare("SELECT output_path FROM tasks WHERE job_key = ? AND status = 'success'").all(args.job_key)
            return { ok: true, message: `job ${args.job_key}: ${job.status} (landed ${job.landed}/${job.total})`, summary: { ...summary, landed: job.landed, abandoned: job.abandoned, status: job.status }, contact_sheet_path: undefined }
          }

          if (command === 'contact_sheet') {
            const manifest = JSON.parse(job.manifest_json) as BatchManifest
            const landed = db.prepare("SELECT group_id, slot, output_path AS path FROM tasks WHERE job_key = ? AND status = 'success'").all(args.job_key)
            const plan = computeDeadline(manifest, 0)
            const outDir = join(workspaceRoot, config.outputDir)
            await ensureDir(outDir)
            const sheetPath = join(outDir, `contact-${args.job_key}.html`)
            await writeFile(sheetPath, buildContactSheetHtml({ ...plan, deadlineAtMs: job.deadline_seconds }, manifest.groups, landed), 'utf8')
            return { ok: true, message: `contact sheet: ${sheetPath}`, contact_sheet_path: sheetPath, summary: { landed: job.landed, abandoned: job.abandoned, status: job.status } }
          }
          return { ok: false, message: `unknown command: ${command}` }
        } finally {
          db.close()
        }
      },
    }),
  )
}

/** Detached scheduler loop (runs after the tool call returns). */
async function runScheduler(
  db: DatabaseSync,
  jobKey: string,
  manifest: BatchManifest,
  deadlineAtMs: number,
  privateRoot: string,
  routerConfig: RouterConfig,
  outputDir: string,
  workspaceRoot: string,
): Promise<void> {
  const plan = computeDeadline(manifest)
  const pending = db.prepare("SELECT task_id, group_id, slot, prompt, ratio FROM tasks WHERE job_key = ? AND status = 'pending' ORDER BY rowid").all(jobKey) as TaskRow[]
  const inFlight = new Map<string, Promise<void>>()
  let nextSubmitAt = Date.now()

  const runOne = async (task: TaskRow): Promise<void> => {
    db.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE task_id = ?").run(new Date().toISOString(), task.task_id)
    try {
      const outcome = await runImageRouter({
        prompt: task.prompt,
        images: [],
        ratio: task.ratio,
        config: routerConfig,
        workspaceRoot,
        privateRoot,
        taskId: `batch-${jobKey}-${task.group_id}-${task.slot}`,
      })
      const destDir = join(workspaceRoot, outputDir, jobKey, task.group_id)
      await ensureDir(destDir)
      const { copyFile } = await import('node:fs/promises')
      const dest = join(destDir, `${task.group_id}-${String(task.slot).padStart(2, '0')}${outcome.outputPath.slice(outcome.outputPath.lastIndexOf('.')) || '.png'}`)
      await copyFile(outcome.outputPath, dest)
      db.prepare("UPDATE tasks SET status = 'success', finished_at = ?, output_path = ?, provider = ?, model = ? WHERE task_id = ?")
        .run(new Date().toISOString(), dest, outcome.provider, outcome.model, task.task_id)
      db.prepare('UPDATE jobs SET landed = landed + 1 WHERE job_key = ?').run(jobKey)
    } catch (error: any) {
      db.prepare("UPDATE tasks SET status = 'failed', finished_at = ?, error = ? WHERE task_id = ?")
        .run(new Date().toISOString(), String(error?.message ?? error).slice(0, 500), task.task_id)
      db.prepare('UPDATE jobs SET abandoned = abandoned + 1 WHERE job_key = ?').run(jobKey)
    }
  }

  try {
    while ((pending.length > 0 || inFlight.size > 0) && Date.now() < deadlineAtMs) {
      while (inFlight.size < plan.concurrency && pending.length > 0 && Date.now() < deadlineAtMs) {
        const task = pending.shift()!
        // dedupe guard: never re-run a task that already settled
        const settled = db.prepare("SELECT status FROM tasks WHERE task_id = ?").get(task.task_id) as any
        if (settled && settled.status !== 'pending') continue
        const wait = nextSubmitAt - Date.now()
        if (wait > 0) await sleep(wait)
        const promise = runOne(task).finally(() => inFlight.delete(task.task_id))
        inFlight.set(task.task_id, promise)
        nextSubmitAt = Date.now() + 1000 // real submissions >= 1 s apart
      }
      if (inFlight.size > 0) {
        await Promise.race([...inFlight.values()])
      }
    }
    // deadline reached (or queue empty): permanent abandon for everything not landed
    const abandoned = db.prepare("UPDATE tasks SET status = 'abandoned', finished_at = ? WHERE job_key = ? AND status IN ('pending', 'running')").run(new Date().toISOString(), jobKey).changes
    if (abandoned > 0) db.prepare('UPDATE jobs SET abandoned = abandoned + ? WHERE job_key = ?').run(abandoned, jobKey)
    // collect still-in-flight landings (bounded by their own task budgets)
    if (inFlight.size > 0) await Promise.allSettled([...inFlight.values()])
    db.prepare("UPDATE jobs SET status = 'finished', finished_at = ? WHERE job_key = ?").run(new Date().toISOString(), jobKey)
    const landed = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE job_key = ? AND status = 'success'").get(jobKey) as any).n
    db.prepare('UPDATE jobs SET landed = ? WHERE job_key = ?').run(landed, jobKey)
    void appendSafeLog(privateRoot, 'batch_image', { jobKey, event: 'finished', landed, abandoned: (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE job_key = ? AND status = 'abandoned'").get(jobKey) as any).n })
  } finally {
    // no-op: detached loop leaves the DB as the source of truth
  }
}

export { apply }
