import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createProject,
  transition,
  canTransition,
  validateVideoSettings,
  addMaterial,
  confirmPrompt,
  addPrompt,
  buildSubmissionPayload,
  planSlots,
  assessSlotCounts,
  lockFinalMaterials,
  mediaExtensions,
} from '../src/shared/project-core.ts'

test('state machine follows the guide sequence', () => {
  let p = createProject('p1', 'skill-a')
  assert.equal(p.status, 'awaiting_skill_confirmation')
  p = transition(p, 'awaiting_video_settings')
  p = transition(p, 'project_initialized')
  p = transition(p, 'awaiting_image_stage_choice')
  p = transition(p, 'collecting_user_materials')
  p = transition(p, 'final_images_ready')
  p = addPrompt(p, '提示词 V1', 'skill_v1')
  assert.equal(p.status, 'authoring_prompt')
  p = transition(p, 'awaiting_prompt_confirmation')
  p = confirmPrompt(p)
  assert.equal(p.status, 'prompt_confirmed')
  assert.ok(p.lockedPromptHash)
  // revision loop
  p = transition(p, 'revision_requested')
  p = transition(p, 'dt_revision')
  p = addPrompt(p, '修订版提示词', 'dt_revision')
  assert.equal(p.status, 'authoring_prompt')
  p = confirmPrompt(p)
  assert.equal(p.prompts.length, 2)
  assert.equal(p.prompts[1].confirmed, true)
  p = transition(p, 'generating_video')
  p = transition(p, 'completed')
  assert.equal(p.status, 'completed')
})

test('invalid transitions are rejected', () => {
  const p = createProject('p2')
  assert.throws(() => transition(p, 'completed'), /invalid project transition/)
  assert.throws(() => transition(p, 'prompt_confirmed'), /invalid project transition/)
  assert.ok(!canTransition(p.status, 'completed'))
  assert.throws(() => validateVideoSettings('9:16x', 5), /unsupported video ratio/)
  assert.throws(() => validateVideoSettings('16:9', 3), /4 and 30/)
})

test('materials enforce slot max and lock hashes at confirmation', () => {
  let p = createProject('p3')
  p = transition(p, 'awaiting_video_settings')
  p = transition(p, 'project_initialized')
  p = transition(p, 'awaiting_image_stage_choice')
  p = transition(p, 'collecting_user_materials')
  const slots = [{ id: 'hero', min: 1, max: 2 }]
  p = addMaterial(p, 'hero', 'D:/a.png', 'h1', slots)
  p = addMaterial(p, 'hero', 'D:/b.png', 'h2', slots)
  assert.throws(() => addMaterial(p, 'hero', 'D:/c.png', 'h3', slots), /max 2/)
  // materials cannot be added outside the collecting stage
  const locked = { ...p, status: 'final_images_ready' }
  assert.throws(() => addMaterial(locked, 'hero', 'D:/d.png', 'h4', slots), /can only be added/)
  p = transition(p, 'final_images_ready')
  p = addPrompt(p, 'v1', 'skill_v1')
  p = confirmPrompt(p)
  assert.equal(Object.keys(p.lockedMaterialHashes ?? {}).length, 2)
})

test('buildSubmissionPayload rejects changed material hashes (unconfirmed version guard)', () => {
  let p = createProject('p4')
  p = transition(p, 'awaiting_video_settings')
  p = transition(p, 'project_initialized')
  p = transition(p, 'awaiting_image_stage_choice')
  p = transition(p, 'collecting_user_materials')
  p = addMaterial(p, 'hero', 'D:/a.png', 'hash-v1')
  p = transition(p, 'final_images_ready')
  p = addPrompt(p, '确认的提示词', 'skill_v1')
  p = confirmPrompt(p)
  // unchanged hashes → payload builds
  const payload = buildSubmissionPayload(p, { 'hero:D:/a.png': 'hash-v1' })
  assert.equal(payload.prompt_hash, p.lockedPromptHash)
  // changed hash → refused
  assert.throws(() => buildSubmissionPayload(p, { 'hero:D:/a.png': 'hash-CHANGED' }), /hashes changed/)
  // build before prompt_confirmed → refused
  const notConfirmed = { ...p, status: 'authoring_prompt' }
  assert.throws(() => buildSubmissionPayload(notConfirmed, { 'hero:D:/a.png': 'hash-v1' }), /prompt_confirmed/)
})

