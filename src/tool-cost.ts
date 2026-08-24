/**
 * Session RMB cost tool (host half): read the current session's durable event
 * log, price each billed step by its own model + wall-clock instant (peak /
 * off-peak window), and return the four billed buckets plus the total in RMB.
 * Pure pricing logic lives in `./shared/cost-core.ts`.
 *
 * The price row is resolved from the litellm community table, fetched over the
 * outbound proxy (which must go through 127.0.0.1:7897 — see the proxy env) at
 * startup and refreshed on a timer, with the bundled DeepSeek row as fallback.
 *
 * @module dsh-media-plugins/tool-cost
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import {
  costPriceFromLitellm, DEFAULT_BASE_PRICE, DEFAULT_FX_RMB_PER_USD,
  DEFAULT_LITELLM_URL, DEEPSEEK_FALLBACK_ROW, findModelRow, priceAtTs, stepCost,
  type CostPrice, type LitellmPriceRow, type StepCost, type TimeWindow,
} from './shared/cost-core.ts'

export const name = 'Ws_tool-cost'
export const inject = ['tools']

export const Config: z<{
  fxRmbPerUsd?: number
  proxyUrl?: string
  litellmUrl?: string
  refreshMs?: number
  windows?: readonly TimeWindow[]
}> = z.object({
  fxRmbPerUsd: z.number().optional(),
  proxyUrl: z.string().optional(),
  litellmUrl: z.string().optional(),
  refreshMs: z.number().optional(),
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

interface SessionLike { events: readonly unknown[] }
interface ExecContextLike { agent: { session: SessionLike } | undefined }

/** Key aliases mapping model ids to a canonical priced model. */
const MODEL_ALIASES: Record<string, string> = {
  'deepseek-v4-flash-vision-exp': 'deepseek-v4-flash',
}

/** The durable assistant usage step = usage + model + wall-clock instant. */
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
    const existing = lastKey === key ? steps.at(-1) : undefined
    if (existing !== undefined) existing.usage = usage
    else steps.push({ model, timestampMs: event.time, usage })
    lastKey = key
  }
  return steps
}

/** Live per-(model, instant) resolver: litellm over the proxy + fallback. */
function makePriceAt(config: ResolvedConfig): (model: string | undefined, ts: number) => CostPrice {
  let table: Record<string, LitellmPriceRow> = {}
  let agent: ProxyAgent | undefined
  const fx = config.fxRmbPerUsd ?? DEFAULT_FX_RMB_PER_USD
  const windows = config.windows
  const proxyUrl = config.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? ''

  const dispatcher = (): ProxyAgent | undefined => {
    if (proxyUrl === '') return undefined
    agent ??= new ProxyAgent(proxyUrl)
    return agent
  }

  const refresh = async (): Promise<void> => {
    try {
      const url = config.litellmUrl ?? DEFAULT_LITELLM_URL
      const res = await undiciFetch(url, dispatcher() === undefined ? {} : { dispatcher: dispatcher() })
      table = (await res.json()) as Record<string, LitellmPriceRow>
    } catch {
      // Keep the previous table (or bundled fallback); never fail the agent.
    }
  }
  void refresh()
  const refreshMs = config.refreshMs ?? 0
  if (refreshMs > 0) setInterval(() => { void refresh() }, refreshMs)

  return (model, timestampMs) => {
    const canonical = MODEL_ALIASES[model ?? ''] ?? model
    const row = findModelRow(table, canonical) ?? DEEPSEEK_FALLBACK_ROW
    let base: CostPrice
    try {
      base = costPriceFromLitellm(row, fx)
    } catch {
      base = DEFAULT_BASE_PRICE
    }
    return priceAtTs(base, timestampMs, windows)
  }
}

function apply(ctx: Context, config: ResolvedConfig): void {
  const priceAt = makePriceAt(config)
  ctx.tools.register(
    defineTool({
      name: 'media_cost',
      description:
        '计算当前会话已消耗的人民币（RMB）。按每个请求发生时刻 + 当时生效单价计费（分时：默认北京 00:30–08:30 谷时折扣；模型别名 deepseek-v4-flash-vision-exp 与 deepseek-v4-flash 同价；单价来自 litellm 社区价表，走 127.0.0.1:7897 代理拉取并缓存，离线回退内置 DeepSeek 价）。返回四个计费桶（输入未命中 / 缓存命中 / 缓存写入 / 输出）各自的人民币、总价，以及当前时段（峰/谷）。数据来自会话的持久化事件日志，不受分页影响。',
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
        let totals: StepCost = { input: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0 }
        for (const step of steps) {
          const usage = {
            uncachedInputTokens: step.usage.inputTokens,
            cacheReadTokens: step.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: step.usage.cacheWriteTokens ?? 0,
            outputTokens: step.usage.outputTokens,
          }
          const cost = stepCost(usage, priceAt(step.model, step.timestampMs))
          totals = {
            input: totals.input + cost.input,
            cacheHit: totals.cacheHit + cost.cacheHit,
            cacheWrite: totals.cacheWrite + cost.cacheWrite,
            output: totals.output + cost.output,
            total: totals.total + cost.total,
          }
        }
        const nowPrice = priceAt(undefined, Date.now())
        const peak = nowPrice.inputMiss === DEFAULT_BASE_PRICE.inputMiss
        const windowNote = peak ? null : '00:30–08:30 谷时折扣（输入/缓存/写入 ×0.25 · 输出 ×0.125）'
        const money = (v: number): string => (v >= 0.01 ? `¥${v.toFixed(2)}` : `¥${v.toFixed(4)}`)
        return {
          ok: true,
          cost: totals,
          peak,
          windowNote,
          fxRmbPerUsd: config.fxRmbPerUsd ?? DEFAULT_FX_RMB_PER_USD,
          steps: steps.length,
          message: `当前会话 ${money(totals.total)}（输入 ${money(totals.input)} · 缓存命中 ${money(totals.cacheHit)} · 缓存写入 ${money(totals.cacheWrite)} · 输出 ${money(totals.output)}）${peak ? ' · 峰时全价' : ' · 谷时折扣'}`,
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
