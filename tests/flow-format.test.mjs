import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseYamlLite, validateCodexFlowPackage, buildFlowReviewCard, buildFlowIntakeReceipt, flowPackageSha256, flowMetaToRegistryShape } from '../src/shared/flow-format.ts'
import { SkillRegistry } from '../src/shared/registry-core.ts'

function makePackage(skillId = 'test-flow-skill', overrides = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'flow-skill-'))
  const dir = join(parent, skillId)
  mkdirSync(dir, { recursive: true })
  const name = overrides.name ?? skillId
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 测试用 Codex_Flow 技能包。\n---\n\n# 测试\n\n业务内容。\n`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'meta.yaml'),
    `schema: codex-flow-skill/v1
name: ${name}
version: 1.0.0
display-name-zh: 测试技能
source: codex-flow
release-tier: experimental
primary-output: video
intermediate-outputs:
  - prompt
workflow-profile: staged
interaction-profile: conversation
tags:
  - test
aliases:
  - 测试技能
exclude-intents:
  - 视频生成
capabilities:
  - video.generate
references:
  creative_guidance:
    path: references/creative-guidance.md
    load-at:
      - authoring
  examples:
    path: references/examples.md
    load-at:
      - authoring
`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'workflow.yaml'),
    `schema: codex-flow-workflow/v1
profile: staged
stages:
  - id: brief
    output: brief
    gate: decision
  - id: video
    capability: video.generate
    depends-on:
      - brief
    output: video
    gate: paid-execution
`,
    'utf8',
  )
  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(join(dir, 'references', 'creative-guidance.md'), '# 创意指导\n', 'utf8')
  writeFileSync(join(dir, 'references', 'examples.md'), '# 示例\n', 'utf8')
  return { dir, name, parent }
}

test('parseYamlLite: nested references with load-at lists', () => {
  const meta = parseYamlLite(`schema: codex-flow-skill/v1
name: x
references:
  creative_guidance:
    path: references/creative-guidance.md
    load-at:
      - authoring
      - final-qc
exclude-intents: []
`)
  assert.equal(meta.name, 'x')
  assert.equal(meta.schema, 'codex-flow-skill/v1')
  assert.equal(meta.references.creative_guidance.path, 'references/creative-guidance.md')
  assert.deepEqual(meta.references.creative_guidance['load-at'], ['authoring', 'final-qc'])
  assert.deepEqual(meta['exclude-intents'], [])
})

test('parseYamlLite: workflow stages (list of dicts with nested depends-on)', () => {
  const workflow = parseYamlLite(`schema: codex-flow-workflow/v1
profile: staged
stages:
  - id: brief
    output: brief
    gate: decision
  - id: video
    capability: video.generate
    depends-on:
      - brief
    output: video
    gate: paid-execution
`)
  assert.equal(workflow.profile, 'staged')
  assert.equal(workflow.stages.length, 2)
  assert.equal(workflow.stages[1].id, 'video')
  assert.equal(workflow.stages[1].capability, 'video.generate')
  assert.deepEqual(workflow.stages[1]['depends-on'], ['brief'])
  assert.equal(workflow.stages[1].gate, 'paid-execution')
})

test('validateCodexFlowPackage: valid package passes', () => {
  const { dir } = makePackage()
  const issues = validateCodexFlowPackage(dir)
  assert.deepEqual(issues, [])
  rmSync(dir, { recursive: true, force: true })
})

test('validateCodexFlowPackage: missing workflow for staged profile, name mismatch, pollution', () => {
  const { dir, name } = makePackage()
  rmSync(join(dir, 'workflow.yaml'))
  let issues = validateCodexFlowPackage(dir)
  assert.ok(issues.includes('MISSING_WORKFLOW_YAML'))
  // name mismatch between directory and meta
  writeFileSync(join(dir, 'workflow.yaml'), 'stages: []\n', 'utf8')
  const dir2 = join(tmpdir(), `flow-badname-${Date.now()}`)
  mkdirSync(dir2, { recursive: true })
  writeFileSync(join(dir2, 'SKILL.md'), '---\nname: x\ndescription: d\n---\n', 'utf8')
  writeFileSync(join(dir2, 'meta.yaml'), `schema: codex-flow-skill/v1\nname: other\nversion: 1.0.0\nprimary-output: image\nworkflow-profile: simple\ninteraction-profile: conversation\n`, 'utf8')
  issues = validateCodexFlowPackage(dir2)
  assert.ok(issues.includes('NAME_MISMATCH'))
  assert.ok(issues.includes('DIRECTORY_NAME_MISMATCH'))
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
})

