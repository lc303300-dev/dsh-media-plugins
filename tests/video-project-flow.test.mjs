/**
 * Phase 3：视频项目管线适配 Codex_Flow 格式包。
 * 覆盖：flow → 内部契约合成（synthesizeVideoContractFromFlow）能通过现有
 * validateContract 与项目管线既有校验；临时 flow 包经 SkillRegistry ingest +
 * setStatus 后，create 边界识别（isFlowVideoSkill）正确；合成槽走项目管线
 * 最少步骤不抛错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isFlowVideoSkill,
  synthesizeVideoContractFromFlow,
  createProject,
  transition,
  addMaterial,
  addPrompt,
  confirmPrompt,
  buildSubmissionPayload,
  planSlots,
  assessSlotCounts,
} from '../src/shared/project-core.ts'
import { SkillRegistry, validateContract, VIDEO_RATIOS } from '../src/shared/registry-core.ts'
import { validateCodexFlowPackage, flowMetaToRegistryShape } from '../src/shared/flow-format.ts'

/** 与 flow-format.test.mjs makePackage 对齐的最小合法 flow 视频包。 */
function makeFlowVideoPackage(skillId = 'flow-video-demo') {
  const parent = mkdtempSync(join(tmpdir(), 'flow-video-'))
  const dir = join(parent, skillId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${skillId}\ndescription: 测试用 Codex_Flow 视频技能包。\n---\n\n# 测试\n\n业务内容。\n`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'meta.yaml'),
    `schema: codex-flow-skill/v1
name: ${skillId}
version: 1.0.0
display-name-zh: 测试视频技能
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
  - 测试视频技能
exclude-intents:
  - 静态图片
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
  return { dir, name: skillId, parent }
}

/** 与注册记录同形的完整 flow 元数据（含 validateContract 要求的字段）。 */
function sampleFlow() {
  return {
    capabilities: ['video.generate'],
    exclude_intents: ['静态图片'],
    primary_output: 'video',
    display_name: '测试视频技能',
    workflow_profile: 'staged',
    interaction_profile: 'conversation',
    release_tier: 'experimental',
    package_sha256: 'a'.repeat(64),
    references: {
      creative_guidance: { path: 'references/creative-guidance.md', load_at: ['authoring'] },
      examples: { path: 'references/examples.md', load_at: ['authoring'] },
    },
    entry: 'C:/pkg/SKILL.md',
    source: 'codex-flow',
  }
}

test('synthesizeVideoContractFromFlow: 合成契约通过 validateContract 且形状正确', () => {
  const contract = synthesizeVideoContractFromFlow(sampleFlow(), {
    name: 'flow-video-demo',
    version: '1.0.0',
    description: '测试用 Codex_Flow 视频技能包。',
    taxonomy: ['测试视频技能', 'test'],
  })
  // 现有 validateContract 必须放行
  const validated = validateContract(contract)
  assert.equal(validated.name, 'flow-video-demo')
  assert.equal(validated.version, '1.0.0')
  assert.equal(validated.description, '测试用 Codex_Flow 视频技能包。')
  assert.deepEqual(validated.taxonomy, ['测试视频技能', 'test'])
  // video：全量比例 + 4-30 秒
  assert.equal(validated.video.duration_min, 4)
  assert.equal(validated.video.duration_max, 30)
  for (const r of validated.video.ratios) assert.ok(VIDEO_RATIOS.includes(r))
  // 单个通用素材槽（max 省略以通过 validateContract；max_count=null 表示无上限）
  assert.equal(validated.slots.length, 1)
  const slot = validated.slots[0]
  assert.equal(slot.id, 'reference-material')
  assert.equal(slot.label, '参考素材（flow 包无槽声明，按业务 Skill 指导收集）')
  assert.equal(slot.media_type, 'image')
  assert.equal(slot.min, 1)
  assert.equal(slot.min_count, 1)
  assert.equal(slot.max_count, null)
  assert.equal(slot.count_rule, 'per_second')
  // prompt 与 flow 原样保留
  assert.equal(validated.prompt.lang, 'zh')
  assert.equal(validated.prompt.corpus_policy, 'up_to_3_examples')
  assert.deepEqual(validated.flow.capabilities, ['video.generate'])
  assert.equal(validated.flow.primary_output, 'video')
  // 无 identity 时兜底 name/version 仍可通过 validateContract
  const bare = validateContract(synthesizeVideoContractFromFlow(sampleFlow()))
  assert.equal(bare.name, '测试视频技能')
  assert.equal(bare.version, '1.0.0')
})

test('flow 合成槽走项目管线最少步骤不抛错（计划/收集/提示词/确认/载荷）', () => {
  const contract = synthesizeVideoContractFromFlow(sampleFlow(), { name: 'flow-skill', version: '1.0.0' })
  const slots = contract.slots
  // planSlots：min=1、无上限、recommended（flow 无 count_rule 约束，用通用默认）
  const plans = planSlots(slots, 8, 'D:/slots')
  assert.equal(plans.length, 1)
  assert.equal(plans[0].slot, 'reference-material')
  assert.equal(plans[0].min, 1)
  assert.equal(plans[0].max, null)
  assert.equal(plans[0].planned_count, 1)
  assert.equal(plans[0].count_enforcement, 'recommended')
  // 推荐校验不硬性要求恰好 1 张
  assert.equal(assessSlotCounts(plans, { 'reference-material': 1 })[0].ok, true)
  assert.equal(assessSlotCounts(plans, { 'reference-material': 3 })[0].ok, true)

  // 最小完整流程（镜像 tool-project 的 create → set_settings → choose_image_stage → ...）
  let p = createProject('flow-p1', 'flow-skill')
  p = transition(p, 'awaiting_video_settings')
  p = { ...transition(p, 'project_initialized'), ratio: '16:9', duration: 8, slotPlans: plans }
  p = transition(p, 'awaiting_image_stage_choice')
  p = transition(p, 'collecting_user_materials')
  // 通用槽无上限：可加多张
  p = addMaterial(p, 'reference-material', 'D:/slots/reference-material/source/a.png', 'h-a', slots)
  p = addMaterial(p, 'reference-material', 'D:/slots/reference-material/source/b.png', 'h-b', slots)
  p = transition(p, 'final_images_ready')
  p = addPrompt(p, '图片1 是身份基准，图片2 是场景参考，画面完全依据图片1 与图片2 建立空间。', 'skill_v1')
  p = confirmPrompt(p)
  assert.equal(p.status, 'prompt_confirmed')
  assert.ok(p.lockedPromptHash)
  assert.equal(Object.keys(p.lockedMaterialHashes ?? {}).length, 2)
  const payload = buildSubmissionPayload(p, {
    'reference-material:D:/slots/reference-material/source/a.png': 'h-a',
    'reference-material:D:/slots/reference-material/source/b.png': 'h-b',
  })
  assert.equal(payload.skill_name, 'flow-skill')
  assert.equal(payload.ratio, '16:9')
  assert.equal(payload.duration, 8)
  assert.equal(payload.prompt_hash, p.lockedPromptHash)
})

test('flow 包经 registry ingest + publish 后在创建边界被识别', () => {
  const { dir, name } = makeFlowVideoPackage('flow-video-demo')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'flow-vid-reg-')), 'registry.db')
  const registry = new SkillRegistry(dbPath)
  try {
    // 包本身通过 flow 校验器
    assert.deepEqual(validateCodexFlowPackage(dir), [])
    // 镜像 skill_registry 工具的 flow ingest 路径
    const shape = flowMetaToRegistryShape(dir)
    const contract = validateContract({
      name: shape.name,
      version: shape.version,
      description: shape.description,
      taxonomy: shape.taxonomy,
      flow: shape.flow,
    })
    registry.ingest(
      { contract, routing: { aliases: shape.taxonomy, negative_intents: shape.flow.exclude_intents }, packageRoot: dir, provenance: 'test (codex-flow)' },
      { force: true },
    )
    registry.setStatus(shape.name, shape.version, 'published')
    const rec = registry.get(name)
    assert.ok(rec)
    // create 边界识别：flow 视频包 → true
    assert.equal(isFlowVideoSkill(rec.contract), true)
    // flow.references 提供 knowledge 路由（load-at）
    assert.ok(rec.contract.flow.references.creative_guidance.load_at.includes('authoring'))
    assert.equal(rec.contract.flow.entry, join(dir, 'SKILL.md'))
    // 用注册记录的真实 flow 合成契约 → 仍通过 validateContract
    const synthesized = synthesizeVideoContractFromFlow(rec.contract.flow, {
      name: rec.name,
      version: rec.version,
      description: rec.description,
      taxonomy: rec.taxonomy,
    })
    validateContract(synthesized)
    assert.equal(synthesized.slots[0].id, 'reference-material')

    // 旧格式（无 flow）→ 不识别
    const legacy = validateContract({ name: 'legacy-skill', version: '1.0.0', slots: [{ id: 'hero', min: 1, max: 1 }] })
    assert.equal(isFlowVideoSkill(legacy), false)
    // 非视频能力的 flow 包 → 不识别
    const imageFlow = { ...shape.flow, capabilities: ['image.generate'], primary_output: 'image' }
    assert.equal(isFlowVideoSkill({ flow: imageFlow }), false)
    // 无契约 → 不识别
    assert.equal(isFlowVideoSkill(undefined), false)
  } finally {
    registry.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
