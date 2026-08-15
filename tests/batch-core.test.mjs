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
})

test('manifest validation rejects bad input', () => {
  assert.throws(() => validateManifest({ groups: [] }), /non-empty/)
  assert.throws(() => validateManifest({ groups: [{ id: 'a', prompt: 'x', candidates: 0, image_ratio: '1:1' }] }), /candidates/)
  assert.throws(() => validateManifest({ groups: [{ id: 'a', prompt: '', candidates: 1, image_ratio: '1:1' }] }), /prompt/)
  assert.throws(() => validateManifest({ groups: [{ id: 'a', prompt: 'x', candidates: 1, image_ratio: '4:5' }] }), /image_ratio/)
  assert.throws(() => validateManifest({ groups: [{ id: 'a', prompt: 'x', candidates: 1, image_ratio: '1:1' }, { id: 'a', prompt: 'y', candidates: 1, image_ratio: '1:1' }] }), /duplicate group/)
  assert.throws(() => validateManifest({ ...baseManifest, concurrency: 11 }), /concurrency/)
  assert.throws(() => validateManifest({ ...baseManifest, concurrency: 0 }), /concurrency/)
})

test('stable job key: same content, same key; order-insensitive', () => {
  const m1 = { groups: [{ id: 'a', prompt: 'p', candidates: 2, image_ratio: '1:1' }, { id: 'b', prompt: 'q', candidates: 3, image_ratio: '16:9' }], concurrency: 4 }
  const m2 = { groups: [{ id: 'b', prompt: 'q', candidates: 3, image_ratio: '16:9' }, { id: 'a', prompt: 'p', candidates: 2, image_ratio: '1:1' }], concurrency: 4 }
  const m3 = { groups: [{ id: 'a', prompt: 'p', candidates: 2, image_ratio: '1:1' }, { id: 'b', prompt: 'q', candidates: 3, image_ratio: '16:9' }], concurrency: 8 }
  assert.equal(jobKeyFor(m1), jobKeyFor(m2))
  assert.notEqual(jobKeyFor(m1), jobKeyFor(m3))
})

test('deadline math: 40 candidates @10 → estimate 240s, default deadline 360s', () => {
  const plan = computeDeadline(baseManifest, 1_000_000)
  assert.equal(plan.total, 40)
  assert.equal(plan.estimateSeconds, 240)
  assert.equal(plan.deadlineSeconds, 360)
  assert.equal(plan.deadlineAtMs, 1_000_000 + 360_000)
})

test('deadline math: ceil up partial waves; explicit override wins', () => {
  const partial = computeDeadline({ groups: [{ id: 'a', prompt: 'p', candidates: 21, image_ratio: '1:1' }], concurrency: 10 })
  assert.equal(partial.estimateSeconds, Math.ceil(21 / 10) * 60) // 180
  assert.equal(partial.deadlineSeconds, 270) // ceil(2.1)*60s*1.5
  const explicit = computeDeadline({ ...baseManifest, deadline_seconds: 500 })
  assert.equal(explicit.deadlineSeconds, 500)
})

test('flattenTasks yields one task per candidate in slot order', () => {
  const tasks = flattenTasks(baseManifest)
  assert.equal(tasks.length, 40)
  assert.deepEqual(tasks[0], { groupId: 'a', slot: 1, prompt: '一只橘猫', ratio: '1:1' })
  assert.deepEqual(tasks[20], { groupId: 'b', slot: 1, prompt: '未来城市', ratio: '16:9' })
})
