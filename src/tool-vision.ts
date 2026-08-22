/**
 * Model-facing `describe_image` tool: FALLBACK-ONLY image viewing. When the
 * current main model cannot read images, bridge to a vision sub-model
 * (Volcengine Doubao) that "sees" pixels and returns a text description. When
 * the main model IS image-capable, the tool refuses and steers to the core
 * `read_image` tool, so it never burns a second vision-model call.
 * @module @deepseek-ai/dsh-tool-vision
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-vision'

/** Services required by the vision tool. */
export const inject = ['tools', 'fs', 'attachments', 'llm']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Vision provider route (must be registered, e.g. via llm-pi-ai settings). */
  provider?: string
  /** Vision model id under that route. */
  model?: string
  /** Per-request output token cap. */
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  provider: z.string().default('volcengine'),
  model: z.string().default('doubao-seed-2-0-mini-260428'),
  maxTokens: z.number().default(4096),
})

type ResolvedConfig = Required<Config>

/** Extensions `describe_image` accepts, mapped to their declared media type. */
const IMAGE_MEDIA: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Register the `describe_image` tool. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig

  ctx.tools.register(defineTool({
    name: 'describe_image',
    description: '兜底看图工具：仅当当前主模型无法直接读图时，用火山方舟 Doubao 视觉模型分析本地图片并返回中文描述。若主模型可读图（视觉模型），请直接使用 read_image 读图，不要调用本工具——本工具此时会拒绝并提示改用 read_image。',
    parameters: {
      file_path: { type: 'string', required: true, description: '图片文件路径（PNG/JPEG/WebP/GIF），由文件系统后端解析。' },
      prompt: { type: 'string', description: '可选的视觉提示词，指定要识别/回答的内容；省略时默认详细描述图片。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args, exec) {
      const filePath = args.file_path.trim()
      if (filePath.length === 0) throw new Error('file_path must be a non-empty string')

      const dot = filePath.lastIndexOf('.')
      const mediaType = IMAGE_MEDIA[dot >= 0 ? filePath.slice(dot).toLowerCase() : '']
      if (mediaType === undefined) {
        throw new Error('describe_image only accepts PNG/JPEG/WebP/GIF paths')
      }

      // Fallback-only gate: this bridge is for main models that cannot read
      // images. Only refuse when the core `read_image` tool is actually
      // registered AND the calling route declares `image` input — i.e. a real
      // native path exists. Otherwise fall back to Doubao so the agent still
      // gets a description.
      const routed = exec.agent?.session.requestHeader()?.config
      const provider = routed?.provider ?? exec.agent?.options.provider
      const model = routed?.model ?? exec.agent?.options.model
      if (provider !== undefined && model !== undefined && ctx.tools.get('read_image') !== undefined) {
        const active = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
        if (active.inputModalities?.includes('image')) {
          throw new Error(
            `describe_image is a fallback-only tool: the current main model ("${model}") can read images natively, so use the read_image tool on this file instead. describe_image only applies when the main model cannot read images.`,
          )
        }
      }

      const prompt = args.prompt?.trim() || 'Describe the image in detail.'

      const target = await ctx.fs.resolve(filePath)
      const data = await ctx.fs.readBytes(target, exec.signal, 10 * 1024 * 1024)
      const slash = filePath.lastIndexOf('/')
      const back = filePath.lastIndexOf('\\')
      const name = filePath.slice(Math.max(slash, back) + 1)
      const ref = await ctx.attachments.saveImage({ data, mediaType, name })

      let text = ''
      let failure: string | null = null
      for await (const chunk of ctx.llm.stream({
        provider: resolved.provider,
        model: resolved.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: prompt }, { type: 'image', attachment: ref }],
          source: { kind: 'plugin', plugin: 'Ws_tool-vision' },
        })],
        maxTokens: resolved.maxTokens,
        signal: exec.signal,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          failure = chunk.reason.failure.message
        }
      }
      if (failure !== null) throw new Error(failure)
      if (text.trim().length === 0) throw new Error('vision model returned no text')
      return { text }
    },
  }))
}
