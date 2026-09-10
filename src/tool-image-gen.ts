/**
 * Model-facing `generate_image` tool: text-to-image and image-to-image
 * through the unified serial media router.
 *
 * Contract:
 * - `image_ratio` is required (the 8 standard ratios, or a concrete pixel size
 *   such as 1920x1080 that is converted to the nearest standard ratio); missing
 *   or unsupported values fail as input_error before any provider is called.
 * - `image_resolution` is optional (1K/2K/4K); both Comfly routes are
 *   single-class and clamp rather than reject: GPT 2.5 is 4K-only (1K/2K
 *   clamp up to 4K) and Gemini is 2K-only (1K/4K clamp to 2K). Dreamina
 *   keeps 1K.
 * - The default route is `comfly-gpt-image-2.5` (`gpt-image-2.5-sunburst`,
 *   concrete pixel `size`, no `resolution`, no `response_format`, image read
 *   from `data[0].b64_json`).
 * - Adapters run strictly serially: comfly-gpt-image-2.5 →
 *   comfly-gemini-flash-preview → dreamina-image. Fallback only for allowed failure classes;
 *   indeterminate submissions never retry.
 * - `image_provider` (restricted enum) pins the run to exactly one route
 *   with no cross-route fallback; unknown/disabled routes are input_error.
 * - One 90 s time box per candidate (`IMAGE_SECONDS_PER_CANDIDATE`): the
 *   per-attempt budget, the whole-task budget and the batch per-candidate
 *   basis are all that same number; one cross-process capacity
 *   pool shared by every image task (default 10); the video pipeline keeps
 *   its own, entirely separate `seedance-cli` capacity.
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
import { packageRootOf } from './shared/pkg-root.ts'
import {
  DEFAULT_IMAGE_CONCURRENCY,
  SUPPORTED_RATIOS,
  SUPPORTED_RESOLUTIONS,
  SUPPORTED_IMAGE_PROVIDERS,
  runImageRouter,
  normalizeRatio,
  ratioToSize,
  type RouterConfig,
} from './shared/adapters.ts'
import { mediaErrors } from './shared/failure.ts'
import { DEFAULT_IMAGE_REQUEST_TIMEOUT_MS } from './shared/media-client.ts'
import {
  TaskStore,
  appendSafeLog,
  ensureDir,
  newTaskId,
  redactPrompt,
  resolvePrivateRoot,
} from './shared/private-runtime.ts'

/** Bundle root: the built tool file lives in dist/, so resolve from the package root. */
const PACKAGE_ROOT = packageRootOf(import.meta.url)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-image-gen'

