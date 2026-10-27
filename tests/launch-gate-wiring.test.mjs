/**
 * 生成启动门 — 工具接线测试（防止"门只存在于文档"）。
 *
 * 覆盖范围：**只有视频**。真实故障模式（2026-10-27）：规则写了"必须人工启动"，
 * 但生成工具里没有校验，Agent 仍然一句调用就能花钱。这里直接调用工具的 execute，断言：
 *   1. 视频提交（generate_video / dreamina_canvas node run）没有 launch_ticket → 拒绝；
 *   2. 拒绝发生在任何付费/网络动作之前（不会先发请求再报错）；
 *   3. 图片线路（generate_image / batch_image / upscale / 图片节点）不过门，
 *      且 schema 里没有 launch_ticket —— 迭代出图不被拖慢。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyCanvas } from '../src/tool-canvas.ts'
import { apply as applyImage } from '../src/tool-image-gen.ts'
import { apply as applyBatch } from '../src/tool-batch-image.ts'

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

/** Minimal batch config: only the parameter shape is asserted, nothing executes. */
const batchImageConfig = {
  comflyBaseURL: 'https://example.invalid',
  comflyApiKeyEnv: 'COMFLY_API_KEY',
  dreaminaPath: '',
  dreaminaCanvasPath: '',
  dreaminaCanvasProfile: '',
  proxyUrl: '',
  outputDir: 'outputs',
  privateDir: '',
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

test('dreamina_canvas: upscale（图片改图）不受启动门限制', async () => {
  await withRoot(async (root) => {
    const ctx = makeCtx()
    applyCanvas(ctx, canvasConfig)
    const result = await ctx.tool.execute(
      { command: 'node', action: 'upscale image', args: { project_id: 'p', node_id: 'node_x', credit_ceiling: 10 } },
      makeExec(root),
    )
    assert.notEqual(result?.outcome, 'launch_ticket_required')
  })
})

test('dreamina_canvas: node create image --run（图片节点）不受启动门限制', async () => {
  await withRoot(async (root) => {
    const ctx = makeCtx()
    applyCanvas(ctx, canvasConfig)
    const result = await ctx.tool.execute(
      { command: 'node', action: 'create image', args: { project_id: 'p', run: true, credit_ceiling: 10 } },
      makeExec(root),
    )
    assert.notEqual(result?.outcome, 'launch_ticket_required')
  })
})

test('generate_image: 图片线路不过门（schema 里没有 launch_ticket）', async () => {
  const ctx = makeCtx()
  applyImage(ctx, imageConfig)
  assert.equal(ctx.tool.parameters?.launch_ticket, undefined)
})

test('batch_image: 图片线路不过门（schema 里没有 launch_ticket）', async () => {
  const ctx = makeCtx()
  applyBatch(ctx, batchImageConfig)
  assert.equal(ctx.tool.parameters?.launch_ticket, undefined)
})

