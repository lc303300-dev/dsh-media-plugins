import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IMAGE_HASH_ALGORITHM,
  IMAGE_VALIDATOR_VERSION,
  approveImageIntakeReport,
  auditImageSkill,
  buildImageIntakeReceipt,
  imageContractToRegistryContract,
  imageCoreSha256,
  imageFileSha256,
  imagePackageSha256,
  scaffoldImageSkill,
  stageImagePublish,
  validateImageContractShape,
  validateImagePackage,
  validateImageReceipt,
} from '../src/shared/image-skill-core.ts'

const LIBRARY_PKG = new URL('../refs/image-skill-library/scene-storyboard-grid', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const TEMPLATE = new URL('../refs/image-skill-template', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('shipped library package passes the full governed validation', () => {
  const issues = validateImagePackage(LIBRARY_PKG, { requireReport: true, requireReceipt: true })
  assert.deepEqual(issues, [], `issues: ${issues.join('; ')}`)
})

test('shipped package contract matches the storyboard constraints', () => {
  const contract = JSON.parse(readFileSync(join(LIBRARY_PKG, 'contract.json'), 'utf8'))
  assert.deepEqual(contract.references.map((r) => r.id), ['scene-base', 'identity-design'])
  assert.equal(contract.business_constraints.panel_count, 9)
  assert.equal(contract.business_constraints.panel_orientation_source, 'scene-base')
  assert.equal(contract.business_constraints.uniform_panel_orientation, true)
  assert.equal(contract.business_constraints.outer_ratio_independent_from_panel_orientation, true)
  assert.equal(contract.business_constraints.requires_per_scene_fact_ledger, true)
  assert.equal(contract.business_constraints.shot_selection_strategy, 'evidence_conditioned')
  assert.equal(validateImageContractShape(contract).length, 0)
})

test('audit produces ready_for_approval with sealed sources', () => {
  const { dir, cleanup } = tempDir('is-audit-')
  try {
    const pkg = join(dir, 'scene-storyboard-grid')
    copyTree(LIBRARY_PKG, pkg)
    rmSync(join(pkg, 'intake-report.json'), { force: true })
    rmSync(join(pkg, 'intake-receipt.json'), { force: true })
    const source = join(dir, 'source.md')
    writeFileSync(source, 'blueprint content', 'utf8')
    const report = auditImageSkill(pkg, [source])
    assert.equal(report.status, 'ready_for_approval')
    assert.deepEqual(report.validation_issues, [])
    assert.equal(report.sources.length, 1)
    assert.equal(report.sources[0].name, 'source.md')
    assert.match(report.sources[0].sha256, /^[a-f0-9]{64}$/)
    assert.equal(report.user_approval.approved, false)
  } finally {
    cleanup()
  }
})

test('approve requires ready report and binds the core hash', () => {
  const { dir, cleanup } = tempDir('is-approve-')
  try {
    const pkg = join(dir, 'scene-storyboard-grid')
    copyTree(LIBRARY_PKG, pkg)
    rmSync(join(pkg, 'intake-report.json'), { force: true })
    rmSync(join(pkg, 'intake-receipt.json'), { force: true })
    writeFileSync(join(dir, 'source.md'), 'x', 'utf8')
    const report = auditImageSkill(pkg, [join(dir, 'source.md')])
    writeFileSync(join(pkg, 'intake-report.json'), JSON.stringify(report, null, 2), 'utf8')
    const approved = approveImageIntakeReport(pkg)
    assert.equal(approved.status, 'approved')
    assert.equal(approved.user_approval.approved, true)
    assert.equal(approved.user_approval.approved_by, 'user')
    // a report with blocking questions must not be approvable
    const withBlockers = JSON.parse(readFileSync(join(pkg, 'intake-report.json'), 'utf8'))
    withBlockers.status = 'ready_for_approval'
    withBlockers.blocking_questions = ['素材槽数量无法从来源确定']
    withBlockers.user_approval = { required: true, approved: false, approved_by: null, approved_at: null }
    writeFileSync(join(pkg, 'intake-report.json'), JSON.stringify(withBlockers, null, 2), 'utf8')
    assert.throws(() => approveImageIntakeReport(pkg), /not ready for approval/)
    // a package changed after review must be rejected at approval
    const tampered = JSON.parse(readFileSync(join(pkg, 'intake-report.json'), 'utf8'))
    tampered.blocking_questions = []
    writeFileSync(join(pkg, 'intake-report.json'), JSON.stringify(tampered, null, 2), 'utf8')
    writeFileSync(join(pkg, 'references', 'creative-guidance.md'), readFileSync(join(pkg, 'references', 'creative-guidance.md'), 'utf8') + '\ntampered', 'utf8')
    assert.throws(() => approveImageIntakeReport(pkg), /Core package changed after review/)
  } finally {
    cleanup()
  }
})

test('stage publish refuses overwrite-unapproved and binds receipt hashes', () => {
  const { dir, cleanup } = tempDir('is-publish-')
  try {
    const pkg = join(dir, 'scene-storyboard-grid')
    copyTree(LIBRARY_PKG, pkg)
    rmSync(join(pkg, 'intake-report.json'), { force: true })
    rmSync(join(pkg, 'intake-receipt.json'), { force: true })
    writeFileSync(join(dir, 'source.md'), 'x', 'utf8')
    const report = auditImageSkill(pkg, [join(dir, 'source.md')])
    writeFileSync(join(pkg, 'intake-report.json'), JSON.stringify(report, null, 2), 'utf8')
    const approved = approveImageIntakeReport(pkg)
    writeFileSync(join(pkg, 'intake-report.json'), JSON.stringify(approved, null, 2), 'utf8')
    const staging = join(dir, 'staging')
    const { skillId, receipt, stagingPath } = stageImagePublish(pkg, staging, [{ name: 'source.md', sha256: imageFileSha256(join(dir, 'source.md')) }])
    assert.equal(skillId, 'scene-storyboard-grid')
    assert.equal(stagingPath, join(staging, skillId))
    assert.equal(receipt.schema_version, 2)
    assert.equal(receipt.hash_algorithm, IMAGE_HASH_ALGORITHM)
    assert.equal(receipt.status, 'published')
    assert.equal(receipt.approved_by, 'user')
    assert.equal(receipt.validator_version, IMAGE_VALIDATOR_VERSION)
    assert.equal(receipt.package_sha256, imagePackageSha256(stagingPath))
    // staging is fully valid as a published package
    assert.deepEqual(validateImagePackage(stagingPath, { requireReport: true, requireReceipt: true }), [])
  } finally {
    cleanup()
  }
})

test('receipt validation detects stale packages', () => {
  const { dir, cleanup } = tempDir('is-stale-')
  try {
    const pkg = join(dir, 'scene-storyboard-grid')
    copyTree(LIBRARY_PKG, pkg)
    const { receipt, issues } = validateImageReceipt(pkg, 'scene-storyboard-grid')
    assert.equal(issues.length, 0)
    assert.equal(receipt.skill_id, 'scene-storyboard-grid')
    // tamper with a knowledge file -> STALE_RECEIPT
    const guidance = join(pkg, 'references', 'creative-guidance.md')
    writeFileSync(guidance, readFileSync(guidance, 'utf8') + '\ntampered', 'utf8')
    const stale = validateImageReceipt(pkg, 'scene-storyboard-grid')
    assert.ok(stale.issues.includes('STALE_RECEIPT'))
    assert.ok(validateImagePackage(pkg, { requireReceipt: true }).includes('STALE_RECEIPT'))
  } finally {
    cleanup()
  }
})

test('scaffold template markers block publication validation', () => {
  const { dir, cleanup } = tempDir('is-scaffold-')
  try {
    const destination = scaffoldImageSkill(TEMPLATE, 'draft-skill', dir, '草稿图片 Skill')
    assert.ok(existsSync(join(destination, 'SKILL.md')))
    assert.ok(existsSync(join(destination, 'contract.json')))
    assert.ok(existsSync(join(destination, 'agents', 'openai.yaml')))
    const issues = validateImagePackage(destination)
    assert.ok(issues.includes('UNRESOLVED_TEMPLATE_MARKER'))
    // placeholders were rendered
    assert.match(readFileSync(join(destination, 'routing.json'), 'utf8'), /draft-skill/)
    assert.throws(() => scaffoldImageSkill(TEMPLATE, 'draft-skill', dir, 'x'))
  } finally {
    cleanup()
  }
})

test('text-only skill without references is valid', () => {
  const { dir, cleanup } = tempDir('is-text-')
  try {
    const pkg = join(dir, 'text-poster')
    mkdirSync(join(pkg, 'references'), { recursive: true })
    writeFileSync(join(pkg, 'SKILL.md'), '---\nname: text-poster\ndescription: Create a text-only poster prompt for a confirmed visual brief.\n---\n\nRead the contract, author V1, and wait for confirmation.\n', 'utf8')
    const contract = {
      schema_version: 1, skill_id: 'text-poster', display_name: '纯文本海报提示词', description: '根据纯文本需求编写单张海报图片提示词。',
      input_mode: 'text_only', references: [],
      reference_policy: { allowed_slot_ids: [], reject_uncontracted_images: true, maximum_reference_images_per_scene: 0, preserve_reference_order: true },
      workload: { scene_count: { min: 1, max: 1 }, candidate_count_per_scene: { min: 1, max: 1 }, batch_allowed: false },
      output: { media_type: 'image', requires_ratio_confirmation: true, supported_ratios: ['1:1'] },
      authoring: { primary_language: 'zh', requires_reference_binding: false, requires_prompt_confirmation: true, user_instruction_priority: 'highest' },
      execution: { provider_neutral: true, single_candidate_entry: 'generate_image', batch_entry: 'batch-image-generation', requires_paid_batch_confirmation: true, automatic_retry: false, automatic_visual_ranking: false },
      knowledge: { creative_guidance: 'references/creative-guidance.md', failure_cases: 'references/failure-cases.md', examples: 'references/examples.md' },
      business_constraints: {},
    }
    writeFileSync(join(pkg, 'contract.json'), JSON.stringify(contract), 'utf8')
    writeFileSync(join(pkg, 'routing.json'), JSON.stringify({ schema_version: 1, skill_id: 'text-poster', aliases: ['文字海报'], user_intents: ['根据文字制作海报提示词'], subjects: [], styles: [], narrative_patterns: [], negative_intents: ['九宫格分镜'], priority: 40 }), 'utf8')
    writeFileSync(join(pkg, 'references', 'creative-guidance.md'), '# Guidance\nUse the confirmed brief.\n', 'utf8')
    writeFileSync(join(pkg, 'references', 'failure-cases.md'), '# Failures\nSymptom, cause, fix, stop.\n', 'utf8')
    writeFileSync(join(pkg, 'references', 'examples.md'), '# Examples\nExamples do not define the contract.\n', 'utf8')
    assert.deepEqual(validateImagePackage(pkg), [])
  } finally {
    cleanup()
  }
})

test('registry contract conversion maps image packages', () => {
  const contract = JSON.parse(readFileSync(join(LIBRARY_PKG, 'contract.json'), 'utf8'))
  const routing = JSON.parse(readFileSync(join(LIBRARY_PKG, 'routing.json'), 'utf8'))
  const converted = imageContractToRegistryContract(contract, routing, '1.0.0')
  assert.equal(converted.name, 'scene-storyboard-grid')
  assert.equal(converted.version, '1.0.0')
  assert.equal(converted.image.input_mode, 'reference_conditioned')
  assert.equal(converted.image.supported_ratios.length, 8)
  assert.equal(converted.image.batch_allowed, true)
  assert.deepEqual(converted.slots.map((s) => s.id), ['scene-base', 'identity-design'])
  assert.ok(converted.taxonomy.includes('把一张场景底图拆解为一张九宫格分镜图'))
})

test('canonical hashing is length-prefixed and excludes the receipt', () => {
  const withReceipt = imagePackageSha256(LIBRARY_PKG)
  const core = imageCoreSha256(LIBRARY_PKG)
  assert.match(withReceipt, /^[a-f0-9]{64}$/)
  assert.match(core, /^[a-f0-9]{64}$/)
  assert.notEqual(withReceipt, core)
})

/** Minimal recursive copy for test fixtures. */
function copyTree(src, dst) {
  const entries = readdirSync(src)
  mkdirSync(dst, { recursive: true })
  for (const entry of entries) {
    const from = join(src, entry)
    const to = join(dst, entry)
    const st = statSync(from)
    if (st.isDirectory()) copyTree(from, to)
    else if (st.isFile()) copyFileSync(from, to)
  }
}
