import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCanvasEnvelope,
  classifyCanvasResult,
  selectCanvasVideoMode,
  selectCanvasImageMode,
  formatCanvasRef,
  assertCanonicalResourceId,
  buildVideoNodeArgs,
  buildImageNodeArgs,
  parseCanvasQuote,
  parseCanvasCreditToken,
  parseCanvasNodeHandle,
  parseCanvasRunAcceptance,
  parseCanvasOperation,
  parseCanvasDownload,
  parseCanvasList,
  parseCanvasCreated,
  parseCanvasModelList,
  findCanvasModel,
  canvasModeSpec,
  isTerminalOperationState,
  resolveCanvasProject,
  createCanvasCli,
  canvasGlobalArgs,
  normalizeCanvasName,
} from '../src/shared/dreamina-canvas.ts'
import { runCanvasVideoBatch, waitCanvasOperation, uploadCanvasResource } from '../src/shared/video-canvas-pipeline.ts'
import { parseRegSubkeys, keychainRegPath, KEYCHAIN_ROOT } from '../src/shared/dreamina-keychain.ts'

const UUID_A = 'ae6e3832-9103-49fa-9845-148dd2e65983'
const UUID_B = 'c6bd0fec-10c5-498e-920f-480b40104765'
const UUID_SUBMIT = 'd9eb943d-a9e5-4a1a-a795-a553f3af69fa'
const PROJECT = '2d7fb6f3-73ff-4783-8b05-078a1810d020'

const ok = (data) => JSON.stringify({ schemaVersion: '1', ok: true, data, meta: { requestId: 'req-1' } })
const err = (error) => `{"schemaVersion":"1","ok":false,"error":${JSON.stringify(error)}}`

/** 假 CLI：按「命令串包含的关键字」分派，同时记录调用顺序。 */
function fakeExec(routes) {
  const calls = []
  const exec = async (_binary, args) => {
    calls.push(args)
    const line = args.join(' ')
    for (const [needle, handler] of routes) {
      if (line.includes(needle)) {
        const out = await handler(args, line)
        return out
      }
    }
    return { stdout: ok({}), stderr: '', exitCode: 0 }
  }
  return { exec, calls }
}

/* ------------------------------------------------------------------ */
/* envelope 与退出码分类                                                */
/* ------------------------------------------------------------------ */

test('parseCanvasEnvelope: plain JSON, log-prefixed output, and stderr-only failures', () => {
  assert.deepEqual(parseCanvasEnvelope(ok({ a: 1 })).data, { a: 1 })
  assert.equal(parseCanvasEnvelope(ok({})).ok, true)
  // 噪声前缀（CLI 有时把人类提示写到同一流）
  assert.equal(parseCanvasEnvelope(`some log line\n${ok({ b: 2 })}`).data.b, 2)
  // 完全没有 envelope
  assert.equal(parseCanvasEnvelope('boom'), undefined)
  assert.equal(parseCanvasEnvelope(''), undefined)
})

test('classifyCanvasResult: exit codes map to the documented outcomes', () => {
  assert.equal(classifyCanvasResult(0, { ok: true }).outcome, 'ok')
  assert.equal(classifyCanvasResult(2, { ok: false, error: { class: 'validation' } }).outcome, 'input_error')
  assert.equal(classifyCanvasResult(10, undefined).outcome, 'credits_required')
  assert.equal(classifyCanvasResult(11, undefined).outcome, 'auth_required')
  assert.equal(classifyCanvasResult(12, undefined).outcome, 'permission_denied')
  assert.equal(classifyCanvasResult(13, undefined).outcome, 'permission_denied')
  assert.equal(classifyCanvasResult(20, undefined).outcome, 'pending')
  assert.equal(classifyCanvasResult(21, undefined).outcome, 'service_retryable')
  assert.equal(classifyCanvasResult(22, undefined).outcome, 'manual_intervention')
  assert.equal(classifyCanvasResult(1, undefined).outcome, 'unknown')
})

