/**
 * Corpus credential hard gate — tool-level tests.
 *
 * `prompt_revision search_corpus` issues a single-use credential and
 * `authoring_gate` consumes it bound to a segment; `prompt_batch set_prompts`
 * refuses to write any segment that has no consumed credential of its own.
 * That is what makes "8 segments = 8 corpus searches" enforceable by code
 * rather than by convention.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyRevision } from '../src/tool-revision.ts'
import { apply as applyBatch } from '../src/tool-prompt-batch.ts'

/** Build a minimal plugin context that captures the registered tool. */
function makeCtx() {
  const ctx = { tools: { register(tool) { ctx.tool = tool } } }
  return ctx
}

/** Minimal tool-execution context: only the session cwd is consumed. */
function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

test('authoring_gate consumes a single-use credential and rejects reuse', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-corpus-gate-'))
  try {
    const ctx = makeCtx()
    applyRevision(ctx, { indexPath: '' })
    const exec = makeExec(cwd)

    const search = await ctx.tool.execute({ command: 'search_corpus', query: '航拍 推进', limit: 5 }, exec)
    assert.equal(search.ok, true, search.message)
    assert.match(String(search.search_id), /^sq-[0-9a-f]{8}$/)

    const prompt = '镜头缓慢推进，主体位于画面中央，图片1 为参考。'
    const gate = await ctx.tool.execute(
      { command: 'authoring_gate', search_id: search.search_id, current_prompt: prompt, media: { images: 1, videos: 0, audios: 0 }, segment: 'D:/m/a.png' },
      exec,
    )
    assert.equal(gate.ok, true, gate.message)
    assert.equal(gate.consumed_by, 'D:/m/a.png')

    // the same credential cannot authorize a second segment
    const reuse = await ctx.tool.execute(
      { command: 'authoring_gate', search_id: search.search_id, current_prompt: prompt, media: { images: 1 }, segment: 'D:/m/b.png' },
      exec,
    )
    assert.equal(reuse.ok, false, 'reused credential must be rejected')
    assert.match(String(reuse.message), /already consumed/)

    // self-reported hit counts are no longer accepted at all
    const missing = await ctx.tool.execute({ command: 'authoring_gate', current_prompt: prompt, media: { images: 1 }, corpus_hits: 9 }, exec)
    assert.equal(missing.ok, false, 'a bare corpus_hits number must not open the gate')
    assert.match(String(missing.message), /requires search_id/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('prompt_batch refuses a segment without its own consumed credential', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-corpus-gate-'))
  try {
    const material = join(cwd, 'seg-1.png')
    await writeFile(material, 'hashable-bytes-not-a-real-png')
    const prompt = '镜头缓慢推近，主体位于画面中央，图片1 为参考。'

    const batch = makeCtx()
    applyBatch(batch, { privateDir: '', outputDir: 'outputs' })
    const exec = makeExec(cwd)
    const init = await batch.tool.execute({ command: 'init_batch', materials: [material], duration: 8, ratio: '16:9' }, exec)
    assert.equal(init.ok, true, init.message)
    const batchId = init.batch_id

    // 1) no credential for this segment yet -> the whole call is refused
    const noCredential = await batch.tool.execute({ command: 'set_prompts', batch_id: batchId, prompts: [{ material, prompt }] }, exec)
    assert.equal(noCredential.ok, false)
    assert.match(String(noCredential.message), /no consumed corpus credential/)

    // 2) issue + consume a credential for exactly this segment -> write succeeds
    const rev = makeCtx()
    applyRevision(rev, { indexPath: '' })
    const search = await rev.tool.execute({ command: 'search_corpus', query: '推近 主体', limit: 3 }, exec)
    const gate = await rev.tool.execute(
      { command: 'authoring_gate', search_id: search.search_id, current_prompt: prompt, media: { images: 1 }, segment: material },
      exec,
    )
    assert.equal(gate.ok, true, gate.message)

    const withCredential = await batch.tool.execute({ command: 'set_prompts', batch_id: batchId, prompts: [{ material, prompt }] }, exec)
    assert.equal(withCredential.ok, true, withCredential.message)
    assert.equal(withCredential.diagnostics[0].corpus_search_id, search.search_id, 'diagnostics record the credential used')

    // 3) a neighbouring segment with no credential of its own is still refused
    const other = join(cwd, 'seg-2.png')
    await writeFile(other, 'x')
    const wrongSegment = await batch.tool.execute(
      { command: 'set_prompts', batch_id: batchId, prompts: [{ material: other, prompt: '镜头推进，图片1 参考。' }] },
      exec,
    )
    assert.equal(wrongSegment.ok, false, 'a credential bound to seg-1 must not authorize seg-2')
    assert.match(String(wrongSegment.message), /no consumed corpus credential/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
