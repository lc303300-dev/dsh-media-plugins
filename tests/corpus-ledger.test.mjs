/**
 * Corpus retrieval ledger — pure-domain tests.
 *
 * The ledger turns "one corpus search per segment" from a self-reported number
 * into an enforceable fact: each credential is single-use, so N segments
 * require N retrievals.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  consumeCredential,
  emptyLedger,
  findCredential,
  gateCredentialError,
  issueCredential,
  ledgerStats,
  newSearchId,
  parseLedger,
  pruneLedger,
  segmentEvidence,
} from '../src/shared/corpus-ledger.ts'

const at = '2026-08-26T00:00:00.000Z'

function issue(ledger, id, query = 'q', hits = 2) {
  return issueCredential(ledger, { id, query, hits, top_ids: ['forge-1'], at })
}

test('newSearchId issues distinct sq- prefixed credentials', () => {
  const a = newSearchId('航拍')
  const b = newSearchId('航拍')
  assert.match(a, /^sq-[0-9a-f]{8}$/)
  assert.notEqual(a, b, 'every search gets its own credential')
})

test('issueCredential appends a fresh unused credential', () => {
  const { ledger, record } = issue(emptyLedger(), 'sq-1', '宫殿 航拍', 4)
  assert.equal(record.consumed_by, null)
  assert.equal(ledger.queries.length, 1)
  assert.equal(findCredential(ledger, 'sq-1')?.hits, 4)
  assert.deepEqual(ledgerStats(ledger), { total: 1, consumed: 0, available: 1 })
})

test('gate rejects a missing, unknown, or already-consumed credential', () => {
  const { ledger } = issue(emptyLedger(), 'sq-1')
  assert.ok(gateCredentialError(undefined, undefined), 'no credential presented')
  assert.ok(gateCredentialError(findCredential(ledger, 'sq-nope'), 'sq-nope'), 'unknown credential')
  const consumed = consumeCredential(ledger, 'sq-1', 'D:/m/a.png', at)
  assert.equal(consumed.ok, true)
  assert.ok(gateCredentialError(findCredential(consumed.ledger, 'sq-1'), 'sq-1'), 'credential already consumed')
})

test('consumeCredential binds a credential to exactly one segment', () => {
  const { ledger } = issue(emptyLedger(), 'sq-1')
  const first = consumeCredential(ledger, 'sq-1', 'D:/m/a.png', at)
  assert.equal(first.ok, true)
  assert.equal(first.record.consumed_by, 'D:/m/a.png')
  assert.equal(segmentEvidence(first.ledger, 'D:/m/a.png')?.id, 'sq-1')
  assert.equal(segmentEvidence(first.ledger, 'D:/m/b.png'), undefined, 'another segment has no evidence')
  const second = consumeCredential(first.ledger, 'sq-1', 'D:/m/b.png', at)
  assert.equal(second.ok, false, 'one credential cannot cover two segments')
  assert.match(String(second.error), /already consumed/)
})

test('eight segments need eight credentials (the point of the ledger)', () => {
  const segments = Array.from({ length: 8 }, (_, i) => `D:/m/seg-${i + 1}.png`)

  // one shared credential: only the first segment is accepted
  // (the ledger is immutable, so each consumption must be threaded forward —
  // exactly what the tool layer does by persisting it to disk)
  let sharedLedger = issue(emptyLedger(), 'sq-shared').ledger
  const accepted = segments.map((s) => {
    const result = consumeCredential(sharedLedger, 'sq-shared', s, at)
    sharedLedger = result.ledger
    return result.ok
  })
  assert.deepEqual(accepted, [true, false, false, false, false, false, false, false])

  // eight credentials: every segment is accepted
  let ledger = emptyLedger()
  for (let i = 0; i < 8; i += 1) ledger = issue(ledger, `sq-${i}`).ledger
  const before = ledger
  const all = segments.map((s, i) => consumeCredential(before, `sq-${i}`, s, at).ok)
  assert.deepEqual(all, Array(8).fill(true))
  assert.deepEqual(ledgerStats(before), { total: 8, consumed: 0, available: 8 })
})

test('a zero-hit search is still a valid credential (searching is the requirement)', () => {
  const { ledger } = issue(emptyLedger(), 'sq-empty', '冷门题材', 0)
  assert.equal(gateCredentialError(findCredential(ledger, 'sq-empty'), 'sq-empty'), null)
  assert.equal(consumeCredential(ledger, 'sq-empty', 'D:/m/a.png', at).ok, true)
})

test('parseLedger tolerates garbage; pruneLedger drops consumed entries first', () => {
  assert.deepEqual(parseLedger(undefined).queries, [])
  assert.deepEqual(parseLedger({ queries: 'nope' }).queries, [])
  assert.equal(parseLedger({ queries: [{ id: 'sq-1' }] }).queries[0].hits, 0)

  let ledger = emptyLedger()
  for (let i = 0; i < 5; i += 1) ledger = issue(ledger, `sq-${i}`).ledger
  ledger = consumeCredential(ledger, 'sq-0', 'D:/m/0.png', at).ledger
  const pruned = pruneLedger(ledger, 4)
  assert.equal(pruned.queries.length, 4)
  assert.equal(findCredential(pruned, 'sq-0'), undefined, 'consumed entry dropped first')
  assert.ok(findCredential(pruned, 'sq-4'), 'newest entry kept')
})
