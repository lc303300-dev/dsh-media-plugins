import test from 'node:test'
import assert from 'node:assert/strict'
import { toCliFlags, canvasPositionals, isSpendingCall, CANVAS_COMMANDS } from '../src/tool-canvas.ts'

/* ------------------------------------------------------------------ */
/* flag 透传：下划线 → 连字符、数组重复、布尔开关                          */
/* ------------------------------------------------------------------ */

test('toCliFlags: underscore keys become hyphenated flags, arrays repeat the flag', () => {
  const flags = toCliFlags({
    project_id: '2d7fb6f3-73ff-4783-8b05-078a1810d020',
    node_id: 'node_x',
    mode: 't2v',
    duration: 4,
    count: 1,
    ref: ['res:ae6e3832-9103-49fa-9845-148dd2e65983', 'node:node_a'],
  })
  assert.deepEqual(flags, [
    '--project-id', '2d7fb6f3-73ff-4783-8b05-078a1810d020',
    '--node-id', 'node_x',
    '--mode', 't2v',
    '--duration', '4',
    '--count', '1',
    '--ref', 'res:ae6e3832-9103-49fa-9845-148dd2e65983',
    '--ref', 'node:node_a',
  ])
})

test('toCliFlags: true is a bare switch, false/null/undefined are omitted', () => {
  assert.deepEqual(toCliFlags({ run: true, wait: true, dry_run: false, model: undefined, ratio: null }), ['--run', '--wait'])
  assert.deepEqual(toCliFlags({}), [])
  assert.deepEqual(toCliFlags(undefined), [])
  // 已带连字符的键原样保留（不重复加前缀）
  assert.deepEqual(toCliFlags({ '--node-id': 'node_x' }), ['--node-id', 'node_x'])
  // 下划线开头的内部键被忽略
  assert.deepEqual(toCliFlags({ _internal: 'x', ratio: '16:9' }), ['--ratio', '16:9'])
})

test('toCliFlags: array entries keep order and skip empty entries', () => {
  assert.deepEqual(toCliFlags({ clip: ['node_a,kind=canvas_node', 'node_b,kind=canvas_node'] }), [
    '--clip', 'node_a,kind=canvas_node',
    '--clip', 'node_b,kind=canvas_node',
  ])
})

/* ------------------------------------------------------------------ */
/* 位置参数：schema 要整串，其余按空格拆                                   */
/* ------------------------------------------------------------------ */

test('canvasPositionals: schema takes the command path as ONE argument', () => {
  assert.deepEqual(canvasPositionals('schema', 'node create video'), ['node create video'])
  assert.deepEqual(canvasPositionals('schema', 'auth account'), ['auth account'])
  assert.deepEqual(canvasPositionals('schema', ''), [])
})

test('canvasPositionals: other commands split the action into positionals', () => {
  assert.deepEqual(canvasPositionals('node', 'create video'), ['create', 'video'])
  assert.deepEqual(canvasPositionals('node', 'upscale image'), ['upscale', 'image'])
  assert.deepEqual(canvasPositionals('canvas', 'ls'), ['ls'])
})

test('canvasPositionals: extra positionals are appended after the action', () => {
  // operation wait <submitId> / resource download <resourceId> / canvas create <name>
  assert.deepEqual(canvasPositionals('operation', 'wait', ['d9eb943d-a9e5-4a1a-a795-a553f3af69fa']), ['wait', 'd9eb943d-a9e5-4a1a-a795-a553f3af69fa'])
  assert.deepEqual(canvasPositionals('resource', 'download', ['ae6e3832-9103-49fa-9845-148dd2e65983']), ['download', 'ae6e3832-9103-49fa-9845-148dd2e65983'])
  assert.deepEqual(canvasPositionals('catalog', 'find', ['seedance2.5']), ['find', 'seedance2.5'])
})

/* ------------------------------------------------------------------ */
/* 付费门：花钱的动作必须显式批准                                          */
/* ------------------------------------------------------------------ */

test('isSpendingCall: --run, node run and node upscale are spending', () => {
  assert.equal(isSpendingCall('node', 'create video', { run: true }), true)
  assert.equal(isSpendingCall('node', 'create image', { run: true }), true)
  assert.equal(isSpendingCall('node', 'run', {}), true)
  assert.equal(isSpendingCall('node', 'upscale image', {}), true)
  assert.equal(isSpendingCall('node', 'run', { credit_token: 'tok' }), true, '仍需批准方式，由调用方校验')
})

test('isSpendingCall: --dry-run is never spending, read commands are never spending', () => {
  assert.equal(isSpendingCall('node', 'create video', { run: true, dry_run: true }), false)
  assert.equal(isSpendingCall('node', 'quote', {}), false)
  assert.equal(isSpendingCall('node', 'show', {}), false)
  assert.equal(isSpendingCall('node', 'find', {}), false)
  assert.equal(isSpendingCall('operation', 'wait', {}), false)
  assert.equal(isSpendingCall('resource', 'download', {}), false)
  assert.equal(isSpendingCall('canvas', 'create', {}), false)
  assert.equal(isSpendingCall('catalog', 'list', {}), false)
})

test('command surface stays aligned with the documented CLI command set', () => {
  assert.deepEqual([...CANVAS_COMMANDS], ['catalog', 'canvas', 'node', 'operation', 'resource', 'voice', 'schema', 'version'])
})
