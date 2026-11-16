/**
 * 会被 Host 退出流程主动终止的子进程登记表。
 *
 * 桌面更新只有在 Host「自己」以 0 退出并确认 shutdown 之后才安装；一个还在跑的
 * CLI 子进程（即梦画布 CLI、ffmpeg）会像未清理的定时器一样拖住进程，让桌面壳在
 * 10 秒后强杀并判为「不干净停止」。
 *
 * 登记表挂在 globalThis 的符号上：tsdown 把每个入口打成独立 bundle，模块级变量
 * 不会跨 bundle 共享，只有 globalThis 在同一个 Host 进程内是同一份。
 *
 * @module dsh-media-plugins/shared/host-resources
 */

import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'

interface ChildRegistry {
  children: Set<ChildProcess>
}

const REGISTRY_KEY = Symbol.for('dsh-media-plugins.host-resources')

function registry(): ChildRegistry {
  const host = globalThis as unknown as Record<symbol, ChildRegistry | undefined>
  const existing = host[REGISTRY_KEY]
  if (existing !== undefined) return existing
  const created: ChildRegistry = { children: new Set() }
  host[REGISTRY_KEY] = created
  return created
}

/** Register a child so a Host shutdown can stop it instead of waiting it out. */
export function trackChild(child: ChildProcess): void {
  const { children } = registry()
  children.add(child)
  const forget = (): void => {
    children.delete(child)
  }
  child.once('close', forget)
  child.once('error', forget)
}

/** Terminate every tracked child; called on the Desktop shell's shutdown request. */
export function killTrackedChildren(): void {
  const { children } = registry()
  for (const child of [...children]) {
    try {
      child.kill()
    } catch {
      // Already gone; nothing to stop.
    }
    children.delete(child)
  }
}

/**
 * `execFile` whose child is registered for shutdown termination.
 *
 * Behavior matches `promisify(execFile)`: resolve `{ stdout, stderr }`, reject
 * with the exec error carrying `code`/`stdout`/`stderr`.
 */
export function execFileTracked(
  binary: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, [...args], options, (error, stdout, stderr) => {
      if (error !== null) {
        const enriched = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
        enriched.stdout = stdout
        enriched.stderr = stderr
        reject(enriched)
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr ?? '') })
    })
    trackChild(child)
  })
}
