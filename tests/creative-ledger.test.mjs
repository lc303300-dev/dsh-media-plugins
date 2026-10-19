/**
 * Creative-ledger credential tests: the gate that proves prompt text came from
 * `creative_writer` before prompt_batch accepts it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CREATIVE_LEDGER_MAX_ENTRIES,
  CREATIVE_KINDS,
  appendCreativeRecord,
  creativeGateMessage,
  emptyCreativeLedger,
  findRecentCreative,
  newCreativeId,
  parseCreativeLedger,
  sha256Text,
} from '../src/shared/creative-ledger.ts'

const T0 = Date.parse('2026-10-18T10:00:00.000Z')

function rec(overrides = {}) {
  return {
    id: newCreativeId('seed'),
    kind: 'prompt',
    model: 'gemini-4-argon-thinking-high',
    brief_sha256: sha256Text('brief'),
    output_sha256: sha256Text('output'),
    chars: 6,
    at: new Date(T0).toISOString(),
    ...overrides,
  }
}

test('emptyCreativeLedger starts with schema version and no records', () => {
  const ledger = emptyCreativeLedger()
  assert.equal(ledger.schema_version, 1)
  assert.deepEqual(ledger.records, [])
})

test('parseCreativeLedger tolerates garbage and drops malformed records', () => {
  assert.equal(parseCreativeLedger(undefined).records.length, 0)
  assert.equal(parseCreativeLedger(null).records.length, 0)
  assert.equal(parseCreativeLedger({ records: 'nope' }).records.length, 0)
  const parsed = parseCreativeLedger({ records: [rec(), { id: 1 }, null] })
  assert.equal(parsed.records.length, 1)
  assert.equal(parsed.records[0].kind, 'prompt')
})

test('appendCreativeRecord keeps the ledger bounded', () => {
  let ledger = emptyCreativeLedger()
  for (let i = 0; i < CREATIVE_LEDGER_MAX_ENTRIES + 10; i += 1) {
    ledger = appendCreativeRecord(ledger, rec({ id: `cw-${i}` }))
  }
  assert.equal(ledger.records.length, CREATIVE_LEDGER_MAX_ENTRIES)
  assert.equal(ledger.records[ledger.records.length - 1].id, `cw-${CREATIVE_LEDGER_MAX_ENTRIES + 9}`)
})

test('findRecentCreative returns the newest matching kind', () => {
  let ledger = emptyCreativeLedger()
  ledger = appendCreativeRecord(ledger, rec({ id: 'a', kind: 'copy', at: new Date(T0).toISOString() }))
  ledger = appendCreativeRecord(ledger, rec({ id: 'b', kind: 'script', at: new Date(T0 + 1000).toISOString() }))
  const hit = findRecentCreative(ledger, { kinds: CREATIVE_KINDS, now: T0 + 5000 })
  assert.equal(hit.id, 'b')
})

test('findRecentCreative rejects records outside the age window', () => {
  const ledger = appendCreativeRecord(emptyCreativeLedger(), rec({ at: new Date(T0).toISOString() }))
  const tooOld = findRecentCreative(ledger, { maxAgeMs: 1000, now: T0 + 5000 })
  assert.equal(tooOld, undefined)
  const fresh = findRecentCreative(ledger, { maxAgeMs: 60_000, now: T0 + 5000 })
  assert.equal(fresh.id, ledger.records[0].id)
})

test('findRecentCreative respects a since cutoff', () => {
  let ledger = emptyCreativeLedger()
  ledger = appendCreativeRecord(ledger, rec({ id: 'old', at: new Date(T0).toISOString() }))
  const after = findRecentCreative(ledger, { since: new Date(T0 + 1000).toISOString(), now: T0 + 2000 })
  assert.equal(after, undefined)
  const before = findRecentCreative(ledger, { since: new Date(T0 - 1000).toISOString(), now: T0 + 2000 })
  assert.equal(before.id, 'old')
})

test('non-creative kinds do not satisfy the gate', () => {
  const ledger = appendCreativeRecord(emptyCreativeLedger(), rec({ kind: 'other' }))
  const hit = findRecentCreative(ledger, { kinds: CREATIVE_KINDS, maxAgeMs: 60_000, now: T0 + 1000 })
  assert.equal(hit, undefined)
})

test('creativeGateMessage tells the caller how to unblock', () => {
  const message = creativeGateMessage(undefined)
  assert.match(message, /creative_writer/)
  assert.match(message, /allow_manual_prompts=true/)
})
