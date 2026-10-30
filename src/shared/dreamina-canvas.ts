/**
 * 即梦画布 CLI（dreamina-canvas）适配层 —— 纯领域部分。
 *
 * 旧 `dreamina` CLI 与画布 CLI 是两套产品模型：旧的是「会话 + 一次性命令」，
 * 新的是「画布(project) + 节点(node) + 报价确认 + 可恢复操作(operation)」。
 * 本模块只负责把两边的语义翻译成命令与结构化判断，**不做任何 DSH/供应商接线**，
 * 因此可以被 `node --test` 直接覆盖；执行封装见 `createCanvasCli`。
 *
 * 契约事实（2026-10 实测 1.2.0 / cee4f27a，公开 cn 制品）：
 * - 所有命令支持全局 `--format json --non-interactive [--profile NAME] [--region cn]`；
 * - 输出统一 envelope：`{schemaVersion, ok, data|error, meta}`；
 * - 退出码：0 成功 / 2 参数 / 10 待积分确认 / 11 需登录 / 12,13 权限·权益·版本 /
 *   20 等待未完成 / 21,22 服务失败·需人工 / 1 其他；
 * - 失败 envelope **可能落在 stderr**（实测 `auth account` 未登录时如此），
 *   所以解析必须同时看两条流，不能只看 stdout；
 * - 生成必须显式给 `--mode`；节点保存 ≠ 生成，`--run` 才进入
 *   保存 → 报价 → 批准 → 运行；
 * - 付费安全：`node quote` 报价、`node confirm --credit-ceiling` 取短期凭证、
 *   `node run --credit-token` 提交；`--credit-ceiling` 与 `--credit-token` 互斥；
 * - 视频公开模式只有 `t2v` / `first_last_frame` / `m2v`，**没有 i2v**：
 *   单图生视频用 `first_last_frame`（首帧锁比例），单图但要保留调用方指定
 *   比例、或图片/视频/音频混合引导时用 `m2v`（官方 identity-and-references 授权）；
 * - 引用写法 `--ref node:<nodeId>`（跟随最新产物）或 `--ref res:<uuid>`（冻结素材）；
 * - 产物取回 `resource download <resourceId> --output <dir>`（实测视频同样可下）。
 *
 * @module dsh-media-plugins/shared/dreamina-canvas
 */

import { createHash } from 'node:crypto'
import type { RegRunner } from './dreamina-keychain.ts'

/* ------------------------------------------------------------------ */
/* 常量：制品与本地身份                                                  */
/* ------------------------------------------------------------------ */

/** 画布 CLI 的 keychain 子键前缀（实测 `dreamina_canvas_oauth_v2_<64hex>`）。 */
export const CANVAS_KEYCHAIN_PREFIX = 'dreamina_canvas'

/** 注册表值名（base64 编码后的 `byted_cli_user_token`，与旧 CLI 同名不同键）。 */
export const CANVAS_VALUE_NAME = Buffer.from('byted_cli_user_token', 'utf8').toString('base64')

/** 旧 CLI 的 keychain 子键（保留：只读探测与余额查询还会用到）。 */
export const LEGACY_KEYCHAIN_SUBKEY = 'dreamina'

/** 公开视频模式（`multi_modal` 等内部写法不是合法的 `--mode`）。 */
export const CANVAS_VIDEO_MODES = ['t2v', 'first_last_frame', 'm2v'] as const
export type CanvasVideoMode = (typeof CANVAS_VIDEO_MODES)[number]

/** 图片模式。 */
export const CANVAS_IMAGE_MODES = ['t2i', 'i2i'] as const
export type CanvasImageMode = (typeof CANVAS_IMAGE_MODES)[number]

/** 可恢复操作的状态。 */
export const CANVAS_OPERATION_STATES = ['running', 'succeeded', 'failed', 'canceled', 'unknown'] as const
export type CanvasOperationState = (typeof CANVAS_OPERATION_STATES)[number]

/**
 * 画布 CLI 的官方安装 / 升级入口（固化，免去每次临时检索）。
 *
 * 升级判定：先用 `dreamina-canvas version` 读本地版本，再拉 `versionJson` 比对
 * `version` 字段；两者不一致就重跑对应的安装脚本，安装脚本会自带最新制品基址，
 * 无需手填打包号。安装脚本同时会刷新 `~/.agents/skills/dreamina-canvas-cli`，
 * 装完必须重新登录一次（`auth login`）。
 */
export const CANVAS_CLI_SOURCE = {
  /** 当前解析到的制品基址（来自 install.ps1 的 `$DefaultDownloadBase`；打包号会随发版变化）。 */
  artifactBase: 'https://jimeng.jianying.com/canvas-cli/install/1_0_0_53',
  /** 制品元数据（含 version / releaseDate / releaseNotes）。 */
  versionJson: 'https://jimeng.jianying.com/canvas-cli/install/1_0_0_53/version.json',
  /** Windows PowerShell：`irm <installPs1> | iex`。 */
  installPs1: 'https://jimeng.jianying.com/canvas-cli/install.ps1',
  /** macOS / Linux：`curl -fsSL <installSh> | bash`。 */
  installSh: 'https://jimeng.jianying.com/canvas-cli/install.sh',
  /** Windows CMD：`curl.exe -fsSLO <installBat> && install.bat`。 */
  installBat: 'https://jimeng.jianying.com/canvas-cli/install.bat',
} as const

