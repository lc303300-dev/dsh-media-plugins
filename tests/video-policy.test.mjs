import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VIDEO_EXECUTION_MODES,
  VIDEO_COMMANDS,
  TEST_CHANNEL_MODEL,
  resolveVideoModel,
  resolveVideoResolution,
  limitsFor,
  normalizeModel,
  resolutionEquals,
  selectVideoCommand,
  promptPreferences,
  requiresExplicitSelectionSource,
  isSupportedVideoModel,
} from '../src/shared/video-policy.ts'

test('model policy: default seedance_2.5; explicit 2.0-family normalizes to seedance_2.0_vip', () => {
  assert.equal(resolveVideoModel('production', 'seedance_2.5'), 'seedance_2.5')
  assert.equal(resolveVideoModel('production', 'seedance_2.0'), 'seedance_2.0_vip')
  assert.equal(resolveVideoModel('production', 'seedance_2.0fast'), 'seedance_2.0_fast_vip')
  assert.equal(resolveVideoModel('production', 'seedance_2.0mini'), 'seedance_2.0_mini')
  assert.equal(resolveVideoModel('production', 'seedance_2.0_vip'), 'seedance_2.0_vip')
  assert.equal(resolveVideoModel('production_submit_only', 'seedance_2.5'), 'seedance_2.5')
})

test('model policy: test channel forces the cheapest callable model regardless of user model', () => {
  assert.equal(resolveVideoModel('test_submit_only', 'seedance_2.5'), TEST_CHANNEL_MODEL)
  assert.equal(resolveVideoModel('test_submit_only', 'seedance_2.0_vip'), TEST_CHANNEL_MODEL)
})

test('resolution policy: test forces 720p; production defaults to 480p or explicit value', () => {
  assert.equal(resolveVideoResolution('test_submit_only', undefined, '480p'), '720p')
  assert.equal(resolveVideoResolution('test_submit_only', '1080p', '480p'), '720p')
  assert.equal(resolveVideoResolution('production', undefined, '480p'), '480p')
  assert.equal(resolveVideoResolution('production', '720p', '480p'), '720p')
})

test('limits: seedance_2.5 50 refs/4-30s/480p-1080p/audio-only; 2.0_vip 12 refs; fast/mini 720p only', () => {
  const l25 = limitsFor('seedance_2.5')
  assert.equal(l25.total, 50)
  assert.equal(l25.durationMax, 30)
  assert.deepEqual(l25.resolutions, ['480p', '720p', '1080p'])
  assert.equal(l25.audioOnlyAllowed, true)
  assert.equal(l25.supportsMultimodal, true)

  const vip = limitsFor('seedance_2.0_vip')
  assert.equal(vip.total, 12)
  assert.equal(vip.durationMax, 15)
  // 画布 CLI 实测：2.0_vip 从 720p 起步（没有 480p），到 4k 为止。
  assert.deepEqual(vip.resolutions, ['720p', '1080p', '4k'])
  assert.equal(vip.audioOnlyAllowed, false)

  const fast = limitsFor('seedance_2.0_fast_vip')
  assert.deepEqual(fast.resolutions, ['720p'])
  assert.deepEqual(limitsFor('seedance_2.0_mini').resolutions, ['720p'])

  // seedance_pro_fast 只提供 t2v / first_last_frame
  const framesOnly = limitsFor('seedance_pro_fast')
  assert.equal(framesOnly.supportsMultimodal, false)
  assert.equal(framesOnly.durationMin, 5)
  assert.equal(framesOnly.durationMax, 10)
})

test('resolution matching is case-insensitive (720p vs 720P appear in the same catalog)', () => {
  assert.equal(resolutionEquals('720p', '720P'), true)
  assert.equal(resolutionEquals('1080P', '1080p'), true)
  assert.equal(resolutionEquals('1080p', '720p'), false)
})

test('model aliases resolve to canvas canonical names; unknown passthrough', () => {
  assert.equal(normalizeModel('2.5'), 'seedance_2.5')
  assert.equal(normalizeModel('2.0fast'), 'seedance_2.0_fast_vip')
  assert.equal(normalizeModel('1.0fast'), 'seedance_pro_fast')
  assert.equal(normalizeModel('3.0'), 'wan_3.0')
  // legacy canonical spellings keep working through the migration
  assert.equal(normalizeModel('seedance2.5'), 'seedance_2.5')
  assert.equal(normalizeModel('seedance2.0mini'), 'seedance_2.0_mini')
  assert.equal(normalizeModel(undefined), undefined)
})

