/**
 * Launch gate (生成启动门): no paid generation may start without a one-shot
 * ticket that a human minted **in a real terminal** by typing the confirmation
 * phrase. Agents run without a TTY, so they cannot mint (approve) a ticket
 * themselves — that is the whole point of the gate.
 *
 * Flow:
 *   1. Agent writes a plan file (node ids / prompts / model / ratio / duration).
 *   2. Agent runs: node scripts/launch-gate.mjs plan --json plan.json  → plan id.
 *   3. Human runs: node scripts/launch-gate.mjs approve --plan <id>   (TTY required)
 *      and types 自动开始任务 → one-shot ticket, TTL 30 min, scope-limited.
 *   4. Agent calls the paid tool with launch_ticket=<ticket id>; the tool
 *      verifies tool/scope/expiry and CONSUMES the ticket before submitting.
 *
 * State lives in <privateRoot>/launch-gate/state.json (never in Git).
 *
 * @module dsh-media-plugins/shared/launch-gate
 */

import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir, readJsonSafe } from './private-runtime.ts'

/** The exact phrase a human must type in the terminal. */
export const LAUNCH_PHRASE = '自动开始任务'

/** Ticket lifetime (a ticket is one-shot regardless of TTL). */
export const LAUNCH_TICKET_TTL_MS = 30 * 60 * 1000

export const LAUNCH_GATE_DIR = 'launch-gate'
export const LAUNCH_GATE_STATE_FILE = 'state.json'

export type LaunchPlanStatus = 'pending' | 'approved' | 'revoked'

export interface LaunchScope {
  /** Maximum number of items (tasks / images / nodes) this approval covers. */
  maxItems: number
  /** Optional cap on total video seconds; omitted for image-only approvals. */
  maxDurationSeconds?: number
}

export interface LaunchPlan {
  id: string
  createdAt: string
  tool: string
  title?: string
  scope: LaunchScope
  /** Human-readable lines shown in the approving terminal. */
  summary: string[]
  status: LaunchPlanStatus
  approvedAt?: string
  revokedAt?: string
}

export interface LaunchTicket {
  id: string
  planId: string
  tool: string
  scope: LaunchScope
  createdAt: string
  expiresAt: string
  consumedAt?: string
  usedBy?: {
    at: string
    items: number
    durationSeconds?: number
    detail?: string
  }
}

export interface LaunchGateState {
  version: 1
  plans: LaunchPlan[]
  tickets: LaunchTicket[]
}

export const EMPTY_GATE_STATE: LaunchGateState = { version: 1, plans: [], tickets: [] }

/** `<privateRoot>/launch-gate/state.json`. */
export function launchGateStatePath(privateRoot: string): string {
  return join(privateRoot, LAUNCH_GATE_DIR, LAUNCH_GATE_STATE_FILE)
}

function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** Structural upgrade for state read from disk (tolerates old/partial files). */
export function normalizeGateState(raw: any): LaunchGateState {
  const plans: LaunchPlan[] = Array.isArray(raw?.plans) ? raw.plans.filter((p: any) => p && typeof p.id === 'string') : []
  const tickets: LaunchTicket[] = Array.isArray(raw?.tickets) ? raw.tickets.filter((t: any) => t && typeof t.id === 'string') : []
  return { version: 1, plans, tickets }
}

export async function readGateState(privateRoot: string): Promise<LaunchGateState> {
  return normalizeGateState(await readJsonSafe(launchGateStatePath(privateRoot)))
}

/** Atomic write with a tiny retry loop (agent + CLI may race on one file). */
export async function writeGateState(privateRoot: string, state: LaunchGateState): Promise<void> {
  const path = launchGateStatePath(privateRoot)
  await ensureDir(join(privateRoot, LAUNCH_GATE_DIR))
  const payload = `${JSON.stringify(state, null, 2)}\n`
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, path)
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Keep the state file bounded: last 50 plans, last 100 tickets. */
function prune(state: LaunchGateState): LaunchGateState {
  const plans = state.plans.slice(-50)
  const tickets = state.tickets.slice(-100)
  return { version: 1, plans, tickets }
}

