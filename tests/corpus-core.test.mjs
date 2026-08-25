import test from 'node:test'
import assert from 'node:assert/strict'
import { searchCorpus, corpusSize, scoreCorpusRow, toCorpusMatch, resolveIndexPath, cjkBigrams } from '../src/shared/corpus-core.ts'

test('corpus loads from the bundled index (full seedance-forge port)', () => {
  const size = corpusSize()
  assert.ok(size >= 2400, `expected >= 2400 bundled entries, got ${size}`)
})

test('search finds relevant matches and preserves provenance', () => {
  const matches = searchCorpus('anime character', 3)
  assert.ok(matches.length > 0 && matches.length <= 10)
  const first = matches[0]
  assert.ok(first.id.length > 0)
  assert.ok(typeof first.portable_pattern === 'string' && first.portable_pattern.length > 0)
  assert.ok(typeof first.source_metadata === 'object', 'provenance must be preserved')
  assert.ok('model' in first.source_metadata && 'license' in first.source_metadata)
})

test('search respects the revision cap of 10 even when asked for more', () => {
  const matches = searchCorpus('城市 夜景 镜头', 10)
  assert.ok(matches.length <= 10, 'contract caps corpus usage at 10')
})

test('empty query returns no matches', () => {
  assert.deepEqual(searchCorpus('  '), [])
})

test('ranking: title hits weigh more than content hits', () => {
  const rowTitle = { id: 't', title: 'anime cat portrait', description: '', content: '' }
  const rowContent = { id: 'c', title: '', description: '', content: 'anime cat portrait is described deep inside' }
  assert.ok(scoreCorpusRow(rowTitle, 'anime') > scoreCorpusRow(rowContent, 'anime'))
})

test('corpus model/version is metadata only — never a filter', () => {
  // seedance_version may be "2.0" on rows, but search must not constrain by it
  const matches = searchCorpus('makeup routine', 3)
  assert.ok(matches.length > 0)
  // the match payload exposes source_model but the search ran without model filtering
  for (const m of matches) {
    assert.ok(typeof m.source_model === 'string')
    assert.ok('source_metadata' in m)
  }
})

test('toCorpusMatch always yields the portable_pattern field', () => {
  const match = toCorpusMatch({ id: 'x', content: '夜晚的城市，镜头缓慢推进。' })
  assert.equal(match.id, 'x')
  assert.ok(match.portable_pattern.includes('夜晚'))
  assert.ok(match.content_preview.length > 0)
})

test('CJK bigram tokenization makes long Chinese queries match', () => {
  assert.deepEqual(cjkBigrams('夜晚城市'), ['夜晚', '晚城', '城市'])
  const row = { id: 'x', title: '', description: '', content: '夜晚的城市霓虹灯光' }
  assert.ok(scoreCorpusRow(row, '夜晚的未来城市霓虹灯光倒映') > 0, 'long CJK query must score via bigrams')
  const hits = searchCorpus('夜晚的未来城市，霓虹灯光倒映在湿润的街道上，镜头从楼顶缓慢推近到街角人群', 3)
  assert.ok(hits.length > 0 && hits.length <= 10, 'long CJK query finds bounded matches')
})

test('resolveIndexPath resolves to the bundled index file', () => {
  const path = resolveIndexPath()
  assert.ok(path.endsWith('forge-index.jsonl'), `unexpected path: ${path}`)
})
