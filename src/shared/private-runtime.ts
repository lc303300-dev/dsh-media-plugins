/**
 * Private media runtime: the DSH counterpart of `.codex-image-private`.
 *
 * Everything sensitive or disposable (task stores, locks, logs, caches,
 * normalized inputs, validation artifacts) lives under one private root
 * (default `<workspace>/.dsh-media-private/`) and never enters Git or chat.
 *
 * @module dsh-media-plugins/shared/private-runtime
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Default private root name inside the workspace. */
export const DEFAULT_PRIVATE_DIR = '.dsh-media-private'

/** Resolve the configured private root against the workspace. */
export function resolvePrivateRoot(workspaceRoot: string, configured?: string): string {
  if (configured && configured.trim().length > 0) {
    return isAbsolute(configured) ? configured : join(workspaceRoot, configured)
  }
  return join(workspaceRoot, DEFAULT_PRIVATE_DIR)
}

/** Recursively ensure a directory exists. */
export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  return path
}

/** Atomically write a UTF-8 JSON file (tmp + rename). */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await ensureDir(path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))))
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Read a JSON file; return undefined when missing or corrupt. */
export async function readJsonSafe(path: string): Promise<any | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Atomic text write (used for logs; appends use a separate helper). */
export async function atomicWriteText(path: string, text: string): Promise<void> {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  await ensureDir(path.slice(0, Math.max(0, slash)))
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** SHA-256 of a file's bytes (material hashing / integrity locks). */
export async function sha256File(path: string): Promise<string> {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

/** Safe prompt record: never store the raw prompt outside the task request. */
export function redactPrompt(prompt: string): { value: '<redacted>'; characters: number; sha256: string } {
  return { value: '<redacted>', characters: prompt.length, sha256: sha256Text(prompt) }
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'needs_review'
  | 'cancelled'
  | 'abandoned'

export interface AttemptRecord {
  adapter: string
  model?: string
  status: 'success' | 'skipped' | 'failed' | 'timeout'
  failureClass?: string
  durationMs?: number
  reason?: string
}

export interface TaskRecord {
  taskId: string
  batchId: string
  createdAt: string
  updatedAt: string
  status: TaskStatus
  kind: 'image' | 'video' | 'batch-item' | 'gif'
  provider?: string
  model?: string
  submitId?: string
  outputPath?: string
  failureClass?: string
  failureMessage?: string
  attempts: AttemptRecord[]
  nextAction?: 'none' | 'user_check_backend' | 'query_later' | 'retry_manual'
  requestHash: string
}

const ALLOWED_TRANSITIONS: Readonly<Record<string, ReadonlyArray<TaskStatus>>> = {
  pending: ['running', 'cancelled', 'abandoned'],
  running: ['success', 'failed', 'needs_review', 'cancelled', 'abandoned'],
  success: [],
  failed: [],
  needs_review: [],
  cancelled: [],
  abandoned: [],
}

/**
 * Task store under `<private>/jobs/<batchId>/<taskId>/` with
 * request.json / state.json / result.json, atomic writes and validated
 * state transitions. Idempotent by taskId; recovery reads state.json.
 */
export class TaskStore {
  readonly jobsRoot: string

  constructor(jobsRoot: string) {
    this.jobsRoot = jobsRoot
  }

  async taskDir(batchId: string, taskId: string): Promise<string> {
    return ensureDir(join(this.jobsRoot, batchId, taskId))
  }

  async create(batchId: string, taskId: string, kind: TaskRecord['kind'], request: unknown): Promise<TaskRecord> {
    const dir = await this.taskDir(batchId, taskId)
    const now = new Date().toISOString()
    const record: TaskRecord = {
      taskId,
      batchId,
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      kind,
      attempts: [],
      nextAction: 'none',
      requestHash: sha256Text(JSON.stringify(request ?? {})),
    }
    await atomicWriteJson(join(dir, 'request.json'), request ?? {})
    await atomicWriteJson(join(dir, 'state.json'), record)
    return record
  }

  async load(batchId: string, taskId: string): Promise<TaskRecord | undefined> {
    return readJsonSafe(join(this.jobsRoot, batchId, taskId, 'state.json'))
  }

  async transition(
    batchId: string,
    taskId: string,
    to: TaskStatus,
    patch?: Partial<TaskRecord>,
  ): Promise<TaskRecord> {
    const current = (await this.load(batchId, taskId)) ?? {
      taskId,
      batchId,
      createdAt: new Date().toISOString(),
      status: 'pending' as TaskStatus,
      kind: 'image' as const,
      attempts: [],
    }
    const allowed = ALLOWED_TRANSITIONS[current.status] ?? []
    // self-transition (running -> running) is a patch update, not a state change
    if (to !== current.status && !allowed.includes(to)) {
      throw new Error(`invalid task transition ${current.status} -> ${to} for ${taskId}`)
    }
    const next: TaskRecord = {
      ...current,
      ...patch,
      status: to,
      updatedAt: new Date().toISOString(),
    }
    await atomicWriteJson(join(this.jobsRoot, batchId, taskId, 'state.json'), next)
    return next
  }

  async saveResult(batchId: string, taskId: string, result: unknown): Promise<void> {
    await atomicWriteJson(join(this.jobsRoot, batchId, taskId, 'result.json'), result)
  }

  async listTasks(batchId: string): Promise<string[]> {
    const dir = join(this.jobsRoot, batchId)
    try {
      return await readdir(dir)
    } catch {
      return []
    }
  }
}

export interface SlotLeaseOptions {
  taskId: string
  timeoutMs: number
  pollMs?: number
  /** Staleness threshold; locks older than this are reclaimed. */
  staleMs?: number
}

/**
 * Cross-process slot lease via atomic exclusive file creation
 * (O_CREAT | O_EXCL), the DSH/JS counterpart of the blueprint's
 * `.codex-image-private/locks/providers/<capacity-key>/slot-N.lock`.
 * Returns an async release function or throws MediaError on timeout.
 */
export async function acquireSlot(
  lockRoot: string,
  capacityKey: string,
  maxSlots: number,
  options: SlotLeaseOptions,
): Promise<() => Promise<void>> {
  const { taskId, timeoutMs, pollMs = 250, staleMs = 10 * 60 * 1000 } = options
  const dir = await ensureDir(join(lockRoot, 'providers', capacityKey))
  const started = Date.now()

  const tryAcquire = async (): Promise<string | undefined> => {
    for (let n = 1; n <= maxSlots; n += 1) {
      const path = join(dir, `slot-${n}.lock`)
      try {
        const handle = await open(path, 'wx', 0o600)
        const payload = JSON.stringify({ pid: process.pid, taskId, createdAt: Date.now(), heartbeat: Date.now() })
        await handle.writeFile(payload, 'utf8')
        await handle.close()
        return path
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error
        // stale cleanup: reclaim if older than threshold
        try {
          const st = await readFile(path, 'utf8')
          const meta = JSON.parse(st)
          if (Date.now() - (meta.heartbeat ?? meta.createdAt ?? 0) > staleMs) {
            await unlink(path)
            // retry this slot once
            const retry = await open(path, 'wx', 0o600)
            const payload = JSON.stringify({ pid: process.pid, taskId, createdAt: Date.now(), heartbeat: Date.now() })
            await retry.writeFile(payload, 'utf8')
            await retry.close()
            return path
          }
        } catch {
          // unreadable lock file: treat as busy, move on
        }
      }
    }
    return undefined
  }

  for (;;) {
    const acquired = await tryAcquire()
    if (acquired) {
      const release = async (): Promise<void> => {
        try {
          await unlink(acquired)
        } catch {
          /* already released */
        }
      }
      return release
    }
    if (Date.now() - started >= timeoutMs) {
      const err: any = new Error(`no free slot on capacity "${capacityKey}" within ${Math.round(timeoutMs / 1000)}s (task ${taskId})`)
      err.cls = 'concurrency_busy'
      throw err
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/** Remove lock files whose owning PID is gone (best-effort). */
export async function cleanupStaleLocks(lockRoot: string, capacityKey: string): Promise<number> {
  const dir = join(lockRoot, 'providers', capacityKey)
  let removed = 0
  try {
    const files = await readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.lock')) continue
      const path = join(dir, file)
      try {
        const meta = JSON.parse(await readFile(path, 'utf8'))
        if (typeof meta.pid === 'number' && !isPidAlive(meta.pid)) {
          await unlink(path)
          removed += 1
        }
      } catch {
        /* unreadable -> leave */
      }
    }
  } catch {
    /* no lock dir */
  }
  return removed
}

/** Best-effort PID liveness check (works cross-process on Windows too). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === 'EPERM'
  }
}

/** Append one safe JSON log line to `<private>/logs/<name>.log`. */
export async function appendSafeLog(privateRoot: string, name: string, entry: Record<string, unknown>): Promise<void> {
  const dir = await ensureDir(join(privateRoot, 'logs'))
  const path = join(dir, `${name}.log`)
  await ensureDir(join(privateRoot, 'logs'))
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
  await writeFile(path, line, { flag: 'a' })
}

/** Allocate a stable task id (uuid without dashes). */
export function newTaskId(): string {
  return randomUUID().replaceAll('-', '')
}

export { fsConstants }
