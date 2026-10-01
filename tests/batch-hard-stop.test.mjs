import test from 'node:test'
import assert from 'node:assert/strict'
import { waitWithHardStop, SHUTDOWN_DRAIN_MS, DEFAULT_COMPLETION_GRACE_SECONDS } from '../src/shared/batch-core.ts'

// A batch job has a MAXIMUM wait: dispatch deadline + completion grace. When the
// grace is spent the runners are aborted and only a bounded drain window is
// granted, so a runner that ignores its abort signal can never keep a job alive
// (and a job can never quietly retry work on its own — topping up is the user's
// decision, taken from the review page).

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('hard stop: work that finishes inside the grace wins and no abort is fired', async () => {
  let aborted = false
  const outcome = await waitWithHardStop(sleep(20), 200, 200, () => {
    aborted = true
  })
  assert.equal(outcome, 'settled')
  assert.equal(aborted, false, 'the grace timer must not fire when the work settles first')
})

test('hard stop: work that never settles is stopped after grace + drain, and the grace fires once', async () => {
  let aborts = 0
  const started = Date.now()
  const outcome = await waitWithHardStop(new Promise(() => {}), 60, 60, () => {
    aborts += 1
  })
  const elapsed = Date.now() - started
  assert.equal(outcome, 'stopped')
  assert.equal(aborts, 1, 'the runner is aborted exactly once when the grace elapses')
  assert.ok(elapsed >= 100, `must wait grace + drain (took ${elapsed} ms)`)
  assert.ok(elapsed < 600, `must not wait indefinitely (took ${elapsed} ms)`)
})

test('hard stop: the drain window is bounded, independent of the grace length', async () => {
  assert.equal(SHUTDOWN_DRAIN_MS, 5000, 'the drain window is a fixed, small constant')
  assert.equal(DEFAULT_COMPLETION_GRACE_SECONDS, 120, 'and the grace itself stays capped at 120 s')
  const started = Date.now()
  const outcome = await waitWithHardStop(new Promise(() => {}), 40, 40, () => {})
  const elapsed = Date.now() - started
  assert.equal(outcome, 'stopped')
  assert.ok(elapsed < 400, `the stop must be observable within the test window (took ${elapsed} ms)`)
})
