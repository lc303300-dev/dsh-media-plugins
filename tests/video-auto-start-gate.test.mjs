/**
 * auto_start 硬门（用户 2026-11-13 定）：自动开始改为手动触发。
 *
 * - 默认（不传 auto_start）：只建节点，不提交；
 * - auto_start=true 必须同时给 auto_start_reason（用户原话留痕），否则在接触任何
 *   CLI / 付费动作之前就拒绝。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/tool-video-gen.ts'

const baseConfig = {
  dreaminaPath: '',
  dreaminaProfile: '',
  model: 'seedance_2.5',
  resolution: '480p',
  outputDir: 'outputs',
  privateDir: '',
  pollTimeoutMs: 1_000,
  executionMode: 'production',
  videoCapacity: 10,
  runHelpBeforeSubmit: false,
  openCanvasInBrowser: false,
  canvasBrowserPath: '',
  canvasOpenCooldownMs: 1,
  canvasStateDir: '',
  dreaminaAccount: '',
}

function captureTool(overrides = {}) {
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool) } }, { ...baseConfig, ...overrides })
  assert.equal(tools.length, 1)
  return tools[0]
}

function execCtx(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

/** 指向不存在的 CLI：让"过了参数门之后"的调用在真正连即梦之前就失败（测试不产生画布副作用）。 */
function missingCliPath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-no-cli-')), 'no-such-dreamina-canvas.exe')
}

test('auto_start=true 缺 auto_start_reason → 在付费动作之前拒绝', async () => {
  const tool = captureTool()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-auto-start-'))
  await assert.rejects(
    tool.execute(
      {
        prompt: '镜头推进',
        allow_manual_prompts: true,
        manual_prompts_reason: 'test: normalize-only',
        auto_start: true,
        launch_ticket: 'lt_fake',
      },
      execCtx(cwd),
    ),
    /auto_start_reason/,
  )
})

test('auto_start=false（默认）不要求 auto_start_reason / 确认门', async () => {
  const tool = captureTool({ dreaminaPath: missingCliPath() })
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-auto-start-'))
  let message = ''
  try {
    await tool.execute(
      { prompt: '镜头推进', allow_manual_prompts: true, manual_prompts_reason: 'test: normalize-only' },
      execCtx(cwd),
    )
  } catch (error) {
    message = String(error?.message ?? error)
  }
  // 默认手动模式不该被 auto_start / 确认门拦下；测试里用不存在的 CLI 提前失败。
  assert.equal(/auto_start_reason|requires confirmation of model/.test(message), false, message)
  assert.match(message, /dreamina/i)
})
