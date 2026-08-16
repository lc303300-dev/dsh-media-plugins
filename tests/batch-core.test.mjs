import test from 'node:test'
import assert from 'node:assert/strict'
import { validateManifest, jobKeyFor, computeDeadline, flattenTasks } from '../src/shared/batch-core.ts'

const baseManifest = {
  groups: [
    { id: 'a', prompt: '一只橘猫', candidates: 20, image_ratio: '1:1' },
    { id: 'b', prompt: '未来城市', candidates: 20, image_ratio: '16:9' },
  ],
  concurrency: 10,
}

test('manifest validation accepts a valid manifest', () => {
  assert.doesNotThrow(() => validateManifest(baseManifest))
  assert.doesNotThrow(() => validateManifest({ ...baseManifest, image_resolution: '2K', image_provider: 'comfly-gpt-image-2' }))
  assert.doesNotThrow(() => validateManifest({ ...baseManifest, image_provider: 'comfly-gemini-lite' }), 'legacy alias is accepted')
  assert.doesNotThrow(() => validateManifest({ ...baseManifest, completion_grace_seconds: 60 }))
  assert.doesNotThrow(() => validateManifest({ ...baseManifest, completion_grace_seconds: 120 }))
})

test('manifest validation rejects bad input', () => {
  assert.throws(() => validateManifest({ groups: [] }), /non-empty/)
  assert.throws(() => validateManifest({ groups: [{ id: 'a', prompt: 'x', candidates: 0, image_ratio: '1:1' }] }), /candidates/)
  assert.throws(() => validateManifest({ groups: [{ id: 'a', prompt: '', candidates: 1, image_ratio: '1:1' }] }), /prompt/)
  assert.throws(() => validateManifest({ groups: [{ id: 'a', prompt: 'x', candidates: 1, image_ratio: '4:5' }] }), /image_ratio/)
  assert.throws(() => validateManifest({ groups: [{ id: 'a', prompt: 'x', candidates: 1, image_ratio: '1:1' }, { id: 'a', prompt: 'y', candidates: 1, image_ratio: '1:1' }] }), /duplicate group/)
  assert.throws(() => validateManifest({ ...baseManifest, concurrency: 11 }), /concurrency/)
  assert.throws(() => validateManifest({ ...baseManifest, concurrency: 0 }), /concurrency/)
  assert.throws(() => validateManifest({ ...baseManifest, image_resolution: '8K' }), /image_resolution/)
  assert.throws(() => validateManifest({ ...baseManifest, image_provider: 'antigravity-image' }), /image_provider/)
  assert.throws(() => validateManifest({ ...baseManifest, image_provider: 'comfly-gpt-image-2-all' }), /image_provider/, 'retired route is rejected')
  assert.throws(() => validateManifest({ ...baseManifest, completion_grace_seconds: 0 }), /completion_grace_seconds/)
  assert.throws(() => validateManifest({ ...baseManifest, completion_grace_seconds: -5 }), /completion_grace_seconds/)
  assert.throws(() => validateManifest({ ...baseManifest, completion_grace_seconds: 121 }), /completion_grace_seconds/, 'grace may never exceed 120 s')
})

test('stable job key: same content, same key; order-insensitive; resolution/provider included', () => {
  const m1 = { groups: [{ id: 'a', prompt: 'p', candidates: 2, image_ratio: '1:1' }, { id: 'b', prompt: 'q', candidates: 3, image_ratio: '16:9' }], concurrency: 4 }
  const m2 = { groups: [{ id: 'b', prompt: 'q', candidates: 3, image_ratio: '16:9' }, { id: 'a', prompt: 'p', candidates: 2, image_ratio: '1:1' }], concurrency: 4 }
  const m3 = { groups: [{ id: 'a', prompt: 'p', candidates: 2, image_ratio: '1:1' }, { id: 'b', prompt: 'q', candidates: 3, image_ratio: '16:9' }], concurrency: 8 }
  const m4 = { ...m1, image_resolution: '2K' }
  const m5 = { ...m1, image_resolution: '4K' }
  const m6 = { ...m1, image_provider: 'dreamina-image' }
  assert.equal(jobKeyFor(m1), jobKeyFor(m2))
  assert.notEqual(jobKeyFor(m1), jobKeyFor(m3))
  assert.notEqual(jobKeyFor(m1), jobKeyFor(m4))
  assert.notEqual(jobKeyFor(m4), jobKeyFor(m5))
  assert.notEqual(jobKeyFor(m1), jobKeyFor(m6))
})

