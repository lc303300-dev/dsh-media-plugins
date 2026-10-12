/**
 * 画布自动打开（best-effort，纯逻辑 + 可注入执行器）。
 *
 * 官方 dreamina-canvas Skill 的要求：「创建画布成功或进入已有画布后，使用 CLI
 * 返回、与目标画布匹配的 webUrl 打开画布，并立即把可点击链接发给用户」。
 * 本模块负责其中的确定性部分：
 *
 * - **URL 安全**：只接受 https（webUrl 由 CLI 返回，但仍不放任任意 scheme 进
 *   启动器）；
 * - **冷却去重**：同一画布在 `cooldownMs` 内只打开一次 —— 连续生成时反复唤起
 *   浏览器只会打断用户，复用已开标签页没有意义；
 * - **平台命令构造是纯函数**，可直接单测，不必真的开浏览器；
 * - **绝不阻断生成**：打开失败只作为日志事实返回，调用方不得因此失败。
 *
 * @module dsh-media-plugins/shared/canvas-browser
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { atomicWriteJson, readJsonSafe } from './private-runtime.ts'

/** 一次浏览器唤起的命令与参数。 */
export interface BrowserLaunchSpec {
  command: string
  args: string[]
}

/** 冷却窗口默认值：同一画布 10 分钟内只唤起一次。 */
export const DEFAULT_CANVAS_OPEN_COOLDOWN_MS = 10 * 60 * 1000

/** 记录「每个画布上次被打开的时间」的状态文件名（位于私有运行目录）。 */
export const CANVAS_OPEN_STATE_FILE = 'canvas-opened.json'

/**
 * 构造平台相关的打开命令。
 *
 * Windows 用 `cmd /c start "" <url>`：它对带 `&`/`?` 的查询串最稳，且会走用户
 * 的默认浏览器；显式配置 `browserPath` 时优先用它（例如固定用某个已登录即梦的
 * 浏览器配置）。
 */
export function browserLaunchSpec(url: string, options: { platform?: string; browserPath?: string } = {}): BrowserLaunchSpec {
  const platform = options.platform ?? process.platform
  const browser = String(options.browserPath ?? '').trim()
  if (browser.length > 0) return { command: browser, args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  if (platform === 'darwin') return { command: 'open', args: [url] }
  return { command: 'xdg-open', args: [url] }
}

/** 只允许 https 链接进入启动器。 */
export function isSafeCanvasUrl(url: string): boolean {
  const text = String(url ?? '').trim()
  if (text.length === 0) return false
  try {
    return new URL(text).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 冷却判定（纯函数）：没有记录、记录损坏、或已过冷却窗口 → 应该打开。
 */
export function shouldOpenCanvas(state: Record<string, number>, projectId: string, nowMs: number, cooldownMs: number): boolean {
  const last = Number(state?.[projectId])
  if (!Number.isFinite(last)) return true
  if (cooldownMs <= 0) return true
  return nowMs - last >= cooldownMs
}

export interface OpenCanvasOptions {
  /** 私有运行目录（冷却状态落在这里）。 */
  privateRoot: string
  projectId: string
  cooldownMs?: number
  browserPath?: string
  /** 注入的当前时间（单测用）。 */
  now?: number
  /** 注入的启动器（单测用，避免真的开浏览器）。 */
  launch?: (spec: BrowserLaunchSpec) => Promise<void>
}

export interface OpenCanvasResult {
  opened: boolean
  /** 未打开时的原因：unsafe-url / cooldown / launch-failed / no-op。 */
  reason?: string
}

/** 状态文件路径。 */
export function canvasOpenStatePath(privateRoot: string): string {
  return join(privateRoot, CANVAS_OPEN_STATE_FILE)
}

/** 默认启动器：分离子进程，不接管 stdio，也不等待浏览器退出。 */
async function defaultLaunch(spec: BrowserLaunchSpec): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * 按需打开画布：安全校验 → 冷却判定 → 唤起 → 记录时间。
 *
 * 返回 `{opened:false, reason}` 表示「这次不打开」，调用方应当把它当正常情况
 * 处理（记日志即可），绝不能因为打不开画布而让生成失败。
 */
export async function openCanvasInBrowser(webUrl: string, options: OpenCanvasOptions): Promise<OpenCanvasResult> {
  if (!isSafeCanvasUrl(webUrl)) return { opened: false, reason: 'unsafe-url' }

  const cooldownMs = options.cooldownMs ?? DEFAULT_CANVAS_OPEN_COOLDOWN_MS
  const now = options.now ?? Date.now()
  const statePath = canvasOpenStatePath(options.privateRoot)
  const state = ((await readJsonSafe(statePath)) ?? {}) as Record<string, number>

  if (!shouldOpenCanvas(state, options.projectId, now, cooldownMs)) {
    return { opened: false, reason: 'cooldown' }
  }

  const spec = browserLaunchSpec(webUrl, { browserPath: options.browserPath })
  try {
    await (options.launch ?? defaultLaunch)(spec)
  } catch {
    // 唤起失败不写冷却时间：下次仍应再试一次。
    return { opened: false, reason: 'launch-failed' }
  }

  try {
    const next = { ...state, [options.projectId]: now }
    await atomicWriteJson(statePath, next)
  } catch {
    // 状态写不进去不影响「已经打开了」这一事实。
  }
  return { opened: true }
}
