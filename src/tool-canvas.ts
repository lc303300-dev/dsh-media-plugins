/**
 * `dreamina_canvas` — 即梦画布 CLI 的通用能力入口（对齐官方命令面）。
 *
 * 为什么需要一个「透传」工具：官方明确要求 Agent **不得凭记忆猜测命令、flag、
 * 枚举与 JSON 字段**，一切以已安装二进制的 `schema` / `--help` 为准。固定参数
 * 的工具（`generate_video` / `generate_image`）只能覆盖生成主链路，覆盖不了
 * 主体(Element)、时间轴(timeline)、文本节点、超清、音色目录、跨项目资源、
 * 音频生成等能力，也无法在版本升级后自适应。
 *
 * 本工具因此把官方命令面**原样**暴露给 Agent，并在这几件事上强于裸 CLI：
 *
 * - **付费门**：任何会花钱的动作（`--run`、`node run`、`node upscale`）都必须在
 *   同一次调用里显式带上 `credit_ceiling` 或 `credit_token`，否则拒绝执行 ——
 *   报价不等于授权，工具不允许"顺手花掉"；
 * - **结构化结果**：直接返回 `outcome` / `required_action` / `request_id` /
 *   `partial_items` / `credit_confirmation`，Agent 按字段分支，绝不解析文案；
 * - **身份纪律**：失败时若 CLI 回了 `partialData`，原样带出 `nodeId` / `submitId`，
 *   让调用方复用同一 submit ID 续跑（换新 ID 等于第二次运行、会再扣一次钱）；
 * - **账号闸门**：每次 CLI 调用前确保配置的即梦账号是活登录。
 *
 * @module @deepseek-ai/dsh-tool-canvas
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { appendSafeLog, resolvePrivateRoot } from './shared/private-runtime.ts'
import { createAccountGate } from './shared/dreamina-account.ts'
import {
  canvasRequestId,
  createCanvasCli,
  parseCanvasCreditConfirmation,
  parseCanvasPartialItems,
  resolveCanvasBinary,
  type CanvasRunResult,
} from './shared/dreamina-canvas.ts'
import { openCanvasInBrowser, resolveBrowserBinary } from './shared/canvas-browser.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-canvas'
export const inject = ['tools']

/** 顶层命令（与 CLI 的 `available commands` 对齐）。 */
export const CANVAS_COMMANDS = ['catalog', 'canvas', 'node', 'operation', 'resource', 'voice', 'schema', 'version'] as const

/** command → CLI 顶层子命令。`catalog` 只是 model 的别名。 */
const COMMAND_ROOT: Record<string, string> = {
  catalog: 'model',
  canvas: 'canvas',
  node: 'node',
  operation: 'operation',
  resource: 'resource',
  voice: 'voice',
  schema: 'schema',
  version: 'version',
}

/** 会消耗积分的动作（必须显式带批准方式）。 */
const SPENDING_ACTION = /^(run|upscale)/

export interface Config {
  /** 画布 CLI 路径；留空 = 自动解析（包内 bin → ~/bin → PATH）。 */
  dreaminaPath?: string
  /** 登录态隔离名（`--profile`）。 */
  dreaminaProfile?: string
  privateDir?: string
  /** 管线默认即梦账号（空 = 不触碰登录态）。 */
  dreaminaAccount?: string
  /** CLI 业务记录目录（`DREAMINA_CANVAS_STATE_DIR`）；留空 = 收进私有运行目录。 */
  stateDir?: string
  /** 单次调用超时（毫秒）。 */
  timeoutMs?: number
  /** 需要时把画布 webUrl 打开到浏览器。 */
  openCanvasInBrowser?: boolean
  canvasBrowserPath?: string
  /** 固定浏览器配置目录（`--user-data-dir`，即梦登录态存在这里）；留空 = `<private>/browser-profile`。 */
  canvasBrowserProfileDir?: string
  canvasOpenCooldownMs?: number
}

