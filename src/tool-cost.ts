/**
 * Session RMB cost tool (host half): read the current session's durable event
 * log, price each billed step by its own model + wall-clock instant (peak /
 * off-peak window, litellm-style base price × FX), and return the four billed
 * buckets plus the total in RMB. Pure pricing logic lives in
 * `./shared/cost-core.ts` (no DSH/provider deps).
 *
 * This is the syncable "engine" part of the session cost window: it runs as an
 * ordinary host plugin/tool, so other machines get it by pulling this repo.
 * The live litellm fetch and the browser pill (a client plugin) are heavier
 * additions, handled separately.
 *
 * @module dsh-media-plugins/tool-cost
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_BASE_PRICE, DEFAULT_FX_RMB_PER_USD, priceAtTs, stepCost,
  type CostPrice, type StepCost, type TimeWindow,
} from './shared/cost-core.ts'

export const name = 'Ws_tool-cost'
export const inject = ['tools']

export const Config: z<{ fxRmbPerUsd?: number; windows?: readonly TimeWindow[] }> = z.object({
  fxRmbPerUsd: z.number().optional(),
  windows: z.array(z.object({
    startMinute: z.number(),
    endMinute: z.number(),
    inputFactor: z.number(),
    cacheHitFactor: z.number(),
    cacheWriteFactor: z.number(),
    outputFactor: z.number(),
  })).optional(),
})

type ResolvedConfig = z.infer<typeof Config>

interface SessionLike {
  events: readonly unknown[]
}

interface AgentLike {
  session: SessionLike
}

interface ExecContextLike {
  agent: { session: SessionLike } | undefined
}

/** The durable-assistant usage step = usage + model + wall-clock instant. */
interface Step {
  model: string | undefined
  timestampMs: number
  usage: {
    inputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    outputTokens: number
  }
}

/** Fold the durable log into the last usage per model-facing step. */
function foldSteps(events: readonly unknown[]): Step[] {
  const steps: Step[] = []
  let model: string | undefined
  let lastKey: string | undefined
  for (const raw of events) {
    const event = raw as { type: string; time: number; data: Record<string, unknown> }
    if (event.type === 'request/header') {
      const config = (event.data.header as { config?: { model?: string } } | undefined)?.config
      model = config?.model ?? model
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage as Step['usage'] | undefined
    if (usage === undefined) continue
    const data = event.data as { turn: number; step: number }
    const key = `${data.turn}:${data.step}`
    // Same-step final sample replaces the earlier chunk sample (no double count).
    const existing = lastKey === key ? steps.at(-1) : undefined
    const step: Step = { model, timestampMs: event.time, usage }
    if (existing !== undefined) step.usage = existing.usage = usage
    if (existing === undefined) steps.push(step)
    lastKey = key
  }
  return steps
}

/** Price each step and fold to a session total. */
function computeSessionCost(steps: readonly Step[], fx: number, windows: readonly TimeWindow[] | undefined): {
  buckets: StepCost
  peak: boolean
  windowNote: string | null
} {
  let totals: StepCost = { input: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0 }
  for (const step of steps) {
    // Bundled DeepSeek fallback row (documented default); the model alias is
    // applied when a per-model price table is wired in later.
    const price = priceAtTs(DEFAULT_BASE_PRICE, step.timestampMs, windows)
    const usage = {
      uncachedInputTokens: step.usage.inputTokens,
      cacheReadTokens: step.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: step.usage.cacheWriteTokens ?? 0,
      outputTokens: step.usage.outputTokens,
    }
    const cost = stepCost(usage, price)
    totals = {
      input: totals.input + cost.input,
      cacheHit: totals.cacheHit + cost.cacheHit,
      cacheWrite: totals.cacheWrite + cost.cacheWrite,
      output: totals.output + cost.output,
      total: totals.total + cost.total,
    }
  }
  const now = Date.now()
  const nowPrice = priceAtTs(DEFAULT_BASE_PRICE, now, windows)
  const peak = nowPrice.inputMiss === DEFAULT_BASE_PRICE.inputMiss
  const windowNote = peak ? null : '00:30–08:30 谷时折扣（输入/缓存/写入 ×0.25 · 输出 ×0.125）'
  return { buckets: totals, peak, windowNote }
}

function apply(ctx: Context, config: ResolvedConfig): void {
  const fx = config.fxRmbPerUsd ?? DEFAULT_FX_RMB_PER_USD
  ctx.tools.register(
    defineTool({
      name: 'media_cost',
      description:
        '计算当前会话已消耗的人民币（RMB）。按每个请求发生时刻 + 当时生效单价计费（分时：默认北京 00:30–08:30 谷时折扣；模型别名 deepseek-v4-flash-vision-exp 与 deepseek-v4-flash 同价）。返回四个计费桶（输入未命中 / 缓存命中 / 缓存写入 / 输出）各自的人民币、总价，以及当前时段（峰/谷）。数据来自会话的持久化事件日志，不受分页影响。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', required: true },
            cost: {
              type: 'object',
              properties: {
                input: { type: 'number' }, cacheHit: { type: 'number' },
                cacheWrite: { type: 'number' }, output: { type: 'number' },
                total: { type: 'number' },
              },
              required: true,
            },
            peak: { type: 'boolean' },
            windowNote: { type: 'string' },
            fxRmbPerUsd: { type: 'number' },
            steps: { type: 'number' },
            message: { type: 'string' },
          },
          required: true,
        },
      },
      async execute(_args: unknown, exec: ExecContextLike) {
        const session = exec.agent?.session
        if (session === undefined) {
          return { ok: false, cost: { input: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0 }, steps: 0, message: 'no session' }
        }
        const steps = foldSteps(session.events ?? [])
        const { buckets, peak, windowNote } = computeSessionCost(steps, fx, config.windows)
        const money = (v: number): string => (v >= 0.01 ? `¥${v.toFixed(2)}` : `¥${v.toFixed(4)}`)
        return {
          ok: true,
          cost: buckets,
          peak,
          windowNote,
          fxRmbPerUsd: fx,
          steps: steps.length,
          message: `当前会话 ${money(buckets.total)}（输入 ${money(buckets.input)} · 缓存命中 ${money(buckets.cacheHit)} · 缓存写入 ${money(buckets.cacheWrite)} · 输出 ${money(buckets.output)}）${peak ? ' · 峰时全价' : ' · 谷时折扣'}`,
        }
      },
      render(_args: unknown, value: { cost?: StepCost; peak?: boolean; windowNote?: string | null; steps?: number; message?: string }) {
        const c = value.cost ?? { input: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0 }
        const rows: string[] = [
          value.message ?? '',
          '',
          `输入（未命中）  ${c.input} 元`,
          `缓存命中        ${c.cacheHit} 元`,
          `缓存写入        ${c.cacheWrite} 元`,
          `输出            ${c.output} 元`,
          `总计            ${c.total} 元`,
        ]
        if (value.windowNote !== null && value.windowNote !== undefined) rows.push(`当前时段：${value.windowNote}`)
        return [{ type: 'text', text: rows.join('\n') }]
      },
    }),
  )
}

export { apply }
