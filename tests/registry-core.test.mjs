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
