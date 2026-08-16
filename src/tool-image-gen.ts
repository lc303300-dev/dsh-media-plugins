/**
 * Model-facing `generate_image` tool: text-to-image and image-to-image
 * through the unified serial media router.
 *
 * Contract:
 * - `image_ratio` is required (8 supported values); missing or unsupported
 *   fails as input_error before any provider is called (never inferred).
 * - `image_resolution` is optional (1K/2K/4K); when omitted, Gemini routes
 *   default to 2K, GPT image routes to 4K, and Dreamina to 1K.
 * - Adapters run strictly serially: comfly-gemini-flash-preview →
 *   comfly-gpt-image-2 → apimart-gpt-image-2 → google-gemini-image →
 *   dreamina-image. Fallback only for allowed failure classes;
 *   indeterminate submissions never retry.
 * - `image_provider` (restricted enum) pins the run to exactly one route
 *   with no cross-route fallback; unknown/disabled routes are input_error.
 * - Per-adapter budget 120 s, whole-task 300 s; cross-process capacity
 *   lease per adapter (default 6; dreamina shares `seedance-cli`).
 * - Reference images are EXIF-normalized and capped at 1920 px long edge
 *   into the private runtime; originals are never overwritten.
 *
 * @module @deepseek-ai/dsh-tool-image-gen
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { copyFile, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SUPPORTED_RATIOS,
  SUPPORTED_RESOLUTIONS,
  SUPPORTED_IMAGE_PROVIDERS,
  runImageRouter,
  ratioToSize,
  type RouterConfig,
} from './shared/adapters.ts'
import { mediaErrors } from './shared/failure.ts'
import {
  TaskStore,
  appendSafeLog,
  ensureDir,
  newTaskId,
  redactPrompt,
  resolvePrivateRoot,
} from './shared/private-runtime.ts'

/** Bundle root: the built tool file lives at the package root. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-image-gen'

/** Services required by the image-generation tool. */
export const inject = ['tools', 'fs', 'credentials']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  comflyBaseURL?: string
  comflyApiKeyEnv?: string
  apimartBaseURL?: string
  apimartApiKeyEnv?: string
  geminiApiURL?: string
  geminiApiKeyEnv?: string
  dreaminaPath?: string
  proxyUrl?: string
  outputDir?: string
  privateDir?: string
  maxConcurrency?: number
  providerTimeoutMs?: number
  taskTimeoutMs?: number
  /** Adapter ids to enable; empty means all in contract order. */
  enabled?: string[]
}

export const Config: z<Config> = z.object({
  comflyBaseURL: z.string().default('https://ai.comfly.org/v1'),
  comflyApiKeyEnv: z.string().default('COMFLY_API_KEY'),
  apimartBaseURL: z.string().default('https://api.apimart.ai/v1'),
  apimartApiKeyEnv: z.string().default('APIMART_API_KEY'),
  geminiApiURL: z.string().default('https://generativelanguage.googleapis.com/v1beta/interactions'),
  geminiApiKeyEnv: z.string().default('GEMINI_API_KEY'),
  dreaminaPath: z.string().default(join(PACKAGE_ROOT, 'bin', 'dreamina.exe')),
  proxyUrl: z.string().default(''),
  outputDir: z.string().default('outputs'),
  privateDir: z.string().default(''),
  maxConcurrency: z.number().default(6),
  providerTimeoutMs: z.number().default(120000),
  taskTimeoutMs: z.number().default(300000),
  enabled: z.array(z.string()).default([]),
})

type ResolvedConfig = Required<Config>

/** Move or copy the router artifact to its final public destination. */
async function stageOutput(
  source: string,
  outputDir: string,
  requested: string | undefined,
  workspaceRoot: string,
): Promise<string> {
  let finalPath: string
  if (requested !== undefined && requested.trim().length > 0) {
    finalPath = isAbsolute(requested) ? requested : join(workspaceRoot, requested)
  } else {
    const dir = join(workspaceRoot, outputDir)
    await ensureDir(dir)
    const ext = source.slice(source.lastIndexOf('.')) || '.png'
    finalPath = join(dir, `generated-${Date.now()}${ext}`)
  }
  await ensureDir(dirname(finalPath))
  try {
    await rename(source, finalPath)
  } catch {
    await copyFile(source, finalPath)
  }
  return finalPath
}

