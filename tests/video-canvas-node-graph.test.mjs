/**
 * 画布素材节点 + 付费段顺序（2026-11-05 两条硬规则）。
 *
 * 事故现场：Agent 先用 `resource upload` 只登记资源、再用 `{{res:...}}` 引用，
 * 视频节点的 `upstreamNodeIds` 为空 —— 画布上看不到图片、没有连线，用户拿到的
 * 是一张空节点。另一处：票据在节点创建之前就被消费，节点创建失败时票白烧。
 *
 * 这里把两条规则钉成测试：
 *   1. 图片素材必须先 `node create image --resource-id` 挂成图片节点，视频节点用
 *      `node:<nodeId>` 引用（不是 `res:`）；
 *   2. `beforePaidSubmit`（消费票据的闸门）只在**全部节点保存之后**调用一次；
 *      建节点失败时它一次都不会被调用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvasCli } from '../src/shared/dreamina-canvas.ts'
import { runCanvasVideoBatch } from '../src/shared/video-canvas-pipeline.ts'

const UUID_A = 'ae6e3832-9103-49fa-9845-148dd2e65983'
const UUID_B = 'c6bd0fec-10c5-498e-920f-480b40104765'
const UUID_SUBMIT = 'd9eb943d-a9e5-4a1a-a795-a553f3af69fa'
const PROJECT = '2d7fb6f3-73ff-4783-8b05-078a1810d020'

const ok = (data) => JSON.stringify({ schemaVersion: '1', ok: true, data, meta: { requestId: 'req-1' } })

function fakeExec(routes) {
  const calls = []
  const exec = async (_binary, args) => {
    calls.push(args)
    const line = args.join(' ')
    for (const [needle, handler] of routes) {
      if (line.includes(needle)) return await handler(args, line)
    }
    return { stdout: ok({}), stderr: '', exitCode: 0 }
  }
  return { exec, calls }
}

function routes(overrides = {}) {
  return [
    ['resource upload', () => ({ stdout: ok({ resourceId: UUID_A, mediaType: 'image' }), stderr: '', exitCode: 0 })],
    ['node create image', () => ({ stdout: ok({ node: { nodeId: 'node_img1', type: 'image', status: 'success' } }), stderr: '', exitCode: 0 })],
    ['node create video', overrides.createVideo ?? (() => ({ stdout: ok({ node: { nodeId: 'node_x', type: 'video' } }), stderr: '', exitCode: 0 }))],
    ['node quote', () => ({ stdout: ok({ items: [{ nodeId: 'node_x', maxCredits: 10 }], totalMaxCredits: 10, confirmable: true }), stderr: '', exitCode: 0 })],
    ['node confirm', () => ({ stdout: ok({ creditConfirmationToken: 'tok' }), stderr: '', exitCode: 0 })],
    ['node run', () => ({ stdout: ok({ items: [{ nodeId: 'node_x', submitId: UUID_SUBMIT, state: 'accepted', resources: [{ resourceId: UUID_B }] }] }), stderr: '', exitCode: 0 })],
  ]
}

function makeTask() {
  return { taskId: 't1', title: 'a-1', prompt: '海面日落', images: ['C:\\in\\a.png'], videos: [], audios: [], duration: 5, explicitRatio: true }
}

test('图片素材被挂成画布图片节点，视频节点用 node: 引用（不是 res:）', async () => {
  let createVideoArgs
  const { exec, calls } = fakeExec(
    routes({ createVideo: (args) => { createVideoArgs = args; return { stdout: ok({ node: { nodeId: 'node_x', type: 'video' } }), stderr: '', exitCode: 0 } } }),
  )
  const cli = createCanvasCli({ binary: 'b', exec })
  await runCanvasVideoBatch(
    { cli, projectId: PROJECT, model: 'seedance_2.5', resolution: '480p', ratio: '16:9', pollTimeoutMs: 60_000, submitOnly: true },
    [makeTask()],
    ['C:\\jobs\\t1'],
    [UUID_SUBMIT],
  )

  const lines = calls.map((c) => c.join(' '))
  // 上传 → 建图片节点 → 建视频节点，顺序固定
  const uploadIdx = lines.findIndex((l) => l.includes('resource upload'))
  const imgIdx = lines.findIndex((l) => l.includes('node create image'))
  const videoIdx = lines.findIndex((l) => l.includes('node create video'))
  assert.ok(uploadIdx >= 0 && imgIdx > uploadIdx && videoIdx > imgIdx, '顺序应为 上传 → 图片节点 → 视频节点')

  // 图片节点必须带 --resource-id + --import-kind local_upload
  const imgCall = calls[imgIdx]
  assert.equal(imgCall[imgCall.indexOf('--resource-id') + 1], UUID_A)
  assert.equal(imgCall[imgCall.indexOf('--import-kind') + 1], 'local_upload')

  // 视频节点引用必须是 node:
  assert.ok(createVideoArgs.includes('node:node_img1'), '视频节点必须用 node: 引用图片节点')
  assert.equal(createVideoArgs.some((a) => a.startsWith('res:')), false, '图片素材不得退化成 res: 引用')
})

test('beforePaidSubmit 只在全部节点保存之后调用一次（此时还没有任何报价）', async () => {
  const { exec, calls } = fakeExec(routes())
  const cli = createCanvasCli({ binary: 'b', exec })
  const gateCalls = []
  await runCanvasVideoBatch(
    {
      cli,
      projectId: PROJECT,
      model: 'seedance_2.5',
      resolution: '480p',
      ratio: '16:9',
      pollTimeoutMs: 60_000,
      submitOnly: true,
      beforePaidSubmit: async () => {
        gateCalls.push(calls.map((c) => c.join(' ')))
      },
    },
    [makeTask()],
    ['C:\\jobs\\t1'],
    [UUID_SUBMIT],
  )

  assert.equal(gateCalls.length, 1, '闸门必须只触发一次')
  const atGate = gateCalls[0]
  assert.ok(atGate.some((l) => l.includes('node create video')), '闸门触发时视频节点应已建好')
  assert.equal(atGate.some((l) => l.includes('node quote')), false, '闸门触发时不得已进入付费段')
})

test('建节点失败时闸门不触发（票据不会被烧掉）', async () => {
  const { exec } = fakeExec(
    routes({ createVideo: () => ({ stdout: '', stderr: 'boom', exitCode: 1 }) }),
  )
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
      submitOnly: true,
      beforePaidSubmit: async () => {
        gateHit = true
      },
    },
    [makeTask()],
    ['C:\\jobs\\t1'],
    [UUID_SUBMIT],
  )

  assert.equal(gateHit, false, '节点没建成就不能消费票据')
  assert.equal(results[0].status, 'failed')
})
