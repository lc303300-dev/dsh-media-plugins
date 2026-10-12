/**
 * Media status / deployment verification tool (Codex_image
 * get-pipeline-setup-status + scripts/deployment/verify-deployment port).
 * Read-only: reports ready / degraded / unavailable per tool, checks
 * credentials presence (names only), Dreamina binary + login + credit,
 * ffmpeg, corpus, registry DB and private runtime. Never prints key values.
 *
 * @module @deepseek-ai/dsh-tool-status
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolvePrivateRoot } from './shared/private-runtime.ts'
import { corpusSize, resolveIndexPath } from './shared/corpus-core.ts'
import { resolveFfmpeg } from './shared/gif-core.ts'
import { packageRootOf } from './shared/pkg-root.ts'

const execFileAsync = promisify(execFile)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-status'
export const inject = ['tools', 'credentials']

const PACKAGE_ROOT = packageRootOf(import.meta.url)

export interface Config {
  privateDir?: string
  /** 旧 `dreamina` CLI 路径：只剩「积分余额查询」这一个用途。 */
  dreaminaPath?: string
  /** 画布 CLI（`dreamina-canvas`）路径；留空 = 自动解析。 */
  dreaminaCanvasPath?: string
  /** 画布登录态隔离名（`--profile`）。 */
  dreaminaCanvasProfile?: string
}

export const Config: z<Config> = z.object({
  privateDir: z.string().default(''),
  dreaminaPath: z.string().default(''),
  dreaminaCanvasPath: z.string().default(''),
  dreaminaCanvasProfile: z.string().default(''),
})

type ResolvedConfig = Required<Config>