test('execution modes are exactly the three contract values', () => {
  assert.deepEqual([...VIDEO_EXECUTION_MODES], ['production', 'production_submit_only', 'test_submit_only'])
})

test('command set is text2video/image2video/frames2video/multimodal2video', () => {
  assert.deepEqual([...VIDEO_COMMANDS], ['text2video', 'image2video', 'frames2video', 'multimodal2video'])
})

test('selectVideoCommand: auto-selection duplicates upstream video_router', () => {
  assert.equal(selectVideoCommand({ prompt: 'a cat runs', images: 0, videos: 0, audios: 0 }), 'text2video')
  assert.equal(selectVideoCommand({ prompt: 'p', images: 1, videos: 0, audios: 0 }), 'multimodal2video')
  assert.equal(selectVideoCommand({ prompt: 'p', images: 3, videos: 0, audios: 0 }), 'multimodal2video')
  assert.equal(selectVideoCommand({ prompt: 'p', images: 0, videos: 1, audios: 0 }), 'multimodal2video')
  assert.equal(selectVideoCommand({ prompt: 'p', images: 0, videos: 0, audios: 1 }), 'multimodal2video')
  assert.equal(selectVideoCommand({ prompt: 'p 首尾帧 使用', images: 2, videos: 0, audios: 0 }), 'frames2video')
  assert.equal(selectVideoCommand({ prompt: 'p first last frame', images: 2, videos: 0, audios: 0 }), 'frames2video')
  // two images WITHOUT first/last semantics stay multimodal
  assert.equal(selectVideoCommand({ prompt: 'p 两个参考', images: 2, videos: 0, audios: 0 }), 'multimodal2video')
})

test('selectVideoCommand: explicit override, canvas mode names, legacy multiframe rejected', () => {
  assert.equal(selectVideoCommand({ prompt: 'p', images: 1, videos: 0, audios: 0, video_command: 'image2video' }), 'image2video')
  // canvas public mode names are accepted too
  assert.equal(selectVideoCommand({ prompt: 'p', images: 1, videos: 0, audios: 0, video_command: 'first_last_frame' }), 'frames2video')
  assert.equal(selectVideoCommand({ prompt: 'p', images: 1, videos: 0, audios: 0, video_command: 'm2v' }), 'multimodal2video')
  assert.throws(() => selectVideoCommand({ prompt: 'p', images: 2, videos: 0, audios: 0, video_command: 'multiframe2video' }), /disabled legacy/)
  assert.throws(() => selectVideoCommand({ prompt: 'p', images: 0, videos: 0, audios: 0, video_command: 'nope' }), /Unsupported video command/)
})

test('promptPreferences: ratio and labelled/bare duration hints, excluding terminal noise', () => {
  assert.deepEqual(promptPreferences('16:9 全片'), { ratio: '16:9', duration: undefined })
  assert.deepEqual(promptPreferences('视频时长：8 秒，夜景'), { ratio: undefined, duration: 8 })
  assert.deepEqual(promptPreferences('0-3 秒 特写，一共 12 秒'), { ratio: undefined, duration: 12 })
  // terminal telemetry ("Wall time: 0.6 seconds") must never be read as a generation duration
  assert.deepEqual(promptPreferences('Wall time: 0.6 seconds, 16:9'), { ratio: '16:9', duration: undefined })
})

test('requiresExplicitSelectionSource: any non-default model requires user_explicit', () => {
  assert.equal(requiresExplicitSelectionSource('seedance_2.5', 'production'), false)
  assert.equal(requiresExplicitSelectionSource('seedance_2.0_vip', 'production'), true)
  assert.equal(requiresExplicitSelectionSource('wan_3.0', 'production'), true)
  assert.equal(requiresExplicitSelectionSource('seedance_2.0_vip', 'test_submit_only'), false)
})

test('isSupportedVideoModel: only the models the canvas catalog actually exposes', () => {
  for (const model of ['seedance_2.5', 'seedance_2.0_vip', 'seedance_2.0_fast_vip', 'seedance_2.0_mini', 'seedance_pro_fast', 'wan_3.0', 'happyhorse_1.1']) {
    assert.equal(isSupportedVideoModel(model), true, model)
  }
  for (const model of ['seedance2.5', 'seedance_3.0', 'seedance1.5pro', 'seedance2.0']) {
    assert.equal(isSupportedVideoModel(model), false, model)
  }
})
