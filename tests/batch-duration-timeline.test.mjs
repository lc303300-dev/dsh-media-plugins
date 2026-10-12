/**
 * Regression: batch planning must not read a storyboard timeline as a duration.
 *
 * `promptPreferences` keeps the upstream bare-number hint for video-gen
 * compatibility, so `"…2.5-5秒【树叶】…"` legitimately parses as 5 seconds there.
 * Batch planning must use `promptDurationLabel` instead: otherwise a 10-second
 * batch silently submits 5-second clips, and the paid call diverges from the
 * duration the user confirmed. Observed in production on 2026-10-09
 * (batch 20261009-0209-庭院场景游览, batch duration 10 → plan said "durations 5s").
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promptDurationLabel, promptPreferences } from '../src/shared/video-policy.ts'

/** A timecoded scene-tour prompt: the exact shape that triggered the bug. */
const TIMELINE_PROMPT = [
  '0-2.5秒【水】：镜头贴近水面低机位缓慢前推。',
  '2.5-5秒【树叶】：逆光穿过枝叶，叶片半透明金绿。',
  '5-7.5秒【树与树影】：枝叶缓慢摇摆翻面。',
  '7.5-10秒【光影收束】：极慢推进并轻微上仰。',
  '不生成音乐，仅生成音效。',
].join('\n')

test('promptDurationLabel: a storyboard timeline is NOT a duration declaration', () => {
  assert.equal(promptDurationLabel(TIMELINE_PROMPT), undefined)
})

test('promptPreferences: the bare-number fallback stays untouched for video-gen', () => {
  // Documented upstream-compatible behaviour — deliberately preserved.
  assert.equal(promptPreferences(TIMELINE_PROMPT).duration, 5)
})

test('promptDurationLabel: an explicit declaration still wins', () => {
  assert.equal(promptDurationLabel('视频时长：10 秒，绑定图片1'), 10)
  assert.equal(promptDurationLabel('video duration: 12s, 图片1'), 12)
  assert.equal(promptDurationLabel('视频时长：10秒\n0-2.5秒：起手'), 10)
  // out-of-range declarations are ignored rather than clamped
  assert.equal(promptDurationLabel('视频时长：99 秒'), undefined)
})

test('batch duration resolution: timeline prompt + batch duration 10 stays 10', () => {
  // Mirrors run_batch: material.duration → explicit label → batch-level duration.
  const resolve = (material, prompt, batchDuration) => {
    if (Number.isInteger(material.duration)) return Number(material.duration)
    return promptDurationLabel(prompt) ?? batchDuration
  }

  assert.equal(resolve({}, TIMELINE_PROMPT, 10), 10)
  assert.equal(resolve({ duration: 10 }, TIMELINE_PROMPT, 10), 10)
  assert.equal(resolve({}, '视频时长：12秒 绑定图片1', 10), 12)
  assert.equal(resolve({ duration: 8 }, '视频时长：12秒 绑定图片1', 10), 8)
  assert.equal(resolve({}, '无时长声明的提示词 绑定图片1', 10), 10)
})
