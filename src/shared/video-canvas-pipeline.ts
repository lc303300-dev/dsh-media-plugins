/**
 * 即梦画布视频批处理管线（纯逻辑 + 注入 CLI 门面）。
 *
 * 旧管线是「每任务一条一次性命令 + query_result --download_dir」；新画布 CLI
 * 的付费链路是显式的四段式，本模块把这四段固定下来，任何一步都不允许被跳过：
 *
 *   1. `resource upload`      本地素材登记到画布 → resourceId（引用必须用 res:）
 *   2. `node create video`    保存节点（不生成）→ nodeId
 *   3. `node quote`           服务端报价（报价 ≠ 授权）
 *   4. `node confirm`         取 creditConfirmationToken（上限 = 报价或用户显式 ceiling）
 *   5. `node run`             提交 → submitId（同一 submitId 绝不重复提交）
 *   6. `operation wait`       等终态（超时不等于失败，任务可继续查询）
 *   7. `resource download`    按 resourceId 精确取回产物
 *
 * 设计约束：
 * - **单产物单节点**：官方要求多产物分节点展示，所以每个任务恒 `--count 1`；
 * - **失败即停**：每个任务只走一次提交，失败或不确定就标 `needs_review`，
 *   绝不自动重放（付费不可回滚）；
 * - **引用顺序固定**为 图片 → 视频 → 音频，与 prompt 里的裸标签编号一致；
 * - 每个任务独占自己的下载目录，落地产物只从该目录取，避免张冠李戴。
 *
 * @module dsh-media-plugins/shared/video-canvas-pipeline
 */