test('classifyCanvasResult: requiredAction wins over a misleading exit code', () => {
  const login = classifyCanvasResult(1, { ok: false, error: { requiredAction: 'login', message: 'Authentication is required.' } })
  assert.equal(login.outcome, 'auth_required')
  const confirm = classifyCanvasResult(1, { ok: false, error: { requiredAction: 'confirm' } })
  assert.equal(confirm.outcome, 'credits_required')
  const resume = classifyCanvasResult(1, { ok: false, error: { requiredAction: 'resume', retryable: true } })
  assert.equal(resume.outcome, 'service_retryable')
  // requestId 必须带出来（排障用）
  const withId = classifyCanvasResult(11, { ok: false, error: { requiredAction: 'login', requestId: 'r-9' } })
  assert.equal(withId.requestId, 'r-9')
})

/* ------------------------------------------------------------------ */
/* 模式选择（官方 identity-and-references 规则）                          */
/* ------------------------------------------------------------------ */

test('selectCanvasVideoMode: no media -> t2v; frames -> first_last_frame; mixed -> m2v', () => {
  assert.equal(selectCanvasVideoMode({ images: 0, videos: 0, audios: 0 }), 't2v')
  // 单图 + 未显式指定比例 → 首帧锁比例
  assert.equal(selectCanvasVideoMode({ images: 1, videos: 0, audios: 0, explicitRatio: false }), 'first_last_frame')
  assert.equal(selectCanvasVideoMode({ images: 1, videos: 0, audios: 0 }), 'first_last_frame')
  // 单图 + 明确要保留调用方比例 → m2v（官方表格）
  assert.equal(selectCanvasVideoMode({ images: 1, videos: 0, audios: 0, explicitRatio: true }), 'm2v')
  // 两张有序图片 → 首尾帧
  assert.equal(selectCanvasVideoMode({ images: 2, videos: 0, audios: 0 }), 'first_last_frame')
  // 两张图片 + 首尾帧语义提示
  assert.equal(selectCanvasVideoMode({ images: 2, videos: 0, audios: 0, firstLastHint: true }), 'first_last_frame')
  // 视频/音频参考、三张以上图片 → m2v
  assert.equal(selectCanvasVideoMode({ images: 0, videos: 1, audios: 0 }), 'm2v')
  assert.equal(selectCanvasVideoMode({ images: 0, videos: 0, audios: 1 }), 'm2v')
  assert.equal(selectCanvasVideoMode({ images: 3, videos: 0, audios: 0 }), 'm2v')
})

test('selectCanvasVideoMode: image-to-video is never produced as a mode', () => {
  // 旧契约名 image2video 映射到 m2v（上层再按显式比例决定首帧）；
  // 关键契约是：绝不产出 `i2v`。
  const modes = [
    selectCanvasVideoMode({ images: 1, videos: 0, audios: 0, explicitRatio: true }),
    selectCanvasVideoMode({ images: 1, videos: 0, audios: 0 }),
    selectCanvasVideoMode({ images: 0, videos: 0, audios: 0 }),
  ]
  for (const mode of modes) assert.notEqual(mode, 'i2v')
  assert.equal(selectCanvasVideoMode({ images: 1, videos: 0, audios: 0, video_command: 'image2video' }), 'm2v')
  assert.equal(selectCanvasVideoMode({ images: 2, videos: 0, audios: 0, video_command: 'frames2video' }), 'first_last_frame')
  assert.equal(selectCanvasVideoMode({ images: 0, videos: 0, audios: 0, video_command: 'text2video' }), 't2v')
  assert.equal(selectCanvasVideoMode({ images: 0, videos: 1, audios: 0, video_command: 'multimodal2video' }), 'm2v')
})