function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'media_status',
      description:
        '媒体与业务工具就绪检查（get-pipeline-setup-status / verify-deployment 的 DSH 重建，只读）：status 按 ready/degraded/unavailable 报告各工具状态（图片工具=任一适配器可用即 degraded、主通道 Comfly 就绪即 ready；视频工具=即梦画布 CLI（dreamina-canvas）可用才 ready；skill_registry=SQLite 注册库；prompt_revision=语料库；video_to_gif=ffmpeg）；verify 做部署验证（凭证存在性只报变量名、dreamina-canvas 二进制/登录（auth status + auth account）、ffmpeg、私有运行目录可写、语料可加载、注册库可开）。绝不输出密钥值或完整登录材料。旧 dreamina CLI 已退役，不再探测、也不查询积分余额。',
      parameters: {
        command: {
          type: 'string',
          enum: ['status', 'verify'],
          required: true,
          description: '操作命令：status（工具状态）或 verify（部署验证）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            command: { type: 'string' },
            message: { type: 'string' },
            tools: { type: 'object', additionalProperties: true },
            tool_reasons: { type: 'object', additionalProperties: true },
            providers: { type: 'object', additionalProperties: true },
            deployment: { type: 'object', additionalProperties: true },
            credentials: { type: 'object', additionalProperties: true },
          },
        },
        render(_args: unknown, value: any) {
          const lines: string[] = [value.message ?? JSON.stringify(value)]
          const tools: Record<string, string> = value.tools ?? {}
          const reasons: Record<string, string> = value.tool_reasons ?? {}
          lines.push('', '工具状态:')
          for (const [tool, status] of Object.entries(tools)) {
            const reason = reasons[tool]
            lines.push(`- ${tool}: ${status}${reason && reason !== 'ready' ? `（${reason}）` : ''}`)
          }
          if (value.command === 'verify') {
            const d: Record<string, any> = value.deployment ?? {}
            lines.push('', '部署验证:')
            lines.push(`- deployment_ok: ${d.deployment_ok}`)
            lines.push(`- private_runtime_writable: ${d.private_runtime_writable}`)
            lines.push(`- dreamina_canvas: binary=${d.dreamina_canvas_binary} / login=${d.dreamina_canvas_login} / user_id=${d.dreamina_canvas_user_id ?? 'n/a'} / vip=${d.dreamina_canvas_vip ?? 'n/a'}`)
            lines.push(
              `- dreamina_account: 当前激活=${d.dreamina_active_account ?? '（未入库）'} / user_id=${d.dreamina_user_id ?? 'n/a'} / 管线默认=${d.dreamina_default_account ?? '（未设置）'}${d.dreamina_account_mismatch ? ' ⚠ 与默认不一致（下次即梦调用会自动切回）' : ''}`,
            )
            lines.push(`- ffmpeg: ${d.ffmpeg} / corpus_entries: ${d.corpus_entries} / registry_db: ${d.registry_db}`)
            lines.push(`- proxy_port_7897: ${d.proxy_port_7897}`)
            lines.push('', '凭证存在性（仅变量名，不输出值）:')
            for (const [k, present] of Object.entries<any>(value.credentials ?? {})) {
              lines.push(`- ${k}: ${present ? 'configured' : 'missing'}`)
            }
          } else {
            lines.push('', '生图/视频线路:')
            for (const [provider, info] of Object.entries<any>(value.providers ?? {})) {
              lines.push(`- ${provider}: ${info.ready ? 'ready' : 'skip'}（${info.reason ?? ''}${info.model ? ` · ${info.model}` : ''}）`)
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args: any, exec: any) {
        const command: 'status' | 'verify' = args?.command === 'verify' ? 'verify' : 'status'
        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)

        // credential presence (names only, never values)
        const creds: Record<string, boolean> = {}
        for (const env of ['COMFLY_API_KEY', 'VOLCANO_ENGINE_API_KEY']) {
          try {
            const resolved = await ctx.credentials?.resolve(credentialRef(env))
            creds[env] = Boolean(resolved?.value)
          } catch {
            creds[env] = false
          }
        }

        // 旧 `dreamina` CLI 已退役（2026-11 停维）：既不探测二进制、也不查询积分余额。
        // 账户身份与会员等级一律来自画布 CLI 的 `auth account`。

        // 画布 CLI（dreamina-canvas）：generate_video 与 dreamina 图片线路的唯一依赖。
        // 旧 `dreamina` 只剩「余额查询」用途 —— 画布 CLI 的账户信息不返回积分。
        let dreaminaCanvasBinary = false
        let dreaminaCanvasLogin = false
        let dreaminaCanvasUserId: string | null = null
        let dreaminaCanvasVip = ''
        let dreaminaCanvasError = ''
        try {
          const { createCanvasCli, resolveCanvasBinary } = await import('./shared/dreamina-canvas.ts')
          const binary = await resolveCanvasBinary(config.dreaminaCanvasPath)
          const cli = createCanvasCli({ binary, profile: config.dreaminaCanvasProfile })
          const version = await cli.run(['version'], { timeoutMs: 20000 })
          dreaminaCanvasBinary = version.classification.outcome === 'ok'
          if (dreaminaCanvasBinary) {
            const status = await cli.run(['auth', 'status'], { timeoutMs: 20000 })
            dreaminaCanvasLogin = status.envelope?.data?.loggedIn === true
            if (dreaminaCanvasLogin) {
              const account = await cli.run(['auth', 'account'], { timeoutMs: 20000 })
              const data: any = account.envelope?.data ?? {}
              dreaminaCanvasUserId = data.userId === undefined || data.userId === null ? null : String(data.userId)
              dreaminaCanvasVip = String(data.vipLevel ?? (data.isVip === true ? 'vip' : ''))
            }
          }
        } catch (error: any) {
          dreaminaCanvasError = String(error?.message ?? error).slice(0, 200)
        }

        // dreamina account store (read-only): which captured account is live vs the pipeline default
        let dreaminaAccount: { active: string | null; default: string | null; live_user_id: string | null; mismatched: boolean } = {
          active: null,
          default: null,
          live_user_id: null,
          mismatched: false,
        }
        try {
          const { readActiveKeychain, readActiveCanvasKeychain, readDefaultAccount, listAccounts } = await import('./shared/dreamina-account.ts')
          const live = await readActiveKeychain()
          const liveCanvas = await readActiveCanvasKeychain()
          const accounts = await listAccounts(privateRoot)
          const matched = live.fingerprint ? accounts.find((a) => a.fingerprint === live.fingerprint) : undefined
          const matchedCanvas = liveCanvas.fingerprint ? accounts.find((a) => a.canvasFingerprint === liveCanvas.fingerprint) : undefined
          const liveName = matched?.name ?? matchedCanvas?.name ?? null
          const defaultName = (await readDefaultAccount(privateRoot)) ?? null
          dreaminaAccount = {
            active: liveName,
            default: defaultName,
            live_user_id: dreaminaCanvasUserId ?? matched?.userId ?? null,
            mismatched: Boolean(defaultName && liveName !== defaultName),
          }
        } catch {
          /* 账号库/注册表不可读不影响其余诊断 */
        }

        // ffmpeg
        const ffmpeg = Boolean(await resolveFfmpeg())

        // corpus
        let corpusOk = false
        let corpusCount = 0
        try {
          corpusCount = corpusSize()
          corpusOk = corpusCount > 0
        } catch {
          corpusOk = false
        }

        // registry db writable
        let registryOk = false
        try {
          const { SkillRegistry } = await import('./shared/registry-core.ts')
          const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
          registry.list(undefined, 1)
          registry.close()
          registryOk = true
        } catch {
          registryOk = false
        }

        // private runtime writable
        let privateOk = false
        try {
          await mkdir(join(privateRoot, 'locks'), { recursive: true })
          privateOk = true
        } catch {
          privateOk = false
        }

        const canvasReady = dreaminaCanvasBinary && dreaminaCanvasLogin
        const tools: Record<string, string> = {
          generate_image: creds.COMFLY_API_KEY ? 'ready' : canvasReady ? 'degraded' : 'unavailable',
          generate_video: canvasReady ? 'ready' : dreaminaCanvasBinary ? 'degraded' : 'unavailable',
          describe_image: 'disabled',
          skill_registry: registryOk ? 'ready' : 'unavailable',
          prompt_revision: corpusOk ? 'ready' : 'degraded',
          video_to_gif: ffmpeg ? 'ready' : 'unavailable',
          batch_image: creds.COMFLY_API_KEY ? 'ready' : 'degraded',
        }
        const toolReasons: Record<string, string> = {
          generate_image: !creds.COMFLY_API_KEY ? '主通道缺少 COMFLY_API_KEY' : 'ready',
          generate_video: !dreaminaCanvasBinary ? 'dreamina-canvas 二进制缺失' : !dreaminaCanvasLogin ? 'dreamina-canvas 未登录（auth login）' : 'ready',
          describe_image: '火山方舟通道已屏蔽（cordis.patch.yml 未注册 Ws_tool-vision）',
          skill_registry: !registryOk ? '注册库不可用' : 'ready',
          prompt_revision: !corpusOk ? '语料未加载' : 'ready',
          video_to_gif: !ffmpeg ? 'ffmpeg 未找到' : 'ready',
          batch_image: !creds.COMFLY_API_KEY ? '主通道缺少 COMFLY_API_KEY' : 'ready',
        }

        // proxy port probe (read-only TCP connect attempt)
        let proxyOpen = false
        try {
          const { createConnection } = await import('node:net')
          proxyOpen = await new Promise((resolve) => {
            const socket = createConnection({ host: '127.0.0.1', port: 7897, timeout: 3000 })
            socket.once('connect', () => { socket.destroy(); resolve(true) })
            socket.once('error', () => resolve(false))
            socket.once('timeout', () => { socket.destroy(); resolve(false) })
          })
        } catch {
          proxyOpen = false
        }

        const providers = {
          'comfly-gpt-image-2-4k': { ready: creds.COMFLY_API_KEY, reason: creds.COMFLY_API_KEY ? 'ok' : 'missing COMFLY_API_KEY', model: 'gpt-image-2-4k (aspect_ratio 模式，实测输出 2048 长边；不传 size)', default_resolution: '2K', default_image_route: true },
          'comfly-gemini-flash-preview': { ready: creds.COMFLY_API_KEY, reason: creds.COMFLY_API_KEY ? 'ok' : 'missing COMFLY_API_KEY', model: 'gemini-3.1-flash-image-preview-2k (2K-only；1K/4K 请求钳制为 2K)', default_resolution: '2K' },
          'dreamina-image': { ready: canvasReady, reason: canvasReady ? 'ok' : 'dreamina-canvas 未就绪（图片共享容量池）', model: 'seedream_4.5 (画布节点生成；1K 请求按 2K 执行)', default_resolution: '2K' },
          'dreamina-video': { ready: canvasReady, reason: canvasReady ? 'ok' : 'dreamina-canvas 未就绪' },
        }

        const now = new Date().toISOString()
        const deploymentOk = privateOk && canvasReady && ffmpeg && corpusOk && registryOk
        const deployment = {
          deployment_ok: deploymentOk,
          private_runtime_writable: privateOk,
          // 即梦线路的全部事实都来自画布 CLI（旧 CLI 已退役，不再有余额字段）
          dreamina_canvas_binary: dreaminaCanvasBinary,
          dreamina_canvas_login: dreaminaCanvasLogin,
          dreamina_canvas_user_id: dreaminaCanvasUserId,
          dreamina_canvas_vip: dreaminaCanvasVip || null,
          dreamina_canvas_error: dreaminaCanvasError || null,
          dreamina_active_account: dreaminaAccount.active,
          dreamina_default_account: dreaminaAccount.default,
          dreamina_account_mismatch: dreaminaAccount.mismatched,
          ffmpeg,
          corpus_entries: corpusCount,
          registry_db: registryOk,
          proxy_port_7897: proxyOpen,
          last_checked: now,
        }

        const credentials = {
          COMFLY_API_KEY: creds.COMFLY_API_KEY,
          VOLCANO_ENGINE_API_KEY: creds.VOLCANO_ENGINE_API_KEY,
        }

        const readyCount = Object.values(tools).filter((t) => t === 'ready').length
        const degradedCount = Object.values(tools).filter((t) => t === 'degraded').length
        const unavailableCount = Object.values(tools).filter((t) => t === 'unavailable').length
        const disabledCount = Object.values(tools).filter((t) => t === 'disabled').length
        const disabledSuffix = disabledCount > 0 ? ` / ${disabledCount} disabled` : ''
        const message =
          command === 'verify'
            ? `deployment: ${deploymentOk ? 'OK' : 'ISSUES'} | tools: ${readyCount} ready / ${degradedCount} degraded / ${unavailableCount} unavailable${disabledSuffix}`
            : `tools: ${readyCount} ready / ${degradedCount} degraded / ${unavailableCount} unavailable${disabledSuffix}`
        return {
          ok: unavailableCount === 0,
          command,
          message,
          tools,
          tool_reasons: toolReasons,
          providers,
          deployment,
          credentials,
        }
      },
    }),
  )
}

export { apply }
