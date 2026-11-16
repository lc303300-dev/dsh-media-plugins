/**
 * Desktop Host 退出保险（host-exit-guard）。
 *
 * Electron 桌面壳只有在 Host「自己」以退出码 0 结束、且此前已回送
 * shutdown-complete 时，才认为更新交接是干净的；否则它等 10 秒后用 SIGTERM
 * 强杀，并弹「未能安全停止任务，更新尚未安装，请稍后重试。」——应用内更新
 * 因此永远装不上。
 *
 * Host 自身的 shutdown 有 5 秒硬超时：dispose 超过 5 秒会直接 process.exit(0)
 * 且来不及回送确认。所以这里只做兜底：收到桌面壳通过 IPC 发来的 shutdown 后
 * 等 7 秒（大于 dispose 预算、小于壳的期限），若进程仍被某个残留句柄（插件定时器、
 * 子进程、socket）拖住，就以 0 退出。此时 shutdown-complete 早已送达，壳看到的
 * 是干净停止；正常退出（通常 <1 秒）完全不受影响。
 *
 * 只在收到 shutdown 时武装；主进程崩溃/断开时不会抢先退出，以免截断会话落盘。
 *
 * @module dsh-media-plugins/host-exit-guard
 */

import { killTrackedChildren } from './shared/host-resources.ts'

export const name = 'Ws_host-exit-guard'

/** dispose 预算 5 秒，桌面壳最多等 10 秒；取中间值兜底。 */
const EXIT_GRACE_MS = 7_000

let installed = false

export function apply(): void {
  if (installed) return
  installed = true
  process.on('message', (message: unknown) => {
    const type = (message as { type?: unknown } | null)?.type
    if (type !== 'shutdown') return
    // Stop CLI children (dreamina-canvas, ffmpeg) that would otherwise hold the
    // process open past the shell's deadline, then arm the last-resort exit.
    killTrackedChildren()
    const timer = setTimeout(() => {
      // shutdown-complete 已发出；残留句柄不能把一次成功的更新拖成「不干净停止」。
      process.exit(0)
    }, EXIT_GRACE_MS)
    timer.unref?.()
  })
}
