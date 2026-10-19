/**
 * Creative-gate wiring — tool-level tests.
 *
 * `creative_writer` records a `cw-*` credential in the workspace private root;
 * `prompt_batch set_prompts` refuses prompt text unless such a record exists
 * (or the caller passes `allow_manual_prompts: true`).
 *
 * These tests exist because the ledger was dead code: the pure functions were
 * implemented and unit-tested, but nothing wrote to or read from the ledger, so
 * an agent hand-writing prompts was never actually stopped (2026-10-19).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyRevision } from '../src/tool-revision.ts'
import { apply as applyBatch } from '../src/tool-prompt-batch.ts'
import {
  CREATIVE_LEDGER_FILE,
  appendCreativeRecord,
  buildCreativeRecord,
  emptyCreativeLedger,
} from '../src/shared/creative-ledger.ts'

/** Build a minimal plugin context that captures the registered tool. */
function makeCtx() {
  const ctx = { tools: { register(tool) { ctx.tool = tool } } }
  return ctx
}

/** Minimal tool-execution context: only the session cwd is consumed. */
function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

/** Init a one-material batch and consume a corpus credential for that segment. */
async function readySegment(cwd, batch, rev, exec, name) {
  const material = join(cwd, `${name}.png`)
  await writeFile(material, 'hashable-bytes-not-a-real-png')
  const init = await batch.tool.execute({ command: 'init_batch', materials: [material], duration: 8, ratio: '16:9' }, exec)
  assert.equal(init.ok, true, init.message)
  const search = await rev.tool.execute({ command: 'search_corpus', query: '推近 主体', limit: 3 }, exec)
  const gate = await rev.tool.execute(
    { command: 'authoring_gate', search_id: search.search_id, current_prompt: '镜头1：近景，图片1。', media: { images: 1 }, segment: material },
    exec,
  )
  assert.equal(gate.ok, true, gate.message)
  return { batchId: init.batch_id, material }
}

/** Seed one fresh `prompt` creative record into the workspace private root. */
async function seedCreativeRecord(cwd) {
  const privateRoot = join(cwd, '.dsh-media-private')
  await mkdir(privateRoot, { recursive: true })
  const record = buildCreativeRecord({ kind: 'prompt', model: 'gemini-4-argon', brief: 'brief', output: 'output' })
  const ledger = appendCreativeRecord(emptyCreativeLedger(), record)
  await writeFile(join(privateRoot, CREATIVE_LEDGER_FILE), JSON.stringify(ledger, null, 2), 'utf8')
  return record.id
}

test('set_prompts is refused when no creative_writer record exists', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-creative-gate-'))
  try {
    const batch = makeCtx()
    const rev = makeCtx()
    applyBatch(batch, { privateDir: '', outputDir: 'outputs' })
    applyRevision(rev, { indexPath: '' })
    const exec = makeExec(cwd)
    const { batchId, material } = await readySegment(cwd, batch, rev, exec, 'seg-1')

    const res = await batch.tool.execute(
      { command: 'set_prompts', batch_id: batchId, prompts: [{ material, prompt: '镜头1：近景，图片1。' }] },
      exec,
    )
    assert.equal(res.ok, false)
    assert.match(String(res.message), /creative_writer/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('set_prompts passes the creative gate once a fresh record exists', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-creative-ok-'))
  try {
    const batch = makeCtx()
    const rev = makeCtx()
    applyBatch(batch, { privateDir: '', outputDir: 'outputs' })
    applyRevision(rev, { indexPath: '' })
    const exec = makeExec(cwd)
    const { batchId, material } = await readySegment(cwd, batch, rev, exec, 'seg-1')
    const credentialId = await seedCreativeRecord(cwd)

    const res = await batch.tool.execute(
      { command: 'set_prompts', batch_id: batchId, prompts: [{ material, prompt: '镜头1：近景，图片1。' }] },
      exec,
    )
    assert.equal(res.ok, true, res.message)
    assert.equal(res.creative_credential, credentialId, 'the accepted record id is reported back')
    assert.equal(res.manual_prompts, undefined, 'no bypass on the gated path')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('allow_manual_prompts=true bypasses the gate and is reported', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-creative-manual-'))
  try {
    const batch = makeCtx()
    const rev = makeCtx()
    applyBatch(batch, { privateDir: '', outputDir: 'outputs' })
    applyRevision(rev, { indexPath: '' })
    const exec = makeExec(cwd)
    const { batchId, material } = await readySegment(cwd, batch, rev, exec, 'seg-1')

    const res = await batch.tool.execute(
      { command: 'set_prompts', batch_id: batchId, allow_manual_prompts: true, prompts: [{ material, prompt: '镜头1：近景，图片1。' }] },
      exec,
    )
    assert.equal(res.ok, true, res.message)
    assert.equal(res.manual_prompts, true, 'the bypass must be visible in the result')
    assert.match(String(res.message), /bypassed/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