/* ------------------------------------------------------------------ */
/* Envelope 解析与退出码分类                                             */
/* ------------------------------------------------------------------ */

export interface CanvasErrorBody {
  code?: string
  serviceCode?: number
  class?: string
  message?: string
  retryable?: boolean
  requiredAction?: string
  reason?: string
  requestId?: string
  traceId?: string
  /** 结构化校验信息（fieldPath / reasonCode），只用于人工排查。 */
  validation?: Record<string, unknown>
  /**
   * 本地业务记录（journal）失败时的分类事实。`submissionPhase: 'after_submit'`
   * 意味着副作用可能已经发生 —— 官方要求改用只读查询，**不得**重新创建或提交。
   */
  localStorage?: { reason?: string; stage?: string; directory?: string; submissionPhase?: string }
}

export interface CanvasEnvelope<T = any> {
  schemaVersion?: string
  ok: boolean
  data?: T
  error?: CanvasErrorBody
  meta?: Record<string, unknown>
  /** 失败但已产生副作用时的部分事实（官方 recovery 协议：必须复用这些身份续跑）。 */
  partialData?: { items?: Array<Record<string, unknown>> }
  /** 报价之后停下时的金额事实；`minimumCreditCeiling` 缺席表示服务端算不准占用。 */
  creditConfirmation?: { reason?: string; minimumCreditCeiling?: number }
}

/**
 * 从任意 CLI 输出里取出 JSON envelope。同时接受纯 JSON、前置日志行、
 * 以及 `{...}` 之前的噪声（CLI 有时把人类提示写到同一流）。
 */
export function parseCanvasEnvelope(raw: string): CanvasEnvelope | undefined {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return undefined
  const attempts = [text]
  const start = text.indexOf('{')
  if (start > 0) attempts.push(text.slice(start))
  // 多行输出里逐行找最后一个像 envelope 的对象
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (line.startsWith('{') && line.endsWith('}')) attempts.push(line)
  }
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && typeof (parsed as any).ok === 'boolean') {
        return parsed as CanvasEnvelope
      }
    } catch {
      /* try the next shape */
    }
  }
  return undefined
}