export const Config: z<Config> = z.object({
  dreaminaPath: z.string().default(''),
  dreaminaProfile: z.string().default(''),
  privateDir: z.string().default(''),
  dreaminaAccount: z.string().default(''),
  stateDir: z.string().default(''),
  timeoutMs: z.number().default(300000),
  openCanvasInBrowser: z.boolean().default(true),
  canvasBrowserPath: z.string().default(''),
  canvasBrowserProfileDir: z.string().default(''),
  canvasOpenCooldownMs: z.number().default(10 * 60 * 1000),
})

type ResolvedConfig = Required<Config>

/**
 * flag 透传：`{ project_id: 'x', ref: ['res:..','node:..'], wait: true }`
 * → `--project-id x --ref res:.. --ref node:.. --wait`。
 *
 * 下划线转连字符是官方 flag 的书写规则；`false`/`null`/`undefined` 一律省略
 * （CLI 的布尔开关只认"出现即真"）。
 */
/**
 * 递归剔除 `undefined` 键。
 *
 * DSH 对工具返回值做无损 JSON 校验：`required_action` / `request_id` /
 * `credit_confirmation` 这类字段在成功路径上天然缺席，直接放进返回对象就会让
 * 整个调用被拒（"value is not lossless JSON"）。
 */
function jsonSafe<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue
      out[key] = jsonSafe(entry)
    }
    return out as T
  }
  return value
}

export function toCliFlags(args: Record<string, unknown> | undefined): string[] {
  const out: string[] = []
  for (const [rawKey, value] of Object.entries(args ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (rawKey.startsWith('_')) continue
    const flag = rawKey.startsWith('--') ? rawKey : `--${rawKey.replace(/_/g, '-')}`
    if (value === true) {
      out.push(flag)
      continue
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === undefined || entry === null) continue
        out.push(flag, String(entry))
      }
      continue
    }
    out.push(flag, String(value))
  }
  return out
}

/** 位置参数：`schema` 需要一个含空格的整串，其余命令按空格拆成多个位置参数。 */
export function canvasPositionals(command: string, action: string, positional: string[] = []): string[] {
  const trimmed = String(action ?? '').trim()
  const head = command === 'schema' ? (trimmed.length > 0 ? [trimmed] : []) : trimmed.split(/\s+/).filter(Boolean)
  return [...head, ...positional.map((p) => String(p))]
}

/** 是否属于付费动作（需要显式批准方式）。 */
export function isSpendingCall(command: string, action: string, args: Record<string, unknown> | undefined): boolean {
  if (args?.dry_run === true) return false
  if (args?.run === true) return true
  if (command === 'node' && SPENDING_ACTION.test(String(action ?? '').trim())) return true
  return false
}