test('selectCanvasVideoMode: frame mode without any image is rejected; legacy multiframe rejected', () => {
  assert.throws(() => selectCanvasVideoMode({ images: 0, videos: 0, audios: 0, video_command: 'frames2video' }), /首帧/)
  assert.throws(() => selectCanvasVideoMode({ images: 0, videos: 0, audios: 0, video_command: 'multiframe2video' }), /disabled legacy/)
  assert.throws(() => selectCanvasVideoMode({ images: 0, videos: 0, audios: 0, video_command: 'nope' }), /Unsupported video command/)
})

test('selectCanvasImageMode: any image reference forces i2i', () => {
  assert.equal(selectCanvasImageMode(0), 't2i')
  assert.equal(selectCanvasImageMode(1), 'i2i')
  assert.equal(selectCanvasImageMode(6), 'i2i')
})

/* ------------------------------------------------------------------ */
/* 引用形态与命令构造                                                    */
/* ------------------------------------------------------------------ */

test('formatCanvasRef: node ids need the node_ prefix; resource ids must be canonical lowercase UUIDs', () => {
  assert.equal(formatCanvasRef({ kind: 'node', id: 'node_abc' }), 'node:node_abc')
  assert.equal(formatCanvasRef({ kind: 'res', id: UUID_A }), `res:${UUID_A}`)
  assert.throws(() => formatCanvasRef({ kind: 'node', id: 'abc' }), /node_/)
  // 大写 / urn / 去连字符都会被 CLI 在本地拒绝，所以我们先拒
  assert.throws(() => assertCanonicalResourceId(UUID_A.toUpperCase()), /小写规范 UUID/)
  assert.throws(() => assertCanonicalResourceId(`urn:uuid:${UUID_A}`), /小写规范 UUID/)
  assert.throws(() => assertCanonicalResourceId(UUID_A.replace(/-/g, '')), /小写规范 UUID/)
})

test('canvasGlobalArgs: json + non-interactive always, profile/region only when set', () => {
  assert.deepEqual(canvasGlobalArgs(), ['--format', 'json', '--non-interactive'])
  assert.deepEqual(canvasGlobalArgs({ profile: 'wsstudio', region: 'cn' }), ['--format', 'json', '--non-interactive', '--profile', 'wsstudio', '--region', 'cn'])
})

test('buildVideoNodeArgs: run/confirm flags, refs order, and credit-token/ceiling exclusivity', () => {
  const save = buildVideoNodeArgs({
    projectId: PROJECT, title: 't', mode: 'm2v', prompt: 'p', model: 'seedance_2.5',
    ratio: '16:9', resolution: '480p', durationSeconds: 5, count: 1,
    refs: [{ kind: 'res', id: UUID_A }, { kind: 'res', id: UUID_B }],
  })
  assert.deepEqual(save.slice(0, 6), ['node', 'create', 'video', '--project-id', PROJECT, '--title'])
  assert.ok(save.includes('--mode') && save.includes('m2v'))
  assert.ok(save.includes('--count'))
  assert.equal(save.filter((a) => a === '--ref').length, 2)
  assert.equal(save.includes('--run'), false)
  assert.equal(save.includes('--credit-ceiling'), false)

  const run = buildVideoNodeArgs({
    projectId: PROJECT, title: 't', mode: 't2v', prompt: 'p', model: 'seedance_2.5',
    ratio: '16:9', resolution: '720p', durationSeconds: 8, run: true, wait: true,
    timeout: '10m', interval: '5s', submitId: UUID_SUBMIT, creditCeiling: 48,
  })
  assert.ok(run.includes('--run'))
  assert.ok(run.includes('--wait'))
  assert.deepEqual(run.slice(run.indexOf('--timeout'), run.indexOf('--timeout') + 2), ['--timeout', '10m'])
  assert.deepEqual(run.slice(run.indexOf('--credit-ceiling'), run.indexOf('--credit-ceiling') + 2), ['--credit-ceiling', '48'])
  assert.equal(run.includes('--credit-token'), false)

  // token 优先于 ceiling（两者互斥，CLI 会拒绝同时出现）
  const withToken = buildVideoNodeArgs({
    projectId: PROJECT, title: 't', mode: 't2v', prompt: 'p', model: 'seedance_2.5',
    ratio: '16:9', resolution: '720p', durationSeconds: 5, run: true, creditToken: 'tok', creditCeiling: 48,
  })
  assert.ok(withToken.includes('--credit-token'))
  assert.equal(withToken.includes('--credit-ceiling'), false)

  const dry = buildVideoNodeArgs({
    projectId: PROJECT, title: 't', mode: 't2v', prompt: 'p', model: 'seedance_2.5',
    ratio: '16:9', resolution: '480p', durationSeconds: 5, dryRun: true,
  })
  assert.ok(dry.includes('--dry-run'))
})

