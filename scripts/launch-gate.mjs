#!/usr/bin/env node
/**
 * launch-gate CLI (生成启动门) — 人 / Agent 共用的票据门。
 *
 * 命令：
 *   node scripts/launch-gate.mjs plan --json plan.json   # Agent 写计划（不花钱、不启动）
 *   node scripts/launch-gate.mjs approve --plan pl_xxx   # 真人：真实终端 + 输入确认词 → 一次性票据
 *   node scripts/launch-gate.mjs list                    # 计划与票据状态
 *   node scripts/launch-gate.mjs revoke --ticket lt_xxx  # 作废未使用的票据
 *
 * approve 要求 TTY（process.stdin.isTTY === true）：Agent / 后台进程没有终端，
 * 物理上无法批准启动。票据是一次性的，30 分钟过期，范围（工具 / 项数 / 总时长）锁定。
 *
 * 状态：<cwd>/.dsh-media-private/launch-gate/state.json（与插件 privateRoot 一致）。
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** 自身路径：提示里给出可直接复制的绝对命令。 */
const SELF = fileURLToPath(import.meta.url)

const PHRASE = '自动开始任务'
const DEFAULT_TTL_MS = 30 * 60 * 1000
const MAX_TTL_MS = 6 * 60 * 60 * 1000

function argValue(name, fallback) {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1]
  const eq = argv.find((item) => item.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  return fallback
}

function privateRoot() {
  const explicit = argValue('private', undefined)
  if (explicit) return resolve(explicit)
  return join(process.cwd(), '.dsh-media-private')
}

function statePath(root) {
  return join(root, 'launch-gate', 'state.json')
}

function shortId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function readState(root) {
  const path = statePath(root)
  if (!existsSync(path)) return { version: 1, plans: [], tickets: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    return {
      version: 1,
      plans: Array.isArray(raw?.plans) ? raw.plans : [],
      tickets: Array.isArray(raw?.tickets) ? raw.tickets : [],
    }
  } catch {
    return { version: 1, plans: [], tickets: [] }
  }
}

function writeState(root, state) {
  const path = statePath(root)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, plans: state.plans.slice(-50), tickets: state.tickets.slice(-100) }, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

function say(line = '') {
  process.stdout.write(`${line}\n`)
}

function scopeText(scope) {
  const parts = []
  if (Number.isFinite(scope?.maxItems)) parts.push(`最多 ${scope.maxItems} 项`)
  if (Number.isFinite(scope?.maxDurationSeconds)) parts.push(`总时长 ≤ ${scope.maxDurationSeconds}s`)
  return parts.join('，') || '范围未声明'
}

function loadPlanFile(file) {
  const text = (file === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(file), 'utf8')).replace(/^\uFEFF/, '')
  const raw = JSON.parse(text)
  const scope = raw?.scope ?? {}
  return {
    tool: String(raw?.tool ?? '').trim(),
    title: raw?.title ? String(raw.title) : undefined,
    scope: {
      maxItems: Math.max(1, Math.floor(Number(scope.maxItems ?? raw?.max_items ?? 1))),
      maxDurationSeconds:
        scope.maxDurationSeconds === undefined && raw?.max_duration_seconds === undefined
          ? undefined
          : Math.max(0, Math.floor(Number(scope.maxDurationSeconds ?? raw?.max_duration_seconds))),
    },
    summary: Array.isArray(raw?.summary) ? raw.summary.map(String) : raw?.summary ? [String(raw.summary)] : [],
  }
}

function cmdPlan() {
  const file = argValue('json', undefined)
  if (!file) {
    say('用法：node scripts/launch-gate.mjs plan --json <plan.json|->')
    process.exitCode = 2
    return
  }
  let plan
  try {
    plan = loadPlanFile(file)
  } catch (error) {
    say(`计划文件读取失败：${error?.message ?? error}`)
    process.exitCode = 2
    return
  }
  if (!plan.tool) {
    say('计划缺少 tool 字段（生成工具名，如 generate_video / generate_image / batch_image）。')
    process.exitCode = 2
    return
  }
  const root = privateRoot()
  const state = readState(root)
  const record = {
    id: shortId('pl'),
    createdAt: new Date().toISOString(),
    tool: plan.tool,
    title: plan.title,
    scope: plan.scope,
    summary: plan.summary,
    status: 'pending',
  }
  state.plans.push(record)
  writeState(root, state)
  say(`计划已登记：${record.id}（工具 ${record.tool}，${scopeText(record.scope)}）`)
  if (record.summary.length > 0) {
    say('清单：')
    for (const line of record.summary) say(`  - ${line}`)
  }
  say('')
  say('下一步（必须由用户本人执行）：')
  say(`  node "${SELF}" ask --plan ${record.id}`)
  say('  （会弹出一个终端窗口；也可以自己开终端运行 approve --plan ' + record.id + '）')
  say(`然后在真实终端里输入「${PHRASE}」。`)
}

function ask(rl, question) {
  return new Promise((resolvePromise) => rl.question(question, resolvePromise))
}

