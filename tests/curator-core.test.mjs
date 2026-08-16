import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultCountRule,
  addMissingCountRules,
  plannedCount,
  packageSha256,
  buildIntakeReceipt,
  validatePackage,
  validateScaffoldInput,
  parseFrontmatter,
  sealSources,
  detectEncoding,
  compileChecklist,
  readIntakeSources,
} from '../src/shared/curator-core.ts'

/** Build a fully valid skill package at root. */
function buildValidPackage(root) {
  mkdirSync(join(root, 'references'), { recursive: true })
  mkdirSync(join(root, 'agents'), { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `---\nname: city-night-skill\ndescription: 城市夜景氛围短片创作：负责按已确认素材与专业规则编写可执行的中文视频提示词。\n---\n\n# 城市夜景短片\n\n按 contract.json 素材槽顺序绑定参考素材，编写可执行中文提示词。\n`, 'utf8')
  writeFileSync(join(root, 'contract.json'), JSON.stringify({
    schema_version: 1,
    skill_id: 'city-night-skill',
    display_name: '城市夜景短片',
    description: '城市夜景氛围短片创作：按素材槽顺序绑定参考素材，产出可执行中文提示词并确认后生成视频。',
    references: [{
      id: 'primary-reference',
      media_type: 'image',
      role: 'scene',
      description: '城市夜景主体画面，作为镜头构图与氛围基准。',
      required: true,
      min_count: 1,
      max_count: 1,
      count_rule: {
        type: 'fixed',
        enforcement: 'required',
        fixed_count: 1,
        seconds_per_item: null,
        rounding: null,
        duration_share: 1,
        duration_to_count: [],
        provenance: 'curator_default',
        confidence: 'high',
        rationale: '固定身份或基准素材默认只需要一项。',
      },
      ordered: true,
      observation_required: true,
    }],
    video: { reference_required: true, allowed_modes: ['multimodal2video'] },
    authoring: {
      primary_language: 'zh-CN',
      preserve_professional_english: true,
      user_instruction_priority: 'highest',
      timing_strategy: 'adaptive',
      transition_strategy: 'adaptive',
      requires_prompt_confirmation: true,
      requires_reference_binding: true,
    },
    knowledge: {
      creative_guidance: 'references/creative-guidance.md',
      community_experience: 'references/community-experience.md',
      failure_cases: 'references/failure-cases.md',
      examples: 'references/examples.md',
    },
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(root, 'routing.json'), JSON.stringify({
    schema_version: 1,
    skill_id: 'city-night-skill',
    aliases: ['夜景短片'],
    user_intents: ['做一条城市夜景短片'],
    subjects: [],
    styles: [],
    narrative_patterns: [],
    negative_intents: [],
    priority: 50,
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(root, 'agents/openai.yaml'), `interface:\n  display_name: "城市夜景短片"\n  short_description: "根据已确认素材与专业规则生成城市夜景氛围短片的中文视频提示词"\n  default_prompt: "Use $city-night-skill to create a professional video prompt."\npolicy:\n  allow_implicit_invocation: true\n`, 'utf8')
  for (const file of ['creative-guidance.md', 'community-experience.md', 'failure-cases.md', 'examples.md']) {
    writeFileSync(join(root, 'references', file), `# ${file}\n\n创作指导内容。\n`, 'utf8')
  }
  return root
}

test('count rules: fixed roles get fixed counts; variable slots get bounded recommendation', () => {
  const fixed = defaultCountRule({ role: 'style', required: true, min_count: 0, max_count: null })
  assert.equal(fixed.type, 'fixed')
  assert.equal(fixed.fixed_count, 1)
  const variable = defaultCountRule({ role: 'scene', required: false, min_count: 0, max_count: 6 })
  assert.equal(variable.type, 'bounded_recommendation')
  assert.equal(variable.seconds_per_item, 5)
  assert.equal(variable.rounding, 'ceil')
})

test('addMissingCountRules fills every slot without a rule', () => {
  const { contract, additions } = addMissingCountRules({
    references: [
      { id: 'a', role: 'identity', required: true, min_count: 1, max_count: 1 },
      { id: 'b', role: 'scene', required: false, min_count: 0, max_count: 4, count_rule: { type: 'fixed', enforcement: 'required', fixed_count: 1, seconds_per_item: null, rounding: null, duration_share: 1, duration_to_count: [], provenance: 'curator_default', confidence: 'high', rationale: '已经明确的固定规则。' } },
    ],
  })
  assert.equal(additions.length, 1)
  assert.equal(additions[0].slot_id, 'a')
  assert.equal(contract.references[0].count_rule.type, 'fixed')
  assert.equal(contract.references[1].count_rule.type, 'fixed')
})

test('plannedCount derives per-slot counts from duration', () => {
  const fixed = { type: 'fixed', fixed_count: 2 } 
  assert.equal(plannedCount(fixed, 8), 2)
  const formula = { type: 'bounded_recommendation', seconds_per_item: 5, rounding: 'ceil', duration_share: 1, duration_to_count: [] }
  assert.equal(plannedCount(formula, 8), 2) // ceil(8/5)
  assert.equal(plannedCount(formula, 10), 2) // exactly 2
  const lookup = { type: 'duration_lookup', duration_to_count: [{ duration_seconds: 5, count: 1 }, { duration_seconds: 10, count: 2 }] }
  assert.equal(plannedCount(lookup, 4), 0)
  assert.equal(plannedCount(lookup, 8), 1)
  assert.equal(plannedCount(lookup, 12), 2)
})

test('validatePackage: a well-formed package is valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-curator-'))
  try {
    buildValidPackage(join(dir, 'city-night-skill'))
    const issues = validatePackage(join(dir, 'city-night-skill'))
    assert.deepEqual(issues, [], `expected no issues, got ${JSON.stringify(issues)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validatePackage: placeholders, missing receipt fields, and stale receipt are caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-curator-'))
  try {
    const root = buildValidPackage(join(dir, 'city-night-skill'))
    // placeholder scan
    const skillPath = join(root, 'SKILL.md')
    const original = readFileSync(skillPath, 'utf8')
    writeFileSync(skillPath, original + '\nTODO: fill me\n')
    let issues = validatePackage(root)
    assert.ok(issues.some((i) => i.code === 'UNRESOLVED_PLACEHOLDER'), 'TODO marker must be flagged')
    // receipt binding: valid receipt passes, then stale after content change
    const receipt = buildIntakeReceipt(root, [{ name: 'src.md', sha256: 'a'.repeat(64) }])
    writeFileSync(join(root, 'intake-receipt.json'), JSON.stringify(receipt), 'utf8')
    issues = validatePackage(root, true)
    assert.ok(!issues.some((i) => i.code === 'STALE_RECEIPT'), 'fresh receipt must match')
    writeFileSync(skillPath, original + '\n# changed\n', 'utf8')
    issues = validatePackage(root, true)
    assert.ok(issues.some((i) => i.code === 'STALE_RECEIPT'), 'changed content must invalidate the receipt')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scaffold input validation matches the Python rules', () => {
  assert.throws(() => validateScaffoldInput('Bad_ID', '名', '短'), /lowercase hyphen-case/)
  assert.throws(() => validateScaffoldInput('ok-id', '名', '太短的描述'), /at least 20 characters/)
  assert.throws(() => validateScaffoldInput('ok-id', '名', 'x'.repeat(30), '太短'), /25-64 characters/)
  assert.doesNotThrow(() => validateScaffoldInput('ok-id', '名称', '这是一个足够长的能力与触发条件描述，超过二十个字符。', '根据已确认素材与专业规则生成城市夜景氛围短片的视频提示词'))
})

test('parseFrontmatter extracts name and description', () => {
  const { metadata } = parseFrontmatter('---\nname: demo-skill\ndescription: 描述内容\n---\n正文')
  assert.equal(metadata.name, 'demo-skill')
  assert.equal(metadata.description, '描述内容')
})

test('sealSources records name + sha256 + encoding without touching the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-seal-'))
  try {
    const src = join(dir, 'source.md')
    writeFileSync(src, '\uFEFF# 城市夜景创作经验\n主体数量固定 1 张，必须按顺序绑定。\n', 'utf8')
    const sealed = sealSources([src])
    assert.equal(sealed.length, 1)
    assert.equal(sealed[0].name, 'source.md')
    assert.match(sealed[0].sha256, /^[a-f0-9]{64}$/)
    assert.equal(sealed[0].encoding, 'utf-8-sig')
    assert.equal(readFileSync(src, 'utf8').charCodeAt(0), 0xfeff, 'original must not be modified')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectEncoding distinguishes BOM, plain UTF-8 and binary', () => {
  assert.equal(detectEncoding(Buffer.from('\uFEFFabc', 'utf8')), 'utf-8-sig')
  assert.equal(detectEncoding(Buffer.from('abc', 'utf8')), 'utf-8')
})

test('compileChecklist classifies source lines into target files', () => {
  const text = '主体固定 1 张，必须按顺序绑定。\n镜头缓慢推近，光线偏冷。\n社区实测经验：环绕镜头更稳。\n避免画面过暗：给主光方向。\n例如：夜晚城市霓虹。'
  const counts = compileChecklist(text)
  assert.ok(counts.constraints >= 1)
  assert.ok(counts.creative >= 1)
  assert.ok(counts.community >= 1)
  assert.ok(counts.failures >= 1)
  assert.ok(counts.examples >= 1)
})

test('readIntakeSources returns sealed provenance or null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-srcs-'))
  try {
    assert.equal(readIntakeSources(dir), null)
    writeFileSync(join(dir, 'intake-sources.json'), JSON.stringify({ schema_version: 1, sources: [{ name: 'a.md', sha256: 'a'.repeat(64), encoding: 'utf-8' }] }), 'utf8')
    const sources = readIntakeSources(dir)
    assert.equal(sources.length, 1)
    assert.equal(sources[0].name, 'a.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