test('buildImageNodeArgs: mode/count/refs are explicit', () => {
  const args = buildImageNodeArgs({
    projectId: PROJECT, title: 'img', mode: 'i2i', prompt: 'p', model: 'seedream_4.5',
    ratio: '1:1', resolution: '2K', count: 1, refs: [{ kind: 'res', id: UUID_A }],
  })
  assert.deepEqual(args.slice(0, 5), ['node', 'create', 'image', '--project-id', PROJECT])
  assert.ok(args.includes('i2i'))
  assert.ok(args.includes('seedream_4.5'))
  assert.deepEqual(args.slice(args.indexOf('--count'), args.indexOf('--count') + 2), ['--count', '1'])
  assert.deepEqual(args.slice(args.indexOf('--ref'), args.indexOf('--ref') + 2), ['--ref', `res:${UUID_A}`])
})

/* ------------------------------------------------------------------ */
/* 结果解析                                                             */
/* ------------------------------------------------------------------ */

test('parseCanvasQuote: quote is a ceiling, not an approval', () => {
  const quote = parseCanvasQuote(parseCanvasEnvelope(ok({ items: [{ nodeId: 'node_a', maxCredits: 48 }], totalMaxCredits: 48, confirmable: true, confirmationRequired: false, draftVersion: 2 })))
  assert.equal(quote.totalMaxCredits, 48)
  assert.equal(quote.confirmable, true)
  assert.equal(quote.confirmationRequired, false)
  assert.deepEqual(quote.items, [{ nodeId: 'node_a', maxCredits: 48 }])
  assert.equal(quote.draftVersion, 2)
})

test('parseCanvasCreditToken / parseCanvasNodeHandle / parseCanvasRunAcceptance', () => {
  const token = parseCanvasCreditToken(parseCanvasEnvelope(ok({ creditConfirmationToken: 'tok', creditCeiling: 48, expiresAt: '2026-10-12T10:41:58Z' })))
  assert.equal(token.token, 'tok')
  assert.equal(token.ceiling, 48)

  const handle = parseCanvasNodeHandle(parseCanvasEnvelope(ok({ node: { nodeId: 'node_x', type: 'image', title: 't', status: 'empty' } })))
  assert.equal(handle.nodeId, 'node_x')
  assert.equal(handle.type, 'image')

  const accepted = parseCanvasRunAcceptance(parseCanvasEnvelope(ok({ items: [{ nodeId: 'node_x', submitId: UUID_SUBMIT, state: 'accepted', resources: [{ resourceId: UUID_A }] }] })))
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].submitId, UUID_SUBMIT)
  assert.deepEqual(accepted[0].resourceIds, [UUID_A])
})

test('parseCanvasOperation: terminal states, resources and the do-not-resubmit advice', () => {
  const op = parseCanvasOperation(parseCanvasEnvelope(ok({
    operationRef: UUID_SUBMIT,
    state: 'succeeded',
    resources: [{ resourceId: UUID_B, state: 'succeeded', width: 1536, height: 1536, format: 'jpeg' }],
    submission: { state: 'completed', resubmittable: false, adviceCode: 'submission_accepted', advice: 'do not resubmit' },
  })))
  assert.equal(op.state, 'succeeded')
  assert.equal(op.resources[0].format, 'jpeg')
  assert.equal(op.adviceCode, 'submission_accepted')
  assert.equal(isTerminalOperationState(op.state), true)
  assert.equal(isTerminalOperationState('running'), false)
  // 未知状态不能被误当成终态
  assert.equal(parseCanvasOperation(parseCanvasEnvelope(ok({ state: 'wat' }))).state, 'unknown')
})