import { basename, join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import {
  buildVideoNodeArgs,
  canvasRequestId,
  parseCanvasCreditConfirmation,
  parseCanvasCreditToken,
  parseCanvasDownload,
  parseCanvasNodeHandle,
  parseCanvasOperation,
  parseCanvasPartialItems,
  parseCanvasQuote,
  parseCanvasRunAcceptance,
  selectCanvasVideoMode,
  type CanvasCli,
  type CanvasEnvelope,
  type CanvasNodeRef,
  type CanvasVideoMode,
} from './dreamina-canvas.ts'
import { isVideoExtName } from './video-pipeline.ts'

/** 一个视频任务的完整输入（参考素材已是可提交的本地路径）。 */
export interface CanvasVideoTask {
  taskId: string
  title: string
  prompt: string
  /** 图片参考（顺序即 图片1、图片2…）。 */
  images: string[]
  /** 视频参考（顺序即 视频1、视频2…）。 */
  videos: string[]
  /** 音频参考（顺序即 音频1、音频2…）。 */
  audios: string[]
  duration: number
  /** 调用方显式指定的兼容命令/模式（可选）。 */
  video_command?: string
  firstLastHint?: boolean
  explicitRatio: boolean
}

/** 单任务结果。 */
export interface CanvasVideoTaskResult {
  taskId: string
  status: 'success' | 'submitted' | 'failed' | 'needs_review'
  mode?: CanvasVideoMode
  nodeId?: string
  submitId?: string
  resourceId?: string
  path?: string
  /** 落地字节数（官方交付校验：零字节不算有效交付）。 */
  bytes?: number
  /** CLI 返回的 SHA256，供校验与交付记录。 */
  sha256?: string
  /** 服务端实际扣费（若回执带 creditsAmount）。 */
  credits?: number
  error?: string
  /** 受理但未到终态：保留身份，稍后可继续查询。 */
  advice?: string
  /** 报价后停下、从未提交（服务端没有这份 submission，不得轮询、不得换 ID 重跑）。 */
  paused?: boolean
}

export interface CanvasVideoBatchOptions {
  cli: CanvasCli
  projectId: string
  model: string
  resolution: string
  ratio: string
  /** 轮询总预算（ms）。 */
  pollTimeoutMs: number
  /** 轮询间隔（ms），≥1s。 */
  pollIntervalMs?: number
  /**
   * 用户已确认的积分上限（每任务）。不传时用服务端报价本身作为上限 ——
   * 这仍然不是"无限授权"：报价超过用户预期就只能靠调用方显式给更小的值拦下。
   */
  creditCeiling?: number
  /** 审计日志钩子。 */
  log?: (event: string, payload: Record<string, unknown>) => Promise<void> | void
  /** 只提交不轮询（`production_submit_only`）。 */
  submitOnly?: boolean
  /** 同时在跑的提交数（`videoCapacity`）；超出的任务排队而不是失败。 */
  concurrency?: number
  /** 交付根目录：产物最终会被移动到这里（保持可点击可分享）。 */
  deliverDir?: string
  signal?: AbortSignal
}

/**
 * 有界并发的 map（不引入依赖）：超出的任务排队，而不是一次性打满服务端。
 * 返回与 `Promise.allSettled` 同形的结果数组（保序）。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let cursor = 0
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(workers)
  return results
}

/** 素材类型 → `resource upload --type`。 */
function mediaTypeOf(kind: 'image' | 'video' | 'audio'): string {
  return kind
}

/** 上传一个本地素材，返回 resourceId。 */
export async function uploadCanvasResource(
  cli: CanvasCli,
  projectId: string,
  kind: 'image' | 'video' | 'audio',
  filePath: string,
): Promise<{ resourceId: string; mediaType?: string }> {
  const args = ['resource', 'upload', '--project-id', projectId, '--file', filePath, '--type', mediaTypeOf(kind), '--name', basename(filePath)]
  const result = await cli.runOrThrow(args, { timeoutMs: 300_000, label: `resource upload ${kind}` })
  const resourceId = String(result.envelope?.data?.resourceId ?? '')
  if (resourceId.length === 0) {
    throw new Error(`dreamina-canvas resource upload 未返回 resourceId: ${result.raw.slice(0, 300)}`)
  }
  return { resourceId, mediaType: result.envelope?.data?.mediaType }
}

/** 上传任务的全部参考素材，保持 图片 → 视频 → 音频 的顺序。 */
export async function uploadTaskRefs(
  cli: CanvasCli,
  projectId: string,
  task: Pick<CanvasVideoTask, 'images' | 'videos' | 'audios'>,
): Promise<CanvasNodeRef[]> {
  const refs: CanvasNodeRef[] = []
  for (const p of task.images) refs.push({ kind: 'res', id: (await uploadCanvasResource(cli, projectId, 'image', p)).resourceId })
  for (const p of task.videos) refs.push({ kind: 'res', id: (await uploadCanvasResource(cli, projectId, 'video', p)).resourceId })
  for (const p of task.audios) refs.push({ kind: 'res', id: (await uploadCanvasResource(cli, projectId, 'audio', p)).resourceId })
  return refs
}

/**
 * 提交一个任务：保存 → 报价 → 批准 → 运行。任一步失败都抛错，由调用方标记
 * `failed`（绝不自动重试）。
 */
export async function submitCanvasVideoTask(
  options: CanvasVideoBatchOptions,
  task: CanvasVideoTask,
  refs: CanvasNodeRef[],
  submitId: string,
): Promise<{ nodeId: string; submitId: string; resourceIds: string[]; quotedCredits?: number; mode: CanvasVideoMode; paused?: boolean; pausedReason?: string }> {
  const { cli } = options
  const mode = selectCanvasVideoMode({
    images: task.images.length,
    videos: task.videos.length,
    audios: task.audios.length,
    video_command: task.video_command,
    firstLastHint: task.firstLastHint,
    explicitRatio: task.explicitRatio,
  })

  // 1) 保存节点（不生成）
  const created = await cli.runOrThrow(
    buildVideoNodeArgs({
      projectId: options.projectId,
      title: task.title,
      mode,
      prompt: task.prompt,
      model: options.model,
      ratio: options.ratio,
      resolution: options.resolution,
      durationSeconds: task.duration,
      count: 1,
      refs,
      submitId,
      run: false,
    }),
    { timeoutMs: 240_000, label: 'node create video' },
  )
  const handle = parseCanvasNodeHandle(created.envelope)
  if (!handle) throw new Error(`dreamina-canvas node create video 未返回 nodeId: ${created.raw.slice(0, 300)}`)

  // 2) 报价（报价 ≠ 授权）
  const quoted = await cli.runOrThrow(
    ['node', 'quote', '--project-id', options.projectId, '--node-id', handle.nodeId],
    { timeoutMs: 90_000, label: 'node quote' },
  )
  const quote = parseCanvasQuote(quoted.envelope)
  const quoteRequestId = canvasRequestId(quoted.envelope)

  // 3) 批准：用户 ceiling 优先，否则用服务端报价封顶。
  //    报价不可信时**绝不按 0 批准**：官方明确 `minimumCreditCeiling` 缺席等于
  //    occupancy_unknown（「不等于 0」），按 0 去批准必然再次被拒，还会掩盖"算不准"。
  let ceiling = options.creditCeiling
  if (ceiling === undefined) {
    if (!quote.confirmable || !(quote.totalMaxCredits > 0)) {
      throw new Error(
        `服务端暂时给不出可用报价（totalMaxCredits=${quote.totalMaxCredits}, confirmable=${quote.confirmable}）：` +
          '不能按 0 积分批准。请稍后重试，或显式传 video_credit_ceiling 给出你愿意接受的上限。',
      )
    }
    ceiling = quote.totalMaxCredits
  }
  const confirmed = await cli.runOrThrow(
    ['node', 'confirm', '--project-id', options.projectId, '--node-id', handle.nodeId, '--credit-ceiling', String(ceiling)],
    { timeoutMs: 90_000, label: 'node confirm' },
  )
  const token = parseCanvasCreditToken(confirmed.envelope).token
  if (!token) throw new Error(`dreamina-canvas node confirm 未返回 creditConfirmationToken: ${confirmed.raw.slice(0, 300)}`)

  // 4) 运行（同一 submitId 是重试身份，绝不换新）
  //
  // 官方 recovery 协议：媒体在报价后停下（退出码 10）时，节点已保存、**没有扣费**，
  // 必须复用 `partialData` 里的 nodeId + submitId 续跑；换新 submitId 会被当成第二次
  // 运行、再扣一次钱。所以这里不把 10 当失败抛出，而是把已冻结的身份交给上层。
  const ran = await cli.run(
    [
      'node', 'run',
      '--project-id', options.projectId,
      '--node-id', handle.nodeId,
      '--submit-id', submitId,
      '--credit-token', token,
    ],
    { timeoutMs: 240_000 },
  )
  const runRequestId = canvasRequestId(ran.envelope)
  if (ran.classification.outcome !== 'ok') {
    const partial = parseCanvasPartialItems(ran.envelope)[0]
    const confirmation = parseCanvasCreditConfirmation(ran.envelope)
    const identity = { nodeId: partial?.nodeId ?? handle.nodeId, submitId: partial?.submitId ?? submitId }
    if (ran.classification.outcome === 'credits_required' || ran.classification.outcome === 'pending') {
      await options.log?.('canvas-paused-before-submit', {
        taskId: task.taskId,
        ...identity,
        ceiling,
        reason: confirmation.reason,
        occupancyUnknown: confirmation.occupancyUnknown,
        requestId: runRequestId,
      })
      return {
        nodeId: identity.nodeId,
        submitId: identity.submitId,
        resourceIds: [],
        quotedCredits: quote.totalMaxCredits,
        mode,
        paused: true,
        pausedReason: confirmation.occupancyUnknown
          ? '服务端算不准本次积分占用（occupancy_unknown）：节点已保存且未扣费，需要用户给出上限后再续跑'
          : `服务端要求批准（${confirmation.reason ?? ran.classification.requiredAction ?? 'confirm'}）：节点已保存且未扣费，复用原 submitId 续跑即可，切勿换新 ID`,
      }
    }
    throw new Error(`dreamina-canvas node run failed [${ran.classification.outcome}]: ${ran.classification.message}`)
  }
  const acceptance = parseCanvasRunAcceptance(ran.envelope)
  const accepted = acceptance.find((a) => a.nodeId === handle.nodeId) ?? acceptance[0]
  if (!accepted) throw new Error(`dreamina-canvas node run 未返回受理回执: ${ran.raw.slice(0, 300)}`)

  await options.log?.('canvas-submitted', {
    taskId: task.taskId,
    nodeId: handle.nodeId,
    submitId: accepted.submitId,
    mode,
    quotedCredits: quote.totalMaxCredits,
    ceiling,
    quoteRequestId,
    runRequestId,
  })

  return {
    nodeId: handle.nodeId,
    submitId: accepted.submitId,
    resourceIds: accepted.resourceIds,
    quotedCredits: quote.totalMaxCredits,
    mode,
  }
}

/**
 * 等一个提交进入终态。`operation wait` 超时（退出码 20）**不是失败**：
 * 服务端任务仍在继续，所以返回 `pending` 让调用方保留身份、稍后续查。
 */
export async function waitCanvasOperation(
  options: CanvasVideoBatchOptions,
  submitId: string,
): Promise<{ state: 'succeeded' | 'failed' | 'canceled' | 'pending' | 'unknown'; resourceIds: string[]; advice?: string; failedReason?: string }> {
  const seconds = Math.max(30, Math.round(options.pollTimeoutMs / 1000))
  const interval = Math.max(2, Math.round((options.pollIntervalMs ?? 5000) / 1000))
  const result = await options.cli.run(
    ['operation', 'wait', submitId, '--project-id', options.projectId, '--timeout', `${seconds}s`, '--interval', `${interval}s`],
    { timeoutMs: options.pollTimeoutMs + 60_000 },
  )
  const operation = parseCanvasOperation(result.envelope)
  const classification = result.classification
  if (classification.outcome === 'pending') {
    return { state: 'pending', resourceIds: operation?.resources.map((r) => r.resourceId).filter(Boolean) ?? [], advice: operation?.advice }
  }
  if (classification.outcome !== 'ok') {
    // 服务端拒绝/需人工：保留身份，交由上层记为 needs_review，不自动重提。
    return { state: 'unknown', resourceIds: operation?.resources.map((r) => r.resourceId).filter(Boolean) ?? [], failedReason: classification.message }
  }
  if (!operation) return { state: 'unknown', resourceIds: [], failedReason: `operation wait 返回无法解析: ${result.raw.slice(0, 200)}` }
  const resourceIds = operation.resources.map((r) => r.resourceId).filter((id) => id.length > 0)
  if (operation.state === 'succeeded') return { state: 'succeeded', resourceIds, advice: operation.advice }
  if (operation.state === 'failed' || operation.state === 'canceled') {
    return { state: operation.state, resourceIds, failedReason: operation.advice ?? operation.state }
  }
  return { state: 'pending', resourceIds, advice: operation.advice }
}

/** 一次下载的可验证事实。 */
export interface CanvasDownloadOutcome {
  path?: string
  size?: number
  sha256?: string
  /** 致命失败原因（命令失败，或文件体积异常）。 */
  error?: string
}

/**
 * 下载一份产物到指定目录。
 *
 * 官方交付校验要求：检查 CLI 返回的字节数（零字节/异常文件不算有效交付）、记录
 * SHA256、必要时验真实内容而不是只看扩展名。这里把 `size > 0` 作为硬门槛并把
 * SHA256 带出来；媒体类型/容器校验由调用方按期望类型追加。
 */
export async function downloadCanvasResource(
  cli: CanvasCli,
  projectId: string,
  resourceId: string,
  outputDir: string,
): Promise<CanvasDownloadOutcome> {
  const result = await cli.run(
    ['resource', 'download', resourceId, '--project-id', projectId, '--output', outputDir],
    { timeoutMs: 600_000 },
  )
  if (result.classification.outcome !== 'ok') {
    return { error: `resource download failed [${result.classification.outcome}]: ${result.classification.message}` }
  }
  const parsed = parseCanvasDownload(result.envelope)
  if (!parsed) return { error: `resource download 未返回落地路径: ${result.raw.slice(0, 200)}` }
  if (!(parsed.size > 0)) return { error: `产物体积异常（size=${parsed.size}），不作为有效交付` }
  return { path: parsed.path, size: parsed.size, sha256: parsed.sha256 }
}

/** 产物校验：可读、非空、真实容器头（复用视频管线的判定）。 */
export async function isUsableVideoFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (info.size <= 0) return false
    const { open } = await import('node:fs/promises')
    const handle = await open(path, 'r')
    try {
      const buf = Buffer.alloc(16)
      await handle.read(buf, 0, 16, 0)
      if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'AVI ') return true
      if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true
      return false
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

/** 从任务自己的隔离目录里挑出刚下载的、通过校验的视频。 */
export async function pickDownloadedFromDir(dir: string): Promise<string | undefined> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
  const candidates: Array<{ path: string; mtimeMs: number }> = []
  for (const name of names) {
    if (!isVideoExtName(name)) continue
    const full = join(dir, name)
    if (!(await isUsableVideoFile(full))) continue
    candidates.push({ path: full, mtimeMs: (await stat(full)).mtimeMs })
  }
  if (candidates.length === 0) return undefined
  return candidates.reduce((best, c) => (c.mtimeMs > best.mtimeMs ? c : best)).path
}