/** Services required by the image-generation tool. */
export const inject = ['tools', 'fs', 'credentials']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  comflyBaseURL?: string
  comflyApiKeyEnv?: string
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
  dreaminaPath: z.string().default(join(PACKAGE_ROOT, 'bin', 'dreamina.exe')),
  proxyUrl: z.string().default(''),
  outputDir: z.string().default('outputs'),
  privateDir: z.string().default(''),
  maxConcurrency: z.number().default(DEFAULT_IMAGE_CONCURRENCY),
  providerTimeoutMs: z.number().default(DEFAULT_IMAGE_REQUEST_TIMEOUT_MS),
  taskTimeoutMs: z.number().default(DEFAULT_IMAGE_REQUEST_TIMEOUT_MS),
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
        '用统一媒体路由器生成或编辑图片并保存到 workspace，返回图片的绝对路径。image_ratio 必填（仅 21:9、16:9、3:2、4:3、1:1、3:4、2:3、9:16），缺失或不支持会在任何供应商调用前拒绝。默认图片线路是 comfly-gpt-image-2.5（Comfly gpt-image-2.5-sunburst），该线路只出 4K：提交 4K 具体像素尺寸，不传 resolution/response_format，图片读 data[0].b64_json 解码；用户给的是具体像素尺寸（如 1920x1080、1920×1080、1920*1080、1080x1920）时，直接把它填进 image_ratio 即可，工具自动换算成最接近的标准比例（1920x1080 → 16:9、1080x1920 → 9:16、2880x2880 → 1:1 等）再出图，无需自行换算。次选线路 comfly-gemini-flash-preview 仅出 2K（1K/4K 请求一律按 2K 执行）。image_provider 可选：仅当用户明确点名某条受支持线路时传入（comfly-gpt-image-2.5、comfly-gemini-flash-preview、dreamina-image；comfly-gpt-image-2 是 comfly-gpt-image-2.5 的兼容别名），指定后只走该线路、失败不回退；未知或禁用线路在任何供应商调用前以 input_error 拒绝。未点名线路时按 comfly-gpt-image-2.5 → comfly-gemini-flash-preview → dreamina-image 严格串行尝试，单张总预算 90 秒（单次尝试、整任务与每股基准是同一个时间盒）；只有错误类失败才进入下一适配器（超时类与下载失败直接判失败，不再换线路重复付费），提交结果不确定时标记 needs_review 且绝不自动重试。文生图传 prompt；图生图再传 image 参考图路径列表（顺序有语义）。参考图会做 EXIF 方向归一化并按最长边 1920px 等比缩放后提交，绝不覆盖原图。本工具只对出图数量与速度负责：生成后不做质量、审美或一致性检查，不逐张读图验收、不自动重生成；质量判断交由用户。全部图片任务（含 batch_image 与同一 workspace 的其他会话）共享一个跨进程容量池，默认最多 10 张图同时生成；视频容量独立。',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: '生成/编辑提示词，UTF-8，不能为空。',
        },
        image_ratio: {
          type: 'string',
          description: '必填：图片输出比例（21:9、16:9、3:2、4:3、1:1、3:4、2:3、9:16）；也接受用户给的具体像素尺寸（1920x1080、1920×1080、1920*1080、1080x1920 等写法均可），工具自动换算成最接近的标准比例后再生成。不得从参考图/提示词推断。',
        },
        image_resolution: {
          type: 'string',
          enum: [...SUPPORTED_RESOLUTIONS],
          description: '可选：图片输出分辨率（1K/2K/4K）。两条 Comfly 线路都是单档位、只钳制不报错：默认线路 comfly-gpt-image-2.5 只出 4K（传 1K/2K 按 4K 执行），comfly-gemini-flash-preview 只出 2K（传 1K/4K 按 2K 执行）；Dreamina 缺省 1K。用户要求的是具体像素尺寸（如 1920x1080）时不要用本字段，直接把像素尺寸传进 image_ratio，工具会自动换算成最接近的标准比例。',
        },
        image_provider: {
          type: 'string',
          enum: [...SUPPORTED_IMAGE_PROVIDERS, 'comfly-gpt-image-2'],
          description: '可选：用户明确点名的图片线路。默认线路是 comfly-gpt-image-2.5；comfly-gpt-image-2 是它的兼容别名。指定后只走该线路、失败不回退；未知或禁用线路在任何供应商调用前以 input_error 拒绝。',
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
            ratio: { type: 'string' },
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
        const requestedRatio = String(args.image_ratio ?? args.size ?? '').trim()
        if (requestedRatio.length === 0) {
          throw mediaErrors.input('image_ratio is required; choose one of: ' + SUPPORTED_RATIOS.join(', '))
        }
        // A concrete pixel request (1920x1080) is converted to the nearest standard ratio.
        const ratio = normalizeRatio(requestedRatio)
        const size = ratioToSize(ratio) // throws input_error for unsupported
        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)
        const taskId = newTaskId()
        const store = new TaskStore(join(privateRoot, 'jobs'))

        // resolve provider keys through the DSH credentials service (never env-only)
        const credentials: Record<string, string> = {}
        for (const env of [config.comflyApiKeyEnv]) {
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
            size: outcome.size ?? size,
            ratio,
            model: outcome.model,
            provider: outcome.provider,
            attempts: outcome.attempts.length,
            resolution: outcome.resolution ?? args.image_resolution ?? undefined,
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