test('parseCanvasDownload / parseCanvasList / parseCanvasCreated', () => {
  const dl = parseCanvasDownload(parseCanvasEnvelope(ok({ resourceId: UUID_B, path: 'C:\\out\\x.mp4', size: 4948982, sha256: 'abc' })))
  assert.equal(dl.path, 'C:\\out\\x.mp4')
  assert.equal(dl.size, 4948982)

  const list = parseCanvasList(parseCanvasEnvelope(ok({ items: [{ projectId: PROJECT, name: 'dsh-media', webUrl: 'https://x' }], nextCursor: 'c1' })))
  assert.equal(list.projects[0].name, 'dsh-media')
  assert.equal(list.nextCursor, 'c1')
  // 兼容 canvases/projects 形态
  assert.equal(parseCanvasList(parseCanvasEnvelope(ok({ canvases: [{ projectId: PROJECT }] }))).projects.length, 1)

  const created = parseCanvasCreated(parseCanvasEnvelope(ok({ project: { projectId: PROJECT, name: 'n', webUrl: 'https://web' }, draftVersion: 0, current: true })))
  assert.equal(created.projectId, PROJECT)
  assert.equal(created.created, true)
  assert.equal(created.webUrl, 'https://web')
})

test('normalizeCanvasName: blank names fall back, newlines collapse', () => {
  assert.equal(normalizeCanvasName(''), 'dsh-media')
  assert.equal(normalizeCanvasName('  \n '), 'dsh-media')
  assert.equal(normalizeCanvasName('a\nb'), 'a b')
  assert.equal(normalizeCanvasName('x'.repeat(500)).length, 120)
})

/* ------------------------------------------------------------------ */
/* 实时模型目录                                                         */
/* ------------------------------------------------------------------ */

test('parseCanvasModelList: dynamic flag ranges become usable limits', () => {
  const envelope = parseCanvasEnvelope(
    ok({
      items: [
        {
          model: 'seedance_2.5',
          aliases: ['seedance2.5'],
          modes: [
            {
              name: 'm2v',
              flags: [
                { flag: '--ratio', values: ['21:9', '16:9'] },
                { flag: '--resolution', values: ['480p', '720p', '1080p'] },
                { flag: '--duration', min: 4, max: 30, step: 1 },
                { flag: '--count', min: 1, max: 4 },
                { flag: '--prompt', required: false, maxLength: 15000 },
              ],
              references: { min: 1, max: 50, types: [{ mediaType: 'image', min: 0, max: 30 }, { mediaType: 'video', min: 0, max: 10 }] },
            },
          ],
        },
      ],
    }),
  )
  const models = parseCanvasModelList(envelope)
  assert.equal(models.length, 1)
  const model = findCanvasModel(models, 'seedance2.5')
  assert.equal(model.model, 'seedance_2.5')
  const spec = canvasModeSpec(model, 'm2v')
  assert.deepEqual(spec.resolutions, ['480p', '720p', '1080p'])
  assert.equal(spec.durationMin, 4)
  assert.equal(spec.durationMax, 30)
  assert.equal(spec.countMax, 4)
  assert.equal(spec.references.max, 50)
  // 别名不区分大小写；未知模型返回 undefined
  assert.equal(findCanvasModel(models, 'SEEDANCE2.5').model, 'seedance_2.5')
  assert.equal(findCanvasModel(models, 'nope'), undefined)
})

/* ------------------------------------------------------------------ */
/* keychain 子键（新旧 CLI 共存）                                        */
/* ------------------------------------------------------------------ */

