/**
 * Phase 2：图片业务技能治理轨道迁移到 Codex_Flow 格式 —— 测试
 *
 * 覆盖：
 * 1. flow 图片包校验通过 / 污染拒绝 / 图片专属检查（FLOW_IMAGE_* issue 码）
 * 2. image_skill_curator 的 flow publish 路径（审核门 + intake-receipt STALE_RECEIPT 绑定 + 注册库）
 * 3. image_skill_pipeline 从 flow skill 合成内部图片契约（经 registry-core 直接 ingest flow 记录）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flowSkillToImageContractShape,
  isCodexFlowImagePackage,
  scaffoldImageSkill,
  validateCodexFlowImagePackage,
} from '../src/shared/image-skill-core.ts'
import { buildFlowIntakeReceipt, flowMetaToRegistryShape, validateCodexFlowPackage } from '../src/shared/flow-format.ts'
import { SkillRegistry, validateContract } from '../src/shared/registry-core.ts'
import { createImageProject, validateImageSettings } from '../src/shared/image-project-core.ts'
import { apply as applyCurator } from '../src/tool-image-skill-curator.ts'
import { resolveSkill as pipelineResolveSkill } from '../src/tool-image-skill-pipeline.ts'

const FLOW_IMAGE_TEMPLATE = new URL('../refs/codex-flow-image-template', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 构造一个 Codex_Flow 图片包（含 references 三件套；batch 决定 capabilities）。 */
function makeFlowImagePackage(skillId = 'flow-image-skill', options = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'flow-image-'))
  const dir = join(parent, skillId)
  mkdirSync(dir, { recursive: true })
  const displayName = options.displayName ?? '测试图片技能'
  const batch = options.batch !== false
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${skillId}\ndescription: ${options.description ?? '生成受治理图片业务图片的提示词与执行。'}\n---\n\n# ${displayName}\n\n核心任务。\n`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'meta.yaml'),
    `schema: codex-flow-skill/v1
name: ${skillId}
version: 1.0.0
display-name-zh: ${displayName}
source: codex-flow
release-tier: experimental
primary-output: image
intermediate-outputs:
  - prompt
workflow-profile: staged
interaction-profile: conversation
tags:
  - ${skillId}
aliases:
  - ${displayName}
exclude-intents:
  - 视频生成
capabilities:
  - image.generate
${batch ? '  - image.batch-generate\n' : ''}references:
  creative_guidance:
    path: references/creative-guidance.md
    load-at:
      - authoring
  failure_cases:
    path: references/failure-cases.md
    load-at:
      - final-qc
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
  - id: image
    capability: image.generate
    depends-on:
      - brief
    output: image
    gate: paid-execution
`,
    'utf8',
  )
  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(join(dir, 'references', 'creative-guidance.md'), '# 创作指导\n\n方法。\n', 'utf8')
  writeFileSync(join(dir, 'references', 'failure-cases.md'), '# 失败案例\n\n症状/原因/修复/停止。\n', 'utf8')
  writeFileSync(join(dir, 'references', 'examples.md'), '# 示例\n\n示例不定义契约。\n', 'utf8')
  return { dir, name: skillId, parent }
}

