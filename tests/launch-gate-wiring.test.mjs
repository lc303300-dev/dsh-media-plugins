/**
 * 生成启动门 — 工具接线测试（防止"门只存在于文档"）。
 *
 * 真实故障模式（2026-10-27）：规则写了"必须人工启动"，但生成工具里没有校验，
 * Agent 仍然一句调用就能花钱。这里直接调用工具的 execute，断言：
 *   1. 没有 launch_ticket → 拒绝，且报错里给出申请票据的下一步；
 *   2. 票据工具不符 → 拒绝；
 *   3. 未过门的调用不会触达供应商（拒绝发生在任何付费/网络动作之前）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyCanvas } from '../src/tool-canvas.ts'
import { apply as applyImage } from '../src/tool-image-gen.ts'
import { approveLaunchPlan, createLaunchPlan } from '../src/shared/launch-gate.ts'

function makeCtx() {
  const ctx = {
    tools: {
      register(tool) {
        ctx.tool = tool
      },
    },
    credentials: { resolve: async () => ({ value: 'dummy-key-not-used' }) },
  }
  return ctx
}

function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

/** Minimal canvas config: the gate runs before any config field beyond privateDir is read. */
const canvasConfig = {
  dreaminaPath: '',
  dreaminaProfile: '',
  dreaminaAccount: '',
  stateDir: '',
  timeoutMs: 60_000,
  openCanvasInBrowser: false,
  canvasBrowserPath: '',
  privateDir: '',
}

/** Minimal image config: the gate runs before the router is called. */
const imageConfig = {
  comflyBaseURL: 'https://example.invalid',
  comflyApiKeyEnv: 'COMFLY_API_KEY',
  dreaminaPath: '',
  dreaminaCanvasPath: '',
  dreaminaCanvasProfile: '',
  proxyUrl: '',
  outputDir: 'outputs',
  privateDir: '',
  maxConcurrency: 1,
  providerTimeoutMs: 1000,
  taskTimeoutMs: 1000,
  enabled: [],
  dreaminaAccount: '',
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'launch-gate-wiring-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('dreamina_canvas: 付费动作 node run 没有票据 → launch_ticket_required', async () => {
  await withRoot(async (root) => {
    const ctx = makeCtx()
    applyCanvas(ctx, canvasConfig)
    const result = await ctx.tool.execute(
      { command: 'node', action: 'run', args: { project_id: 'p', node_id: 'node_x', submit_id: 's', credit_ceiling: 100 } },
      makeExec(root),
    )
    assert.equal(result.ok, false)
    assert.equal(result.outcome, 'launch_ticket_required')
    assert.match(result.message, /launch_ticket/)
    assert.match(result.message, /launch-gate\.mjs/)
  })
})

test('dreamina_canvas: 非付费动作（node show）不需要票据', async () => {
  await withRoot(async (root) => {
    const ctx = makeCtx()
    applyCanvas(ctx, canvasConfig)
    const result = await ctx.tool.execute({ command: 'node', action: 'show', args: { project_id: 'p', node_id: 'n' } }, makeExec(root))
    // 没有票据也不会停在门上（后续会因为缺 dreamina 二进制失败，那不是门的问题）
    assert.notEqual(result?.outcome, 'launch_ticket_required')
  })
})

test('generate_image: 没有票据 → 拒绝且提示申请下一步', async () => {
  await withRoot(async (root) => {
    const ctx = makeCtx()
    applyImage(ctx, imageConfig)
    await assert.rejects(
      () => ctx.tool.execute({ prompt: '测试提示词', image_ratio: '1:1' }, makeExec(root)),
      (error) => {
        const text = String(error?.message ?? error)
        assert.match(text, /launch_ticket/)
        assert.match(text, /launch-gate\.mjs/)
        return true
      },
    )
  })
})

test('generate_image: 票据工具不符 → 拒绝', async () => {
  await withRoot(async (root) => {
    // 工具把 privateRoot 解析为 <cwd>/.dsh-media-private，计划必须写在同一个根下。
    const privateRoot = join(root, '.dsh-media-private')
    const plan = await createLaunchPlan(privateRoot, { tool: 'generate_video', scope: { maxItems: 1 }, summary: ['video'] })
    const approved = await approveLaunchPlan(privateRoot, { planId: plan.id, phrase: '自动开始任务', isTTY: true })
    assert.equal(approved.ok, true)
    const ctx = makeCtx()
    applyImage(ctx, imageConfig)
    await assert.rejects(
      () => ctx.tool.execute({ prompt: '测试提示词', image_ratio: '1:1', launch_ticket: approved.ticket.id }, makeExec(root)),
      (error) => {
        assert.match(String(error?.message ?? error), /不能用于 generate_image/)
        return true
      },
    )
  })
})
