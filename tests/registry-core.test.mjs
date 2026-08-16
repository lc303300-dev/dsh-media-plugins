import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillRegistry, validateContract } from '../src/shared/registry-core.ts'

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-registry-'))
  const db = new SkillRegistry(join(dir, 'registry.db'))
  return { db, dir, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const sampleContract = {
  name: '城市夜景短片',
  version: '1.0.0',
  description: '未来城市夜景氛围短片',
  taxonomy: ['城市', '夜景', '氛围'],
  video: { ratios: ['16:9', '9:16'], duration_min: 4, duration_max: 10 },
  slots: [
    { id: 'hero', label: '主体图', min: 1, max: 3 },
    { id: 'bg', label: '背景图', min: 0, max: 2 },
  ],
  prompt: { lang: 'zh', corpus_policy: 'up_to_3_examples' },
}

test('contract validation accepts valid and rejects invalid contracts', () => {
  assert.doesNotThrow(() => validateContract(sampleContract))
  assert.throws(() => validateContract({ version: '1' }), /name is required/)
  assert.throws(() => validateContract({ name: 'x', version: '1', video: { ratios: ['4:5'] } }), /unsupported ratio/)
  assert.throws(() => validateContract({ name: 'x', version: '1', slots: [{ id: 'a' }, { id: 'a' }] }), /duplicate slot/)
  assert.throws(() => validateContract({ name: 'x', version: '1', slots: [{ id: 'a', min: 5, max: 2 }] }), /min > max/)
})

test('ingest → search (FTS5 trigram CJK) → publish → search filter', () => {
  const { db, cleanup } = tempDb()
  try {
    db.ingest({ contract: sampleContract, routing: { keywords: ['夜拍', '城市'] } })
    const rec = db.get('城市夜景短片')
    assert.equal(rec.status, 'draft')
    assert.equal(rec.sha256.length, 64)

    // draft is not returned by default published search, but 'any' works
    assert.equal(db.search('夜景', 10, 'published').length, 0)
    assert.equal(db.search('夜景', 10, 'any').length, 1)

    db.setStatus('城市夜景短片', '1.0.0', 'published')
    const hits = db.search('夜景', 10, 'published')
    assert.ok(hits.length >= 1)
    assert.equal(hits[0].name, '城市夜景短片')

    // re-ingest with identical content + routing is idempotent
    assert.doesNotThrow(() => db.ingest({ contract: sampleContract, routing: { keywords: ['夜拍', '城市'] } }))
    // changed content without force is rejected
    assert.throws(() => db.ingest({ contract: { ...sampleContract, description: 'changed' } }), /different content/)
    // force overwrites
    assert.doesNotThrow(() => db.ingest({ contract: { ...sampleContract, description: 'changed' } }, { force: true }))
  } finally {
    cleanup()
  }
})

test('search tokenizes multi-term CJK+ASCII intent queries', () => {
  const { db, cleanup } = tempDb()
  try {
    db.ingest({
      contract: {
        name: 'giant-ip-landmark-parade',
        version: '1.0.0',
        description: '巨型IP地标巡游硬切视频：将 IP 角色设定图与多张城市地标实景合成参考编排为巨型 IP 巡游。',
        taxonomy: ['IP', '地标', '巡游'],
        slots: [{ id: 'ip-character', label: 'IP 身份图', min: 1, max: 1 }],
      },
      routing: { user_intents: ['巨型 IP 地标巡游'] },
    })
    db.setStatus('giant-ip-landmark-parade', '1.0.0', 'published')
    const hits = db.search('巨型 logo 巡游 品牌地标', 5, 'published')
    assert.ok(hits.length > 0, 'short CJK terms must match via per-term LIKE')
    assert.equal(hits[0].name, 'giant-ip-landmark-parade')
  } finally {
    cleanup()
  }
})

test('search: matched reasons, negative weighting, alias boost, material guidance', () => {
  const { db, cleanup } = tempDb()
  try {
    db.ingest({
      contract: {
        name: 'demo-promo',
        version: '1.0.0',
        description: '地产楼盘宣传片：将楼盘与社区参考素材编排为城市叙事的人居宣传片提示词。',
        taxonomy: ['地产', '宣传片'],
        slots: [{ id: 'hero', label: '楼盘图', min: 1, max: 3, count_rule: 'fixed' }],
      },
      routing: {
        aliases: ['地产宣传片'],
        user_intents: ['地产', '楼盘宣传'],
        subjects: ['楼盘'],
        styles: [],
        narrative_patterns: [],
        negative_intents: ['纪录片'],
      },
    })
    db.setStatus('demo-promo', '1.0.0', 'published')
    // exact alias boost: query equals an alias → +100 and reason
    const aliasHits = db.search('地产宣传片', 5, 'published')
    assert.ok(aliasHits[0].score >= 100, 'exact alias must get the +100 boost')
    assert.ok(aliasHits[0].matched_reasons?.some((r) => r.includes('别名')), 'alias hit reason must be present')
    // intent term match → reason + score boost
    const intentHits = db.search('我想做地产楼盘的宣传片', 5, 'published')
    assert.ok(intentHits.length > 0, 'unsegmented long query must retrieve via grams/semantic')
    assert.ok(intentHits[0].matched_reasons?.some((r) => r.includes('意图命中')), 'intent reason must be present')
    // material guidance from contract
    assert.ok(Array.isArray(intentHits[0].material_guidance) && intentHits[0].material_guidance.length === 1)
    assert.equal(intentHits[0].material_guidance[0].id, 'hero')
    // negative intent weighting: query with a negative term scores lower
    const negHits = db.search('地产宣传片纪录片', 5, 'published')
    assert.ok(negHits[0].negative_hits?.includes('纪录片'), 'negative intent must be reported')
  } finally {
    cleanup()
  }
})

test('dedupe by name+version across versions', () => {
  const { db, cleanup } = tempDb()
  try {
    db.ingest({ contract: { ...sampleContract, version: '1.0.0' } })
    db.ingest({ contract: { ...sampleContract, version: '2.0.0' } })
    assert.equal(db.get('城市夜景短片', '2.0.0').version, '2.0.0')
    assert.equal(db.get('城市夜景短片', '1.0.0').version, '1.0.0')
    assert.equal(db.list().length, 2)
  } finally {
    cleanup()
  }
})
