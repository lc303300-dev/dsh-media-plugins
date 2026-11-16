// Regression guards for the desktop in-app update gate.
//
// The Electron shell only installs an update after the DSH host exits *by
// itself* with code 0 following its shutdown acknowledgement. Anything that
// keeps the process alive after disposal (a ref'd timer, a running CLI child)
// turns every update into "未能安全停止任务，更新尚未安装":
//
//   1. tool-cost must not own a periodic timer at all (the 6h price refresh
//      used to be one and blocked every update).
//   2. CLI children must be tracked so a shutdown stops them.
//   3. host-exit-guard must register exactly one shutdown listener.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'

import { apply as applyCost } from '../dist/tool-cost.js'
import { execFileTracked, killTrackedChildren } from '../dist/host-resources.js'
import { apply as applyGuard } from '../dist/host-exit-guard.js'

test('tool-cost owns no periodic timer (a ref timer blocks the update gate)', async () => {
  const live = new Map()
  const hook = createHook({
    init(id, type) {
      if (type === 'Timeout') live.set(id, new Error().stack)
    },
    destroy(id) {
      live.delete(id)
    },
  })
  hook.enable()

  const disposers = []
  const ctx = {
    effect: (fn) => {
      disposers.push(fn())
    },
    tools: { register: () => {} },
  }

  // Stack frames from this plugin, excluding undici's own keep-alive timers
  // (which are chained through the startup fetch but time out on their own).
  const pluginTimers = () =>
    [...live.values()].filter((stack) => stack.includes('tool-cost') && !stack.includes('undici'))

  try {
    applyCost(ctx, {
      // Point at a closed local port so the one startup refresh fails instantly
      // and the test never touches the network.
      litellmUrl: 'http://127.0.0.1:1/model_prices_and_context_window.json',
      windows: [],
    })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(pluginTimers().length, 0, 'no price-refresh timer is armed')
    assert.equal(disposers.length, 1, 'the plugin still registers its disposal hook')

    disposers[0]()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(pluginTimers().length, 0, 'disposal leaves no timer behind')
  } finally {
    hook.disable()
  }
})

test('killTrackedChildren terminates a tracked CLI child', async () => {
  const pending = execFileTracked(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']).catch((error) => error)
  // Give execFile time to actually spawn the child before stopping it.
  await new Promise((resolve) => setTimeout(resolve, 500))
  killTrackedChildren()
  const result = await pending
  assert.ok(result instanceof Error, 'a killed child rejects the tracked exec')
})

test('host-exit-guard registers exactly one shutdown listener', () => {
  const before = process.listenerCount('message')
  applyGuard()
  applyGuard() // repeated plugin instances must not stack listeners
  assert.equal(process.listenerCount('message'), before + 1)
})