async function cmdApprove() {
  const root = privateRoot()
  const state = readState(root)
  const wanted = argValue('plan', undefined)
  const pending = state.plans.filter((plan) => plan.status === 'pending')
  const plan = wanted ? state.plans.find((item) => item.id === wanted) : pending[pending.length - 1]
  if (!plan) {
    say(wanted ? `找不到计划 ${wanted}` : '没有待批准的计划：先让 Agent 运行 plan 写入计划。')
    process.exitCode = 3
    return
  }
  if (plan.status !== 'pending') {
    say(`计划 ${plan.id} 状态是 ${plan.status}，不能再次批准。`)
    process.exitCode = 3
    return
  }
  say('=== 待批准的生成计划 ===')
  say(`计划 id : ${plan.id}`)
  say(`工具    : ${plan.tool}`)
  if (plan.title) say(`标题    : ${plan.title}`)
  say(`范围    : ${scopeText(plan.scope)}`)
  if (Array.isArray(plan.summary) && plan.summary.length > 0) {
    say('清单    :')
    for (const line of plan.summary) say(`  - ${line}`)
  }
  say('========================')
  if (process.stdin.isTTY !== true) {
    say('拒绝：approve 必须在真实终端（TTY）里运行。Agent / 后台进程不能批准启动。')
    process.exitCode = 4
    return
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await ask(rl, `确认启动请输入「${PHRASE}」（其他任何输入都会取消）：`)
    if (String(answer ?? '').trim() !== PHRASE) {
      say('已取消：确认词不匹配，未批准。')
      process.exitCode = 5
      return
    }
  } finally {
    rl.close()
  }
  const ttlMinutes = Number(argValue('ttl-minutes', '30'))
  const ttl = Math.min(Math.max(Number.isFinite(ttlMinutes) ? ttlMinutes * 60_000 : DEFAULT_TTL_MS, 60_000), MAX_TTL_MS)
  const createdAt = new Date()
  const ticket = {
    id: shortId('lt'),
    planId: plan.id,
    tool: plan.tool,
    scope: plan.scope,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttl).toISOString(),
  }
  plan.status = 'approved'
  plan.approvedAt = createdAt.toISOString()
  state.tickets.push(ticket)
  writeState(root, state)
  say('')
  say(`已批准：ticket ${ticket.id}（一次性，有效期至 ${ticket.expiresAt}）`)
  say(`让 Agent 带 launch_ticket=${ticket.id} 调用 ${ticket.tool}；该项提交后票据立即作废。`)
}

function cmdList() {
  const root = privateRoot()
  const state = readState(root)
  const pending = state.plans.filter((plan) => plan.status === 'pending')
  const now = Date.now()
  const valid = state.tickets.filter((ticket) => !ticket.consumedAt && Date.parse(ticket.expiresAt) > now)
  say(`状态文件：${statePath(root)}`)
  say(`待批准计划：${pending.length}`)
  for (const plan of pending) say(`  ${plan.id}  ${plan.tool}  ${scopeText(plan.scope)}${plan.title ? `  ${plan.title}` : ''}`)
  say(`有效票据：${valid.length}`)
  for (const ticket of valid) {
    const minutes = Math.max(0, Math.round((Date.parse(ticket.expiresAt) - now) / 60000))
    say(`  ${ticket.id}  ${ticket.tool}  ${scopeText(ticket.scope)}  剩余 ${minutes} 分钟`)
  }
}

/**
 * 打开一个真实终端窗口执行 approve。
 * Agent 只能"开窗"，确认词必须由人在窗口里敲进去——这正是门的意义。
 */
function cmdAsk() {
  const root = privateRoot()
  const planId = argValue('plan', undefined)
  const state = readState(root)
  const pending = state.plans.filter((plan) => plan.status === 'pending')
  const plan = planId ? state.plans.find((item) => item.id === planId) : pending[pending.length - 1]
  if (!plan) {
    say('没有待批准的计划：先让 Agent 运行 plan。')
    process.exitCode = 3
    return
  }
  const inner = `node "${SELF}" approve --plan ${plan.id} --private "${root}"`
  say(`待你确认：${plan.id}  ${plan.tool}  ${scopeText(plan.scope)}`)
  for (const line of plan.summary ?? []) say(`  - ${line}`)
  if (process.platform === 'win32') {
    const res = spawnSync('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoLogo', '-NoExit', '-Command', inner], {
      stdio: 'ignore',
      windowsHide: false,
    })
    if (res.error) {
      say(`打开终端失败：${res.error.message}\n请手动运行：\n  ${inner}`)
      process.exitCode = 6
      return
    }
    say('已打开终端窗口：请在里面输入「' + PHRASE + '」。')
  } else {
    say(`请在终端里手动运行：\n  ${inner}`)
  }
}

function cmdRevoke() {  const root = privateRoot()
  const id = argValue('ticket', undefined)
  const state = readState(root)
  const ticket = state.tickets.find((item) => item.id === id)
  if (!ticket) {
    say(`找不到票据 ${id}`)
    process.exitCode = 3
    return
  }
  if (ticket.consumedAt) {
    say(`票据 ${id} 已用过（${ticket.consumedAt}），无需作废。`)
    return
  }
  ticket.consumedAt = new Date().toISOString()
  ticket.usedBy = { at: ticket.consumedAt, items: 0, detail: 'revoked' }
  writeState(root, state)
  say(`已作废票据 ${id}。`)
}

async function main() {
  const command = process.argv[2]
  switch (command) {
    case 'plan':
      cmdPlan()
      return
    case 'approve':
      await cmdApprove()
      return
    case 'ask':
      cmdAsk()
      return
    case 'list':
      cmdList()
      return
    case 'revoke':
      cmdRevoke()
      return
    default:
      say('用法：')
      say('  node scripts/launch-gate.mjs plan --json <plan.json|->')
      say('  node scripts/launch-gate.mjs ask [--plan pl_xxx]        # 打开终端窗口，由用户输入确认词')
      say('  node scripts/launch-gate.mjs approve [--plan pl_xxx] [--ttl-minutes 30]   # 必须在 TTY 里')
      say('  node scripts/launch-gate.mjs list')
      say('  node scripts/launch-gate.mjs revoke --ticket lt_xxx')
      process.exitCode = 2
  }
}

await main()