/**
 * 跑完整批次：并发提交（每个任务独立身份），production 下再等终态并下载。
 *
 * 并发提交不等于并发付费失控：涨价、上限、身份都由上面 `submitCanvasVideoTask`
 * 逐任务走完报价→批准，因此这里只控制「同时在跑的 CLI 调用数」。
 */
export async function runCanvasVideoBatch(
  options: CanvasVideoBatchOptions,
  tasks: CanvasVideoTask[],
  taskDirs: string[],
  /** 每个任务的提交身份（调用方生成并持久化，重试必须复用）。 */
  submitIds: string[],
): Promise<CanvasVideoTaskResult[]> {
  if (tasks.length !== taskDirs.length || tasks.length !== submitIds.length) {
    throw new Error('tasks / taskDirs / submitIds 长度必须一致')
  }

  // 上传 + 提交（有界并发；每个任务一条独立身份链）
  const submitted = await mapWithConcurrency(tasks, options.concurrency ?? tasks.length, async (task, index) => {
    const refs = await uploadTaskRefs(options.cli, options.projectId, task)
    return submitCanvasVideoTask(options, task, refs, submitIds[index])
  })

  const results: CanvasVideoTaskResult[] = tasks.map((task, index) => {
    const outcome = submitted[index]
    if (outcome.status === 'rejected') {
      return { taskId: task.taskId, status: 'failed', error: String((outcome.reason as any)?.message ?? outcome.reason).slice(0, 400) }
    }
    const accepted = outcome.value
    // 报价后停下（退出码 10 / occupancy_unknown）：节点已保存且**未扣费**，身份已冻结。
    // 必须记 needs_review 并保留同一 submitId —— 换新 ID 重跑等于第二次运行、再扣一次钱。
    if (accepted.paused) {
      return {
        taskId: task.taskId,
        status: 'needs_review',
        mode: accepted.mode,
        nodeId: accepted.nodeId,
        submitId: accepted.submitId,
        credits: accepted.quotedCredits,
        advice: accepted.pausedReason,
        paused: true,
      }
    }
    return {
      taskId: task.taskId,
      status: options.submitOnly ? 'submitted' : 'needs_review',
      mode: accepted.mode,
      nodeId: accepted.nodeId,
      submitId: accepted.submitId,
      credits: accepted.quotedCredits,
    }
  })

  if (options.submitOnly) return results

  // 等终态（有界并发），再按各自的 download 目录取片
  await mapWithConcurrency(results, options.concurrency ?? results.length, async (result, index) => {
    if (result.status === 'failed' || result.paused || !result.submitId) return
    if (options.signal?.aborted) return
      const waited = await waitCanvasOperation(options, result.submitId)
      if (waited.state === 'failed' || waited.state === 'canceled') {
        result.status = 'failed'
        result.error = waited.failedReason ?? waited.state
        return
      }
      if (waited.state !== 'succeeded') {
        result.status = 'needs_review'
        result.advice = waited.advice ?? 'operation did not reach a terminal state within the local wait budget'
        return
      }
      const resourceId = result.resourceId ?? waited.resourceIds[0]
      if (!resourceId) {
        result.status = 'needs_review'
        result.advice = 'operation succeeded but no resourceId was returned'
        return
      }
      result.resourceId = resourceId
      const dir = taskDirs[index]
      const downloaded = await downloadCanvasResource(options.cli, options.projectId, resourceId, dir)
      if (downloaded.error || !downloaded.path) {
        result.status = 'needs_review'
        result.advice = `${downloaded.error ?? 'resource download failed'}；operation 已成功，可用同一 resourceId 重新下载（不要重跑生成）`
        return
      }
      // 内容校验：必须是真实可用的视频容器（官方交付校验：不能只看扩展名或接口成功）
      if (!(await isUsableVideoFile(downloaded.path))) {
        result.status = 'needs_review'
        result.advice = `下载产物不是可用的视频容器：${downloaded.path}`
        return
      }
      result.path = downloaded.path
      result.bytes = downloaded.size
      result.sha256 = downloaded.sha256
      result.status = 'success'
  })

  return results
}

/** 把产物移动到交付目录（保持文件名里的身份，便于对回 submitId）。 */
export function deliverPathFor(deliverRoot: string, taskId: string, sourcePath: string): string {
  return join(deliverRoot, `${taskId.slice(0, 8)}-${basename(sourcePath)}`)
}

/** 视频模式的中文说明，用于结果回执与日志（不参与判断）。 */
export function describeCanvasVideoMode(mode: CanvasVideoMode): string {
  switch (mode) {
    case 't2v':
      return '文生视频'
    case 'first_last_frame':
      return '首帧/首尾帧'
    default:
      return '多模态参考'
  }
}
