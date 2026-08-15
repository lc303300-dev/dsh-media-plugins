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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePrivateRoot } from './shared/private-runtime.ts'
import { corpusSize, resolveIndexPath } from './shared/corpus-core.ts'
import { resolveFfmpeg } from './shared/gif-core.ts'

const execFileAsync = promisify(execFile)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-status'
export const inject = ['tools', 'credentials']

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

export interface Config {
  privateDir?: string
  dreaminaPath?: string
}

export const Config: z<Config> = z.object({
  privateDir: z.string().default(''),
  dreaminaPath: z.string().default(join(PACKAGE_ROOT, 'bin', 'dreamina.exe')),
})

type ResolvedConfig = Required<Config>

function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'media_status',
      description:
        '媒体与业务工具就绪检查（get-pipeline-setup-status / verify-deployment 的 DSH 重建，只读）：status 按 ready/degraded/unavailable 报告各工具状态（图片工具=任一适配器可用即 degraded、主通道 Comfly 就绪即 ready；视频工具=Dreamina 可用才 ready；skill_registry=SQLite 注册库；prompt_revision=语料库；video_to_gif=ffmpeg）；verify 做部署验证（凭证存在性只报变量名、dreamina 二进制/登录/只读 user_credit、ffmpeg、私有运行目录可写、语料可加载、注册库可开）。绝不输出密钥值或完整登录材料。',
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
            message: { type: 'string' },
            tools: { type: 'object', additionalProperties: true },
            providers: { type: 'object', additionalProperties: true },
            deployment: { type: 'object', additionalProperties: true },
          },
        },
        render(_args: unknown, value: any) {
          return [{ type: 'text', text: value.message ?? JSON.stringify(value) }]
        },
      },
      async execute(_args: any, exec: any) {
        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)

        // credential presence (names only, never values)
        const creds: Record<string, boolean> = {}
        for (const env of ['COMFLY_API_KEY', 'APIMART_API_KEY', 'GEMINI_API_KEY', 'VOLCANO_ENGINE_API_KEY']) {
          try {
            const resolved = await ctx.credentials?.resolve(credentialRef(env))
            creds[env] = Boolean(resolved?.value)
          } catch {
            creds[env] = false
          }
        }

        // dreamina binary + login state
        let dreaminaBinary = false
        let dreaminaLogin = false
        let dreaminaCredit: number | null = null
        try {
          await access(config.dreaminaPath)
          dreaminaBinary = true
          try {
            const out = await execFileAsync(config.dreaminaPath, ['user_credit'], { timeout: 20000, windowsHide: true })
            const start = out.stdout.indexOf('{')
            if (start >= 0) {
              const parsed = JSON.parse(out.stdout.slice(start))
              dreaminaLogin = true
              dreaminaCredit = Number(parsed.total_credit ?? null)
            }
          } catch {
            dreaminaLogin = false
          }
        } catch {
          dreaminaBinary = false
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

        const tools: Record<string, string> = {
          generate_image: creds.COMFLY_API_KEY ? 'ready' : (creds.APIMART_API_KEY || creds.GEMINI_API_KEY || (dreaminaBinary && dreaminaLogin)) ? 'degraded' : 'unavailable',
          generate_video: dreaminaBinary && dreaminaLogin ? 'ready' : dreaminaBinary ? 'degraded' : 'unavailable',
          describe_image: creds.VOLCANO_ENGINE_API_KEY ? 'ready' : 'unavailable',
          skill_registry: registryOk ? 'ready' : 'unavailable',
          prompt_revision: corpusOk ? 'ready' : 'degraded',
          video_to_gif: ffmpeg ? 'ready' : 'unavailable',
          batch_image: creds.COMFLY_API_KEY ? 'ready' : 'degraded',
        }

        const providers = {
          'comfly-gemini-flash-preview': { ready: creds.COMFLY_API_KEY },
          'comfly-gpt-image-2-all': { ready: creds.COMFLY_API_KEY },
          'comfly-gpt-image-2': { ready: creds.COMFLY_API_KEY },
          'apimart-gpt-image-2': { ready: creds.APIMART_API_KEY },
          'google-gemini-image': { ready: creds.GEMINI_API_KEY },
          'dreamina-image': { ready: dreaminaBinary && dreaminaLogin },
          'dreamina-video': { ready: dreaminaBinary && dreaminaLogin },
        }

        const deployment = {
          private_runtime_writable: privateOk,
          dreamina_binary: dreaminaBinary,
          dreamina_login: dreaminaLogin,
          dreamina_credit: dreaminaCredit,
          ffmpeg,
          corpus_entries: corpusCount,
          registry_db: registryOk,
          proxy_port_7897: null,
        }

        const readyCount = Object.values(tools).filter((t) => t === 'ready').length
        const degradedCount = Object.values(tools).filter((t) => t === 'degraded').length
        const unavailableCount = Object.values(tools).filter((t) => t === 'unavailable').length
        return {
          ok: unavailableCount === 0,
          message: `tools: ${readyCount} ready / ${degradedCount} degraded / ${unavailableCount} unavailable`,
          tools,
          providers,
          deployment,
        }
      },
    }),
  )
}

export { apply }