function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'dreamina_canvas',
      description:
        '即梦画布 CLI（dreamina-canvas）的通用能力入口，对齐官方完整命令面：catalog（model list/find）、voice（voice list 音色目录）、canvas（create/ls）、node（create|edit image/video/audio/text/element/timeline、show、find、quote、confirm、run、upscale）、operation（status/wait）、resource（upload/get/download）、schema、version。**调用前先用 command=schema + action（如 "node create video"）查询当前制品的真实 flag 与枚举，绝不凭记忆猜参数**。付费纪律：任何花钱的动作（--run、node run、node upscale）必须在同一次调用里显式带 credit_ceiling 或 credit_token，否则直接拒绝（报价不等于授权）；返回结构化字段 outcome / required_action / request_id / partial_items / credit_confirmation，失败时原样带出 partialData 里的 nodeId+submitId，供调用方用**同一 submit ID** 续跑（换新 ID 等于第二次运行、会再扣一次钱）。',
      parameters: {
        command: {
          type: 'string',
          required: true,
          enum: [...CANVAS_COMMANDS],
          description: '顶层命令：catalog(=model) / canvas / node / operation / resource / voice / schema / version。',
        },
        action: {
          type: 'string',
          description: '子命令，可含空格：如 canvas 用 "create" / "ls"；node 用 "create video" / "edit image" / "show" / "find" / "quote" / "confirm" / "run" / "upscale image"；operation 用 "status" / "wait"；resource 用 "upload" / "get" / "download"；catalog 用 "list" / "find"；schema 用 "node create video"（整串作为一个参数）。',
        },
        args: {
          type: 'object',
          additionalProperties: true,
          description: 'flag 透传：键为 flag 名（下划线或连字符皆可，自动转 --key），值为字符串/数字/布尔/数组（数组重复该 flag）。例：{"project_id":"<uuid>","node_id":"node_x","mode":"t2v","prompt":"…","ratio":"16:9","resolution":"480p","duration":4,"count":1,"run":true,"credit_ceiling":120,"wait":true}。布尔 true = 出现该开关；false = 省略。',
        },
        positional: {
          type: 'array',
          items: { type: 'string' },
          description: '额外位置参数（放在 action 之后）：如 model find 的名称、canvas create 的画布名、operation wait 的 submitId、resource download 的 resourceId。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            command: { type: 'string' },
            action: { type: 'string' },
            exit_code: { type: 'number' },
            outcome: { type: 'string' },
            required_action: { type: 'string' },
            request_id: { type: 'string' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
            partial_items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            credit_confirmation: { type: 'object', additionalProperties: true },
          },
        },
        render(_args: unknown, value: any) {
          const status = value.ok ? 'ok' : `failed(${value.outcome ?? 'unknown'})`
          const action = value.action ? ` ${value.action}` : ''
          const hint = value.required_action ? ` → requiredAction=${value.required_action}` : ''
          // 关键：调用方（Agent）读到的就是这段文本，必须把 data 原样带出来 ——
          // 否则"先查 schema 再调用"这条官方要求根本无从执行（实测：只回摘要等于什么都没回）。
          const parts = [`dreamina_canvas${action}: ${status}${hint}`]
          if (value.request_id) parts.push(`request_id: ${value.request_id}`)
          if (!value.ok && value.message) parts.push(`message: ${value.message}`)
          if (value.partial_items) parts.push(`partial_items: ${JSON.stringify(value.partial_items)}`)
          if (value.credit_confirmation) parts.push(`credit_confirmation: ${JSON.stringify(value.credit_confirmation)}`)
          if (value.data !== undefined) parts.push(JSON.stringify(value.data, null, 2))
          return [{ type: 'text', text: parts.join('\n') }]
        },
      },
      async execute(args: any, exec: any) {
        const command = String(args.command ?? '').trim()
        const root = COMMAND_ROOT[command]
        if (!root) {
          return { ok: false, outcome: 'input_error', message: `不支持的 command: ${command}（可选：${CANVAS_COMMANDS.join(' / ')}）` }
        }
        const action = String(args.action ?? '').trim()
        const flags = (args.args ?? {}) as Record<string, unknown>
        const positionals = Array.isArray(args.positional) ? args.positional.map((p: unknown) => String(p)) : []

        // 付费门：报价不等于授权，工具绝不允许"顺手花掉"。
        if (isSpendingCall(command, action, flags) && flags.credit_token === undefined && flags.credit_ceiling === undefined) {
          return {
            ok: false,
            command,
            action,
            outcome: 'credits_required',
            required_action: 'confirm',
            message:
              '这是付费动作：必须先 node quote 拿到报价，再 node confirm --credit-ceiling <n> 取得 credit_token，' +
              '然后带 credit_token（或直接带 credit_ceiling 给出你愿意接受的上限）重试。工具不会替你批准花费。',
          }
        }

        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)
        const accountGate = createAccountGate(privateRoot, config.dreaminaAccount, async (info) => {
          await appendSafeLog(privateRoot, 'dreamina-canvas-tool', { action: 'auto-switch', ...info })
        })
        await accountGate.ensure()

        const binary = await resolveCanvasBinary(config.dreaminaPath)
        // 业务记录（journal）收进私有运行目录：官方支持 DREAMINA_CANVAS_STATE_DIR，
        // 能绕开写用户 AppData 时的权限/沙箱类失败（曾经稳定复现 operation_journal_write_failed）。
        const stateDir = config.stateDir.trim().length > 0 ? config.stateDir.trim() : join(privateRoot, 'canvas-state')
        const cli = createCanvasCli({
          binary,
          profile: config.dreaminaProfile,
          ensureAccount: () => accountGate.ensure(),
          timeoutMs: config.timeoutMs,
          env: { DREAMINA_CANVAS_STATE_DIR: stateDir },
        })

        const argv = [root, ...canvasPositionals(command, action, positionals), ...toCliFlags(flags)]
        let result: CanvasRunResult
        try {
          result = await cli.run(argv, { timeoutMs: config.timeoutMs })
        } catch (error: any) {
          return { ok: false, command, action, outcome: 'unknown', message: String(error?.message ?? error).slice(0, 400) }
        }

        const outcome = result.classification.outcome
        const ok = outcome === 'ok'
        await appendSafeLog(privateRoot, 'dreamina-canvas-tool', {
          event: 'call',
          command,
          action,
          outcome,
          exitCode: result.exitCode,
          requestId: canvasRequestId(result.envelope),
        })

        // 官方 Skill 要求：创建/进入画布后主动打开画布（best-effort，失败不影响结果）。
        //
        // projectId 优先取返回体，其次取本次调用显式传的 `--project-id`（node/operation/
        // resource 这类命令的返回里没有画布对象）；webUrl 缺失时按官方画布路由构造
        // （实测形态：https://jimeng.jianying.com/ai-tool/ai-canvas/<projectId>）。
        const explicitProjectId = typeof flags.project_id === 'string' ? flags.project_id : undefined
        const projectId =
          result.envelope?.data?.project?.projectId ?? result.envelope?.data?.projectId ?? explicitProjectId
        const webUrl =
          result.envelope?.data?.project?.webUrl ??
          result.envelope?.data?.webUrl ??
          (typeof projectId === 'string' && projectId.length > 0
            ? `https://jimeng.jianying.com/ai-tool/ai-canvas/${projectId}`
            : undefined)
        if (config.openCanvasInBrowser && typeof webUrl === 'string' && typeof projectId === 'string' && projectId.length > 0) {
          // 固定浏览器 + 固定 `--user-data-dir`：即梦登录态持久化在该目录，登录一次长期复用；
          // 该 profile 已在运行时，URL 会交给已有窗口开新标签页，不会重复开窗。
          const browserPath = await resolveBrowserBinary(config.canvasBrowserPath)
          const profileDir =
            config.canvasBrowserProfileDir.trim().length > 0
              ? config.canvasBrowserProfileDir.trim()
              : join(privateRoot, 'browser-profile')
          const opened = await openCanvasInBrowser(webUrl, {
            privateRoot,
            projectId,
            cooldownMs: config.canvasOpenCooldownMs,
            browserPath,
            profileDir,
          })
          await appendSafeLog(privateRoot, 'dreamina-canvas-tool', {
            event: 'canvas-open',
            projectId,
            browserPath: browserPath ?? '',
            profileDir,
            ...opened,
          })
        }

        const payload: Record<string, unknown> = {
          ok,
          command,
          action,
          exit_code: result.exitCode,
          outcome,
          required_action: result.classification.requiredAction,
          request_id: canvasRequestId(result.envelope),
          message: ok ? 'ok' : result.classification.message,
        }
        const data = result.envelope?.data
        if (data && typeof data === 'object') payload.data = data
        const partial = parseCanvasPartialItems(result.envelope)
        if (partial.length > 0) payload.partial_items = partial
        const confirmation = parseCanvasCreditConfirmation(result.envelope)
        if (!confirmation.occupancyUnknown || confirmation.reason) {
          payload.credit_confirmation = {
            reason: confirmation.reason,
            minimum_credit_ceiling: confirmation.minimumCreditCeiling,
            occupancy_unknown: confirmation.occupancyUnknown,
          }
        }
        // 失败但没有结构化错误时，给一小段原始输出便于排障（不含凭证）。
        if (!ok && payload.message === undefined) payload.message = result.raw.slice(0, 300)
        return jsonSafe(payload)
      },
    }),
  )
}

export { apply }
