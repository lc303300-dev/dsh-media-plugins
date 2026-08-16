import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  confirmImagePaidBatch,
  confirmImagePrompt,
  createImageProject,
  imageMaterialSnapshot,
  imageSafeId,
  imageSha256Text,
  lockImageMaterials,
  setImagePrompt,
  startImageGeneration,
  validateImageSettings,
} from '../src/shared/image-project-core.ts'
import { imagePackageSha256, validateImageReceipt } from '../src/shared/image-skill-core.ts'

const LIBRARY_PKG = new URL('../refs/image-skill-library/scene-storyboard-grid', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function loadContract() {
  return JSON.parse(readFileSync(join(LIBRARY_PKG, 'contract.json'), 'utf8'))
}

function skillBinding(skillId) {
  const { receipt, issues } = validateImageReceipt(LIBRARY_PKG, skillId)
  assert.equal(issues.length, 0)
  const contract = loadContract()
  return {
    skill_id: skillId,
    display_name: String(contract.display_name),
    package_root: LIBRARY_PKG,
    package_hash: String(receipt.package_sha256),
    contract_hash: imageSha256Text(JSON.stringify(contract)),
  }
}

function makeProject({ ratio = '16:9', candidateCount = 1, sceneCount = 1, projectId } = {}) {
  const contract = loadContract()
  return createImageProject({
    projectId: projectId ?? imageSafeId(),
    contract,
    skill: skillBinding('scene-storyboard-grid'),
    ratio,
    candidateCount,
    sceneCount,
    materialsRoot: 'materials',
    promptsRoot: 'prompts',
    executionRoot: 'execution',
    resultsRoot: 'results',
  })
}

function finalFiles(project, filesBySlotKey) {
  const out = {}
  for (const slot of project.material_slots) {
    const key = `${slot.id}@${slot.scene_index ?? 'project'}`
    out[key] = (filesBySlotKey[key] ?? []).map((content, index) => ({
      path: `final/${slot.id}/${index}.png`,
      sha256: imageSha256Text(String(content)),
    }))
  }
  return out
}

function snapshotAndLock(project, filesBySlotKey) {
  const { materials, materialHash } = imageMaterialSnapshot(project, finalFiles(project, filesBySlotKey))
  return lockImageMaterials(project, materials, materialHash)
}

test('create validates settings against the contract workload and ratios', () => {
  const contract = loadContract()
  validateImageSettings(contract, { displayName: '场景一致性九宫格分镜', ratio: '9:16', candidateCount: 1, sceneCount: 1 })
  assert.throws(() => validateImageSettings(contract, { displayName: '场景一致性九宫格分镜', ratio: '5:4', candidateCount: 1, sceneCount: 1 }), /unsupported or unconfirmed image ratio/)
  assert.throws(() => validateImageSettings(contract, { displayName: '场景一致性九宫格分镜', ratio: '1:1', candidateCount: 1, sceneCount: 0 }), /must be positive/)
  assert.throws(() => validateImageSettings(contract, { displayName: '场景一致性九宫格分镜', ratio: '1:1', candidateCount: -1, sceneCount: 1 }), /must be positive/)
  assert.throws(() => validateImageSettings(contract, { displayName: '另一个名字', ratio: '1:1', candidateCount: 1, sceneCount: 1 }), /display_name does not match/)
  // scene-storyboard-grid allows batch; a non-batch skill would reject
  const noBatch = JSON.parse(JSON.stringify(contract))
  noBatch.workload.batch_allowed = false
  noBatch.workload.scene_count = { min: 1, max: null }
  noBatch.workload.candidate_count_per_scene = { min: 1, max: null }
  assert.throws(() => validateImageSettings(noBatch, { displayName: '场景一致性九宫格分镜', ratio: '1:1', candidateCount: 2, sceneCount: 1 }), /does not allow batch workloads/)
})

test('scene-scoped slots are replicated per scene', () => {
  const project = makeProject({ sceneCount: 2, candidateCount: 1 })
  const sceneBase = project.material_slots.filter((slot) => slot.id === 'scene-base')
  assert.deepEqual(sceneBase.map((slot) => slot.scene_index), [1, 2])
  const identity = project.material_slots.filter((slot) => slot.id === 'identity-design')
  assert.deepEqual(identity.map((slot) => slot.scene_index), [1, 2])
})

test('single candidate dry run routes to generate_image', () => {
  const project = makeProject({ ratio: '16:9', candidateCount: 1, sceneCount: 1 })
  assert.equal(project.state, 'awaiting_materials')
  let next = snapshotAndLock(project, { 'scene-base@1': ['a'], 'identity-design@1': ['b'] })
  assert.equal(next.state, 'materials_ready')
  next = setImagePrompt(next, 'OUTPUT CONTRACT\nREFERENCE ROLES\nIDENTITY AND CONTINUITY\nSHOT COVERAGE\nALLOWED VARIATION\nPHYSICAL RELATIONSHIPS\nCLOSED-WORLD RULE\nOUTPUT NEGATIVES', 'business_skill')
  assert.equal(next.state, 'awaiting_prompt_confirmation')
  const { materialHash } = imageMaterialSnapshot(next, finalFiles(next, { 'scene-base@1': ['a'], 'identity-design@1': ['b'] }))
  next = confirmImagePrompt(next, materialHash)
  assert.equal(next.state, 'ready_for_generation')
  const { materials } = imageMaterialSnapshot(next, finalFiles(next, { 'scene-base@1': ['a'], 'identity-design@1': ['b'] }))
  next = startImageGeneration(next, true, materials)
  assert.equal(next.generation.manifest.entry, 'generate_image')
  assert.equal(next.generation.manifest.reference_images_by_scene.length, 1)
  assert.equal(next.generation.manifest.reference_images_by_scene[0].reference_images.length, 2)
  assert.equal(next.generation.status, 'dry_run_ready')
})

test('batch workload requires paid batch confirmation', () => {
  let project = makeProject({ ratio: '3:2', candidateCount: 2, sceneCount: 1 })
  project = snapshotAndLock(project, { 'scene-base@1': ['a'], 'identity-design@1': ['b'] })
  project = setImagePrompt(project, 'confirmed prompt', 'business_skill')
  const { materialHash } = imageMaterialSnapshot(project, finalFiles(project, { 'scene-base@1': ['a'], 'identity-design@1': ['b'] }))
  project = confirmImagePrompt(project, materialHash)
  assert.equal(project.state, 'awaiting_paid_batch_confirmation')
  const { materials } = imageMaterialSnapshot(project, finalFiles(project, { 'scene-base@1': ['a'], 'identity-design@1': ['b'] }))
  assert.throws(() => startImageGeneration(project, true, materials), /does not allow this action/)
  project = confirmImagePaidBatch(project)
  assert.equal(project.state, 'ready_for_batch_generation')
  project = startImageGeneration(project, true, materials)
  assert.equal(project.generation.manifest.entry, 'batch-image-generation')
})

test('material change invalidates prompts and confirmation', () => {
  let project = makeProject({ ratio: '1:1', candidateCount: 1, sceneCount: 1 })
  project = snapshotAndLock(project, { 'scene-base@1': ['one'], 'identity-design@1': ['b'] })
  project = setImagePrompt(project, 'first prompt', 'business_skill')
  // material changes (file content replaced)
  project = snapshotAndLock(project, { 'scene-base@1': ['two'], 'identity-design@1': ['b'] })
  assert.deepEqual(project.prompts, [])
  assert.equal(project.active_prompt_version, null)
  assert.equal(project.confirmation, null)
  assert.equal(project.state, 'materials_ready')
})

test('missing required scene-base and extra slots are rejected at lock', () => {
  const project = makeProject({ ratio: '9:16', candidateCount: 1, sceneCount: 1 })
  // identity-design alone, scene-base missing
  assert.throws(() => snapshotAndLock(project, { 'identity-design@1': ['a'] }), /slot scene-base contains 0 image/)
  // too many images in a max_count=1 slot
  assert.throws(() => snapshotAndLock(project, { 'scene-base@1': ['a', 'b'] }), /slot scene-base contains 2 image/)
})

test('observation-only references are not sent to generation', () => {
  const contract = loadContract()
  contract.references[1].send_to_generation = false
  const project = createImageProject({
    projectId: 'observe-test',
    contract,
    skill: skillBinding('scene-storyboard-grid'),
    ratio: '1:1',
    candidateCount: 1,
    sceneCount: 1,
    materialsRoot: 'materials',
    promptsRoot: 'prompts',
    executionRoot: 'execution',
    resultsRoot: 'results',
  })
  let next = snapshotAndLock(project, { 'scene-base@1': ['a'], 'identity-design@1': ['b'] })
  next = setImagePrompt(next, 'prompt', 'business_skill')
  const { materialHash, materials } = imageMaterialSnapshot(next, finalFiles(next, { 'scene-base@1': ['a'], 'identity-design@1': ['b'] }))
  next = confirmImagePrompt(next, materialHash)
  next = startImageGeneration(next, true, materials)
  assert.equal(next.generation.manifest.reference_images_by_scene[0].reference_images.length, 1)
})

test('project id validation rejects unsafe characters', () => {
  assert.equal(imageSafeId('ok-id_1'), 'ok-id_1')
  assert.throws(() => imageSafeId('bad id/with-slash'), /may contain only letters/)
})

test('package hash is stable for the shipped library', () => {
  assert.match(imagePackageSha256(LIBRARY_PKG), /^[a-f0-9]{64}$/)
})
