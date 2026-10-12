/**
 * Per-task duration (tasks[].duration) resolution, and the pipeline capacity
 * default. A batch is filled to capacity in ONE call — batches are never split
 * by duration, so every task must be able to carry its own duration.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSpecs } from '../src/tool-video-gen.ts'
import { DEFAULT_VIDEO_CAPACITY } from '../src/shared/video-policy.ts'
import { parseTasksPayload } from '../src/shared/video-pipeline.ts'

const base = { prompt: 'fallback 绑定图片1', images: ['a.png'], videos: [], audios: [], count: 3, duration: 5 }

test('buildSpecs: explicit tasks[].duration wins over the call-level duration', () => {
  const specs = buildSpecs(
    {
      tasks: [
        { prompt: 'T1 绑定图片1', images: ['a.png'], duration: 12 },
        { prompt: 'T2 绑定图片2', images: ['b.png'], duration: 15 },
        { prompt: 'T3 绑定图片3', images: ['c.png'], duration: 4 },
      ],
    },
    base,
  )
  assert.deepEqual(specs.map((s) => s.duration), [12, 15, 4])
  assert.deepEqual(specs.map((s) => s.images), [['a.png'], ['b.png'], ['c.png']])
  assert.deepEqual(specs.map((s) => s.prompt), ['T1 绑定图片1', 'T2 绑定图片2', 'T3 绑定图片3'])
})

test('buildSpecs: falls back to the prompt hint, then the call-level duration', () => {
  const specs = buildSpecs(
    {
      tasks: [
        { prompt: '视频时长：8 秒，绑定图片1', images: ['a.png'] },
        { prompt: '绑定图片1，无时长声明', images: ['a.png'] },
      ],
    },
    base,
  )
  assert.equal(specs[0].duration, 8)
  assert.equal(specs[1].duration, 5)
})

test('buildSpecs: duration accepts the 15s / 4秒 forms', () => {
  const specs = buildSpecs(
    {
      tasks: [
        { prompt: '绑定图片1', images: ['a.png'], duration: '15s' },
        { prompt: '绑定图片1', images: ['a.png'], duration: '4秒' },
      ],
    },
    base,
  )
  assert.deepEqual(specs.map((s) => s.duration), [15, 4])
})

test('buildSpecs: without tasks, video_count copies inherit the call-level duration', () => {
  const specs = buildSpecs({}, base)
  assert.equal(specs.length, 3)
  assert.deepEqual(specs.map((s) => s.duration), [5, 5, 5])
})

test('video capacity default is 10 — one call fills a batch to capacity', () => {
  assert.equal(DEFAULT_VIDEO_CAPACITY, 10)
})

test('parseTasksPayload: accepts a bare array and {tasks:[...]} (zero-transcription handoff)', () => {
  const arr = parseTasksPayload(JSON.stringify([{ prompt: 'A 绑定图片1', images: ['a.png'], duration: 12 }]))
  assert.equal(arr.length, 1)
  assert.equal(arr[0].duration, 12)
  assert.deepEqual(arr[0].images, ['a.png'])
  const obj = parseTasksPayload(JSON.stringify({ call: 1, tasks: [{ prompt: 'B 绑定图片1', duration: 5 }] }))
  assert.equal(obj.length, 1)
  assert.equal(obj[0].duration, 5)
})

test('parseTasksPayload: rejects malformed or prompt-less payloads before any paid submit', () => {
  assert.throws(() => parseTasksPayload('not json'), /not valid JSON/)
  assert.throws(() => parseTasksPayload('[]'), /non-empty/)
  assert.throws(() => parseTasksPayload(JSON.stringify({ tasks: [] })), /non-empty/)
  assert.throws(() => parseTasksPayload(JSON.stringify([{ images: ['a.png'] }])), /prompt/)
  assert.throws(() => parseTasksPayload(JSON.stringify([{ prompt: '   ' }])), /prompt/)
  assert.throws(() => parseTasksPayload(JSON.stringify([null])), /must be an object/)
})
