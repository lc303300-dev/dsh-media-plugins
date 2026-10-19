/**
 * 洗图强制 Gemini 硬门（`repaint`）—— tests.
 *
 * 洗图（去绘画感 / UE5 写实重渲染，技能 `image-repaint-cleanup`）是确定性任务：
 * 线路必须钉死在 `comfly-gemini-flash-preview`（2K-only），不得落到默认的
 * `comfly-gpt-image-2-4k`，也不得"失败后换线路"。本测试锁定：
 *
 * 1. manifest 层：`repaint: true` 时未点名会被补成 Gemini、点名其他线路直接拒绝；
 * 2. 任务层：`flattenTasks` 真的把 Gemini 写进每个候选的 `imageProvider`；
 * 3. job key 层：同一组素材的洗图批与普通批是两个不同的 job（不会被去重顶掉）；
 * 4. 工具层：`generate_image` 的 `repaint: true` 在任何付费调用之前完成同样的裁决；
 * 5. 缺省行为不变：不传 `repaint` 的调用一律不碰用户给的线路。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateManifest, flattenTasks, jobKeyFor, effectiveImageProvider } from '../src/shared/batch-core.ts'
import { REPAINT_IMAGE_PROVIDER, resolveRepaintImageProvider } from '../src/shared/adapters.ts'
import { apply as applyImageGen } from '../src/tool-image-gen.ts'
import { apply as applyBatchImage } from '../src/tool-batch-image.ts'

const GEMINI = 'comfly-gemini-flash-preview'
const DEFAULT_ROUTE = 'comfly-gpt-image-2-4k'

const baseManifest = {
  groups: [{ id: 'a', prompt: '把这张插画洗成 UE5 写实 CG', candidates: 1, image_ratio: '16:9' }],
}

/** Minimal plugin context that captures the registered tool. */
function makeCtx() {
  const ctx = {
    tools: { register(tool) { ctx.tool = tool } },
    credentials: { async resolve() { return undefined } },
  }
  return ctx
}

/** Minimal tool-execution context: only the session cwd is consumed. */
function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

test('the repaint route constant is the Gemini route (single source of truth)', () => {
  assert.equal(REPAINT_IMAGE_PROVIDER, GEMINI)
})

test('resolveRepaintImageProvider defaults to Gemini and rejects every other route', () => {
  assert.equal(resolveRepaintImageProvider(undefined), GEMINI, '未点名 = 强制补成 Gemini')
  assert.equal(resolveRepaintImageProvider(''), GEMINI)
  assert.equal(resolveRepaintImageProvider(GEMINI), GEMINI)
  assert.throws(() => resolveRepaintImageProvider(DEFAULT_ROUTE), /洗图任务只允许/)
  assert.throws(() => resolveRepaintImageProvider('dreamina-image'), /洗图任务只允许/)
  assert.throws(() => resolveRepaintImageProvider('comfly-gpt-image-2'), /洗图任务只允许/, '兼容别名同样被拒')
})

test('manifest: repaint=true accepts Gemini (or nothing) and rejects any other route', () => {
  assert.doesNotThrow(() => validateManifest({ ...baseManifest, repaint: true }))
  assert.doesNotThrow(() => validateManifest({ ...baseManifest, repaint: true, image_provider: GEMINI }))
  assert.throws(() => validateManifest({ ...baseManifest, repaint: true, image_provider: DEFAULT_ROUTE }), /洗图任务只允许/)
  assert.throws(() => validateManifest({ ...baseManifest, repaint: true, image_provider: 'dreamina-image' }), /洗图任务只允许/)
  assert.throws(() => validateManifest({ ...baseManifest, repaint: true, image_provider: 'comfly-gpt-image-2.5' }), /洗图任务只允许/)
  // 缺省的普通批完全不受影响：默认线路照旧
  assert.doesNotThrow(() => validateManifest({ ...baseManifest, image_provider: DEFAULT_ROUTE }))
  assert.doesNotThrow(() => validateManifest(baseManifest))
})

test('manifest: a non-boolean repaint is rejected', () => {
  assert.throws(() => validateManifest({ ...baseManifest, repaint: 'yes' }), /repaint must be a boolean/)
})

test('flattenTasks pins every repaint candidate to Gemini', () => {
  const tasks = flattenTasks(validateManifest({ ...baseManifest, repaint: true, groups: [{ id: 'a', prompt: 'p', candidates: 3, image_ratio: '1:1' }] }))
  assert.equal(tasks.length, 3)
  for (const t of tasks) assert.equal(t.imageProvider, GEMINI, 'each candidate must carry the pinned route')
  // 普通批不带 repaint：不替用户选线路
  const plain = flattenTasks(validateManifest(baseManifest))
  assert.equal(plain[0].imageProvider, undefined)
  // 普通批显式点名照旧透传
  const plainPinned = flattenTasks(validateManifest({ ...baseManifest, image_provider: DEFAULT_ROUTE }))
  assert.equal(plainPinned[0].imageProvider, DEFAULT_ROUTE)
})

