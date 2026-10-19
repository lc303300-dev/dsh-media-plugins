/**
 * Order-binding gate — tool-level tests.
 *
 * Official 即梦 samples number references by the SOURCE file name
 * (图片27, 图片28(2), 图片75…), while DSH binds 图片N to the
 * 图片 → 视频 → 音频 upload order. `prompt_batch set_prompts` therefore
 * refuses a segment whose 图片N exceeds that segment's declared reference
 * count — pasting an official sample's numbers verbatim would otherwise
 * reference the wrong material, and the video is already paid for by then.
 *
 * Storyboard-heading FORM is free: both `镜头N` and timestamp / second-range
 * headings (`[00.0-03.0秒|…]`, `0-1.5秒:`) are shapes the official samples
 * actually use and are accepted — the second test is a regression guard
 * against re-tightening that (see the 2026-10 rollback note).
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

test('set_prompts rejects 图片N beyond the segment reference count', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-order-bind-'))
  try {
    const batch = makeCtx()
    applyBatch(batch, { privateDir: '', outputDir: 'outputs' })
    const rev = makeCtx()
    applyRevision(rev, { indexPath: '' })
    const exec = makeExec(cwd)
    const { batchId, material } = await readySegment(cwd, batch, rev, exec, 'seg-1')

    // 范例 03 shape: source-file numbers pasted verbatim (图片27/28/31)
    const pasted = await batch.tool.execute(
      { command: 'set_prompts', batch_id: batchId, allow_manual_prompts: true, prompts: [{ material, prompt: '镜头1：近景，女孩拿起滴管，图片27，环绕拍摄。' }] },
      exec,
    )
    assert.equal(pasted.ok, false)
    assert.match(String(pasted.message), /图片N out of range/)
    assert.match(String(pasted.message), /图片27 exceeds this segment's 1 reference image/)

    // renumbered by upload order -> accepted
    const rewritten = await batch.tool.execute(
      { command: 'set_prompts', batch_id: batchId, allow_manual_prompts: true, prompts: [{ material, prompt: '镜头1：近景，女孩拿起滴管，图片1，环绕拍摄。' }] },
      exec,
    )
    assert.equal(rewritten.ok, true, rewritten.message)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('set_prompts accepts timestamp and second-range headings (official sample shapes)', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-heading-forms-'))
  try {
    const batch = makeCtx()
    applyBatch(batch, { privateDir: '', outputDir: 'outputs' })
    const rev = makeCtx()
    applyRevision(rev, { indexPath: '' })
    const exec = makeExec(cwd)
    const { batchId, material } = await readySegment(cwd, batch, rev, exec, 'seg-1')

    // 范例 06 的 `[00.0-03.0秒|标题]`、范例 04 的 `0-1.5秒:` 必须放行
    const withHeading = await batch.tool.execute(
      { command: 'set_prompts', batch_id: batchId, allow_manual_prompts: true, prompts: [{ material, prompt: '[00.0-03.0秒|穿过拥挤酒馆]\nAura从人群后方冲出，图片1。' }] },
      exec,
    )
    assert.equal(withHeading.ok, true, withHeading.message)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
