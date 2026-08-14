/**
 * Model-facing `describe_image` tool: read a local image and ask a vision model
 * (Volcengine Doubao) for a text description. This is the "vision sub-model
 * bridge": the text model stays the brain, the vision model only "sees" pixels
 * and returns text — the exact split OpenClaw documents as `image` tool +
 * `imageModel` routing.
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
    description: '用火山方舟 Doubao 视觉模型分析一张本地图片，返回图片内容的中文描述。当你需要看图（识别文字、对象、界面、报错截图等）但当前主模型无法直接读图时，调用本工具。',
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
