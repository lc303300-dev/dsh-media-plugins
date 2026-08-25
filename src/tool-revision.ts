/**
 * Prompt revision tool (Codex_DT rebuild): deterministic feedback
 * classification, constrained revision request/result contract with
 * canonical hashes, and bounded corpus search. The classifier never
 * rewrites prompts, never submits media; actual authoring stays with the
 * agent, constrained by the emitted request.
 *
 * @module @deepseek-ai/dsh-tool-revision
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildRevisionRequest, validateRevisionInput, validateRevisionResult } from './shared/revision-core.ts'
import { searchCorpus, corpusSize } from './shared/corpus-core.ts'
import { classifyVideoPromptCompleteness, completenessRequiresCorpus, authoringCorpusGateError } from './shared/video-pipeline.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-revision'
export const inject = ['tools']

export interface Config {
  /** Optional external corpus index path (defaults to the bundled refs/forge-index.jsonl). */
  indexPath?: string
}

export const Config: z<Config> = z.object({
  indexPath: z.string().default(''),
})

type ResolvedConfig = Required<Config>

function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'prompt_revision',
      description:
        '提示词修订工作台（Codex_DT classify_revision 的 DSH 重建）：classify 用确定性正则把用户反馈分类为 explicit_local / ambiguous_creative / structural_rewrite，输出带规范哈希（current_prompt_sha256 + locked_context_sha256）的受约束修订请求（explicit_local 禁语料，其余最多 10 条）；search_corpus 检索内置 seedance-forge 语料（≤10 条，保留 provenance，语料模型版本绝不用于选模型）；validate_result 校验修订结果（必须回显同一 locked_context_sha256，preserved_unspecified_content 必须为 true，explicit_local 不得带语料命中）。分类器不改写提示词、不提交媒体。',
      parameters: {
        command: {
          type: 'string',
          enum: ['classify', 'search_corpus', 'validate_result', 'corpus_stats', 'authoring_gate'],
          required: true,
          description: '操作：classify（分类+生成修订请求）、search_corpus（语料检索）、validate_result（校验修订结果）、corpus_stats（语料规模）、authoring_gate（创作门：本路径必查语料——complete/不完整 都必须已检索语料，corpus_hits<1 即拒绝）。',
        },
        current_prompt: { type: 'string', description: 'classify/authoring_gate 用：当前/待创作提示词。' },
        user_feedback: { type: 'string', description: 'classify 用：用户本轮修改意见。' },
        locked_context: {
          type: 'object',
          additionalProperties: true,
          description: 'classify 用：{contract_rules: string[], material_order: string[], ratio, duration_seconds} 锁定上下文。',
        },
        query: { type: 'string', description: 'search_corpus 用：检索词。' },
        limit: { type: 'integer', description: 'search_corpus 用：返回条数上限（默认 10，契约上限 10）。' },
        result: { type: 'object', additionalProperties: true, description: 'validate_result 用：修订结果 JSON。' },
        request: { type: 'object', additionalProperties: true, description: 'validate_result 用：对应的修订请求（含 locked_context_sha256）。' },
        media: { type: 'object', additionalProperties: true, description: 'authoring_gate 用：{images, videos, audios} 素材数量。' },
        corpus_hits: { type: 'integer', description: 'authoring_gate 用：已检索到的语料命中数（search_corpus 结果数）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string' },
            request: { type: 'object', additionalProperties: true },
            matches: { type: 'array' },
            errors: { type: 'array' },
            corpus_size: { type: 'integer' },
          },
        },
        render(_args: unknown, value: any) {
          const lines: string[] = []
          if (value?.message) lines.push(String(value.message))
          if (Array.isArray(value?.matches) && value.matches.length > 0) {
            lines.push('', '命中明细：')
            value.matches.forEach((m: any, i: number) => {
              const author = m?.author && typeof m.author === 'object' ? m.author.name : ''
              const model = m?.source_model ?? m?.source_metadata?.model ?? ''
              lines.push(`${i + 1}. [${m?.id ?? ''}] ${m?.title ?? ''}  (score=${m?.score ?? 0}${model ? `, model=${model}` : ''}${author ? `, author=${author}` : ''})`)
              if (m?.portable_pattern) lines.push(`   可迁移结构: ${m.portable_pattern}`)
              if (m?.content_preview) lines.push(`   内容预览: ${m.content_preview}`)
            })
          }
          if (value?.completeness !== undefined) lines.push('', `completeness: ${value.completeness}`)
          if (Array.isArray(value?.reasons) && value.reasons.length > 0) lines.push(`reasons: ${value.reasons.join('; ')}`)
          if (value?.request) lines.push('', `request: ${JSON.stringify(value.request)}`)
          if (Array.isArray(value?.errors) && value.errors.length > 0) lines.push('', `errors: ${value.errors.join('; ')}`)
          const text = lines.join('\n').trim()
          return [{ type: 'text', text: text.length > 0 ? text : JSON.stringify(value) }]
        },
      },
      async execute(args: any, _exec: any) {
        const command = args.command as string
        if (command === 'corpus_stats') {
          const size = corpusSize(config.indexPath)
          return { ok: true, message: `corpus entries: ${size}`, corpus_size: size }
        }
        if (command === 'classify') {
          try {
            const input = {
              current_prompt: String(args.current_prompt ?? ''),
              user_feedback: String(args.user_feedback ?? ''),
              locked_context: args.locked_context,
            }
            validateRevisionInput(input)
            const request = buildRevisionRequest(input)
            return { ok: true, message: `classified: ${request.classification}`, request }
          } catch (error: any) {
            return { ok: false, message: String(error?.message ?? error) }
          }
        }
        if (command === 'search_corpus') {
          const query = String(args.query ?? '').trim()
          if (!query) return { ok: false, message: 'query is required' }
          const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 10)
          const matches = searchCorpus(query, limit, config.indexPath)
          return { ok: true, message: `${matches.length} match(es) for "${query}"`, matches }
        }
        if (command === 'validate_result') {
          const check = validateRevisionResult(args.result, args.request ?? undefined)
          return { ok: check.ok, message: check.ok ? 'revision result valid' : `invalid: ${check.errors.join('; ')}`, errors: check.errors }
        }
        if (command === 'authoring_gate') {
          const media = args.media ?? { images: 0, videos: 0, audios: 0 }
          const { verdict, reasons } = classifyVideoPromptCompleteness(String(args.current_prompt ?? ''), media)
          const requiresCorpus = completenessRequiresCorpus(verdict)
          const hits = Number(args.corpus_hits ?? 0)
          const err = authoringCorpusGateError(verdict, hits)
          return {
            ok: !err,
            message: err ?? `authoring gate ok — completeness=${verdict}${reasons.length ? ` (${reasons.join('; ')})` : ''}, corpus consulted (${hits})`,
            completeness: verdict,
            requires_corpus: requiresCorpus,
            reasons,
            corpus_hits: hits,
            errors: err ? [err] : [],
          }
        }
        return { ok: false, message: `unknown command: ${command}` }
      },
    }),
  )
}

export { apply }
