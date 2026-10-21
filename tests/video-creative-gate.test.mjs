/**
 * Video creative gate: production video prompts must come from a fresh
 * creative_writer record in the workspace. User-supplied / normalize-only
 * prompts may bypass, but only with an explicit reason.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CREATIVE_LEDGER_FILE,
  appendCreativeRecord,
  buildCreativeRecord,
  emptyCreativeLedger,
} from '../src/shared/creative-ledger.ts'
import { evaluateVideoCreativeGate } from '../src/shared/video-creative-gate.ts'

test('refuses a production video prompt with no creative record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-video-gate-'))
  try {
    const decision = await evaluateVideoCreativeGate({ workspaceRoot: dir })
    assert.equal(decision.allowed, false)
    assert.match(String(decision.message), /creative_writer/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bypass requires a non-empty reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-video-gate-bypass-'))
  try {
    const refused = await evaluateVideoCreativeGate({ workspaceRoot: dir, allowManual: true })
    assert.equal(refused.allowed, false)
    assert.match(String(refused.message), /manual_prompts_reason/)

    const allowed = await evaluateVideoCreativeGate({
      workspaceRoot: dir,
      allowManual: true,
      manualReason: '用户自带提示词，要求原样提交',
    })
    assert.equal(allowed.allowed, true)
    assert.equal(allowed.bypassed, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('accepts a fresh creative record and reports its id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-video-gate-record-'))
  try {
    const privateRoot = join(dir, '.dsh-media-private')
    await mkdir(privateRoot, { recursive: true })
    const record = buildCreativeRecord({
      kind: 'prompt',
      model: 'gemini-4-argon',
      brief: 'brief',
      output: 'prompt',
    })
    const ledger = appendCreativeRecord(emptyCreativeLedger(), record)
    await writeFile(join(privateRoot, CREATIVE_LEDGER_FILE), JSON.stringify(ledger, null, 2), 'utf8')

    const decision = await evaluateVideoCreativeGate({ workspaceRoot: dir })
    assert.equal(decision.allowed, true)
    assert.equal(decision.bypassed, false)
    assert.equal(decision.record?.id, record.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