/** Register a plan for human review. Never mints a ticket. */
export async function createLaunchPlan(
  privateRoot: string,
  input: { tool: string; title?: string; scope: LaunchScope; summary: string[] },
): Promise<LaunchPlan> {
  const state = await readGateState(privateRoot)
  const plan: LaunchPlan = {
    id: shortId('pl'),
    createdAt: new Date().toISOString(),
    tool: String(input.tool ?? '').trim(),
    title: input.title ? String(input.title).trim() : undefined,
    scope: {
      maxItems: Math.max(1, Math.floor(Number(input.scope?.maxItems ?? 1))),
      maxDurationSeconds:
        input.scope?.maxDurationSeconds === undefined
          ? undefined
          : Math.max(0, Math.floor(Number(input.scope.maxDurationSeconds))),
    },
    summary: (Array.isArray(input.summary) ? input.summary : []).map((line) => String(line)),
    status: 'pending',
  }
  if (plan.tool.length === 0) throw new Error('plan.tool is required')
  state.plans.push(plan)
  await writeGateState(privateRoot, prune(state))
  return plan
}

export interface ApproveResult {
  ok: boolean
  message: string
  ticket?: LaunchTicket
  plan?: LaunchPlan
}

/**
 * Mint a one-shot ticket for a pending plan. `isTTY` must be true: this is the
 * physical human check — agents (and any non-interactive process) cannot pass it.
 */
export async function approveLaunchPlan(
  privateRoot: string,
  input: { planId?: string; phrase: string; isTTY: boolean; ttlMs?: number },
): Promise<ApproveResult> {
  if (input.isTTY !== true) {
    return {
      ok: false,
      message: 'approve 只能在真实终端里运行（需要 TTY）；Agent / 后台进程没有终端，不能批准启动。',
    }
  }
  if (String(input.phrase ?? '').trim() !== LAUNCH_PHRASE) {
    return { ok: false, message: `确认词不匹配：必须原样输入「${LAUNCH_PHRASE}」，本次未批准。` }
  }
  const state = await readGateState(privateRoot)
  const pending = state.plans.filter((plan) => plan.status === 'pending')
  const plan = input.planId
    ? state.plans.find((item) => item.id === input.planId)
    : pending[pending.length - 1]
  if (!plan) {
    return { ok: false, message: input.planId ? `找不到计划 ${input.planId}` : '没有待批准的计划；先让 Agent 用 plan 写入计划。' }
  }
  if (plan.status !== 'pending') {
    return { ok: false, message: `计划 ${plan.id} 状态是 ${plan.status}，不能批准。` }
  }
  const ttl = Math.min(Math.max(Number(input.ttlMs ?? LAUNCH_TICKET_TTL_MS), 60_000), 6 * 60 * 60 * 1000)
  const createdAt = new Date()
  const ticket: LaunchTicket = {
    id: shortId('lt'),
    planId: plan.id,
    tool: plan.tool,
    scope: { ...plan.scope },
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttl).toISOString(),
  }
  plan.status = 'approved'
  plan.approvedAt = createdAt.toISOString()
  state.tickets.push(ticket)
  await writeGateState(privateRoot, prune(state))
  return { ok: true, message: `已批准：ticket ${ticket.id}（工具 ${ticket.tool}，最多 ${ticket.scope.maxItems} 项），有效期至 ${ticket.expiresAt}。`, ticket, plan }
}

export interface TicketCheck {
  ok: boolean
  message: string
  ticket?: LaunchTicket
}