test('parseRegSubkeys: discovers canvas subkey next to the legacy one', () => {
  const stdout = [
    '',
    'HKEY_CURRENT_USER\\Software\\BytedAuthClient\\keychain',
    '    (默认)    REG_SZ    ',
    'HKEY_CURRENT_USER\\Software\\BytedAuthClient\\keychain\\dreamina',
    'HKEY_CURRENT_USER\\Software\\BytedAuthClient\\keychain\\dreamina_canvas_oauth_v2_deadbeef',
    '',
  ].join('\r\n')
  assert.deepEqual(parseRegSubkeys(stdout), ['dreamina', 'dreamina_canvas_oauth_v2_deadbeef'])
  // 只有根、没有子键时返回空
  assert.deepEqual(parseRegSubkeys(`HKEY_CURRENT_USER\\Software\\BytedAuthClient\\keychain\r\n`), [])
})

test('keychainRegPath: subkey names are validated before touching the registry', () => {
  assert.equal(keychainRegPath('dreamina_canvas_oauth_v2_abc'), `${KEYCHAIN_ROOT}\\dreamina_canvas_oauth_v2_abc`)
  assert.equal(keychainRegPath('\\dreamina'), `${KEYCHAIN_ROOT}\\dreamina`)
  assert.throws(() => keychainRegPath('..\\other'), /非法/)
  assert.throws(() => keychainRegPath('a b'), /非法/)
})

/* ------------------------------------------------------------------ */
/* CLI 门面（注入执行器）                                                */
/* ------------------------------------------------------------------ */

test('createCanvasCli: failure envelopes are read from stderr and classified', async () => {
  let ensured = 0
  const cli = createCanvasCli({
    binary: 'dreamina-canvas',
    ensureAccount: async () => { ensured += 1 },
    exec: async () => ({
      stdout: '',
      stderr: err({ code: 'cli.authentication_required', class: 'auth_required', message: 'Authentication is required.', requiredAction: 'login', requestId: 'r-2' }),
      exitCode: 11,
    }),
  })
  const result = await cli.run(['auth', 'account'])
  assert.equal(result.classification.outcome, 'auth_required')
  assert.equal(result.classification.requiredAction, 'login')
  assert.equal(ensured, 1)
  await assert.rejects(() => cli.runOrThrow(['auth', 'account'], { label: 'auth account' }), /auth account failed \[auth_required\]/)
})

test('createCanvasCli: profile and region are injected as global flags', async () => {
  const seen = []
  const cli = createCanvasCli({ binary: 'b', profile: 'isun', region: 'cn', exec: async (_b, args) => { seen.push(args); return { stdout: ok({}), stderr: '', exitCode: 0 } } })
  await cli.run(['version'])
  assert.deepEqual(seen[0], ['--format', 'json', '--non-interactive', '--profile', 'isun', '--region', 'cn', 'version'])
})

/* ------------------------------------------------------------------ */
/* 画布复用                                                             */
/* ------------------------------------------------------------------ */

test('resolveCanvasProject: reuses a same-named canvas instead of creating one', async () => {
  const { exec, calls } = fakeExec([
    ['canvas ls', () => ({ stdout: ok({ items: [{ projectId: PROJECT, name: 'dsh-media', webUrl: 'https://web' }] }), stderr: '', exitCode: 0 })],
    ['canvas create', () => ({ stdout: ok({ project: { projectId: 'created-id', name: 'x' } }), stderr: '', exitCode: 0 })],
  ])
  const cli = createCanvasCli({ binary: 'b', exec })
  const project = await resolveCanvasProject(cli, 'dsh-media')
  assert.equal(project.projectId, PROJECT)
  assert.equal(project.created, false)
  assert.equal(calls.some((c) => c.includes('create')), false)
})

