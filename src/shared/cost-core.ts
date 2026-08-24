/**
 * Pure RMB cost pricing engine for the session cost window.
 *
 * Translates a litellm-style price row (USD per token) into RMB per million
 * tokens (FX), applies a time-of-day (peak/off-peak) schedule, and prices a
 * step's token usage. Pure domain: no DSH/provider dependencies (see
 * AGENTS.md "shared"). The host `tool-cost` plugin wires this to the harness
 * sessionProjections registry.
 *
 * Sources:
 *  - litellm `model_prices_and_context_window.json` (USD/token)
 *  - DeepSeek off-peak window (editable defaults)
 */

/** RMB per million tokens, one bucket per billed token class. */
export interface CostPrice {
  readonly inputMiss: number
  readonly cacheHit: number
  readonly cacheWrite: number
  readonly output: number
}

/** One step's cost in yuan, split by bucket. */
export interface StepCost {
  readonly input: number
  readonly cacheHit: number
  readonly cacheWrite: number
  readonly output: number
  readonly total: number
}

/** Token counts consumed by one step (the durable projection shape). */
export interface StepUsage {
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
}

/** A litellm row's price fields, in USD per token (some optional). */
export interface LitellmPriceRow {
  readonly input_cost_per_token?: number
  readonly input_cost_per_token_cache_hit?: number
  readonly input_cost_per_token_cache_write?: number
  readonly output_cost_per_token?: number
}

const PER_MILLION = 1_000_000

/** Default USD→CNY rate; override with cost.fxRmbPerUsd config. */
export const DEFAULT_FX_RMB_PER_USD = 7.2

/** Default peak RMB/M table for the bundled fallback (deepseek-v4-flash family). */
export const DEFAULT_BASE_PRICE: CostPrice = {
  inputMiss: 3,
  cacheHit: 0.1,
  cacheWrite: 0,
  output: 9,
}

/**
 * Authoritative DeepSeek official peak RMB/M prices (per million tokens).
 * deepseek-v4-flash and deepseek-v4-flash-vision-exp are priced identically;
 * off-peak is 0.5× peak across every bucket; the table charges no separate
 * cache-write bucket. Edit/copy to match your contract.
 */
export const DEEPSEEK_OFFICIAL_PRICES: Readonly<Record<string, CostPrice>> = {
  'deepseek-v4-flash': { inputMiss: 3, cacheHit: 0.10, cacheWrite: 0, output: 9 },
  'deepseek-v4-flash-vision-exp': { inputMiss: 3, cacheHit: 0.10, cacheWrite: 0, output: 9 },
  'deepseek-v4-pro': { inputMiss: 9, cacheHit: 0.30, cacheWrite: 0, output: 27 },
}

/** Convert a litellm USD/token row to RMB per million tokens. */
export function costPriceFromLitellm(row: LitellmPriceRow, fxRmbPerUsd: number): CostPrice {
  const inputPerToken = row.input_cost_per_token ?? 0
  return {
    inputMiss: inputPerToken * PER_MILLION * fxRmbPerUsd,
    cacheHit: (row.input_cost_per_token_cache_hit ?? inputPerToken) * PER_MILLION * fxRmbPerUsd,
    cacheWrite: (row.input_cost_per_token_cache_write ?? 0) * PER_MILLION * fxRmbPerUsd,
    output: (row.output_cost_per_token ?? 0) * PER_MILLION * fxRmbPerUsd,
  }
}

/** One time-of-day window with per-bucket multipliers (1 = full price). */
export interface TimeWindow {
  readonly startMinute: number
  readonly endMinute: number
  readonly inputFactor: number
  readonly cacheHitFactor: number
  readonly cacheWriteFactor: number
  readonly outputFactor: number
}

/** Default DeepSeek off-peak window (00:30–08:30, Beijing): 0.5× peak everywhere. */
export const DEFAULT_WINDOWS: readonly TimeWindow[] = [
  { startMinute: 30, endMinute: 510, inputFactor: 0.5, cacheHitFactor: 0.5, cacheWriteFactor: 0, outputFactor: 0.5 },
]

/** Beijing is UTC+8, fixed. */
export const BEIJING_UTC_OFFSET_MINUTES = 480

/** Active window for a timestamp (undefined = full price). */
export function windowAt(
  timestampMs: number,
  windows: readonly TimeWindow[] = DEFAULT_WINDOWS,
  tzOffsetMinutes = BEIJING_UTC_OFFSET_MINUTES,
): TimeWindow | undefined {
  const minute = Math.floor(((timestampMs / 60_000) + tzOffsetMinutes) % 1440 + 1440) % 1440
  for (const window of windows) {
    if (window.startMinute < window.endMinute) {
      if (minute >= window.startMinute && minute < window.endMinute) return window
    } else if (minute >= window.startMinute || minute < window.endMinute) return window
  }
  return undefined
}

/** Effective RMB/M price at a timestamp: full, or window-discounted. */
export function priceAtTs(
  base: CostPrice,
  timestampMs: number,
  windows: readonly TimeWindow[] = DEFAULT_WINDOWS,
): CostPrice {
  const window = windowAt(timestampMs, windows)
  if (window === undefined) return base
  return {
    inputMiss: base.inputMiss * window.inputFactor,
    cacheHit: base.cacheHit * window.cacheHitFactor,
    cacheWrite: base.cacheWrite * window.cacheWriteFactor,
    output: base.output * window.outputFactor,
  }
}

/** Price one step's usage under an effective RMB/M table. */
export function stepCost(usage: StepUsage, price: CostPrice): StepCost {
  const input = usage.uncachedInputTokens * price.inputMiss / PER_MILLION
  const cacheHit = usage.cacheReadTokens * price.cacheHit / PER_MILLION
  const cacheWrite = usage.cacheWriteTokens * price.cacheWrite / PER_MILLION
  const output = usage.outputTokens * price.output / PER_MILLION
  return { input, cacheHit, cacheWrite, output, total: input + cacheHit + cacheWrite + output }
}

/** Zero cost (before any usage). */
export function zeroCost(): StepCost {
  return { input: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0 }
}

/** Bundled fallback row (USD/token) for a DeepSeek-style chat model. */
export const DEEPSEEK_FALLBACK_ROW: LitellmPriceRow = {
  input_cost_per_token: DEFAULT_BASE_PRICE.inputMiss / PER_MILLION / DEFAULT_FX_RMB_PER_USD,
  input_cost_per_token_cache_hit: DEFAULT_BASE_PRICE.cacheHit / PER_MILLION / DEFAULT_FX_RMB_PER_USD,
  input_cost_per_token_cache_write: DEFAULT_BASE_PRICE.cacheWrite / PER_MILLION / DEFAULT_FX_RMB_PER_USD,
  output_cost_per_token: DEFAULT_BASE_PRICE.output / PER_MILLION / DEFAULT_FX_RMB_PER_USD,
}

/** Default litellm price-table URL (community-maintained USD/token). */
export const DEFAULT_LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

/** Find the closest litellm row for a model id (exact, then prefix/substring). */
export function findModelRow(
  table: Readonly<Record<string, LitellmPriceRow>>,
  model: string | undefined,
): LitellmPriceRow | undefined {
  if (model === undefined) return undefined
  if (table[model] !== undefined) return table[model]
  const lower = model.toLowerCase()
  for (const [id, row] of Object.entries(table)) {
    if (id.toLowerCase().includes(lower) || lower.includes(id.toLowerCase())) return row
  }
  return undefined
}
