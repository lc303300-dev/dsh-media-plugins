/**
 * 生成启动门（launch gate）— 模块级测试。
 *
 * 门的核心承诺：付费生成必须有一张**真人在终端**批准的一次性票据。
 * 这里的测试锁死三件事：
 *   1. 非 TTY（Agent / 后台进程 / 管道）不可能批准；
 *   2. 票据一次性、有 TTL、绑定工具与范围；
 *   3. 任何不符都不会"顺便"消耗票据（拒绝不烧票）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LAUNCH_PHRASE,
  approveLaunchPlan,
  consumeLaunchTicket,
  createLaunchPlan,
  inspectLaunchTicket,
  launchGateStatus,
  readGateState,
  revokeLaunchTicket,
  writeGateState,
} from '../src/shared/launch-gate.ts'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'launch-gate-test-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function approved(root, overrides = {}) {
  const plan = await createLaunchPlan(root, {
    tool: 'generate_video',
    title: '测试计划',
    scope: { maxItems: 2, maxDurationSeconds: 30 },
    summary: ['node_a 15s', 'node_b 15s'],
    ...overrides,
  })
  const result = await approveLaunchPlan(root, { planId: plan.id, phrase: LAUNCH_PHRASE, isTTY: true })
  assert.equal(result.ok, true, result.message)
  return { plan, ticket: result.ticket }
}

test('非 TTY 无法批准（Agent / 后台进程 / 管道喂词都无效）', async () => {
  await withRoot(async (root) => {
    const plan = await createLaunchPlan(root, { tool: 'generate_image', scope: { maxItems: 1 }, summary: ['img'] })
    const refused = await approveLaunchPlan(root, { planId: plan.id, phrase: LAUNCH_PHRASE, isTTY: false })
    assert.equal(refused.ok, false)
    assert.match(refused.message, /TTY/)
    // 未批准 → 没有票据
    const state = await readGateState(root)
    assert.equal(state.tickets.length, 0)
    const plan2 = await readGateState(root).then((s) => s.plans.find((p) => p.id === plan.id))
    assert.equal(plan2.status, 'pending')
  })
})

test('确认词必须逐字匹配「自动开始任务」', async () => {
  await withRoot(async (root) => {
    const plan = await createLaunchPlan(root, { tool: 'generate_image', scope: { maxItems: 1 }, summary: [] })
    for (const phrase of ['自动开始', '自动 开始任务', 'AUTO', '']) {
      const result = await approveLaunchPlan(root, { planId: plan.id, phrase, isTTY: true })
      assert.equal(result.ok, false, `phrase ${JSON.stringify(phrase)} must be refused`)
    }
    const ok = await approveLaunchPlan(root, { planId: plan.id, phrase: LAUNCH_PHRASE, isTTY: true })
    assert.equal(ok.ok, true)
  })
})

test('票据一次性：第二次消费被拒，状态里记录使用者', async () => {
  await withRoot(async (root) => {
    const { ticket } = await approved(root)
    const first = await consumeLaunchTicket(root, { ticketId: ticket.id, tool: 'generate_video', items: 2, durationSeconds: 30 })
    assert.equal(first.ok, true, first.message)
    const second = await consumeLaunchTicket(root, { ticketId: ticket.id, tool: 'generate_video', items: 1 })
    assert.equal(second.ok, false)
    assert.match(second.message, /已被使用|一次性/)
    const state = await readGateState(root)
    assert.equal(state.tickets.find((t) => t.id === ticket.id).usedBy.items, 2)
  })
})

test('票据绑定工具：不能拿视频票去出图', async () => {
  await withRoot(async (root) => {
    const { ticket } = await approved(root)
    const wrong = await inspectLaunchTicket(root, { ticketId: ticket.id, tool: 'generate_image', items: 1 })
    assert.equal(wrong.ok, false)
    // 拒绝不烧票：换回正确工具仍可使用
    const right = await consumeLaunchTicket(root, { ticketId: ticket.id, tool: 'generate_video', items: 1 })
    assert.equal(right.ok, true, right.message)
  })
})

test('票据绑定范围：项数与总时长超限都被拒绝，且不烧票', async () => {
  await withRoot(async (root) => {
    const { ticket } = await approved(root)
    const overItems = await inspectLaunchTicket(root, { ticketId: ticket.id, tool: 'generate_video', items: 3 })
    assert.equal(overItems.ok, false)
    const overDuration = await inspectLaunchTicket(root, { ticketId: ticket.id, tool: 'generate_video', items: 2, durationSeconds: 31 })
    assert.equal(overDuration.ok, false)
    const ok = await consumeLaunchTicket(root, { ticketId: ticket.id, tool: 'generate_video', items: 2, durationSeconds: 30 })
    assert.equal(ok.ok, true, ok.message)
  })
})

test('过期票据被拒', async () => {
  await withRoot(async (root) => {
    const { ticket } = await approved(root)
    const state = await readGateState(root)
    state.tickets.find((t) => t.id === ticket.id).expiresAt = new Date(Date.now() - 1000).toISOString()
    await writeGateState(root, state)
    const expired = await inspectLaunchTicket(root, { ticketId: ticket.id, tool: 'generate_video', items: 1 })
    assert.equal(expired.ok, false)
    assert.match(expired.message, /过期/)
  })
})

test('作废票据后不可用', async () => {
  await withRoot(async (root) => {
    const { ticket } = await approved(root)
    assert.equal(await revokeLaunchTicket(root, ticket.id), true)
    const revoked = await inspectLaunchTicket(root, { ticketId: ticket.id, tool: 'generate_video', items: 1 })
    assert.equal(revoked.ok, false)
  })
})

test('缺失 / 未知票据给出可操作的报错', async () => {
  await withRoot(async (root) => {
    const missing = await consumeLaunchTicket(root, { ticketId: '', tool: 'generate_video', items: 1 })
    assert.equal(missing.ok, false)
    assert.match(missing.message, /launch_ticket/)
    const unknown = await consumeLaunchTicket(root, { ticketId: 'lt_deadbeef', tool: 'generate_video', items: 1 })
    assert.equal(unknown.ok, false)
    assert.match(unknown.message, /不存在/)
  })
})

test('同一计划不能二次批准（避免一张计划多张票）', async () => {
  await withRoot(async (root) => {
    const { plan } = await approved(root)
    const again = await approveLaunchPlan(root, { planId: plan.id, phrase: LAUNCH_PHRASE, isTTY: true })
    assert.equal(again.ok, false)
  })
})

test('状态可读：pending 计划与有效票据分开列出', async () => {
  await withRoot(async (root) => {
    await createLaunchPlan(root, { tool: 'batch_image', scope: { maxItems: 4 }, summary: ['四张候选'] })
    const { ticket } = await approved(root)
    const status = await launchGateStatus(root)
    assert.equal(status.pending.length, 1)
    assert.equal(status.validTickets.length, 1)
    assert.equal(status.validTickets[0].id, ticket.id)
    assert.ok(status.validTickets[0].remainingMs > 0)
  })
})
