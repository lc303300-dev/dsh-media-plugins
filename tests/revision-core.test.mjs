import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  classifyFeedback,
  buildRevisionRequest,
  validateRevisionInput,
  validateRevisionResult,
  canonicalHash,
} from '../src/shared/revision-core.ts'

const lockedContext = {
  contract_rules: ['必须保留猫的橙色毛发', '主体位于画面左侧'],
  material_order: ['hero:hero.png', 'bg:bg.png'],
  ratio: '16:9',
  duration_seconds: 8,
}

function requestFor(feedback) {
  return buildRevisionRequest({ current_prompt: '夜晚的城市镜头缓慢推进。', user_feedback: feedback, locked_context: lockedContext })
}

test('classifier: explicit local feedback', () => {
  const r = classifyFeedback('第二镜不要环绕，改成低机位推进')
  assert.equal(r.classification, 'explicit_local')
  const req = requestFor('第二镜不要环绕，改成低机位推进')
  assert.equal(req.classification, 'explicit_local')
  assert.equal(req.should_search_corpus, false)
  assert.equal(req.corpus_search.max_results, 0)
})

test('classifier: ambiguous creative feedback', () => {
  const r = classifyFeedback('不够震撼，更有电影感')
  assert.equal(r.classification, 'ambiguous_creative')
  const req = requestFor('不够震撼，更有电影感')
  assert.equal(req.should_search_corpus, true)
  assert.equal(req.corpus_search.max_results, 3)
})

test('classifier: structural rewrite feedback', () => {
  const r = classifyFeedback('整体重构整段叙事，重新编排全部镜头')
  assert.equal(r.classification, 'structural_rewrite')
})

test('classifier: empty feedback rejected', () => {
  assert.throws(() => classifyFeedback('  '), /must not be empty/)
})

test('revision request: canonical hashes and immutability policy', () => {
  const req = requestFor('改为 8 秒')
  assert.equal(req.schema_version, '1.0')
  assert.equal(req.kind, 'codex_dt_prompt_revision_request')
  assert.match(req.current_prompt_sha256, /^[0-9a-f]{64}$/)
  assert.match(req.locked_context_sha256, /^[0-9a-f]{64}$/)
  assert.equal(req.revision_policy.contract_rules_are_immutable, true)
  assert.equal(req.revision_policy.material_order_is_immutable, true)
  assert.equal(req.revision_policy.forbid_model_selection_from_corpus, true)
  assert.equal(req.revision_policy.forbid_media_submission, true)
})

test('revision request: hashes are stable across calls (deterministic)', () => {
  const a = requestFor('不够震撼')
  const b = requestFor('不够震撼')
  assert.equal(a.locked_context_sha256, b.locked_context_sha256)
  assert.equal(a.current_prompt_sha256, b.current_prompt_sha256)
})

test('canonical hash matches the Python implementation (cross-platform reproducibility)', async (t) => {
  const value = { contract_rules: ['规则A'], material_order: ['a.png', 'b.png'], ratio: '16:9', duration_seconds: 8 }
  const ours = canonicalHash(value)
  let python = null
  try {
    const script = 'import json,hashlib,sys; v=json.load(sys.stdin); print(hashlib.sha256(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf-8")).hexdigest())'
    python = execFileSync('python', ['-c', script], { input: JSON.stringify(value), encoding: 'utf8' }).trim()
  } catch {
    t.skip('python not available')
    return
  }
  assert.equal(ours, python, 'JS canonical hash must equal Python json.dumps(sort_keys=True) hash')
})

test('validateRevisionInput rejects missing/invalid fields', () => {
  assert.throws(() => validateRevisionInput({ current_prompt: '', user_feedback: 'x', locked_context: lockedContext }), /current_prompt/)
  assert.throws(() => validateRevisionInput({ current_prompt: 'p', user_feedback: 'x', locked_context: { ...lockedContext, ratio: '4:5' } }), /ratio/)
  assert.throws(() => validateRevisionInput({ current_prompt: 'p', user_feedback: 'x', locked_context: { ...lockedContext, duration_seconds: 0 } }), /duration/)
  assert.throws(() => validateRevisionInput({ current_prompt: 'p', user_feedback: 'x', locked_context: { ...lockedContext, contract_rules: [''] } }), /contract_rules/)
  assert.doesNotThrow(() => validateRevisionInput({ current_prompt: 'p', user_feedback: 'x', locked_context: lockedContext }))
})

test('validateRevisionResult: valid result passes; stale hash rejected; corpus cap enforced', () => {
  const req = requestFor('不够震撼')
  const valid = {
    schema_version: '1.0',
    kind: 'codex_dt_prompt_revision_result',
    classification: 'ambiguous_creative',
    revised_prompt: '夜晚的城市，更宏大的镜头缓慢推进。',
    changed_sections: ['镜头'],
    preserved_unspecified_content: true,
    locked_context_sha256: req.locked_context_sha256,
    corpus_usage: { searched: true, matches: [{ id: 'forge-original-1', portable_pattern: '推镜+城市夜景' }] },
  }
  assert.deepEqual(validateRevisionResult(valid, { locked_context_sha256: req.locked_context_sha256 }), { ok: true, errors: [] })
  // stale hash
  const stale = validateRevisionResult(valid, { locked_context_sha256: 'a'.repeat(64) })
  assert.equal(stale.ok, false)
  assert.ok(stale.errors.some((e) => e.includes('stale contract')))
  // too many corpus matches
  const tooMany = validateRevisionResult({ ...valid, corpus_usage: { searched: true, matches: [{ id: 'a', portable_pattern: 'x' }, { id: 'b', portable_pattern: 'y' }, { id: 'c', portable_pattern: 'z' }, { id: 'd', portable_pattern: 'w' }] } })
  assert.equal(tooMany.ok, false)
  assert.ok(tooMany.errors.some((e) => e.includes('at most 3')))
  // explicit_local with corpus matches rejected
  const localWithCorpus = validateRevisionResult({ ...valid, classification: 'explicit_local', corpus_usage: { searched: false, matches: [{ id: 'a', portable_pattern: 'x' }] } })
  assert.equal(localWithCorpus.ok, false)
  assert.ok(localWithCorpus.errors.some((e) => e.includes('explicit_local')))
  // preserved_unspecified_content must be true
  const notPreserved = validateRevisionResult({ ...valid, preserved_unspecified_content: false })
  assert.equal(notPreserved.ok, false)
})
