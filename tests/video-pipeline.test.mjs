/**
 * Unified video pipeline pure-helper tests (Codex_image Media-Router rebuild).
 * Guards the two hard guarantees: precise download selection (never pick
 * another task's video) and the confirmation gate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isVideoExtName,
  pickDownloadedVideo,
  confirmationGateError,
  promptCompletenessBoundaryIssue,
  classifyVideoPromptCompleteness,
  completenessRequiresCorpus,
  authoringCorpusGateError,
  normalizeReferenceLabels,
} from '../src/shared/video-pipeline.ts'

test('isVideoExtName accepts known video containers and rejects others', () => {
  for (const name of ['a.mp4', 'b.MP4', 'clip.mov', 'x.webm', 'y.mkv', 'z.avi', 'm.m4v']) {
    assert.equal(isVideoExtName(name), true)
  }
  for (const name of ['a.png', 'b.jpg', 'c.txt']) assert.equal(isVideoExtName(name), false)
})

test('pickDownloadedVideo: submit_id in filename wins even if older than a sibling', () => {
  const submit = 'abc123'
  const chosen = pickDownloadedVideo([
    { name: 'other-task-def456.mp4', mtimeMs: 2000, valid: true },
    { name: `task-${submit}-out.mp4`, mtimeMs: 1000, valid: true },
  ], submit)
  assert.equal(chosen?.name, `task-${submit}-out.mp4`)
})

test('pickDownloadedVideo: newest valid among the submit_id matches', () => {
  const submit = 'abc123'
  const chosen = pickDownloadedVideo([
    { name: `A-${submit}.mp4`, mtimeMs: 1000, valid: true },
    { name: `B-${submit}.mp4`, mtimeMs: 3000, valid: true },
    { name: `C-${submit}.mp4`, mtimeMs: 2000, valid: false },
  ], submit)
  assert.equal(chosen?.name, `B-${submit}.mp4`)
})

test('pickDownloadedVideo: falls back to newest valid video when no submit_id match (isolated dir)', () => {
  const chosen = pickDownloadedVideo([
    { name: 'fullyRandomName.mp4', mtimeMs: 1000, valid: true },
    { name: 'fullyRandomName2.mp4', mtimeMs: 4000, valid: true },
    { name: 'stillWritin.mp4', mtimeMs: 5000, valid: false },
  ], 'abc123')
  // no filename matches submit_id -> newest VALID wins (the invalid newest is skipped)
  assert.equal(chosen?.name, 'fullyRandomName2.mp4')
})

test('pickDownloadedVideo: returns undefined when nothing is valid yet', () => {
  const chosen = pickDownloadedVideo([
    { name: 'x.mp4', mtimeMs: 5000, valid: false },
  ], 'abc123')
  assert.equal(chosen, undefined)
})

test('pickDownloadedVideo: ignores non-video files', () => {
  const chosen = pickDownloadedVideo([
    { name: 'cover.png', mtimeMs: 9000, valid: true },
    { name: 'real-abc123.mp4', mtimeMs: 1000, valid: true },
  ], 'abc123')
  assert.equal(chosen?.name, 'real-abc123.mp4')
})

test('confirmationGateError: test mode never needs confirmation', () => {
  assert.equal(confirmationGateError('test_submit_only', { model: 'seedance2.0', resolution: '720p', duration: 5 }, {}), null)
})

test('confirmationGateError: production requires all three confirmation fields', () => {
  const resolved = { model: 'seedance2.5', resolution: '480p', duration: 5 }
  assert.ok(confirmationGateError('production', resolved, {}))
  assert.ok(confirmationGateError('production', resolved, { model: 'seedance2.5' }))
  assert.ok(confirmationGateError('production_submit_only', resolved, { model: 'seedance2.5', resolution: '480p' }))
})

test('confirmationGateError: mismatch is rejected with a clear message', () => {
  const resolved = { model: 'seedance2.5', resolution: '480p', duration: 5 }
  assert.match(confirmationGateError('production', resolved, { model: 'seedance2.0_vip', resolution: '480p', duration: 5 }), /model/)
  assert.match(confirmationGateError('production', resolved, { model: 'seedance2.5', resolution: '720p', duration: 5 }), /resolution/)
  assert.match(confirmationGateError('production', resolved, { model: 'seedance2.5', resolution: '480p', duration: 8 }), /duration/)
})

test('confirmationGateError: matching confirmation passes', () => {
  assert.equal(confirmationGateError('production', { model: 'seedance2.5', resolution: '480p', duration: 5 }, { model: 'seedance2.5', resolution: '480p', duration: 5 }), null)
})

test('promptCompletenessBoundaryIssue: rejects empty and terminal metadata, passes clean prompts', () => {
  assert.ok(promptCompletenessBoundaryIssue('   '))
  assert.ok(promptCompletenessBoundaryIssue(''))
  assert.match(promptCompletenessBoundaryIssue('a cat runs\nWall time: 0.6 seconds'), /terminal/)
  assert.match(promptCompletenessBoundaryIssue('Exit code: 1\n正文'), /terminal/)
  assert.equal(promptCompletenessBoundaryIssue('一只猫在夕阳下奔跑，镜头缓慢推进。'), null)
})

test('classifyVideoPromptCompleteness: a bare intent w/o shot/media binding is incomplete', () => {
  const bare = classifyVideoPromptCompleteness('把这4张图做成城市宣传片视频', { images: 4, videos: 0, audios: 0 })
  assert.equal(bare.verdict, 'incomplete')
  assert.ok(bare.reasons.length > 0)
  // missing reference binding is called out when media is present
  const noBind = classifyVideoPromptCompleteness('镜头缓慢推进，展现城市黄昏之美', { images: 4, videos: 0, audios: 0 })
  assert.equal(noBind.verdict, 'incomplete')
  assert.ok(noBind.reasons.some((r) => /引用绑定/.test(r)))
})

test('classifyVideoPromptCompleteness: executable shot + camera + binding is complete', () => {
  const full = classifyVideoPromptCompleteness('镜头以低空航拍掠过幸福大桥，沿街面平视穿行，0-8秒分三段，绑定图片1 与图片4', { images: 4, videos: 0, audios: 0 })
  assert.equal(full.verdict, 'complete')
  assert.equal(full.reasons.length, 0)
})

test('authoring gate: corpus consultation is mandatory regardless of completeness', () => {
  assert.equal(completenessRequiresCorpus('incomplete'), true)
  assert.equal(completenessRequiresCorpus('complete'), true)
  // no corpus hits -> gate rejects for BOTH verdicts (complete must also consult corpus)
  assert.ok(authoringCorpusGateError('incomplete', 0))
  assert.ok(authoringCorpusGateError('incomplete', undefined))
  assert.ok(authoringCorpusGateError('complete', 0))
  // with corpus hits -> gate passes
  assert.equal(authoringCorpusGateError('incomplete', 3), null)
  assert.equal(authoringCorpusGateError('complete', 10), null)
})

test('confirmationGateError: duration accepts 5 / 5s / 5秒 forms', () => {
  const resolved = { model: 'seedance2.5', resolution: '480p', duration: 5 }
  assert.equal(confirmationGateError('production', resolved, { model: 'seedance2.5', resolution: '480p', duration: '5s' }), null)
  assert.equal(confirmationGateError('production', resolved, { model: 'seedance2.5', resolution: '480p', duration: '5秒' }), null)
  assert.ok(confirmationGateError('production', resolved, { model: 'seedance2.5', resolution: '480p', duration: 'not-a-number' }))
})

test('normalizeReferenceLabels: @chip / 参考 prefix / English / whitespace → bare 图片N (idempotent)', () => {
  const out = normalizeReferenceLabels('主角@图片1 看向 参考图片2 与 @Image 3 与 图片 4')
  assert.equal(out.prompt, '主角图片1 看向 图片2 与 图片3 与 图片4')
  assert.ok(out.changed.length >= 4)
  // idempotent: a second pass changes nothing
  assert.equal(normalizeReferenceLabels(out.prompt).changed.length, 0)
})

test('normalizeReferenceLabels: maps 视频/音频 kinds and leaves clean prompts untouched', () => {
  assert.equal(normalizeReferenceLabels('@视频1 和 @音频2').prompt, '视频1 和 音频2')
  assert.equal(normalizeReferenceLabels('镜头推进，绑定图片1 与视频1').prompt, '镜头推进，绑定图片1 与视频1')
  assert.equal(normalizeReferenceLabels('镜头推进，绑定图片1 与视频1').changed.length, 0)
})

test('classifyVideoPromptCompleteness: non-conforming labels (@图片N / 参考图片N) are flagged, not silently accepted', () => {
  const chip = classifyVideoPromptCompleteness('镜头缓慢推进，展现城市黄昏，绑定@图片1', { images: 2, videos: 0, audios: 0 })
  assert.equal(chip.verdict, 'incomplete')
  assert.ok(chip.reasons.some((r) => /裸标签/.test(r)))
  const prefix = classifyVideoPromptCompleteness('镜头缓慢推进，展现城市黄昏，绑定参考图片1', { images: 2, videos: 0, audios: 0 })
  assert.equal(prefix.verdict, 'incomplete')
  assert.ok(prefix.reasons.some((r) => /裸标签/.test(r)))
})

test('classifyVideoPromptCompleteness: bare 图片N label passes (BUG-09 regression guard)', () => {
  const full = classifyVideoPromptCompleteness('镜头以低空航拍掠过城市，沿街面平视穿行，0-8秒分三段，绑定图片1 与图片4', { images: 4, videos: 0, audios: 0 })
  assert.equal(full.verdict, 'complete')
  assert.equal(full.reasons.length, 0)
})
