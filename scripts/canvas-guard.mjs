#!/usr/bin/env node
/**
 * canvas-guard — `dreamina-canvas` 的执行层守卫（2026-11-05 事故后新增）
 *
 * 背景：启动门（launch-gate）原本只装在 `dreamina_canvas` 工具层，可 Agent 直接用
 * PowerShell 调 `dreamina-canvas.exe node run` 就绕过去了（真实事故：连扣 3 次，
 * 工具层门禁一次都没触发）。门禁必须跟着**可执行层**走，所以这里在 CLI 外面包一层。
 *
 * 安装方式（见 scripts/install-canvas-guard.ps1）：
 *   1. 官方二进制改名为 `dreamina-canvas.real.exe`
 *   2. 本脚本以 `dreamina-canvas.cmd` 落在同目录（.cmd 需在 PATHEXT 里能命中，
 *      且不能有同名 .exe，否则会优先命中真二进制）
 *   3. 直调 `dreamina-canvas` 时先过本守卫，再转给 `dreamina-canvas.real.exe`
 *
 * 规则：
 *   - 只拦**付费视频提交**：`node run` / 带 `--run`；`upscale` 与图片节点放行。
 *   - 放行条件：环境变量 `DSH_LAUNCH_TICKET`（由 `dreamina_canvas` 工具在校验票据后注入）
 *     指向一张**未消费、未过期、工具匹配**的一次性票据 —— 守卫在此**消费**它。
 *   - 直调 CLI 的人既没有这个环境变量、也拿不到票据 id，直接拒绝。
 *
 * 这不是防恶意（同权限进程总能找真二进制），而是让「顺手直调」这条路不存在，
 * 并让每一次付费提交都必须先经过真人在终端 approve 的一次性票据。
 */
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const LAUNCH_PHRASE_UNUSED = '自动开始任务'
const GATE_DIR = 'launch-gate'
const GATE_STATE = 'state.json'
const TOOL = process.env.DSH_LAUNCH_TOOL || 'dreamina_canvas'

const argv = process.argv.slice(2)

function isGatedCall(list) {
  const isNodeRun = list[0] === 'node' && list[1] === 'run'
  const hasRunFlag = list.includes('--run')
  if (!isNodeRun && !hasRunFlag) return false
  if (list.includes('upscale')) return false
  if (list.includes('image') && !list.includes('video')) return false
  return true
}

function refuse(message) {
  const envelope = {
    schemaVersion: '1',
    ok: false,
    error: {
      code: 'launch_gate.guard_required',
      class: 'confirmation_required',
      message,
      retryable: false,
      requiredAction: 'launch_gate',
    },
    guard: { layer: 'canvas-guard', tool: TOOL },
  }
  process.stderr.write(JSON.stringify(envelope) + '\n')
  process.exit(2)
}

async function readState(path) {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      version: 1,
      plans: Array.isArray(parsed?.plans) ? parsed.plans : [],
      tickets: Array.isArray(parsed?.tickets) ? parsed.tickets : [],
    }
  } catch {
    return { version: 1, plans: [], tickets: [] }
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const payload = JSON.stringify(state, null, 2) + '\n'
  const tmp = `${path}.tmp-guard-${process.pid}-${Date.now()}`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, path)
}

async function consumeTicket() {
  const privateRoot = String(process.env.DSH_LAUNCH_PRIVATE_ROOT || '').trim()
  if (!privateRoot) {
    refuse('执行层守卫：缺少 DSH_LAUNCH_PRIVATE_ROOT，无法校验启动票据。请通过 dreamina_canvas 工具调用。')
  }
  const ticketId = String(process.env.DSH_LAUNCH_TICKET || '').trim()
  if (!ticketId) {
    refuse(
      '执行层守卫：付费视频提交必须带真人在终端 approve 的一次性票据。' +
        '直接调用 dreamina-canvas 不经过票据校验，已被拒绝。' +
        '请改用 dreamina_canvas 工具并带 launch_ticket=<ticket_id>。',
    )
  }
  const statePath = join(privateRoot, GATE_DIR, GATE_STATE)
  const state = await readState(statePath)
  const ticket = state.tickets.find((t) => t && t.id === ticketId)
  if (!ticket) return refuse(`执行层守卫：启动票据 ${ticketId} 不存在。`)
  if (ticket.consumedAt) return refuse(`执行层守卫：启动票据 ${ticketId} 已被使用（${ticket.consumedAt}），一次性票据不可复用。`)
  if (ticket.tool !== TOOL) return refuse(`执行层守卫：票据 ${ticketId} 是给 ${ticket.tool} 的，不能用于 ${TOOL}。`)
  if (Date.now() > Date.parse(ticket.expiresAt)) return refuse(`执行层守卫：票据 ${ticketId} 已于 ${ticket.expiresAt} 过期。`)
  ticket.consumedAt = new Date().toISOString()
  ticket.usedBy = {
    at: ticket.consumedAt,
    items: 1,
    detail: `canvas-guard ${argv.slice(0, 2).join(' ')}`,
  }
  await writeState(statePath, state)
  return ticket
}

function resolveRealBinary() {
  const fromEnv = String(process.env.DSH_CANVAS_REAL || '').trim()
  if (fromEnv) return fromEnv
  const candidates = [
    join(dirname(process.execPath), 'dreamina-canvas.real.exe'),
    join(homedir(), 'bin', 'dreamina-canvas.real.exe'),
  ]
  return candidates
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function forward(binary) {
  const child = spawn(binary, argv, { stdio: 'inherit', env: process.env })
  const code = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)))
  process.exit(code)
}

const main = async () => {
  if (isGatedCall(argv)) {
    await consumeTicket()
  }
  const resolved = resolveRealBinary()
  const candidates = Array.isArray(resolved) ? resolved : [resolved]
  for (const candidate of candidates) {
    if (await exists(candidate)) return forward(candidate)
  }
  refuse(
    '执行层守卫：找不到官方 CLI（dreamina-canvas.real.exe）。' +
      '请先运行 scripts/install-canvas-guard.ps1 完成安装，或设置 DSH_CANVAS_REAL 指向真二进制。',
  )
}

main().catch((error) => {
  process.stderr.write(`canvas-guard 异常: ${error?.message ?? error}\n`)
  process.exit(1)
})
