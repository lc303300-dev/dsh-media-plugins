/**
 * 默认手动开始（用户 2026-11-13 定）：自动开始改为手动触发。
 *
 * 默认流程 = `prepareOnly`：只上传素材、建图片节点、保存视频节点，随后返回
 * `nodes_ready` —— 不报价、不确认、不运行、不消费票据；由用户在画布手动点开始。
 * 只有显式关掉 prepareOnly（工具层 auto_start=true）才进入付费段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCanvasCli } from '../src/shared/dreamina-canvas.ts'
import { runCanvasVideoBatch } from '../src/shared/video-canvas-pipeline.ts'

const UUID_A = 'ae6e3832-9103-49fa-9845-148dd2e65983'
const PROJECT = '2d7fb6f3-73ff-4783-8b05-078a1810d020'
const SUBMIT = 'd9eb943d-a9e5-4a1a-a795-a553f3af69fa'

const ok = (data) => JSON.stringify({ schemaVersion: '1', ok: true, data, meta: { requestId: 'req-1' } })

function fakeExec() {
  const calls = []
  const exec = async (_binary, args) => {
    calls.push(args)
    const line = args.join(' ')
    if (line.includes('resource upload')) return { stdout: ok({ resourceId: UUID_A, mediaType: 'image' }), stderr: '', exitCode: 0 }
    if (line.includes('node create image')) return { stdout: ok({ node: { nodeId: 'node_img1', type: 'image', status: 'success' } }), stderr: '', exitCode: 0 }
    if (line.includes('node create video')) return { stdout: ok({ node: { nodeId: 'node_v1', type: 'video' } }), stderr: '', exitCode: 0 }
    if (line.includes('node quote')) return { stdout: ok({ items: [{ nodeId: 'node_v1', maxCredits: 10 }], totalMaxCredits: 10, confirmable: true }), stderr: '', exitCode: 0 }
    if (line.includes('node confirm')) return { stdout: ok({ creditConfirmationToken: 'tok' }), stderr: '', exitCode: 0 }
    if (line.includes('node run')) return { stdout: ok({ items: [{ nodeId: 'node_v1', submitId: SUBMIT, state: 'accepted', resources: [{ resourceId: UUID_A }] }] }), stderr: '', exitCode: 0 }
    return { stdout: ok({}), stderr: '', exitCode: 0 }
  }
  return { exec, calls }
}

const task = () => ({ taskId: 't1', title: 'a-1', prompt: '海面日落', images: ['C:\\in\\a.png'], videos: [], audios: [], duration: 5, explicitRatio: true })

test('prepareOnly: 只建图片/视频节点，返回 nodes_ready，不报价不运行不消费票据', async () => {
  const { exec, calls } = fakeExec()
  const cli = createCanvasCli({ binary: 'b', exec })
  let gateHit = false
  const results = await runCanvasVideoBatch(
    {
      cli,
      projectId: PROJECT,
      model: 'seedance_2.5',
      resolution: '480p',
      ratio: '16:9',
      pollTimeoutMs: 60_000,
      prepareOnly: true,
      beforePaidSubmit: async () => {
        gateHit = true
      },
    },
    [task()],
    ['C:\\jobs\\t1'],
    [SUBMIT],
  )

  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'nodes_ready')
  assert.equal(results[0].nodeId, 'node_v1')

  const lines = calls.map((c) => c.join(' '))
  assert.ok(lines.some((l) => l.includes('resource upload')), '素材仍要上传登记')
  assert.ok(lines.some((l) => l.includes('node create image')), '图片素材必须挂成图片节点')
  assert.ok(lines.some((l) => l.includes('node create video')), '视频节点必须建好')
  assert.equal(lines.some((l) => l.includes('node quote')), false, '默认手动模式不得报价')
  assert.equal(lines.some((l) => l.includes('node confirm')), false, '默认手动模式不得确认')
  assert.equal(lines.some((l) => l.includes('node run')), false, '默认手动模式不得运行/扣费')
  assert.equal(gateHit, false, '不提交就不该消费票据')
})

test('prepareOnly 建节点失败：返回 failed，且不进入付费段', async () => {
  const { exec, calls } = fakeExec()
  const execFailing = async (binary, args) => {
    if (args.join(' ').includes('node create video')) return { stdout: '', stderr: 'boom', exitCode: 1 }
    return exec(binary, args)
  }
  const cli = createCanvasCli({ binary: 'b', exec: execFailing })
  const results = await runCanvasVideoBatch(
    { cli, projectId: PROJECT, model: 'seedance_2.5', resolution: '480p', ratio: '16:9', pollTimeoutMs: 60_000, prepareOnly: true },
    [task()],
    ['C:\\jobs\\t1'],
    [SUBMIT],
  )
  assert.equal(results[0].status, 'failed')
  assert.equal(calls.some((c) => c.join(' ').includes('node quote')), false)
})
