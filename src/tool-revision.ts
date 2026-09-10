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
import { classifyVideoPromptCompleteness, completenessRequiresCorpus } from './shared/video-pipeline.ts'
import {
  consumeCredential,
  findCredential,
  gateCredentialError,
  issueCredential,
  ledgerStats,
  newSearchId,
  parseLedger,
} from './shared/corpus-ledger.ts'
import { atomicWriteJson, readJsonSafe, resolvePrivateRoot, sha256Text } from './shared/private-runtime.ts'
import { join } from 'node:path'

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
          description: '操作：classify（分类+生成修订请求）、search_corpus（语料检索）、validate_result（校验修订结果）、corpus_stats（语料规模）、authoring_gate（创作门：必须出示 search_corpus 发放的一次性检索凭证 search_id——凭证真实存在且未被消费才放行，通过即消费并绑定到 segment；同一凭证不可复用，因此每段都必须各自检索一次）。search_corpus 每次调用返回一个 search_id，凭证账本落在私有运行目录 `corpus-ledger.json`。',
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
        search_id: { type: 'string', description: 'authoring_gate 用：search_corpus 返回的一次性检索凭证（sq-xxxxxxxx）。必填——不再接受自报的 corpus_hits；同一凭证只能消费一次，所以 N 段必须 N 次检索。' },
        segment: { type: 'string', description: 'authoring_gate 用：该段标识（批次模式传该段 material 的绝对路径，凭证绑定到它供 set_prompts 校验）。单条模式可省略，缺省按提示词哈希标识。' },
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
            search_id: { type: 'string' },
            consumed_by: { type: 'string' },
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
          if (value?.search_id) lines.push('', `search_id: ${value.search_id}${value?.consumed_by ? ` → 已消费（${value.consumed_by}）` : '（一次性凭证，交给 authoring_gate）'}`)
          if (value?.completeness !== undefined) lines.push('', `completeness: ${value.completeness}`)
          if (Array.isArray(value?.reasons) && value.reasons.length > 0) lines.push(`reasons: ${value.reasons.join('; ')}`)
          if (value?.request) lines.push('', `request: ${JSON.stringify(value.request)}`)
          if (Array.isArray(value?.errors) && value.errors.length > 0) lines.push('', `errors: ${value.errors.join('; ')}`)
          const text = lines.join('\n').trim()
          return [{ type: 'text', text: text.length > 0 ? text : JSON.stringify(value) }]
        },
      },
      async execute(args: any, exec: any) {
        const command = args.command as string
        // 检索凭证账本：search_corpus 发证，authoring_gate 验证并消费（一次性）
        const workspaceRoot: string = exec?.agent?.session?.header?.cwd ?? process.cwd()
        const ledgerPath = join(resolvePrivateRoot(workspaceRoot), 'corpus-ledger.json')
        const loadLedger = async () => parseLedger(await readJsonSafe(ledgerPath))
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
          // 发一次性凭证：每段创作必须各自检索，凭证在 authoring_gate 处消费
          const { ledger, record } = issueCredential(await loadLedger(), {
            id: newSearchId(query),
            query,
            hits: matches.length,
            top_ids: matches.map((m) => String(m.id)),
            at: new Date().toISOString(),
          })
          await atomicWriteJson(ledgerPath, ledger)
          return {
            ok: true,
            message: `${matches.length} match(es) for "${query}" — search_id ${record.id}（该段检索凭证，只能使用一次）`,
            matches,
            search_id: record.id,
          }
        }
        if (command === 'validate_result') {
          const check = validateRevisionResult(args.result, args.request ?? undefined)
          return { ok: check.ok, message: check.ok ? 'revision result valid' : `invalid: ${check.errors.join('; ')}`, errors: check.errors }
        }
        if (command === 'authoring_gate') {
          const media = args.media ?? { images: 0, videos: 0, audios: 0 }
          const { verdict, reasons } = classifyVideoPromptCompleteness(String(args.current_prompt ?? ''), media)
          const requiresCorpus = completenessRequiresCorpus(verdict)
          const searchId = String(args.search_id ?? '').trim()
          const segment = String(args.segment ?? '').trim() || `prompt:${sha256Text(String(args.current_prompt ?? '')).slice(0, 12)}`
          const ledger = await loadLedger()
          // 硬门：凭证必须真实存在且尚未被消费；通过即消费并绑定到该段
          const credentialError = gateCredentialError(findCredential(ledger, searchId), searchId)
          if (credentialError) {
            return {
              ok: false,
              message: credentialError,
              completeness: verdict,
              requires_corpus: requiresCorpus,
              reasons,
              errors: [credentialError],
            }
          }
          const consumed = consumeCredential(ledger, searchId, segment, new Date().toISOString())
          if (!consumed.ok || !consumed.record) {
            const err = consumed.error ?? 'credential could not be consumed'
            return { ok: false, message: err, completeness: verdict, requires_corpus: requiresCorpus, reasons, errors: [err] }
          }
          await atomicWriteJson(ledgerPath, consumed.ledger)
          const stats = ledgerStats(consumed.ledger)
          return {
            ok: true,
            message: `authoring gate ok — completeness=${verdict}${reasons.length ? ` (${reasons.join('; ')})` : ''}; 凭证 ${searchId} 已消费并绑定到 ${segment}（命中 ${consumed.record.hits} 条，账本剩余 ${stats.available} 张未用凭证）`,
            completeness: verdict,
            requires_corpus: requiresCorpus,
            reasons,
            search_id: searchId,
            consumed_by: segment,
            corpus_hits: consumed.record.hits,
            errors: [],
          }
        }
        return { ok: false, message: `unknown command: ${command}` }
      },
    }),
  )
}

export { apply }
