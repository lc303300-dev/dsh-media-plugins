import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { apply } from '../src/tool-video-to-gif.ts'
import { resolveFfmpeg } from '../src/shared/gif-core.ts'

/** Capture the tool definition the plugin registers. */
function captureTool(config) {
  let def
  apply({ tools: { register: (d) => { def = d } } }, config)
  return def
}

const ffmpeg = await resolveFfmpeg()
const skipNoFfmpeg = ffmpeg ? false : 'ffmpeg 不可用（FFMPEG_PATH/PATH/常见路径）'

test('video_to_gif 单文件返回的字段全部落在 output schema 内', { skip: skipNoFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gif-tool-'))
  try {
    const clip = join(dir, 'clip.mp4')
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-pix_fmt', 'yuv420p', clip], { stdio: 'ignore' })

    const def = captureTool({
      ffmpegPath: '',
      gifsiclePath: '',
      outputDir: 'outputs',
      privateDir: '',
      maxSizeMB: 10,
      timeoutMs: 120000,
    })
    assert.ok(def?.output?.schema, '工具必须声明 output.schema')

    const exec = { agent: { session: { header: { cwd: dir } } } }
    const value = await def.execute({ video: clip }, exec)

    // DSH validates the tool result against this schema with
    // additionalProperties:false — an undeclared key makes the whole call fail.
    const declared = new Set(Object.keys(def.output.schema.properties ?? {}))
    const extra = Object.keys(value).filter((k) => !declared.has(k))
    assert.deepEqual(extra, [], `返回值含未声明字段，会被输出校验拒绝: ${extra.join(', ')}`)

    assert.equal(value.ok, true)
    assert.ok(value.path && existsSync(value.path), '产物必须存在')
    assert.ok(statSync(value.path).size > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('video_to_gif 批量返回的字段全部落在 output schema 内', { skip: skipNoFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gif-tool-'))
  try {
    const inputs = join(dir, 'in')
    mkdirSync(inputs, { recursive: true })
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-pix_fmt', 'yuv420p', join(inputs, 'a.mp4')], { stdio: 'ignore' })
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'smptebars=duration=1:size=320x240:rate=10', '-pix_fmt', 'yuv420p', join(inputs, 'b.mp4')], { stdio: 'ignore' })

    const def = captureTool({
      ffmpegPath: '',
      gifsiclePath: '',
      outputDir: 'outputs',
      privateDir: '',
      maxSizeMB: 10,
      timeoutMs: 120000,
    })
    const exec = { agent: { session: { header: { cwd: dir } } } }
    const value = await def.execute({ input_dir: inputs }, exec)

    const declared = new Set(Object.keys(def.output.schema.properties ?? {}))
    assert.deepEqual(Object.keys(value).filter((k) => !declared.has(k)), [])
    assert.equal(value.ok, true)
    assert.equal(value.results.length, 2)
    const paths = value.results.map((r) => r.path)
    assert.equal(new Set(paths).size, 2, '两个输入必须产出不同文件')
    for (const p of paths) assert.ok(existsSync(p) && statSync(p).size > 0, `${p} 必须存在且非空`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
