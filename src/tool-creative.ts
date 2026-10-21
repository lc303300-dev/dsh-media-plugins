/**
 * Model-facing `creative_writer` tool: 创意写作子 Agent。
 *
 * 与 `describe_image` 同一种模式——主 Agent 不自己逐字创作，而是把创意写作
 * 任务分派给一个专职模型（默认 comfly 的 gemini-4-argon），拿回成品直接交付。
 * 这样主 Agent 的上下文只承载「需求 + 成品」，不承载创作过程。
 *
 * @module @deepseek-ai/dsh-tool-creative
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import sharp from 'sharp'
import { join } from 'node:path'
import { appendCreativeRecord, buildCreativeRecord, CREATIVE_LEDGER_FILE, parseCreativeLedger } from './shared/creative-ledger.ts'
import { atomicWriteJson, readJsonSafe, resolvePrivateRoot } from './shared/private-runtime.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-creative'

/** Services required by the creative writer. */
export const inject = ['tools', 'llm', 'fs', 'attachments']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Creative provider route (must be registered, e.g. via llm-pi-ai settings). */
  provider?: string
  /** Creative model id under that route. */
  model?: string
  /** Per-request output token cap (thinking variants spend budget on reasoning first). */
  maxTokens?: number
  /** Longest edge applied to reference images before they reach the model (default 1920). */
  maxImageEdge?: number
  /** Private runtime dir; must match `Ws_tool-prompt-batch` so the ledger is found. */
  privateDir?: string
}

export const Config: z<Config> = z.object({
  provider: z.string().default('comfly'),
  model: z.string().default('gemini-4-argon-thinking-high'),
  maxTokens: z.number().default(32768),
  maxImageEdge: z.number().default(1920),
  privateDir: z.string().default(''),
})

type ResolvedConfig = Required<Config>

/** Extensions `images` accepts, mapped to their declared media type. */
const IMAGE_MEDIA: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Upper bounds for one vision call. */
const MAX_IMAGES = 8
const MAX_READ_BYTES = 20 * 1024 * 1024

/** 体裁 → 该体裁的行业惯例要求，拼进系统提示词。 */
const KIND_GUIDE: Readonly<Record<string, string>> = {
  prompt:
    '视频/图片生成提示词。必须具体、可执行、可直接投喂生成模型：按「主体与外观、动作与镜头、场景与环境、光影与色调、材质与质感、风格与画质、稳定性/禁止项」组织；镜头语言用行业术语（景别、运镜、焦段、光位）但要让人看得懂；不要写成散文式抒情，不要出现「电影感」这类空泛词而不给参数。',
  script:
    '剧本/分镜脚本。场次划分清晰，每场标明场景、时间、人物；动作用可拍摄的描述而不是心理活动；台词口语自然、有潜台词；需要分镜时逐镜给出景别、运镜、时长与画面内容。',
  article:
    '文章。先立论再展开，有明确的中心观点与结构（标题、导语、小节、收束）；论据具体，避免正确的废话与套话；长文用小标题分段。',
  copy:
    '营销文案。短、有钩子、能落地。标题要能被点击，卖点要具体到可感知的利益点，避免堆形容词；若需求要求多版本，按数量给足且每版角度不同。',
  story:
    '故事/叙事文本。人物动机清晰可追溯，冲突具体，节奏有起伏，结尾有力；场景与动作承担叙事，少用解释性旁白。',
  other:
    '通用创意写作。先判断需求真正要的体裁（提示词、剧本、文章、文案、故事或其他），再按该体裁的行业惯例写。',
}

/** 篇幅档位 → 系统提示词里的字数指引。 */
const LENGTH_GUIDE: Readonly<Record<string, string>> = {
  short: '篇幅精简（约 200–400 字，或等价的结构量）。',
  medium: '篇幅适中（约 500–900 字，或等价的结构量）。',
  long: '篇幅充分（1200 字以上，或完整的多段/多场结构）。',
}

/** 思考档位 → comfly 的模型变体。不传档位时用 config 里的 `model`。 */
const THINKING_MODEL: Readonly<Record<string, string>> = {
  base: 'gemini-4-argon',
  low: 'gemini-4-argon-thinking-low',
  medium: 'gemini-4-argon-thinking-medium',
  high: 'gemini-4-argon-thinking-high',
}

/**
 * 解析本次调用实际使用的模型。
 * @param thinking - 调用方指定的思考档位；缺省时跟随配置（默认 thinking-high）。
 * @param configured - 配置里的默认模型 id。
 * @returns 模型 id；未知档位回落到配置值。
 */