/** envelope 顶层的关联 ID（官方硬边界：存在时必须保留，用于排障与支持）。 */
export function canvasRequestId(envelope?: CanvasEnvelope): string | undefined {
  const id = envelope?.meta?.requestId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * 失败 envelope 里的 `partialData.items[]`。
 *
 * 关键场景：媒体 `--run` 在报价之后停下（退出码 10）时，节点已保存、**没有扣费**，
 * 此时必须复用同一 `nodeId` + `submitId` 续跑 —— 换新 submitId 会被当成第二次运行
 * 再扣一次钱。
 */
export function parseCanvasPartialItems(envelope?: CanvasEnvelope): Array<{ nodeId?: string; submitId?: string; sourceNodeId?: string }> {
  const items = envelope?.partialData?.items
  if (!Array.isArray(items)) return []
  return items
    .filter((item: any) => item && typeof item === 'object')
    .map((item: any) => ({
      nodeId: typeof item.nodeId === 'string' ? item.nodeId : undefined,
      submitId: typeof item.submitId === 'string' ? item.submitId : undefined,
      sourceNodeId: typeof item.sourceNodeId === 'string' ? item.sourceNodeId : undefined,
    }))
}

/**
 * `creditConfirmation`：报价后停下时的金额事实。
 *
 * `minimumCreditCeiling` 缺席表示服务端算不准占用（`occupancy_unknown`），官方明确
 * 「它**不等于 0**」—— 按 0 去批准必然再次被拒，此时必须交回用户。
 */
export function parseCanvasCreditConfirmation(envelope?: CanvasEnvelope): {
  reason?: string
  minimumCreditCeiling?: number
  occupancyUnknown: boolean
} {
  const node = envelope?.creditConfirmation
  const minimum = node?.minimumCreditCeiling
  const hasMinimum = typeof minimum === 'number' && Number.isFinite(minimum)
  return {
    reason: typeof node?.reason === 'string' ? node.reason : undefined,
    minimumCreditCeiling: hasMinimum ? minimum : undefined,
    occupancyUnknown: !hasMinimum,
  }
}

/** 画布 CLI 的结果分类（只依赖退出码与结构化字段，绝不解析本地化 message）。 */
export type CanvasOutcome =
  | 'ok'
  | 'credits_required'
  | 'auth_required'
  | 'permission_denied'
  | 'pending'
  | 'service_retryable'
  | 'manual_intervention'
  | 'input_error'
  | 'unknown'

export interface CanvasClassification {
  outcome: CanvasOutcome
  /** 结构化错误里的 requiredAction（若有）。 */
  requiredAction?: string
  retryable: boolean
  message: string
  requestId?: string
}

/** 退出码 → 官方语义（文案只用于日志，判断一律走结构化字段）。 */
export const CANVAS_EXIT_MEANINGS: Readonly<Record<number, string>> = {
  0: '成功',
  1: '其他错误',
  2: '命令或参数不正确',
  10: '需要积分确认',
  11: '需要登录或登录已失效',
  12: '权限或权益限制',
  13: '版本兼容限制',
  20: '本次等待未完成，任务可继续查询',
  21: '服务暂时失败',
  22: '需要人工处理',
}

/** 分类：退出码为主，结构化 error 为辅（两者冲突时以更严格的一侧为准）。 */
export function classifyCanvasResult(exitCode: number, envelope?: CanvasEnvelope): CanvasClassification {
  const error = envelope?.error
  const requiredAction = typeof error?.requiredAction === 'string' ? error.requiredAction : undefined
  const message = String(error?.message ?? CANVAS_EXIT_MEANINGS[exitCode] ?? `dreamina-canvas exited with ${exitCode}`)
  const retryable = error?.retryable === true
  const requestId = typeof error?.requestId === 'string' ? error.requestId : undefined

  // 本地业务记录失败（`error.localStorage`）：`after_submit` 说明副作用可能已发生。
  // 官方要求此时改用只读查询、**不得**重新创建或提交，因此归为 pending（保留身份），
  // 绝不能当成失败让上层重跑 —— 那会二次扣费。
  if (exitCode !== 0 && error?.localStorage?.submissionPhase === 'after_submit') {
    return { outcome: 'pending', requiredAction: requiredAction ?? 'resume', retryable: false, message, requestId }
  }

  if (exitCode === 0 && envelope?.ok !== false) {
    return { outcome: 'ok', requiredAction, retryable: false, message }
  }

  // 退出码 20 的语义只有一个：本地等待结束、服务端任务仍在继续。即使错误体带
  // `requiredAction: resume` / `retryable: true`，它也不是失败，更不该被归成
  // 「可重试的服务错误」——那会诱导上层重新提交并二次扣费。
  if (exitCode === 20) {
    return { outcome: 'pending', requiredAction, retryable, message, requestId }
  }

  const byAction = (): CanvasOutcome | undefined => {
    switch (requiredAction) {
      case 'login':
        return 'auth_required'
      case 'confirm':
      case 'approve':
        return 'credits_required'
      case 'resume':
      case 'retry':
        return retryable ? 'service_retryable' : 'pending'
      case 'manual_action':
      case 'contact_support':
        return 'manual_intervention'
      default:
        return undefined
    }
  }

  const byCode = (): CanvasOutcome => {
    switch (exitCode) {
      case 10:
        return 'credits_required'
      case 11:
        return 'auth_required'
      case 12:
      case 13:
        return 'permission_denied'
      case 20:
        return 'pending'
      case 21:
        return 'service_retryable'
      case 22:
        return 'manual_intervention'
      case 2:
        return 'input_error'
      default:
        break
    }
    const code = String(error?.code ?? '')
    if (/auth|login/i.test(code)) return 'auth_required'
    if (/permission|forbidden|denied/i.test(code)) return 'permission_denied'
    if (/credit/i.test(code)) return 'credits_required'
    return 'unknown'
  }

  const outcome = byAction() ?? byCode()
  return { outcome, requiredAction, retryable, message, requestId }
}

/** 该分类能否在「复用同一身份」的前提下安全重试（绝不换新 submit-id）。 */
export function isRetryableOutcome(outcome: CanvasOutcome): boolean {
  return outcome === 'service_retryable'
}

/** 需要人工/用户介入，必须停下（不能自动重试或另起一次生成）。 */
export function requiresUserStop(outcome: CanvasOutcome): boolean {
  return outcome === 'credits_required' || outcome === 'auth_required' || outcome === 'permission_denied' || outcome === 'manual_intervention'
}

/* ------------------------------------------------------------------ */
/* 视频/图片模式选择                                                     */
/* ------------------------------------------------------------------ */

export interface ModeSelectionInput {
  images: number
  videos: number
  audios: number
  /** 调用方显式传入的兼容命令（旧契约名或新公开名均可）。 */
  video_command?: string
  /** prompt 是否带首尾帧语义。 */
  firstLastHint?: boolean
  /**
   * 调用方是否**显式**指定了输出比例。单图场景下这一位决定走
   * `first_last_frame`（比例由首帧决定）还是 `m2v`（保留调用方比例）。
   */
  explicitRatio?: boolean
}

/** 旧 CLI 命令名 → 新公开模式的兼容映射。 */
export const LEGACY_VIDEO_COMMAND_MODES: Readonly<Record<string, CanvasVideoMode>> = {
  text2video: 't2v',
  image2video: 'm2v',
  frames2video: 'first_last_frame',
  multimodal2video: 'm2v',
  t2v: 't2v',
  first_last_frame: 'first_last_frame',
  m2v: 'm2v',
}

/**
 * 按官方 `identity-and-references.md` 的规则选择公开视频模式：
 *
 * | 解析后的素材 | mode |
 * | --- | --- |
 * | 无媒体素材 | `t2v` |
 * | 一张图片作锁比例首帧 | `first_last_frame` |
 * | 两张有序图片 | `first_last_frame` |
 * | 单图但需保留调用方比例 / 混合多模态 | `m2v` |
 *
 * `image-to-video` 不是公开 CLI 模式，禁止产出。
 */
export function selectCanvasVideoMode(input: ModeSelectionInput): CanvasVideoMode {
  const explicit = String(input.video_command ?? '').trim()
  if (explicit.length > 0) {
    if (explicit === 'multiframe2video') {
      throw new Error('multiframe2video is a disabled legacy command; use multimodal2video')
    }
    const mapped = LEGACY_VIDEO_COMMAND_MODES[explicit]
    if (!mapped) throw new Error(`Unsupported video command: ${explicit}`)
    // 显式覆盖仍受素材约束：无媒体时不允许带引用的帧模式。
    if (mapped === 'first_last_frame' && input.images === 0) {
      throw new Error('first_last_frame 需要一张首帧图（或首帧+尾帧两张）')
    }
    return mapped
  }
  if (input.videos > 0 || input.audios > 0) return 'm2v'
  if (input.images === 0) return 't2v'
  if (input.images === 2) return 'first_last_frame'
  if (input.images === 1) {
    if (input.firstLastHint) return 'first_last_frame'
    return input.explicitRatio ? 'm2v' : 'first_last_frame'
  }
  // 3 张以上图片属于多模态参考
  return 'm2v'
}

/** 图片模式：有图片素材必须 i2i，纯文本 t2i。 */
export function selectCanvasImageMode(images: number): CanvasImageMode {
  return images > 0 ? 'i2i' : 't2i'
}

/* ------------------------------------------------------------------ */
/* 命令构造                                                             */
/* ------------------------------------------------------------------ */

/** 一次 CLI 调用的输出/错误包装（`raw` 同时包含 stdout 与 stderr）。 */
export interface CanvasRunResult {
  exitCode: number
  stdout: string
  stderr: string
  /** stderr + stdout 合并（失败 envelope 可能落在 stderr）。 */
  raw: string
  envelope?: CanvasEnvelope
  classification: CanvasClassification
}

export interface CanvasNodeRef {
  kind: 'node' | 'res'
  id: string
}

/** 规范 Resource ID：只认小写规范 UUID（大写/urn/去连字符都会被 CLI 拒绝）。 */
export const CANONICAL_RESOURCE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function assertCanonicalResourceId(id: string): string {
  const value = String(id ?? '').trim()
  if (!CANONICAL_RESOURCE_UUID_RE.test(value)) {
    throw new Error(`Resource ID 必须是小写规范 UUID：${value}`)
  }
  return value
}

/** `--ref node:node_xxx` / `--ref res:<uuid>`。 */
export function formatCanvasRef(ref: CanvasNodeRef): string {
  if (ref.kind === 'node') {
    const id = String(ref.id ?? '').trim()
    if (!id.startsWith('node_')) throw new Error(`Node ID 必须以 node_ 开头：${id}`)
    return `node:${id}`
  }
  return `res:${assertCanonicalResourceId(ref.id)}`
}

/** 全局 flag（放在子命令之前，与实测一致）。 */
export function canvasGlobalArgs(options: { profile?: string; region?: string } = {}): string[] {
  const args = ['--format', 'json', '--non-interactive']
  const profile = String(options.profile ?? '').trim()
  if (profile.length > 0) args.push('--profile', profile)
  const region = String(options.region ?? '').trim()
  if (region.length > 0) args.push('--region', region)
  return args
}

export interface VideoNodeSpec {
  projectId: string
  title: string
  mode: CanvasVideoMode
  prompt: string
  model: string
  ratio: string
  resolution: string
  durationSeconds: number
  /** 单节点产物数：官方要求多产物分节点，因此恒为 1。 */
  count?: number
  refs?: CanvasNodeRef[]
  /** 只保存（不生成）时为 false。 */
  run?: boolean
  submitId?: string
  creditCeiling?: number
  creditToken?: string
  wait?: boolean
  timeout?: string
  interval?: string
  dryRun?: boolean
}

/** `node create video` 参数（保存与运行共用同一条命令，`--run` 决定是否进入付费链）。 */
export function buildVideoNodeArgs(spec: VideoNodeSpec): string[] {
  const args = ['node', 'create', 'video', '--project-id', spec.projectId, '--title', spec.title]
  if (spec.dryRun) args.push('--dry-run')
  args.push('--mode', spec.mode)
  args.push('--prompt', spec.prompt)
  if (spec.model) args.push('--model', spec.model)
  if (spec.ratio) args.push('--ratio', spec.ratio)
  if (spec.resolution) args.push('--resolution', spec.resolution)
  if (Number.isFinite(spec.durationSeconds)) args.push('--duration', String(spec.durationSeconds))
  args.push('--count', String(spec.count ?? 1))
  for (const ref of spec.refs ?? []) args.push('--ref', formatCanvasRef(ref))
  if (spec.submitId) args.push('--submit-id', spec.submitId)
  if (spec.creditToken) args.push('--credit-token', spec.creditToken)
  else if (spec.creditCeiling !== undefined) args.push('--credit-ceiling', String(spec.creditCeiling))
  if (spec.run) {
    args.push('--run')
    if (spec.wait) {
      args.push('--wait')
      if (spec.timeout) args.push('--timeout', spec.timeout)
      if (spec.interval) args.push('--interval', spec.interval)
    }
  }
  return args
}

export interface ImageNodeSpec {
  projectId: string
  title: string
  mode: CanvasImageMode
  prompt: string
  model?: string
  ratio?: string
  resolution?: string
  count?: number
  refs?: CanvasNodeRef[]
  run?: boolean
  submitId?: string
  creditCeiling?: number
  creditToken?: string
  wait?: boolean
  timeout?: string
  interval?: string
  dryRun?: boolean
}

/** `node create image` 参数。 */
export function buildImageNodeArgs(spec: ImageNodeSpec): string[] {
  const args = ['node', 'create', 'image', '--project-id', spec.projectId, '--title', spec.title]
  if (spec.dryRun) args.push('--dry-run')
  args.push('--mode', spec.mode)
  args.push('--prompt', spec.prompt)
  if (spec.model) args.push('--model', spec.model)
  if (spec.ratio) args.push('--ratio', spec.ratio)
  if (spec.resolution) args.push('--resolution', spec.resolution)
  args.push('--count', String(spec.count ?? 1))
  for (const ref of spec.refs ?? []) args.push('--ref', formatCanvasRef(ref))
  if (spec.submitId) args.push('--submit-id', spec.submitId)
  if (spec.creditToken) args.push('--credit-token', spec.creditToken)
  else if (spec.creditCeiling !== undefined) args.push('--credit-ceiling', String(spec.creditCeiling))
  if (spec.run) {
    args.push('--run')
    if (spec.wait) {
      args.push('--wait')
      if (spec.timeout) args.push('--timeout', spec.timeout)
      if (spec.interval) args.push('--interval', spec.interval)
    }
  }
  return args
}

/* ------------------------------------------------------------------ */
/* 结果解析                                                             */
/* ------------------------------------------------------------------ */

export interface CanvasQuote {
  totalMaxCredits: number
  confirmable: boolean
  confirmationRequired: boolean
  items: Array<{ nodeId: string; maxCredits: number }>
  draftVersion?: number
}

/** `node quote` → 报价（报价 ≠ 授权）。 */
export function parseCanvasQuote(envelope: CanvasEnvelope | undefined): CanvasQuote {
  const data = envelope?.data ?? {}
  const items = Array.isArray(data.items)
    ? data.items.map((item: any) => ({ nodeId: String(item?.nodeId ?? ''), maxCredits: Number(item?.maxCredits ?? 0) }))
    : []
  const total = Number(data.totalMaxCredits)
  return {
    totalMaxCredits: Number.isFinite(total) ? total : items.reduce((sum, item) => sum + item.maxCredits, 0),
    confirmable: data.confirmable === true,
    confirmationRequired: data.confirmationRequired === true,
    items,
    draftVersion: typeof data.draftVersion === 'number' ? data.draftVersion : undefined,
  }
}

/** `node confirm` → 短期凭证（绝不持久化）。 */
export function parseCanvasCreditToken(envelope: CanvasEnvelope | undefined): { token?: string; ceiling?: number; expiresAt?: string } {
  const data = envelope?.data ?? {}
  return {
    token: typeof data.creditConfirmationToken === 'string' ? data.creditConfirmationToken : undefined,
    ceiling: typeof data.creditCeiling === 'number' ? data.creditCeiling : undefined,
    expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : undefined,
  }
}

export interface CanvasNodeHandle {
  nodeId: string
  title?: string
  type?: string
  status?: string
}

/** `node create ...` → 节点身份（create 与 edit 的输出结构不同）。 */
export function parseCanvasNodeHandle(envelope: CanvasEnvelope | undefined): CanvasNodeHandle | undefined {
  const data = envelope?.data ?? {}
  const node = data.node ?? data.item?.node
  if (node && typeof node.nodeId === 'string') {
    return { nodeId: node.nodeId, title: node.title, type: node.type, status: node.status }
  }
  if (typeof data.nodeId === 'string') return { nodeId: data.nodeId, status: data.status }
  return undefined
}

export interface CanvasSubmitAcceptance {
  nodeId: string
  submitId: string
  resourceIds: string[]
}

/** `node run` → 受理回执（每项各自带 submitId，批量时位置对应）。 */
export function parseCanvasRunAcceptance(envelope: CanvasEnvelope | undefined): CanvasSubmitAcceptance[] {
  const items = envelope?.data?.items
  if (!Array.isArray(items)) return []
  return items
    .filter((item: any) => item && typeof item.nodeId === 'string' && typeof item.submitId === 'string')
    .map((item: any) => ({
      nodeId: item.nodeId,
      submitId: item.submitId,
      resourceIds: Array.isArray(item.resources)
        ? item.resources.map((r: any) => String(r?.resourceId ?? '')).filter((id: string) => id.length > 0)
        : [],
    }))
}

export interface CanvasOperationResult {
  operationRef: string
  state: CanvasOperationState
  resources: Array<{ resourceId: string; state?: string; width?: number; height?: number; format?: string }>
  adviceCode?: string
  advice?: string
}

/** `operation status|wait` → 终态事实。 */
export function parseCanvasOperation(envelope: CanvasEnvelope | undefined): CanvasOperationResult | undefined {
  const data = envelope?.data
  if (!data) return undefined
  const ref = String(data.operationRef ?? envelope?.meta?.operationRef ?? '')
  const state = String(data.state ?? 'unknown') as CanvasOperationState
  const resources = Array.isArray(data.resources)
    ? data.resources.map((r: any) => ({
        resourceId: String(r?.resourceId ?? ''),
        state: r?.state === undefined ? undefined : String(r.state),
        width: typeof r?.width === 'number' ? r.width : undefined,
        height: typeof r?.height === 'number' ? r.height : undefined,
        format: typeof r?.format === 'string' ? r.format : undefined,
      }))
    : []
  return {
    operationRef: ref,
    state: (CANVAS_OPERATION_STATES as readonly string[]).includes(state) ? state : 'unknown',
    resources,
    adviceCode: typeof data.submission?.adviceCode === 'string' ? data.submission.adviceCode : undefined,
    advice: typeof data.submission?.advice === 'string' ? data.submission.advice : undefined,
  }
}

/** 操作是否已到终态（`succeeded` / `failed` / `canceled`）。 */
export function isTerminalOperationState(state: CanvasOperationState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'canceled'
}

export interface CanvasDownloadResult {
  resourceId: string
  path: string
  size: number
  sha256?: string
}

/** `resource download` → 落地文件事实。 */
export function parseCanvasDownload(envelope: CanvasEnvelope | undefined): CanvasDownloadResult | undefined {
  const data = envelope?.data
  if (!data || typeof data.path !== 'string' || data.path.length === 0) return undefined
  return {
    resourceId: String(data.resourceId ?? ''),
    path: data.path,
    size: Number(data.size ?? 0),
    sha256: typeof data.sha256 === 'string' ? data.sha256 : undefined,
  }
}

export interface CanvasResourceInfo {
  resourceId: string
  type?: string
  status?: string
  format?: string
  creditsAmount?: number
}

/** `resource get` → 素材状态与稳定事实。 */
export function parseCanvasResource(envelope: CanvasEnvelope | undefined): CanvasResourceInfo | undefined {
  const data = envelope?.data
  if (!data || typeof data.resourceId !== 'string') return undefined
  return {
    resourceId: data.resourceId,
    type: typeof data.type === 'string' ? data.type : undefined,
    status: typeof data.status === 'string' ? data.status : undefined,
    format: typeof data.format === 'string' ? data.format : undefined,
    creditsAmount: typeof data.creditsAmount === 'number' ? data.creditsAmount : undefined,
  }
}

/* ------------------------------------------------------------------ */
/* 模型目录（实时模型规格，替代硬编码 limits）                            */
/* ------------------------------------------------------------------ */

export interface CanvasModelMode {
  name: string
  /** `--ratio` 可取值（模型规格未下发时为空数组）。 */
  ratios: string[]
  /** `--resolution` 可取值。 */
  resolutions: string[]
  durationMin?: number
  durationMax?: number
  countMax?: number
  promptMaxLength?: number
  /** 素材总数范围；`undefined` 表示规格未下发 materials。 */
  references?: { min: number; max: number; types: Array<{ mediaType: string; min?: number; max?: number }> }
}

export interface CanvasModel {
  model: string
  aliases: string[]
  isVip?: boolean
  vipConfigs?: Array<{ resolution?: string; isVip?: boolean }>
  modes: CanvasModelMode[]
}

/** 从 `model list` 的 mode.flags 里抽取值域（flags 是动态下发的）。 */
function modeFromRaw(raw: any): CanvasModelMode {
  const flag = (name: string): any => (Array.isArray(raw?.flags) ? raw.flags.find((f: any) => f?.flag === name || f?.name === name) : undefined)
  const ratioFlag = flag('--ratio')
  const resolutionFlag = flag('--resolution')
  const durationFlag = flag('--duration')
  const countFlag = flag('--count')
  const promptFlag = flag('--prompt')
  const refs = raw?.references
  return {
    name: String(raw?.name ?? ''),
    ratios: Array.isArray(ratioFlag?.values) ? ratioFlag.values.map(String) : [],
    resolutions: Array.isArray(resolutionFlag?.values) ? resolutionFlag.values.map(String) : [],
    durationMin: typeof durationFlag?.min === 'number' ? durationFlag.min : undefined,
    durationMax: typeof durationFlag?.max === 'number' ? durationFlag.max : undefined,
    countMax: typeof countFlag?.max === 'number' ? countFlag.max : undefined,
    promptMaxLength: typeof promptFlag?.maxLength === 'number' ? promptFlag.maxLength : undefined,
    references:
      refs && typeof refs === 'object'
        ? {
            min: Number(refs.min ?? 0),
            max: Number(refs.max ?? 0),
            types: Array.isArray(refs.types)
              ? refs.types.map((t: any) => ({ mediaType: String(t?.mediaType ?? ''), min: t?.min, max: t?.max }))
              : [],
          }
        : undefined,
  }
}

/** `model list --type <t>` → 规范化模型目录。 */
export function parseCanvasModelList(envelope: CanvasEnvelope | undefined): CanvasModel[] {
  const items = envelope?.data?.items
  if (!Array.isArray(items)) return []
  return items.map((item: any) => ({
    model: String(item?.model ?? ''),
    aliases: Array.isArray(item?.aliases) ? item.aliases.map(String) : [],
    isVip: typeof item?.generation?.isVip === 'boolean' ? item.generation.isVip : item?.isVip,
    vipConfigs: Array.isArray(item?.generation?.vipConfigs)
      ? item.generation.vipConfigs.map((v: any) => ({ resolution: v?.resolution, isVip: v?.isVip }))
      : undefined,
    modes: Array.isArray(item?.modes) ? item.modes.map(modeFromRaw) : [],
  }))
}

/** 在目录里按 canonical 名或 alias 定位模型（大小写不敏感，精确先于子串）。 */
export function findCanvasModel(models: CanvasModel[], name: string): CanvasModel | undefined {
  const want = String(name ?? '').trim().toLowerCase()
  if (want.length === 0) return undefined
  return (
    models.find((m) => m.model.toLowerCase() === want) ??
    models.find((m) => m.aliases.some((a) => a.toLowerCase() === want)) ??
    models.find((m) => m.model.toLowerCase().includes(want)) ??
    models.find((m) => m.aliases.some((a) => a.toLowerCase().includes(want)))
  )
}

/** 取某模型某公开模式的可调用规格。 */
export function canvasModeSpec(model: CanvasModel, mode: string): CanvasModelMode | undefined {
  return model.modes.find((m) => m.name === mode)
}

/** 单个 canonical 模型的稳定指纹，用于「模型规格变了」的告警（不参与计费）。 */
export function canvasModelFingerprint(models: CanvasModel[]): string {
  const canonical = models
    .map((m) => ({ model: m.model, modes: m.modes.map((mode) => ({ name: mode.name, res: mode.resolutions, dur: [mode.durationMin, mode.durationMax] })) }))
    .sort((a, b) => a.model.localeCompare(b.model))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

/* ------------------------------------------------------------------ */
/* 账号：keychain 子键发现                                              */
/* ------------------------------------------------------------------ */

/** 一个候选 keychain 子键（画布 CLI 用它存登录态）。 */
export interface CanvasKeychainLocation {
  subKey: string
  valueName: string
}

export interface CanvasCliOptions {
  /** 二进制绝对路径。 */
  binary: string
  /** 登录态隔离名（`--profile`）；空 = CLI 默认 `default`。 */
  profile?: string
  region?: string
  /** 每次调用前的账号闸门（与旧 CLI 同一套 store）。 */
  ensureAccount?: () => Promise<unknown>
  /** 单次调用超时。 */
  timeoutMs?: number
  /** 注入执行器（单测用）；默认 node:child_process。 */
  /**
   * 额外环境变量。用来把 CLI 的业务记录目录收进私有运行目录
   * （`DREAMINA_CANVAS_STATE_DIR`），避免 journal 写进用户 AppData 时的权限/污染问题。
   */
  env?: Record<string, string>
  exec?: (binary: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}

export interface CanvasCli {
  run(args: string[], options?: { timeoutMs?: number }): Promise<CanvasRunResult>
  /** 便捷：要求 outcome === 'ok'，否则抛结构化错误。 */
  runOrThrow(args: string[], options?: { timeoutMs?: number; label?: string }): Promise<CanvasRunResult>
}

/**
 * 用注入的执行器构造一个 CLI 门面。
 *
 * 关键约定：**失败 envelope 可能只在 stderr**，且 execFile 在非零退出时会抛错，
 * 所以执行器必须把 stdout/stderr/exitCode 原样带回，而不是把非零退出当异常抛出。
 */
export function createCanvasCli(options: CanvasCliOptions): CanvasCli {
  const timeoutMs = options.timeoutMs ?? 180_000

  const run = async (args: string[], runOptions: { timeoutMs?: number } = {}): Promise<CanvasRunResult> => {
    if (options.ensureAccount) await options.ensureAccount()
    const full = [...canvasGlobalArgs({ profile: options.profile, region: options.region }), ...args]
    const exec =
      options.exec ??
      (async (binary: string, argv: string[], budget: number) => {
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const execFileAsync = promisify(execFile)
        try {
          const { stdout, stderr } = await execFileAsync(binary, argv, {
            timeout: budget,
            maxBuffer: 32 * 1024 * 1024,
            windowsHide: true,
            env: options.env ? { ...process.env, ...options.env } : process.env,
          })
          return { stdout: String(stdout), stderr: String(stderr ?? ''), exitCode: 0 }
        } catch (error: any) {
          const code = typeof error?.code === 'number' ? error.code : Number.isFinite(Number(error?.code)) ? Number(error.code) : 1
          return { stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? error?.message ?? ''), exitCode: code }
        }
      })
    const result = await exec(options.binary, full, runOptions.timeoutMs ?? timeoutMs)
    const raw = [result.stdout, result.stderr].filter((s) => s && s.trim().length > 0).join('\n')
    const envelope = parseCanvasEnvelope(raw)
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      raw,
      envelope,
      classification: classifyCanvasResult(result.exitCode, envelope),
    }
  }

  const runOrThrow = async (args: string[], runOptions: { timeoutMs?: number; label?: string } = {}): Promise<CanvasRunResult> => {
    const result = await run(args, runOptions)
    if (result.classification.outcome !== 'ok') {
      const label = runOptions.label ?? args.slice(0, 2).join(' ')
      throw new Error(
        `dreamina-canvas ${label} failed [${result.classification.outcome}] ` +
          `exit=${result.exitCode}${result.classification.requiredAction ? ` requiredAction=${result.classification.requiredAction}` : ''}: ` +
          `${result.classification.message}`,
      )
    }
    return result
  }

  return { run, runOrThrow }
}

/** 在 keychain 根下列出所有画布 CLI 子键（新登录态可能新建键，故不硬编码 hash）。 */
export async function discoverCanvasKeychainSubkeys(runner?: RegRunner): Promise<string[]> {
  const { listKeychainSubkeys } = await import('./dreamina-keychain.ts')
  const subkeys = await listKeychainSubkeys(runner)
  return subkeys.filter((k) => k.startsWith(CANVAS_KEYCHAIN_PREFIX))
}

/* ------------------------------------------------------------------ */
/* 二进制解析与画布解析                                                  */
/* ------------------------------------------------------------------ */

/** 平台可执行文件名。 */
export function canvasBinaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'dreamina-canvas.exe' : 'dreamina-canvas'
}