test('resolveCanvasProject: creates when no page holds the name', async () => {
  const { exec, calls } = fakeExec([
    ['canvas ls', () => ({ stdout: ok({ items: [{ projectId: 'other', name: 'someone-else' }] }), stderr: '', exitCode: 0 })],
    ['canvas create', () => ({ stdout: ok({ project: { projectId: 'new-id', name: 'dsh-media', webUrl: 'https://new' } }), stderr: '', exitCode: 0 })],
  ])
  const cli = createCanvasCli({ binary: 'b', exec })
  const project = await resolveCanvasProject(cli, 'dsh-media')
  assert.equal(project.projectId, 'new-id')
  assert.equal(project.created, true)
  // create 绝不能带 --use（那是全局副作用）
  const createCall = calls.find((c) => c.includes('create'))
  assert.equal(createCall.includes('--use'), false)
})

/* ------------------------------------------------------------------ */
/* 端到端（假 CLI）：上传 → 保存 → 报价 → 批准 → 运行 → 等待 → 下载        */
/* ------------------------------------------------------------------ */

function fullChainRoutes(state) {
  return [
    ['resource upload', () => {
      state.uploads += 1
      return { stdout: ok({ resourceId: UUID_A, mediaType: 'image' }), stderr: '', exitCode: 0 }
    }],
    ['node quote', () => ({ stdout: ok({ items: [{ nodeId: 'node_x', maxCredits: 48 }], totalMaxCredits: 48, confirmable: true, confirmationRequired: false }), stderr: '', exitCode: 0 })],
    ['node confirm', (args) => {
      state.ceiling = args[args.indexOf('--credit-ceiling') + 1]
      return { stdout: ok({ creditConfirmationToken: 'tok', creditCeiling: Number(state.ceiling), expiresAt: 'later' }), stderr: '', exitCode: 0 }
    }],
    ['node run', (args) => {
      state.submitId = args[args.indexOf('--submit-id') + 1]
      return { stdout: ok({ items: [{ nodeId: 'node_x', submitId: state.submitId, state: 'accepted', resources: [{ resourceId: UUID_B }] }] }), stderr: '', exitCode: 0 }
    }],
    ['node create video', () => ({ stdout: ok({ node: { nodeId: 'node_x', type: 'video', title: 't', status: 'empty' } }), stderr: '', exitCode: 0 })],
    ['operation wait', () => ({ stdout: ok({ operationRef: state.submitId, state: 'succeeded', resources: [{ resourceId: UUID_B, state: 'succeeded' }] }), stderr: '', exitCode: 0 })],
    ['resource download', () => ({ stdout: ok({ resourceId: UUID_B, path: 'C:\\jobs\\out.mp4', size: 1234, sha256: 'h' }), stderr: '', exitCode: 0 })],
  ]
}

test('runCanvasVideoBatch: full paid chain, quote becomes the ceiling, identity is preserved', async () => {
  const state = { uploads: 0, ceiling: undefined, submitId: undefined }
  const { exec, calls } = fakeExec(fullChainRoutes(state))
  const cli = createCanvasCli({ binary: 'b', exec })
  const task = { taskId: 't1', title: 'a-1', prompt: '海面日落', images: ['C:\\in\\a.png'], videos: [], audios: [], duration: 5, explicitRatio: false }
  const results = await runCanvasVideoBatch(
    { cli, projectId: PROJECT, model: 'seedance_2.5', resolution: '480p', ratio: '16:9', pollTimeoutMs: 60_000 },
    [task],
    ['C:\\jobs\\t1'],
    [UUID_SUBMIT],
  )
  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'success')
  assert.equal(results[0].nodeId, 'node_x')
  assert.equal(results[0].submitId, UUID_SUBMIT)
  assert.equal(results[0].resourceId, UUID_B)
  assert.equal(results[0].path, 'C:\\jobs\\out.mp4')
  assert.equal(results[0].mode, 'first_last_frame', '单图且未显式指定比例 → 首帧模式')
  // 报价 48 自动成为批准上限
  assert.equal(state.ceiling, '48')
  // 同一 submitId 贯穿 run 与 wait（绝不换新身份）
  assert.equal(state.submitId, UUID_SUBMIT)
  const runCall = calls.find((c) => c.join(' ').includes('node run'))
  assert.equal(runCall[runCall.indexOf('--submit-id') + 1], UUID_SUBMIT)
  // 上传发生在保存之前
  assert.ok(calls.findIndex((c) => c.join(' ').includes('resource upload')) < calls.findIndex((c) => c.join(' ').includes('node create video')))
})