/** 给 flow 包写入有效收据（published 态）。 */
function sealPublished(dir) {
  const receipt = buildFlowIntakeReceipt(dir, [{ name: 'src.md', sha256: 'a'.repeat(64) }])
  writeFileSync(join(dir, 'intake-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8')
  assert.deepEqual(validateCodexFlowImagePackage(dir, true), [])
}

/** 把 flow 包直接 ingest 进注册库并置为 published（模拟 registry-core 直连）。 */
function ingestFlowRecord(registry, dir, name, version = '1.0.0') {
  const shape = flowMetaToRegistryShape(dir)
  const contract = validateContract({
    name: shape.name,
    version: shape.version,
    description: shape.description,
    taxonomy: shape.taxonomy,
    flow: shape.flow,
  })
  registry.ingest({ contract, routing: { aliases: shape.taxonomy, negative_intents: shape.flow.exclude_intents }, packageRoot: dir, provenance: 'test' }, { force: true })
  registry.setStatus(name, version, 'published')
  return shape
}

test('flow 图片包校验通过，模板 scaffold 渲染占位符', () => {
  const { dir, name, parent } = makeFlowImagePackage()
  try {
    assert.deepEqual(validateCodexFlowImagePackage(dir), [])
    assert.equal(isCodexFlowImagePackage(dir), true)
    // 旧图片包（无 meta.yaml）识别为 legacy
    assert.equal(isCodexFlowImagePackage(join(parent, 'nonexistent')), false)
    // 领域层 scaffold：codex-flow-image-template 渲染 {{skill_id}}/{{display_name}}/{{description}}
    const out = join(parent, 'out')
    const dest = scaffoldImageSkill(FLOW_IMAGE_TEMPLATE, 'scaffold-img', out, '草稿图片技能', '根据确认的图片素材编写图片提示词。')
    assert.ok(existsSync(join(dest, 'meta.yaml')))
    assert.ok(existsSync(join(dest, 'workflow.yaml')))
    assert.ok(!existsSync(join(dest, 'contract.json')))
    const skill = readFileSync(join(dest, 'SKILL.md'), 'utf8')
    assert.ok(skill.includes('name: scaffold-img'))
    assert.ok(skill.includes('根据确认的图片素材编写图片提示词。'))
    assert.ok(!skill.includes('{{description}}'))
    const meta = readFileSync(join(dest, 'meta.yaml'), 'utf8')
    assert.ok(meta.includes('name: scaffold-img'))
    assert.ok(meta.includes('display-name-zh: 草稿图片技能'))
    // 新 scaffold 的包通过 flow 图片校验（CURATOR-REQUIRED 标记 flow 校验不拦截）
    assert.deepEqual(validateCodexFlowImagePackage(dest), [])
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('flow 图片包污染拒绝 + 图片专属检查（FLOW_IMAGE_ 前缀）', () => {
  const { dir, parent } = makeFlowImagePackage('flow-image-pollute')
  try {
    // provider 污染 → 基础 flow 校验拒绝
    writeFileSync(join(dir, 'SKILL.md'), readFileSync(join(dir, 'SKILL.md'), 'utf8') + '\n使用 Seedance 生成。\n', 'utf8')
    assert.ok(validateCodexFlowImagePackage(dir).includes('PROVIDER_POLLUTION'))
    // 缺 image.generate capability → FLOW_IMAGE_MISSING_CAPABILITY
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: flow-image-pollute\ndescription: 生成图片提示词。\n---\n\n任务。\n', 'utf8')
    const meta = readFileSync(join(dir, 'meta.yaml'), 'utf8')
    writeFileSync(join(dir, 'meta.yaml'), meta.replace('  - image.generate\n', ''), 'utf8')
    assert.ok(validateCodexFlowImagePackage(dir).includes('FLOW_IMAGE_MISSING_CAPABILITY'))
    // primary-output 非 image → FLOW_IMAGE_PRIMARY_OUTPUT_NOT_IMAGE
    writeFileSync(join(dir, 'meta.yaml'), readFileSync(join(dir, 'meta.yaml'), 'utf8').replace('primary-output: image', 'primary-output: video'), 'utf8')
    assert.ok(validateCodexFlowImagePackage(dir).includes('FLOW_IMAGE_PRIMARY_OUTPUT_NOT_IMAGE'))
    // 生产阶段 gate 非付费门 → FLOW_IMAGE_INVALID_PRODUCTION_GATE
    writeFileSync(join(dir, 'meta.yaml'), readFileSync(join(dir, 'meta.yaml'), 'utf8').replace('primary-output: video', 'primary-output: image'), 'utf8')
    writeFileSync(join(dir, 'workflow.yaml'), 'schema: codex-flow-workflow/v1\nprofile: staged\nstages:\n  - id: brief\n    output: brief\n    gate: decision\n  - id: image\n    capability: image.generate\n    depends-on: [brief]\n    output: image\n    gate: none\n', 'utf8')
    assert.ok(validateCodexFlowImagePackage(dir).includes('FLOW_IMAGE_INVALID_PRODUCTION_GATE:image:none'))
    // batch-approval gate 合法（生产阶段门禁放行）
    writeFileSync(join(dir, 'workflow.yaml'), 'schema: codex-flow-workflow/v1\nprofile: staged\nstages:\n  - id: brief\n    output: brief\n    gate: decision\n  - id: image\n    capability: image.generate\n    depends-on: [brief]\n    output: image\n    gate: batch-approval\n', 'utf8')
    assert.ok(!validateCodexFlowImagePackage(dir).includes('FLOW_IMAGE_INVALID_PRODUCTION_GATE'))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('curator publish flow 路径：审核门 + intake-receipt STALE_RECEIPT 绑定 + 注册库', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'flow-curator-'))
  let captured = null
  applyCurator({ tools: { register: (tool) => { captured = tool } } }, {})
  assert.ok(captured, 'curator tool should register')
  const exec = { agent: { session: { header: { cwd: workspace } } } }
  try {
    // scaffold 默认生成 Codex_Flow 图片包
    const outDir = join(workspace, 'skills')
    let r = await captured.execute({ command: 'scaffold', skill_id: 'flow-image-tool', display_name: '测试图片技能', description: '生成受治理图片业务图片的提示词与执行。', output_dir: outDir }, exec)
    assert.equal(r.ok, true, r.message)
    const pkg = join(outDir, 'flow-image-tool')
    assert.ok(existsSync(join(pkg, 'meta.yaml')))
    assert.ok(existsSync(join(pkg, 'workflow.yaml')))
    assert.equal(isCodexFlowImagePackage(pkg), true)
    assert.deepEqual(validateCodexFlowImagePackage(pkg), [])

    // audit 封存来源到 intake-sources.json
    const source = join(workspace, 'source.md')
    writeFileSync(source, 'blueprint content', 'utf8')
    r = await captured.execute({ command: 'audit', package_dir: pkg, sources: [source] }, exec)
    assert.equal(r.ok, true, r.message)
    assert.ok(existsSync(join(pkg, 'intake-sources.json')))

    // 无 approved → 审核卡（含 paid_points/package_hash），拒绝发布
    r = await captured.execute({ command: 'publish', package_dir: pkg }, exec)
    assert.equal(r.ok, false)
    assert.ok(r.checklist, 'publish without approval must return a checklist')
    assert.equal(r.checklist.skill_id, 'flow-image-tool')
    assert.deepEqual(r.checklist.paid_points, ['image'])
    assert.equal(typeof r.checklist.package_hash, 'string')

    // approved=true → 原子发布到图片 Skill 库 + 注册库 flow 记录
    r = await captured.execute({ command: 'publish', package_dir: pkg, approved: true }, exec)
    assert.equal(r.ok, true, r.message)
    const privateRoot = join(workspace, '.dsh-media-private')
    const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
    try {
      const record = registry.get('flow-image-tool')
      assert.ok(record, 'published flow record should exist')
      assert.equal(record.status, 'published')
      assert.equal(record.contract.flow.primary_output, 'image')
      assert.ok(record.contract.flow.capabilities.includes('image.generate'))
      assert.ok(record.contract.flow.capabilities.includes('image.batch-generate'))
      assert.ok(record.contract.flow.entry.replace(/\\/g, '/').endsWith('image-skill-library/flow-image-tool/SKILL.md'))
      const libraryPkg = join(privateRoot, 'image-skill-library', 'flow-image-tool')
      assert.ok(existsSync(join(libraryPkg, 'intake-receipt.json')))
      // 发布态复验通过
      assert.deepEqual(validateCodexFlowImagePackage(libraryPkg, true), [])
      // 篡改包内容 → 工具 validate（require_report=true）报 STALE_RECEIPT
      const examples = join(libraryPkg, 'references', 'examples.md')
      writeFileSync(examples, readFileSync(examples, 'utf8') + '\ntampered', 'utf8')
      r = await captured.execute({ command: 'validate', package_dir: libraryPkg, require_report: true }, exec)
      assert.equal(r.ok, false)
      assert.ok(r.issues.includes('STALE_RECEIPT'))
    } finally {
      registry.close()
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('pipeline create 从 flow skill 合成内部契约（batch / 非 batch）', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'flow-pipeline-'))
  const dbPath = join(parent, 'registry.db')
  const registry = new SkillRegistry(dbPath)
  try {
    // --- 批量 flow 包：batch_allowed=true，候选 max 4 ---
    const { dir, name, parent: p1 } = makeFlowImagePackage('flow-image-batch', { displayName: '批量图片技能' })
    try {
      sealPublished(dir)
      ingestFlowRecord(registry, dir, name)
      const record = registry.get(name)
      assert.equal(record.contract.flow.primary_output, 'image')
      const resolved = await pipelineResolveSkill(registry, name, '')
      assert.equal(resolved.packageRoot, dir)
      assert.equal(resolved.contract.references[0].id, 'image-material')
      assert.equal(resolved.contract.reference_policy.allowed_slot_ids[0], 'image-material')
      assert.deepEqual(resolved.contract.workload.scene_count, { min: 1, max: 6 })
      assert.deepEqual(resolved.contract.workload.candidate_count_per_scene, { min: 1, max: 4 })
      assert.equal(resolved.contract.workload.batch_allowed, true)
      assert.equal(resolved.contract.output.supported_ratios.length, 8)
      assert.equal(resolved.contract.authoring.primary_language, 'zh-CN')
      assert.equal(resolved.contract.execution.provider_neutral, true)
      // 创建边界校验 + 建项目（image-material × 场景数）
      validateImageSettings(resolved.contract, { displayName: '批量图片技能', ratio: '16:9', candidateCount: 2, sceneCount: 2 })
      const project = createImageProject({
        projectId: 'flow-proj-batch',
        contract: resolved.contract,
        skill: { skill_id: name, display_name: '批量图片技能', package_root: dir, package_hash: resolved.packageHash, contract_hash: resolved.contractHash },
        ratio: '16:9',
        candidateCount: 2,
        sceneCount: 2,
        materialsRoot: join(parent, 'materials'),
        promptsRoot: join(parent, 'prompts'),
        executionRoot: join(parent, 'execution'),
        resultsRoot: join(parent, 'results'),
      })
      assert.equal(project.material_slots.length, 2)
      assert.ok(project.material_slots.every((slot) => slot.id === 'image-material' && slot.scene_index !== null))
      assert.deepEqual(project.image_settings, { ratio: '16:9', candidate_count: 2, scene_count: 2 })
      // 篡改包 → resolveSkill 报收据失效（STALE_RECEIPT 绑定）
      writeFileSync(join(dir, 'references', 'examples.md'), readFileSync(join(dir, 'references', 'examples.md'), 'utf8') + '\ntampered', 'utf8')
      await assert.rejects(() => pipelineResolveSkill(registry, name, ''), /receipt is missing or invalid/)
    } finally {
      rmSync(p1, { recursive: true, force: true })
    }

    // --- 非批量 flow 包：batch_allowed=false，候选 max 强制 1 ---
    const { dir: dir2, name: name2, parent: p2 } = makeFlowImagePackage('flow-image-single', { displayName: '单张图片技能', batch: false })
    try {
      sealPublished(dir2)
      ingestFlowRecord(registry, dir2, name2)
      const resolved2 = await pipelineResolveSkill(registry, name2, '')
      assert.equal(resolved2.contract.workload.batch_allowed, false)
      assert.deepEqual(resolved2.contract.workload.candidate_count_per_scene, { min: 1, max: 1 })
      // 候选 2 超上界 → 拒绝
      assert.throws(() => validateImageSettings(resolved2.contract, { displayName: '单张图片技能', ratio: '1:1', candidateCount: 2, sceneCount: 1 }), /outside the selected Skill contract/)
      // 场景 2（即使候选 1）→ 非批量包拒绝批量工作量
      assert.throws(() => validateImageSettings(resolved2.contract, { displayName: '单张图片技能', ratio: '1:1', candidateCount: 1, sceneCount: 2 }), /does not allow batch workloads/)
    } finally {
      rmSync(p2, { recursive: true, force: true })
    }
  } finally {
    registry.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('flowSkillToImageContractShape 直接合成（capabilities 驱动 batch）', () => {
  const base = {
    capabilities: ['image.generate', 'image.batch-generate'],
    exclude_intents: [],
    primary_output: 'image',
    display_name: '合成图片技能',
    workflow_profile: 'staged',
    interaction_profile: 'conversation',
    release_tier: 'experimental',
    package_sha256: 'a'.repeat(64),
    references: {},
    entry: '/tmp/x/SKILL.md',
    source: 'codex-flow',
  }
  const batch = flowSkillToImageContractShape(base, 'synth-batch', '合成图片技能')
  assert.equal(batch.workload.batch_allowed, true)
  assert.deepEqual(batch.workload.candidate_count_per_scene, { min: 1, max: 4 })
  const single = flowSkillToImageContractShape({ ...base, capabilities: ['image.generate'] }, 'synth-single', '合成单图技能')
  assert.equal(single.workload.batch_allowed, false)
  assert.deepEqual(single.workload.candidate_count_per_scene, { min: 1, max: 1 })
})