/** Read-only validity check (no consumption). */
export async function inspectLaunchTicket(
  privateRoot: string,
  input: { ticketId: string; tool: string; items: number; durationSeconds?: number },
): Promise<TicketCheck> {
  const ticketId = String(input.ticketId ?? '').trim()
  if (ticketId.length === 0) {
    return { ok: false, message: '缺少 launch_ticket：付费生成必须带一次性启动票据（由真人在终端 approve 生成）。' }
  }
  const state = await readGateState(privateRoot)
  const ticket = state.tickets.find((item) => item.id === ticketId)
  if (!ticket) return { ok: false, message: `启动票据 ${ticketId} 不存在。` }
  if (ticket.consumedAt) return { ok: false, message: `启动票据 ${ticketId} 已被使用（${ticket.consumedAt}），一次性票据不可复用。` }
  if (ticket.tool !== input.tool) return { ok: false, message: `启动票据 ${ticketId} 是给 ${ticket.tool} 的，不能用于 ${input.tool}。` }
  if (Date.now() > Date.parse(ticket.expiresAt)) return { ok: false, message: `启动票据 ${ticketId} 已于 ${ticket.expiresAt} 过期，请重新批准。` }
  const items = Math.max(1, Math.floor(Number(input.items ?? 1)))
  if (items > ticket.scope.maxItems) {
    return { ok: false, message: `本次 ${items} 项超出票据 ${ticketId} 允许的 ${ticket.scope.maxItems} 项，请重新批准更大范围。` }
  }
  const duration = input.durationSeconds === undefined ? undefined : Number(input.durationSeconds)
  if (duration !== undefined && ticket.scope.maxDurationSeconds !== undefined && duration > ticket.scope.maxDurationSeconds) {
    return { ok: false, message: `本次总时长 ${duration}s 超出票据 ${ticketId} 允许的 ${ticket.scope.maxDurationSeconds}s。` }
  }
  return { ok: true, message: 'ok', ticket }
}

/**
 * Verify the ticket and consume it in the same step. Call this immediately
 * before the paid submit — never earlier, so a rejected call cannot burn it.
 */
export async function consumeLaunchTicket(
  privateRoot: string,
  input: { ticketId: string; tool: string; items: number; durationSeconds?: number; detail?: string },
): Promise<TicketCheck> {
  const check = await inspectLaunchTicket(privateRoot, input)
  if (!check.ok) return check
  const state = await readGateState(privateRoot)
  const ticket = state.tickets.find((item) => item.id === check.ticket!.id)
  if (!ticket) return { ok: false, message: `启动票据 ${input.ticketId} 在写入时消失，请重新批准。` }
  ticket.consumedAt = new Date().toISOString()
  ticket.usedBy = {
    at: ticket.consumedAt,
    items: Math.max(1, Math.floor(Number(input.items ?? 1))),
    durationSeconds: input.durationSeconds,
    detail: input.detail,
  }
  await writeGateState(privateRoot, prune(state))
  return { ok: true, message: 'ok', ticket }
}

export async function revokeLaunchTicket(privateRoot: string, ticketId: string): Promise<boolean> {
  const state = await readGateState(privateRoot)
  const ticket = state.tickets.find((item) => item.id === ticketId)
  if (!ticket || ticket.consumedAt) return false
  ticket.consumedAt = new Date().toISOString()
  ticket.usedBy = { at: ticket.consumedAt, items: 0, detail: 'revoked' }
  await writeGateState(privateRoot, prune(state))
  return true
}

/** Text shown when a paid tool refuses to run without a valid ticket. */
export function launchGateGuidance(privateRoot: string): string {
  return [
    '生成启动门：付费提交需要一次性票据，票据只能由真人在真实终端里输入确认词生成。',
    '步骤 1（Agent）写计划：node scripts/launch-gate.mjs plan --json plan.json',
    '步骤 2（用户）在终端批准：node scripts/launch-gate.mjs approve --plan <plan_id>，按提示输入「自动开始任务」',
    '步骤 3（Agent）带 launch_ticket=<ticket_id> 重新调用本工具。',
    `状态文件：${launchGateStatePath(privateRoot)}`,
  ].join('\n')
}

/** Read state for `media_status` / CLI display. */
export async function launchGateStatus(privateRoot: string): Promise<{
  pending: LaunchPlan[]
  validTickets: Array<LaunchTicket & { remainingMs: number }>
}> {
  const state = await readGateState(privateRoot)
  const now = Date.now()
  return {
    pending: state.plans.filter((plan) => plan.status === 'pending'),
    validTickets: state.tickets
      .filter((ticket) => !ticket.consumedAt && Date.parse(ticket.expiresAt) > now)
      .map((ticket) => ({ ...ticket, remainingMs: Date.parse(ticket.expiresAt) - now })),
  }
}