function resolveModel(thinking: string | undefined, configured: string): string {
  if (thinking === undefined || thinking.length === 0) return configured
  return THINKING_MODEL[thinking] ?? configured
}

/**
 * 组装创意写作专家 persona。
 * @param kind - 体裁键，未知值按 `other` 处理。
 * @param length - 篇幅键，未知值按 `medium` 处理。
 * @param hasImages - 本次是否随消息附了参考图片。
 * @returns 完整的系统提示词。
 */
function systemPrompt(kind: string, length: string, hasImages = false): string {
  return [
    '你是一位资深的创意写作与提示词工程专家。调用方会把创作需求交给你，你唯一的任务是把需求直接写成可用的成品。',
    '',
    '硬性规则：',
    '1. 只输出成品正文。不要开场白（「好的」「以下是」），不要复述需求，不要写「如需修改请告知」这类收尾语。',
    '2. 不要附加创作思路、结构拆解、参数说明、精调建议或备选版本——除非需求明确要求。',
    '3. 成品正文不要用 Markdown 标题、加粗、分隔线；需要编号时用「1. 2. 3.」普通编号。'
      + '提示词类直接给可投喂的连续段落，不要分「一、二、」章节；只有分镜/场次这类体裁本身要求结构化时才逐条编号。',
    '4. 严格遵守需求里的规格：用途、受众、风格、篇幅、语言、格式。需求没说的，按该体裁的行业惯例处理。',
    '5. 语言跟随需求：中文需求用中文写，其他语言的需求用对应语言写。',
    '6. 只使用需求提供的信息。不要编造真实人物、品牌、数据、引用或来源。',
    '7. 不得用 Markdown 代码块包裹整篇成品。',
    '',
    `体裁要求：${KIND_GUIDE[kind] ?? KIND_GUIDE.other}`,
    '',
    `篇幅：${LENGTH_GUIDE[length] ?? LENGTH_GUIDE.medium}`,
    ...(hasImages
      ? ['', '参考图片已随消息附上：先读图再写；只写图中可见或需求明确给出的事实，不要用节令/风格先验补图中不存在的物件。']
      : []),
  ].join('\n')
}