test('deadline math: 40 candidates @10 → estimate 240s, dispatch deadline 360s, grace 120s, max runtime 480s', () => {
  const plan = computeDeadline(baseManifest, 1_000_000)
  assert.equal(plan.total, 40)
  assert.equal(plan.estimateSeconds, 240)
  assert.equal(plan.deadlineSeconds, 360)
  assert.equal(plan.completionGraceSeconds, 120)
  assert.equal(plan.maxRuntimeSeconds, 480)
  assert.equal(plan.deadlineAtMs, 1_000_000 + 360_000)
})

test('deadline math: ceil up partial waves; explicit override wins; grace shortens max runtime', () => {
  const partial = computeDeadline({ groups: [{ id: 'a', prompt: 'p', candidates: 21, image_ratio: '1:1' }], concurrency: 10 })
  assert.equal(partial.estimateSeconds, Math.ceil(21 / 10) * 60) // 180
  assert.equal(partial.deadlineSeconds, 270) // ceil(2.1)*60s*1.5
  assert.equal(partial.maxRuntimeSeconds, 390)
  const explicit = computeDeadline({ ...baseManifest, deadline_seconds: 500 })
  assert.equal(explicit.deadlineSeconds, 500)
  assert.equal(explicit.maxRuntimeSeconds, 620)
  const shortGrace = computeDeadline({ ...baseManifest, completion_grace_seconds: 30 })
  assert.equal(shortGrace.completionGraceSeconds, 30)
  assert.equal(shortGrace.maxRuntimeSeconds, 390)
})

test('flattenTasks yields one task per candidate in slot order and carries batch resolution/provider', () => {
  const tasks = flattenTasks(baseManifest)
  assert.equal(tasks.length, 40)
  assert.deepEqual(tasks[0], { groupId: 'a', slot: 1, prompt: '一只橘猫', ratio: '1:1', resolution: undefined, imageProvider: undefined, references: undefined })
  assert.deepEqual(tasks[20], { groupId: 'b', slot: 1, prompt: '未来城市', ratio: '16:9', resolution: undefined, imageProvider: undefined, references: undefined })
  const withOpts = flattenTasks({ ...baseManifest, image_resolution: '2K', image_provider: 'comfly-gpt-image-2' })
  assert.deepEqual(withOpts[0], { groupId: 'a', slot: 1, prompt: '一只橘猫', ratio: '1:1', resolution: '2K', imageProvider: 'comfly-gpt-image-2', references: undefined })
})

test('group reference images are validated and carried into tasks and job key', () => {
  const withRefs = {
    groups: [{ id: 'a', prompt: '橘猫', candidates: 3, image_ratio: '1:1', reference_images: ['./ref1.png', './ref2.png'], original_image: './ref1.png' }],
  }
  assert.doesNotThrow(() => validateManifest(withRefs))
  assert.throws(() => validateManifest({ groups: [{ id: 'a', prompt: 'x', candidates: 1, image_ratio: '1:1', reference_images: ['ok.png', 42] }] }), /reference_images/)
  assert.throws(() => validateManifest({ groups: [{ id: 'a', prompt: 'x', candidates: 1, image_ratio: '1:1', original_image: '' }] }), /original_image/)
  const tasks = flattenTasks(withRefs)
  assert.deepEqual(tasks[0].references, ['./ref1.png', './ref2.png'])
  assert.notEqual(jobKeyFor(withRefs), jobKeyFor(baseManifest))
  const withoutOriginal = { groups: [{ id: 'a', prompt: '橘猫', candidates: 3, image_ratio: '1:1', reference_images: ['./ref1.png'] }] }
  assert.notEqual(jobKeyFor(withRefs), jobKeyFor(withoutOriginal), 'original_image participates in the stable key')
})