/**
 * 解析画布 CLI 二进制：显式配置 > 包内 `bin/`（随包分发）> 用户 `~/bin`
 * （官方安装器的默认位置）> PATH 上的 `dreamina-canvas`。
 *
 * 官方安装器把二进制放在 `~/bin`，所以「随包」只是兜底；两者都不存在时
 * 交给 PATH，让缺件以清晰的 spawn 错误暴露，而不是静默走错目录。
 */
export async function resolveCanvasBinary(configured?: string): Promise<string> {
  const explicit = String(configured ?? '').trim()
  if (explicit.length > 0) return explicit
  const { access } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const { packageRootOf } = await import('./pkg-root.ts')
  const name = canvasBinaryName()
  const candidates = [join(packageRootOf(import.meta.url), 'bin', name), join(homedir(), 'bin', name)]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      /* try the next location */
    }
  }
  return name
}

export interface CanvasProjectRef {
  projectId: string
  name?: string
  webUrl?: string
  created: boolean
}

/** 从 `canvas ls` 的任意公开形态里取列表（items / canvases / projects）。 */
export function parseCanvasList(envelope: CanvasEnvelope | undefined): { projects: CanvasProjectRef[]; nextCursor?: string } {
  const data = envelope?.data ?? {}
  const raw = data.items ?? data.canvases ?? data.projects
  const projects: CanvasProjectRef[] = Array.isArray(raw)
    ? raw
        .map((item: any) => ({
          projectId: String(item?.projectId ?? ''),
          name: item?.name === undefined ? undefined : String(item.name),
          webUrl: item?.webUrl === undefined ? undefined : String(item.webUrl),
          created: false,
        }))
        .filter((p: CanvasProjectRef) => p.projectId.length > 0)
    : []
  const nextCursor = typeof data.nextCursor === 'string' && data.nextCursor.length > 0 ? data.nextCursor : undefined
  return { projects, nextCursor }
}