test('runCanvasVideoBatch: a user ceiling overrides the quote; submitOnly never polls', async () => {
  const state = { uploads: 0, ceiling: undefined, submitId: undefined }
  const { exec, calls } = fakeExec(fullChainRoutes(state))
  const cli = createCanvasCli({ binary: 'b', exec })
  const task = { taskId: 't1', title: 'a-1', prompt: 'p', images: [], videos: [], audios: [], duration: 4, explicitRatio: true }
  const results = await runCanvasVideoBatch(
    { cli, projectId: PROJECT, model: 'seedance_2.5', resolution: '480p', ratio: '16:9', pollTimeoutMs: 60_000, creditCeiling: 30, submitOnly: true },
    [task],
    ['C:\\jobs\\t1'],
    [UUID_SUBMIT],
  )
  assert.equal(state.ceiling, '30')
  assert.equal(results[0].status, 'submitted')
  assert.equal(results[0].mode, 't2v')
  assert.equal(calls.some((c) => c.join(' ').includes('operation wait')), false)
  assert.equal(calls.some((c) => c.join(' ').includes('resource download')), false)
})

test('runCanvasVideoBatch: submit failure is terminal for that task (never auto-replayed)', async () => {
  const { exec, calls } = fakeExec([
    ['resource upload', () => ({ stdout: ok({ resourceId: UUID_A }), stderr: '', exitCode: 0 })],
    ['node create video', () => ({ stdout: err({ code: 'service.2', message: 'bad mode' }), stderr: '', exitCode: 2 })],
  ])
  const cli = createCanvasCli({ binary: 'b', exec })
  const task = { taskId: 't1', title: 'a-1', prompt: 'p', images: [], videos: [], audios: [], duration: 5, explicitRatio: true }
  const results = await runCanvasVideoBatch(
    { cli, projectId: PROJECT, model: 'seedance_2.5', resolution: '480p', ratio: '16:9', pollTimeoutMs: 1000 },
    [task],
    ['C:\\jobs\\t1'],
    [UUID_SUBMIT],
  )
  assert.equal(results[0].status, 'failed')
  assert.match(results[0].error, /input_error/)
  // 只提交过一次（没有重放）
  assert.equal(calls.filter((c) => c.join(' ').includes('node create video')).length, 1)
})

test('waitCanvasOperation: local wait timeout is "pending", not failure (identity is kept)', async () => {
  const { exec } = fakeExec([
    ['operation wait', () => ({ stdout: err({ code: 'cli.wait_timeout', message: 'not finished', requiredAction: 'resume', retryable: true }), stderr: '', exitCode: 20 })],
  ])
  const cli = createCanvasCli({ binary: 'b', exec })
  const waited = await waitCanvasOperation({ cli, projectId: PROJECT, pollTimeoutMs: 30_000, model: 'm', resolution: '480p', ratio: '16:9' }, UUID_SUBMIT)
  assert.equal(waited.state, 'pending')
})

test('uploadCanvasResource: missing resourceId is a hard error', async () => {
  const { exec } = fakeExec([['resource upload', () => ({ stdout: ok({ mediaType: 'image' }), stderr: '', exitCode: 0 })]])
  const cli = createCanvasCli({ binary: 'b', exec })
  await assert.rejects(() => uploadCanvasResource(cli, PROJECT, 'image', 'C:\\in\\a.png'), /未返回 resourceId/)
})
