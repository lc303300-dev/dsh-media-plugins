import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  stagePlan,
  sanitizeGifStem,
  resolveFfmpeg,
  videoToGif,
  QUALITY_STAGES,
  STRICT_EXTRA_STAGES,
} from '../src/shared/gif-core.ts'

/* ---------- stage plan (pure) ---------- */

test('stagePlan 默认给出完整质量档位（960→360）', () => {
  assert.deepEqual(stagePlan({}), QUALITY_STAGES)
  assert.equal(stagePlan({}).length, 5)
})

test('stagePlan 在 strict 模式追加超小档位', () => {
  const plan = stagePlan({ mode: 'strict' })
  assert.equal(plan.length, QUALITY_STAGES.length + STRICT_EXTRA_STAGES.length)
  assert.deepEqual(plan.slice(-2), STRICT_EXTRA_STAGES)
})

test('stagePlan 尊重 minWidth：不生成低于下限的档位', () => {
  const plan = stagePlan({ minWidth: 480 })
  assert.deepEqual(plan.map((s) => s.width), [960, 720, 640, 480])
  assert.ok(plan.every((s) => s.width >= 480))
})

test('stagePlan 在 minWidth 高于最高档时保底最高档（不返回空计划）', () => {
  assert.deepEqual(stagePlan({ minWidth: 2000 }), [QUALITY_STAGES[0]])
})

test('stagePlan 忽略非法 minWidth（0/负数）并回落到默认下限', () => {
  assert.deepEqual(stagePlan({ minWidth: 0 }), QUALITY_STAGES)
  assert.deepEqual(stagePlan({ minWidth: -100 }), QUALITY_STAGES)
})

test('stagePlan 在 strict 模式不套用 minWidth（允许继续降到 240）', () => {
  const plan = stagePlan({ mode: 'strict', minWidth: 480 })
  assert.equal(plan.at(-1).width, 240)
})

test('固定 width/fps 收敛为单档，自定义 stages 优先', () => {
  assert.deepEqual(stagePlan({ width: 480, fps: 10 }), [{ width: 480, fps: 10 }])
  assert.deepEqual(stagePlan({ width: 480 }), [{ width: 480, fps: 10 }])
  assert.deepEqual(stagePlan({ fps: 12 }), [{ width: 720, fps: 12 }])
  const custom = [{ width: 500, fps: 9 }]
  assert.deepEqual(stagePlan({ stages: custom, minWidth: 900, mode: 'strict' }), custom)
})

/* ---------- artifact stems ---------- */

test('sanitizeGifStem 从路径取基名并去掉扩展名', () => {
  assert.equal(sanitizeGifStem('D:\\clips\\holiday.mp4'), 'holiday')
  assert.equal(sanitizeGifStem('/home/u/clips/holiday.mov'), 'holiday')
})

test('sanitizeGifStem 保留中文并清理非法字符与空白', () => {
  assert.equal(sanitizeGifStem('D:\\素材\\夏日 海边:v2*.mp4'), '夏日_海边_v2')
})

test('sanitizeGifStem 用 stripExtension:false 保留点号（显式 stem 幂等）', () => {
  assert.equal(sanitizeGifStem('a.b', { stripExtension: false }), 'a.b')
  assert.equal(sanitizeGifStem('a.b'), 'a')
})

test('sanitizeGifStem 对空输入兜底且截断超长名', () => {
  assert.equal(sanitizeGifStem(''), 'video')
  assert.equal(sanitizeGifStem('   '), 'video')
  assert.equal(sanitizeGifStem('x'.repeat(80)).length, 48)
})

/* ---------- end-to-end (needs ffmpeg) ---------- */

const ffmpeg = await resolveFfmpeg()
const skipNoFfmpeg = ffmpeg ? false : 'ffmpeg 不可用（FFMPEG_PATH/PATH/常见路径）'

/** Write a 1s 320x240 test clip with the given lavfi source. */
function makeClip(dir, name, source) {
  const file = join(dir, name)
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `${source}=duration=1:size=320x240:rate=10`, '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' })
  return file
}

test('端到端：同一输出目录下多个输入不再互相覆盖', { skip: skipNoFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gif-e2e-'))
  try {
    const a = makeClip(dir, 'clip-a.mp4', 'testsrc')
    const b = makeClip(dir, 'clip-b.mp4', 'smptebars')
    const out = join(dir, 'out')
    const r1 = await videoToGif(a, out, { ffmpegPath: ffmpeg })
    const r2 = await videoToGif(b, out, { ffmpegPath: ffmpeg })
    assert.notEqual(r1.path, r2.path, '两次转换必须落到不同文件')
    assert.ok(r1.path.includes('clip-a') && r2.path.includes('clip-b'))
    assert.ok(existsSync(r1.path) && existsSync(r2.path), '两个产物都必须存在')
    assert.ok(statSync(r1.path).size > 0 && statSync(r2.path).size > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：min_width 阻止档位低于下限', { skip: skipNoFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gif-e2e-'))
  try {
    const a = makeClip(dir, 'clip-a.mp4', 'testsrc')
    const out = join(dir, 'out')
    // Budget far below what any stage can reach: the search must still stop at the floor.
    const r = await videoToGif(a, out, { ffmpegPath: ffmpeg, maxSizeMB: 0.001, minWidth: 480 })
    assert.equal(r.withinBudget, false)
    assert.ok(r.width >= 480, `width=${r.width} 不得低于 min_width=480`)
    assert.ok(r.stagesTried.every((s) => !s.startsWith('360px')), '不应尝试 360 档')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：默认预算下第一档即命中', { skip: skipNoFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gif-e2e-'))
  try {
    const a = makeClip(dir, 'clip-a.mp4', 'testsrc')
    const r = await videoToGif(a, join(dir, 'out'), { ffmpegPath: ffmpeg })
    assert.equal(r.withinBudget, true)
    assert.equal(r.width, 960)
    assert.equal(r.attempts, 1)
    assert.ok(statSync(r.path).size > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
