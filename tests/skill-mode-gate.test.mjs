/**
 * Skill 线硬门（`skill_mode`）—— tests.
 *
 * `project_pipeline` 属于业务 Skill 线。默认视频创作走导演线
 * （`video-prompt-orchestrator` + `prompt_batch`），因此 Skill 线不得被主动触发：
 * `create` 必须显式收到 `skill_mode=true`（代表用户本轮明确要求启用 Skill
 * 模式），否则拒绝创建，且不得落下任何项目状态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/tool-project.ts'

/** Build a minimal plugin context that captures the registered tool. */
function makeCtx() {
  const ctx = { tools: { register(tool) { ctx.tool = tool } } }
  return ctx
}

/** Minimal tool-execution context: only the session cwd is consumed. */
function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

test('project_pipeline declares the skill_mode hard gate in its description', () => {
  const ctx = makeCtx()
  apply(ctx, { privateDir: '' })
  assert.ok(ctx.tool, 'project_pipeline should register')
  assert.equal(ctx.tool.name, 'project_pipeline')
  assert.match(ctx.tool.description, /skill_mode=true/, 'description must state the hard gate')
})

test('create without skill_mode is refused and writes no project state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-skill-gate-'))
  try {
    const ctx = makeCtx()
    apply(ctx, { privateDir: '' })
    const res = await ctx.tool.execute({ command: 'create' }, makeExec(cwd))
    assert.equal(res.ok, false, 'create must be refused without skill_mode')
    assert.match(res.message, /skill mode not enabled/)
    const projects = await readdir(join(cwd, '.dsh-media-private', 'projects')).catch(() => [])
    assert.deepEqual(projects, [], 'a refused create must not write project state')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('create with skill_mode=true proceeds', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-skill-gate-'))
  try {
    const ctx = makeCtx()
    apply(ctx, { privateDir: '' })
    const res = await ctx.tool.execute({ command: 'create', skill_mode: true }, makeExec(cwd))
    assert.equal(res.ok, true, `create should succeed: ${res.message}`)
    const states = await readdir(join(cwd, '.dsh-media-private', 'projects'))
    assert.equal(states.length, 1, 'exactly one project state file should exist')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
