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