test('CS 独享 V1：首版必须 skill_v1，后续必须 dt_revision', () => {
  let p = createProject('cs-only')
  p = transition(p, 'awaiting_video_settings')
  p = transition(p, 'project_initialized')
  p = transition(p, 'awaiting_image_stage_choice')
  p = transition(p, 'collecting_user_materials')
  p = transition(p, 'final_images_ready')
  // V1 用非 skill_v1 来源 → 拒绝
  assert.throws(() => addPrompt(p, '首版', 'user'), /首版提示词必须由 CS Skill/)
  assert.throws(() => addPrompt(p, '首版', 'dt_revision'), /首版提示词必须由 CS Skill/)
  p = addPrompt(p, 'CS Skill 生成的首版', 'skill_v1')
  assert.equal(p.prompts[0].source, 'skill_v1')
  // 第二个 skill_v1 → 拒绝
  assert.throws(() => addPrompt(p, '再来一版', 'skill_v1'), /只生成首版/)
  // 修订走 dt_revision
  p = transition(p, 'awaiting_prompt_confirmation')
  p = transition(p, 'revision_requested')
  p = transition(p, 'dt_revision')
  p = addPrompt(p, 'DT 修订版', 'dt_revision')
  assert.equal(p.prompts[1].source, 'dt_revision')
})

test('planSlots derives planned_count from count_rule and creates dirs', () => {
  const refs = [
    { id: 'hero', media_type: 'image', role: 'identity', min_count: 1, max_count: 1, count_rule: { type: 'fixed', enforcement: 'required', fixed_count: 1, seconds_per_item: null, rounding: null, duration_share: 1, duration_to_count: [], provenance: 'source_explicit', confidence: 'high', rationale: '固定身份一张。' } },
    { id: 'scenes', media_type: 'image', role: 'scene', min_count: 2, max_count: 6, count_rule: { type: 'duration_formula', enforcement: 'required', fixed_count: null, seconds_per_item: 3, rounding: 'ceil', duration_share: 1, duration_to_count: [], provenance: 'source_explicit', confidence: 'high', rationale: '约三秒一景。' } },
  ]
  const plans = planSlots(refs, 10, 'D:/slots')
  assert.equal(plans[0].planned_count, 1)
  assert.equal(plans[1].planned_count, 4) // ceil(10/3) = 4，clamp ≤ max 6
  assert.ok(plans[1].source_dir.endsWith('scenes/source') || plans[1].source_dir.endsWith('scenes\\source'))
  assert.ok(plans[1].final_dir.endsWith('scenes/final') || plans[1].final_dir.endsWith('scenes\\final'))
  assert.equal(mediaExtensions('image').includes('.png'), true)
  assert.equal(mediaExtensions('video').includes('.mp4'), true)
})

test('assessSlotCounts enforces exact planned_count on required slots', () => {
  const plans = planSlots(
    [{ id: 'hero', media_type: 'image', role: 'identity', min_count: 1, max_count: 1, count_rule: { type: 'fixed', enforcement: 'required', fixed_count: 1, seconds_per_item: null, rounding: null, duration_share: 1, duration_to_count: [], provenance: 'source_explicit', confidence: 'high', rationale: '固定。' } }],
    5,
    'D:/slots',
  )
  assert.equal(assessSlotCounts(plans, { hero: 1 })[0].ok, true)
  assert.equal(assessSlotCounts(plans, { hero: 0 })[0].ok, false)
  assert.equal(assessSlotCounts(plans, { hero: 2 })[0].ok, false)
})

test('lockFinalMaterials locks final hashes and marks slots locked', () => {
  let p = createProject('lock')
  const plans = planSlots(
    [{ id: 'hero', media_type: 'image', role: 'identity', min_count: 1, max_count: 1, count_rule: { type: 'fixed', enforcement: 'required', fixed_count: 1, seconds_per_item: null, rounding: null, duration_share: 1, duration_to_count: [], provenance: 'source_explicit', confidence: 'high', rationale: '固定。' } }],
    5,
    'D:/slots',
  )
  p = { ...p, slotPlans: plans }
  const next = lockFinalMaterials(p, [{ slot: 'hero', path: 'D:/slots/hero/final/a.png', hash: 'h1' }])
  assert.equal(next.materials.length, 1)
  assert.equal(next.lockedMaterialHashes['hero:D:/slots/hero/final/a.png'], 'h1')
  assert.equal(next.slotPlans[0].locked, true)
})