/** 从 `canvas create` 回执取画布身份（实测：`data.project.projectId`）。 */
export function parseCanvasCreated(envelope: CanvasEnvelope | undefined): CanvasProjectRef | undefined {
  const data = envelope?.data ?? {}
  const project = data.project ?? data
  const projectId = String(project?.projectId ?? '')
  if (projectId.length === 0) return undefined
  return {
    projectId,
    name: project?.name === undefined ? undefined : String(project.name),
    webUrl: project?.webUrl === undefined ? undefined : String(project.webUrl),
    created: true,
  }
}

/** 项目名 → CLI 参数安全的标题（`canvas ls` 按名字精确匹配复用画布）。 */
export function normalizeCanvasName(name: string): string {
  const clean = String(name ?? '').replace(/[\r\n]+/g, ' ').trim()
  return clean.length === 0 ? 'dsh-media' : clean.slice(0, 120)
}

/**
 * 复用或创建画布：先用 `canvas ls` 分页找同名画布，找不到才创建。
 * 绝不使用 `--use`（那会改用户的「当前画布」，是全局副作用）。
 */
export async function resolveCanvasProject(
  cli: CanvasCli,
  name: string,
  options: { pageLimit?: number; maxPages?: number } = {},
): Promise<CanvasProjectRef> {
  const wanted = normalizeCanvasName(name)
  const limit = options.pageLimit ?? 100
  const maxPages = options.maxPages ?? 5
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const args = ['canvas', 'ls', '--limit', String(limit)]
    if (cursor) args.push('--cursor', cursor)
    const listed = await cli.runOrThrow(args, { timeoutMs: 90_000, label: 'canvas ls' })
    const { projects, nextCursor } = parseCanvasList(listed.envelope)
    const found = projects.find((p) => (p.name ?? '').trim() === wanted)
    if (found) return { ...found, created: false }
    if (!nextCursor) break
    cursor = nextCursor
  }
  const created = await cli.runOrThrow(['canvas', 'create', wanted], { timeoutMs: 90_000, label: 'canvas create' })
  const project = parseCanvasCreated(created.envelope)
  if (!project) throw new Error(`dreamina-canvas canvas create 未返回 projectId: ${created.raw.slice(0, 300)}`)
  return project
}
