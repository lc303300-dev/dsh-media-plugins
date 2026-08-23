import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VIDEO_EXECUTION_MODES,
  VIDEO_COMMANDS,
  resolveVideoModel,
  resolveVideoResolution,
  limitsFor,
  normalizeModel,
  selectVideoSubcommand,
  selectVideoCommand,
  promptPreferences,
  requiresExplicitSelectionSource,
  isSupportedVideoModel,
} from '../src/shared/video-policy.ts'

test('model policy: default 2.5; ordinary explicit 2.0-series normalizes to seedance2.0_vip', () => {
  assert.equal(resolveVideoModel('production', 'seedance2.5'), 'seedance2.5')
  assert.equal(resolveVideoModel('production', 'seedance2.0'), 'seedance2.0_vip')
  assert.equal(resolveVideoModel('production', 'seedance2.0fast'), 'seedance2.0_vip')
  assert.equal(resolveVideoModel('production', 'seedance2.0mini'), 'seedance2.0_vip')
  assert.equal(resolveVideoModel('production', 'seedance2.0_vip'), 'seedance2.0_vip')
  assert.equal(resolveVideoModel('production_submit_only', 'seedance2.5'), 'seedance2.5')
})

test('model policy: test channel forces non-VIP seedance2.0 regardless of user model', () => {
  assert.equal(resolveVideoModel('test_submit_only', 'seedance2.5'), 'seedance2.0')
  assert.equal(resolveVideoModel('test_submit_only', 'seedance2.0_vip'), 'seedance2.0')
})

test('resolution policy: test forces 720p; production defaults to 480p or explicit value', () => {
  assert.equal(resolveVideoResolution('test_submit_only', undefined, '480p'), '720p')
  assert.equal(resolveVideoResolution('test_submit_only', '1080p', '480p'), '720p')
  assert.equal(resolveVideoResolution('production', undefined, '480p'), '480p')
  assert.equal(resolveVideoResolution('production', '720p', '480p'), '720p')
})

test('limits: seedance2.5 supports 50 refs/4-30s/480p-1080p/audio-only; 2.0_vip 12 refs; others 720p only', () => {
  const l25 = limitsFor('seedance2.5')
  assert.equal(l25.total, 50)
  assert.equal(l25.durationMax, 30)
  assert.deepEqual(l25.resolutions, ['480p', '720p', '1080p'])
  assert.equal(l25.audioOnlyAllowed, true)
  const l20 = limitsFor('seedance2.0_vip')
  assert.equal(l20.total, 12)
  assert.equal(l20.durationMax, 15)
  assert.deepEqual(l20.resolutions, ['480p', '720p', '1080p', '4k'])
  assert.equal(l20.audioOnlyAllowed, false)
  const other = limitsFor('seedance2.0mini')
  assert.deepEqual(other.resolutions, ['720p'])
})

test('subcommand selection never emits the disabled legacy multiframe2video', () => {
  assert.equal(selectVideoSubcommand(0), 'text2video')
  assert.equal(selectVideoSubcommand(1), 'multimodal2video')
  assert.equal(selectVideoSubcommand(5), 'multimodal2video')
})

test('model aliases auto-complete the seedance prefix; unknown passthrough', () => {
  assert.equal(normalizeModel('2.5'), 'seedance2.5')
  assert.equal(normalizeModel('2.0fast'), 'seedance2.0fast')
  assert.equal(normalizeModel('seedance2.5'), 'seedance2.5')
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

test('selectVideoCommand: explicit video_command override; legacy multiframe rejected', () => {
  assert.equal(selectVideoCommand({ prompt: 'p', images: 1, videos: 0, audios: 0, video_command: 'image2video' }), 'image2video')
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

test('requiresExplicitSelectionSource: any non-default 2.0-family model requires user_explicit', () => {
  assert.equal(requiresExplicitSelectionSource('seedance2.5', 'production'), false)
  assert.equal(requiresExplicitSelectionSource('seedance2.0_vip', 'production'), true)
  assert.equal(requiresExplicitSelectionSource('seedance2.0', 'production'), true)
  assert.equal(requiresExplicitSelectionSource('seedance2.0_vip', 'test_submit_only'), false)
})

test('isSupportedVideoModel: only the documented CLI video models are accepted', () => {
  assert.equal(isSupportedVideoModel('seedance2.5'), true)
  assert.equal(isSupportedVideoModel('seedance2.0_vip'), true)
  assert.equal(isSupportedVideoModel('seedance2.0mini'), true)
  assert.equal(isSupportedVideoModel('seedance3.0'), false)
  assert.equal(isSupportedVideoModel('seedance1.5pro'), false)
})