/** Register the `generate_image` tool. */
function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_image',
      description:
        '用统一媒体路由器生成或编辑图片并保存到 workspace，返回图片的绝对路径。image_ratio 必填（仅 21:9、16:9、3:2、4:3、1:1、3:4、2:3、9:16），缺失或不支持会在任何供应商调用前拒绝。image_resolution 可选（1K/2K/4K）：缺省时 Gemini 线路默认 2K、GPT 线路默认 4K、Dreamina 默认 1K。image_provider 可选：仅当用户明确点名某条受支持线路时传入，指定后只走该线路、失败不回退；未知或禁用线路在任何供应商调用前拒绝。图片按配置顺序严格串行尝试适配器（comfly-gemini-flash-preview → comfly-gpt-image-2 → apimart-gpt-image-2 → google-gemini-image → dreamina-image），单适配器最多 120 秒、整任务最多 300 秒；仅明确可回退的失败才进入下一适配器，提交结果不确定时标记 needs_review 且绝不自动重试。文生图传 prompt；图生图再传 image 参考图路径列表（顺序有语义）。参考图会做 EXIF 方向归一化并按最长边 1920px 等比缩放后提交，绝不覆盖原图。',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: '生成/编辑提示词，UTF-8，不能为空。',
        },
        image_ratio: {
          type: 'string',
          enum: [...SUPPORTED_RATIOS],
          description: '必填：图片输出比例，仅支持 21:9、16:9、3:2、4:3、1:1、3:4、2:3、9:16；不得从参考图/提示词推断。',
        },
        image_resolution: {
          type: 'string',
          enum: [...SUPPORTED_RESOLUTIONS],
          description: '可选：图片输出分辨率（1K/2K/4K）。缺省时 GPT 图片线路默认 4K、Gemini 图片线路默认 2K、Dreamina 默认 1K。',
        },
        image_provider: {
          type: 'string',
          enum: [...SUPPORTED_IMAGE_PROVIDERS, 'comfly-gemini-lite'],
          description: '可选：用户明确点名的图片线路。comfly-gemini-lite 是 comfly-gemini-flash-preview 的兼容别名。指定后只走该线路、失败不回退；未知或禁用线路在任何供应商调用前以 input_error 拒绝。',
        },
        image: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：图生图参考图路径列表（PNG/JPEG/WEBP），按语义顺序排列。',
        },
        output: {
          type: 'string',
          description: '可选输出路径（绝对路径，或相对会话工作目录的路径）。指定后该产出文件可被点击打开；省略则用自动文件名。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            size: { type: 'string', required: true },
            model: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            attempts: { type: 'number', required: true },
            resolution: { type: 'string' },
            needs_review: { type: 'boolean' },
          },
        },
        render(_args: unknown, value: any) {
          return [
            {
              type: 'text',
              text: `generated image: ${value.path} (${value.size}, via ${value.provider}/${value.model}, ${value.attempts} attempt(s))`,
            },
          ]
        },
      },
      async execute(args: any, exec: any) {
        const prompt = String(args.prompt ?? '').trim()
        if (prompt.length === 0) throw mediaErrors.input('prompt must be a non-empty string')
        const ratio = (args.image_ratio ?? args.size ?? '').trim()
        if (ratio.length === 0) {
          throw mediaErrors.input('image_ratio is required; choose one of: ' + SUPPORTED_RATIOS.join(', '))
        }
        const size = ratioToSize(ratio) // throws input_error for unsupported
        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)
        const taskId = newTaskId()
        const store = new TaskStore(join(privateRoot, 'jobs'))

        // resolve provider keys through the DSH credentials service (never env-only)
        const credentials: Record<string, string> = {}
        for (const env of [config.comflyApiKeyEnv, config.apimartApiKeyEnv, config.geminiApiKeyEnv]) {
          try {
            const resolved = await ctx.credentials?.resolve(credentialRef(env))
            if (resolved?.value) credentials[env] = String(resolved.value)
          } catch {
            /* credential missing or service unavailable: adapter reports auth_unavailable */
          }
        }

        const routerConfig: RouterConfig = {
          comflyBaseURL: config.comflyBaseURL,
          comflyApiKeyEnv: config.comflyApiKeyEnv,
          apimartBaseURL: config.apimartBaseURL,
          apimartApiKeyEnv: config.apimartApiKeyEnv,
          geminiApiURL: config.geminiApiURL,
          geminiApiKeyEnv: config.geminiApiKeyEnv,
          dreaminaPath: config.dreaminaPath,
          proxyUrl: config.proxyUrl,
          maxConcurrency: config.maxConcurrency,
          providerTimeoutMs: config.providerTimeoutMs,
          taskTimeoutMs: config.taskTimeoutMs,
          outputDir: config.outputDir,
          enabled: config.enabled,
          credentials,
        }

        const request = { prompt: redactPrompt(prompt), ratio, size, resolution: args.image_resolution ?? null, imageProvider: args.image_provider ?? null, images: args.image ?? [] }
        await store.create('image', taskId, 'image', request)
        await store.transition('image', taskId, 'running')

        try {
          const outcome = await runImageRouter({
            prompt,
            images: args.image ?? [],
            ratio,
            resolution: args.image_resolution,
            imageProvider: args.image_provider,
            config: routerConfig,
            workspaceRoot,
            privateRoot,
            signal: exec.signal,
            taskId,
          })
          const finalPath = await stageOutput(outcome.outputPath, config.outputDir, args.output, workspaceRoot)
          await store.saveResult('image', taskId, {
            status: 'success',
            provider: outcome.provider,
            model: outcome.model,
            outputPath: finalPath,
            attempts: outcome.attempts,
          })
          await store.transition('image', taskId, 'success', {
            provider: outcome.provider,
            model: outcome.model,
            outputPath: finalPath,
            attempts: outcome.attempts,
          })
          await appendSafeLog(privateRoot, 'generate_image', { taskId, status: 'success', provider: outcome.provider, model: outcome.model, ratio, attempts: outcome.attempts.length })
          return {
            path: finalPath,
            size,
            model: outcome.model,
            provider: outcome.provider,
            attempts: outcome.attempts.length,
            resolution: args.image_resolution ?? undefined,
            needs_review: false,
          }
        } catch (error: any) {
          const cls = error?.cls ?? 'definite_provider_failure'
          const needsReview = cls === 'indeterminate_submission' || cls === 'timeout_before_submit'
          await store.saveResult('image', taskId, { status: needsReview ? 'needs_review' : 'failed', failureClass: cls, message: String(error?.message ?? error) })
          await store.transition('image', taskId, needsReview ? 'needs_review' : 'failed', {
            failureClass: cls,
            failureMessage: String(error?.message ?? error),
            nextAction: needsReview ? 'user_check_backend' : 'none',
          })
          await appendSafeLog(privateRoot, 'generate_image', { taskId, status: needsReview ? 'needs_review' : 'failed', failureClass: cls })
          if (needsReview) {
            throw new Error(
              `图片任务提交结果不确定（${cls}），已标记 needs_review；请到供应商后台人工核对，禁止自动重试。详情：${error?.message ?? error}`,
            )
          }
          throw error
        }
      },
      presentCall(args: any) {
        const requested = args?.output?.trim()
        if (requested === undefined || requested.length === 0) return undefined
        return {
          card: 'generic',
          kind: 'edit',
          title: `生成图片 ${requested}`,
          locations: [{ path: requested }],
        } as GenericCallView
      },
    }),
  )
}

export { apply }