test('validateCodexFlowPackage: provider pollution detected', () => {
  const { dir } = makePackage()
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  writeFileSync(join(dir, 'SKILL.md'), skill.replace('业务内容。', '使用 Seedance 生成。'), 'utf8')
  const issues = validateCodexFlowPackage(dir)
  assert.ok(issues.includes('PROVIDER_POLLUTION'))
  rmSync(dir, { recursive: true, force: true })
})

test('review card exposes paid points and package hash', () => {
  const { dir } = makePackage()
  const card = buildFlowReviewCard(dir)
  assert.equal(card.skill_id, 'test-flow-skill')
  assert.deepEqual(card.paid_points, ['video'])
  assert.equal(card.primary_output, 'video')
  assert.equal(typeof card.package_hash, 'string')
  rmSync(dir, { recursive: true, force: true })
})

test('intake receipt binds the package hash; stale content invalidates it', () => {
  const { dir } = makePackage()
  writeFileSync(join(dir, 'intake-receipt.json'), JSON.stringify(buildFlowIntakeReceipt(dir, [{ name: 'src', sha256: 'a'.repeat(64) }]), null, 2), 'utf8')
  assert.deepEqual(validateCodexFlowPackage(dir, true), [])
  // content change invalidates the receipt
  writeFileSync(join(dir, 'references', 'examples.md'), '# 示例\n新增内容\n', 'utf8')
  assert.ok(validateCodexFlowPackage(dir, true).includes('STALE_RECEIPT'))
  rmSync(dir, { recursive: true, force: true })
})

test('flowMetaToRegistryShape maps aliases/tags/capabilities', () => {
  const { dir } = makePackage()
  const shape = flowMetaToRegistryShape(dir)
  assert.equal(shape.name, 'test-flow-skill')
  assert.equal(shape.version, '1.0.0')
  assert.ok(shape.taxonomy.includes('测试技能'))
  assert.ok(shape.taxonomy.includes('test'))
  assert.deepEqual(shape.flow.capabilities, ['video.generate'])
  assert.deepEqual(shape.flow.exclude_intents, ['视频生成'])
  assert.equal(shape.flow.primary_output, 'video')
  assert.equal(shape.flow.entry, join(dir, 'SKILL.md'))
  rmSync(dir, { recursive: true, force: true })
})

test('registry: flow ingest, route decision, resolve runtime, compile', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'flow-reg-')), 'registry.db')
  const registry = new SkillRegistry(dbPath)
  try {
    const { dir } = makePackage('flow-route-skill')
    const shape = flowMetaToRegistryShape(dir)
    const contract = { name: shape.name, version: shape.version, description: shape.description, taxonomy: shape.taxonomy, flow: shape.flow }
    registry.ingest({ contract, routing: { aliases: shape.taxonomy, negative_intents: shape.flow.exclude_intents }, packageRoot: dir, provenance: 'test' }, { force: true })
    registry.setStatus('flow-route-skill', '1.0.0', 'published')

    // route: capability-filtered, high-confidence hit
    const routed = registry.route('测试技能', 'video.generate')
    assert.equal(routed.decision.mode, 'specialized_skill')
    assert.equal(routed.decision.skill_id, 'flow-route-skill')
    // route: wrong image capability with no image skill → generic-image fallback
    const fallback = registry.route('测试技能', 'image.generate')
    assert.equal(fallback.decision.mode, 'generic_image')
    assert.equal(fallback.decision.skill_id, 'generic-image')
    // route: non-image capability with no candidate → no_match
    const noCap = registry.route('测试技能', 'audio.generate')
    assert.equal(noCap.decision.mode, 'no_match')

    // resolve returns the runtime descriptor
    const resolved = registry.resolve('flow-route-skill')
    assert.equal(resolved.runtime.source, 'codex-flow')
    assert.equal(resolved.runtime.primary_output, 'video')
    assert.equal(resolved.runtime.entry, join(dir, 'SKILL.md'))
    assert.equal(resolved.available, true)

    // compile produces a v2 registry.json with only flow records
    const out = join(dbPath.replace('registry.db', ''), 'registry.json')
    const compiled = registry.compile(out)
    assert.equal(compiled.indexed, 1)
    const parsed = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(parsed.schema, 'codex-flow-registry/v2')
    assert.equal(parsed.skills[0].skill_id, 'flow-route-skill')

    rmSync(dir, { recursive: true, force: true })
  } finally {
    registry.close()
  }
})
