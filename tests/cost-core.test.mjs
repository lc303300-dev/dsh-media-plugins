import test from 'node:test'
import assert from 'node:assert/strict'
import {
  costPriceFromLitellm, DEFAULT_BASE_PRICE, priceAtTs, stepCost, windowAt,
} from '../src/shared/cost-core.ts'

const PEAK = (12 * 60 - 480) * 60_000 // 12:00 Beijing (full price)
const OFF = (2 * 60 - 480) * 60_000 // 02:00 Beijing (off-peak)

test('costPriceFromLitellm converts USD/token to RMB per million under FX', () => {
  const p = costPriceFromLitellm(
    { input_cost_per_token: 2 / 1e6 / 7.2, output_cost_per_token: 8 / 1e6 / 7.2, input_cost_per_token_cache_hit: 0.5 / 1e6 / 7.2 },
    7.2,
  )
  assert.ok(Math.abs(p.inputMiss - 2) < 1e-9)
  assert.ok(Math.abs(p.cacheHit - 0.5) < 1e-9)
  assert.ok(Math.abs(p.output - 8) < 1e-9)
})

test('windowAt/priceAtTs apply the off-peak discount inside the Beijing window', () => {
  assert.ok(windowAt(OFF) !== undefined)
  const discounted = priceAtTs(DEFAULT_BASE_PRICE, OFF)
  assert.ok(Math.abs(discounted.inputMiss - 1.5) < 1e-9)
  assert.ok(Math.abs(discounted.output - 4.5) < 1e-9)
  assert.equal(priceAtTs(DEFAULT_BASE_PRICE, PEAK).inputMiss, DEFAULT_BASE_PRICE.inputMiss)
})

test('stepCost prices each bucket at the effective RMB/M rate', () => {
  const c = stepCost({ uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 }, DEFAULT_BASE_PRICE)
  assert.ok(Math.abs(c.input - 3) < 1e-9)
  assert.ok(Math.abs(c.output - 9) < 1e-9)
  assert.ok(Math.abs(c.total - 12) < 1e-9)
})