/** Register the `creative_writer` tool. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig

  ctx.tools.register(defineTool({
    name: 'creative_writer',
    description:
      '创意写作子 Agent（默认 gemini-4-argon-thinking-high）：把「写提示词 / 剧本分镜 / 文章 / 营销文案 / 故事」这类创意任务一次性成稿交给它。'
      + '当用户要求创作或重写创意文本、且需要一份可直接交付的成品时使用；它会直接返回成品，不会再反问也不做文件操作。'
      + '主 Agent 只负责分派需求与验收，不必自己逐字创作。拿到返回文本即可交付或做少量编辑。'
      + '**可直接读图**：传 images（本地图片路径）时 Gemini 4 会先看图再写，适合实景/参考图/场景游览类提示词；'
      + '图片会 EXIF 归一化并按最长边 1920px（可配置 maxImageEdge）等比缩放、JPEG q85 后提交，不覆盖原图。'
      + '默认思考档位较高：实测 800 字提示词约 77 秒，长剧本 1–3 分钟；需要快速草稿时传 thinking=base。',
    parameters: {
      brief: {
        type: 'string',
        required: true,
        description: '创作需求：写什么、给谁看、什么用途、什么风格或调性、有什么必须包含/必须避免的内容。越具体成品越好。',
      },
      kind: {
        type: 'string',
        enum: ['prompt', 'script', 'article', 'copy', 'story', 'other'],
        description: '体裁：prompt=生成提示词，script=剧本/分镜，article=文章，copy=营销文案，story=故事，other=其他创意文本（默认）。',
      },
      context: {
        type: 'string',
        description: '可选参考材料：设定、已有文本、素材清单、品牌资料等。原样提供给创作模型。',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：本地参考图片路径（PNG/JPEG/WebP/GIF），最多 8 张，顺序有语义。传图后 Gemini 4 直接读图，适合实景/参考图/场景游览提示词；每张按最长边 1920px（配置 maxImageEdge）等比缩放、JPEG q85 后提交。',
      },
      length: {
        type: 'string',
        enum: ['short', 'medium', 'long'],
        description: '篇幅档位：short 精简，medium 适中（默认），long 充分展开。',
      },
      thinking: {
        type: 'string',
        enum: ['base', 'low', 'medium', 'high'],
        description: '思考强度：不传时用默认配置（gemini-4-argon-thinking-high，质量优先但较慢）；base=基础模型最快，low/medium 为中间档。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          model: { type: 'string', required: true },
          /** Ledger id proving this text came from a creative model (audit / gate). */
          credential_id: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args, exec) {
      const brief = (args.brief ?? '').trim()
      if (brief.length === 0) throw new Error('brief must be a non-empty string')

      const kind = args.kind ?? 'other'
      const length = args.length ?? 'medium'
      const model = resolveModel(args.thinking, resolved.model)

      const context = (args.context ?? '').trim()
      const imagePaths = Array.isArray(args.images)
        ? args.images.map((p: unknown) => String(p ?? '').trim()).filter((p) => p.length > 0)
        : []
      if (imagePaths.length > MAX_IMAGES) {
        throw new Error(`images: at most ${MAX_IMAGES} files per call`)
      }
      // Provider-input cap shared with the media pipeline: EXIF-normalize, then
      // fit inside `maxImageEdge` (default 1920) without ever enlarging. JPEG q85
      // is the pipeline's standard copy format; alpha is flattened to white.
      const edge = Math.max(256, Math.min(4096, Math.round(resolved.maxImageEdge)))
      const imageBlocks: any[] = []
      for (const filePath of imagePaths) {
        const dot = filePath.lastIndexOf('.')
        const mediaType = IMAGE_MEDIA[dot >= 0 ? filePath.slice(dot).toLowerCase() : '']
        if (mediaType === undefined) {
          throw new Error(`images only accepts PNG/JPEG/WebP/GIF paths: ${filePath}`)
        }
        const target = await ctx.fs.resolve(filePath)
        const raw = await ctx.fs.readBytes(target, exec.signal, MAX_READ_BYTES)
        const normalized = await sharp(raw)
          .rotate()
          .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 85 })
          .toBuffer()
        const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
        const name = `${base.replace(/\.[^.]+$/, '') || 'image'}.jpg`
        const ref = await ctx.attachments.saveImage({ data: normalized, mediaType: 'image/jpeg', name })
        imageBlocks.push({ type: 'image', attachment: ref })
      }

      const materials: string[] = []
      if (context.length > 0) materials.push(context)
      if (imageBlocks.length > 0) {
        materials.push(`见随附 ${imageBlocks.length} 张参考图片（按传入顺序；已按最长边 ${edge}px 归一化）。`)
      }
      const userText = materials.length > 0
        ? `创作需求：\n${brief}\n\n参考材料：\n${materials.join('\n\n')}`
        : `创作需求：\n${brief}`

      let text = ''
      let failure: string | null = null
      for await (const chunk of ctx.llm.stream({
        provider: resolved.provider,
        model,
        messages: [
          createSystemMessage(systemPrompt(kind, length, imageBlocks.length > 0)),
          createUserMessage({
            content: [{ type: 'text', text: userText }, ...imageBlocks] as any,
            source: { kind: 'plugin', plugin: 'Ws_tool-creative' },
          }),
        ],
        maxTokens: resolved.maxTokens,
        signal: exec.signal,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          failure = chunk.reason.failure.message
        }
      }
      if (failure !== null) throw new Error(failure)

      const trimmed = text.trim()
      if (trimmed.length === 0) {
        throw new Error(
          `creative model "${model}" returned no text`
          + '; a thinking variant can spend its whole budget on reasoning — raise maxTokens or pass thinking=base',
        )
      }
      // Record the creative credential so downstream gates (`prompt_batch set_prompts`)
      // can prove this text came from a creative model instead of self-reporting.
      // Best-effort: a ledger write failure must never discard text the model has
      // already produced (and billed).
      let credentialId: string | undefined
      try {
        const workspaceRoot: string = (exec as any)?.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, resolved.privateDir)
        const ledgerPath = join(privateRoot, CREATIVE_LEDGER_FILE)
        const record = buildCreativeRecord({ kind, model, brief, output: trimmed })
        const ledger = parseCreativeLedger(await readJsonSafe(ledgerPath))
        await atomicWriteJson(ledgerPath, appendCreativeRecord(ledger, record))
        credentialId = record.id
      } catch {
        credentialId = undefined
      }
      return credentialId === undefined
        ? { text: trimmed, model }
        : { text: trimmed, model, credential_id: credentialId }
    },
  }))
}
