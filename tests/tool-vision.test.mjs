/**
 * describe_image fallback-only gate — tests.
 *
 * The tool is a "vision sub-model bridge": it should only run the Doubao BRIDGE
 * when the current main model cannot read images. When the core `read_image`
 * tool is registered AND the calling model declares `image` input, the tool
 * must refuse and steer the agent to `read_image` (never burning a second
 * vision-model call).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/tool-vision.ts'

/** Build a minimal plugin context with a captured registered tool and call log. */
function makeCtx({ readImageRegistered = true, inputModalities = ['text', 'image'] } = {}) {
  const calls = { stream: [] }
  const ctx = {
    tools: {
      register(tool) { ctx.tool = tool },
      get(name) { return name === 'read_image' && readImageRegistered ? { name } : undefined },
    },
    llm: {
      async resolveModelInfo(provider, model) { return { provider, model, inputModalities } },
      stream(opts) {
        calls.stream.push(opts)
        const empty = async function* () {}
        return empty()
      },
    },
    fs: {
      async resolve(p) { return { displayPath: p } },
      async readBytes() { return new Uint8Array() },
    },
    attachments: {
      async saveImage(info) { return { attachmentId: 'a', mediaType: info.mediaType, bytes: 4, width: 1, height: 1, name: info.name } },
    },
  }
  return { ctx, calls }
}

/** Build a minimal tool-execution context with a resolvable model route. */
function makeExec({ provider = 'deepseek', model = 'deepseek-v4-flash-vision-exp' } = {}) {
  const signal = new AbortController().signal
  return {
    agent: {
      session: { requestHeader: () => ({ config: { provider, model } }) },
      options: { provider, model },
    },
    signal,
  }
}

test('describe_image registers with fallback-only name and steering description', () => {
  const { ctx } = makeCtx()
  apply(ctx, {})
  assert.ok(ctx.tool, 'describe_image tool should register')
  assert.equal(ctx.tool.name, 'describe_image')
  assert.match(ctx.tool.description, /read_image/, 'description must steer to read_image')
  assert.match(ctx.tool.description, /主模型可读图/, 'description must note the image-capable case')
})

test('refuses and steers to read_image when the main model is image-capable', async () => {
  const { ctx, calls } = makeCtx({ readImageRegistered: true, inputModalities: ['text', 'image'] })
  apply(ctx, {})
  await assert.rejects(
    () => ctx.tool.execute({ file_path: 'shot.png' }, makeExec()),
    /fallback-only/,
    'must refuse when a native read_image path exists',
  )
  assert.equal(calls.stream.length, 0, 'must not call the Doubao bridge when the model can read natively')
})

test('keeps read_image dependency check: no refusal when read_image is not registered', async () => {
  // Even with an image-capable model, if the core read_image tool is absent the
  // Doubao fallback must stay available (no native path to steer to).
  const { ctx, calls } = makeCtx({ readImageRegistered: false, inputModalities: ['text', 'image'] })
  apply(ctx, {})
  await assert.rejects(
    () => ctx.tool.execute({ file_path: 'shot.png' }, makeExec()),
    /vision model returned no text/,
    'gate must pass through to the Doubao bridge when read_image is unavailable',
  )
  assert.equal(calls.stream.length, 1, 'must fall back to Doubao when no native read_image is registered')
})

test('keeps Doubao fallback when the main model cannot read images', async () => {
  // Model declares text-only input -> the fallback bridge is the correct path.
  const { ctx, calls } = makeCtx({ readImageRegistered: true, inputModalities: ['text'] })
  apply(ctx, {})
  await assert.rejects(
    () => ctx.tool.execute({ file_path: 'shot.png' }, makeExec()),
    /vision model returned no text/,
    'must run the Doubao bridge when the model is not image-capable',
  )
  assert.equal(calls.stream.length, 1, 'must call the Doubao bridge for a text-only model')
})

test('rejects empty file_path and non-image extensions before the gate', async () => {
  const { ctx } = makeCtx()
  apply(ctx, {})
  await assert.rejects(() => ctx.tool.execute({ file_path: '   ' }, makeExec()), /non-empty/)
  await assert.rejects(() => ctx.tool.execute({ file_path: 'a.txt' }, makeExec()), /PNG\/JPEG\/WebP\/GIF/)
})
