import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VIDEO_EXECUTION_MODES,
  resolveVideoModel,
  resolveVideoResolution,
  limitsFor,
  normalizeModel,
  selectVideoSubcommand,
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