test('effectiveImageProvider resolves the gate without mutating the manifest', () => {
  assert.equal(effectiveImageProvider({ ...baseManifest, repaint: true }), GEMINI)
  assert.equal(effectiveImageProvider({ ...baseManifest, repaint: true, image_provider: GEMINI }), GEMINI)
  assert.equal(effectiveImageProvider(baseManifest), undefined)
  assert.equal(effectiveImageProvider({ ...baseManifest, image_provider: DEFAULT_ROUTE }), DEFAULT_ROUTE)
})

test('job keys: a repaint batch and a plain batch of the same material are distinct jobs', () => {
  const plain = jobKeyFor(validateManifest(baseManifest))
  const repaint = jobKeyFor(validateManifest({ ...baseManifest, repaint: true }))
  const repaintPinned = jobKeyFor(validateManifest({ ...baseManifest, repaint: true, image_provider: GEMINI }))
  assert.notEqual(plain, repaint, 'the repaint flag must be part of the stable job key')
  assert.equal(repaint, repaintPinned, 'explicit Gemini and the defaulted Gemini are the same job')
})

test('generate_image declares the repaint hard gate', () => {
  const ctx = makeCtx()
  applyImageGen(ctx, { privateDir: '' })
  assert.equal(ctx.tool.name, 'generate_image')
  assert.ok(ctx.tool.parameters.properties.repaint, 'the repaint flag must be a declared parameter')
  assert.match(ctx.tool.description, /repaint/, 'the description must state the gate')
  assert.match(ctx.tool.description, /comfly-gemini-flash-preview/, 'the description must name the forced route')
})

test('generate_image: repaint=true refuses a non-Gemini route before any provider call and writes no task', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-repaint-gate-'))
  try {
    const ctx = makeCtx()
    applyImageGen(ctx, { privateDir: '' })
    await assert.rejects(
      () => ctx.tool.execute({ prompt: '洗图', image_ratio: '16:9', repaint: true, image_provider: DEFAULT_ROUTE }, makeExec(cwd)),
      /洗图任务只允许/,
    )
    assert.equal(existsSync(join(cwd, '.dsh-media-private', 'jobs')), false, 'a refused repaint must not write task state')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('batch_image: repaint=true rejects a non-Gemini manifest before any job row exists', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-repaint-gate-'))
  try {
    const ctx = {
      tools: { register(tool) { ctx.tool = tool } },
      credentials: { async resolve() { return undefined } },
    }
    applyBatchImage(ctx, { privateDir: '' })
    assert.equal(ctx.tool.name, 'batch_image')
    await assert.rejects(
      () => ctx.tool.execute(
        { command: 'start', manifest: { ...baseManifest, repaint: true, image_provider: DEFAULT_ROUTE } },
        makeExec(cwd),
      ),
      /洗图任务只允许/,
    )
    assert.equal(existsSync(join(cwd, '.dsh-media-private', 'batch', 'batch.db')), true, 'the scheduler db is opened before validation')
    const db = new DatabaseSync(join(cwd, '.dsh-media-private', 'batch', 'batch.db'))
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0, 'a refused repaint manifest must not insert a job row')
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, 'a refused repaint manifest must not insert task rows')
    } finally {
      db.close()
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('batch_image declares the repaint gate in its description and manifest parameter', () => {
  const ctx = { tools: { register(tool) { ctx.tool = tool } }, credentials: { async resolve() { return undefined } } }
  applyBatchImage(ctx, { privateDir: '' })
  assert.match(ctx.tool.description, /repaint/, 'the description must state the gate')
  assert.match(ctx.tool.description, /comfly-gemini-flash-preview/, 'the description must name the forced route')
  assert.match(String(ctx.tool.parameters.properties.manifest.description), /repaint/, 'the manifest parameter must document repaint')
})

test('generate_image: a missing image_ratio still fails first (order of gates is unchanged)', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-repaint-gate-'))
  try {
    const ctx = makeCtx()
    applyImageGen(ctx, { privateDir: '' })
    await assert.rejects(
      () => ctx.tool.execute({ prompt: '洗图', repaint: true, image_provider: DEFAULT_ROUTE }, makeExec(cwd)),
      /image_ratio is required/,
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
