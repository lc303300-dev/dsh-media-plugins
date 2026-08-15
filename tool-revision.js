import { n as validateRevisionInput, r as validateRevisionResult, t as buildRevisionRequest } from "./revision-core.js";
import { n as searchCorpus, t as corpusSize } from "./corpus-core.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/tool-revision.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-revision";
const inject = ["tools"];
const Config = z.object({ indexPath: z.string().default("") });
function apply(ctx, config) {
	ctx.tools.register(defineTool({
		name: "prompt_revision",
		description: "提示词修订工作台（Codex_DT classify_revision 的 DSH 重建）：classify 用确定性正则把用户反馈分类为 explicit_local / ambiguous_creative / structural_rewrite，输出带规范哈希（current_prompt_sha256 + locked_context_sha256）的受约束修订请求（explicit_local 禁语料，其余最多 3 条）；search_corpus 检索内置 seedance-forge 语料（≤3 条，保留 provenance，语料模型版本绝不用于选模型）；validate_result 校验修订结果（必须回显同一 locked_context_sha256，preserved_unspecified_content 必须为 true，explicit_local 不得带语料命中）。分类器不改写提示词、不提交媒体。",
		parameters: {
			command: {
				type: "string",
				enum: [
					"classify",
					"search_corpus",
					"validate_result",
					"corpus_stats"
				],
				required: true,
				description: "操作：classify（分类+生成修订请求）、search_corpus（语料检索）、validate_result（校验修订结果）、corpus_stats（语料规模）。"
			},
			current_prompt: {
				type: "string",
				description: "classify 用：当前提示词（CS Skill 首稿）。"
			},
			user_feedback: {
				type: "string",
				description: "classify 用：用户本轮修改意见。"
			},
			locked_context: {
				type: "object",
				additionalProperties: true,
				description: "classify 用：{contract_rules: string[], material_order: string[], ratio, duration_seconds} 锁定上下文。"
			},
			query: {
				type: "string",
				description: "search_corpus 用：检索词。"
			},
			limit: {
				type: "integer",
				description: "search_corpus 用：返回条数上限（默认 3，契约上限 3）。"
			},
			result: {
				type: "object",
				additionalProperties: true,
				description: "validate_result 用：修订结果 JSON。"
			},
			request: {
				type: "object",
				additionalProperties: true,
				description: "validate_result 用：对应的修订请求（含 locked_context_sha256）。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: { type: "string" },
					request: {
						type: "object",
						additionalProperties: true
					},
					matches: { type: "array" },
					errors: { type: "array" },
					corpus_size: { type: "integer" }
				}
			},
			render(_args, value) {
				return [{
					type: "text",
					text: value.message ?? JSON.stringify(value)
				}];
			}
		},
		async execute(args, _exec) {
			const command = args.command;
			if (command === "corpus_stats") {
				const size = corpusSize(config.indexPath);
				return {
					ok: true,
					message: `corpus entries: ${size}`,
					corpus_size: size
				};
			}
			if (command === "classify") try {
				const input = {
					current_prompt: String(args.current_prompt ?? ""),
					user_feedback: String(args.user_feedback ?? ""),
					locked_context: args.locked_context
				};
				validateRevisionInput(input);
				const request = buildRevisionRequest(input);
				return {
					ok: true,
					message: `classified: ${request.classification}`,
					request
				};
			} catch (error) {
				return {
					ok: false,
					message: String(error?.message ?? error)
				};
			}
			if (command === "search_corpus") {
				const query = String(args.query ?? "").trim();
				if (!query) return {
					ok: false,
					message: "query is required"
				};
				const limit = Math.min(Math.max(Number(args.limit ?? 3), 1), 3);
				const matches = searchCorpus(query, limit, config.indexPath);
				return {
					ok: true,
					message: `${matches.length} match(es) for "${query}"`,
					matches
				};
			}
			if (command === "validate_result") {
				const check = validateRevisionResult(args.result, args.request ?? void 0);
				return {
					ok: check.ok,
					message: check.ok ? "revision result valid" : `invalid: ${check.errors.join("; ")}`,
					errors: check.errors
				};
			}
			return {
				ok: false,
				message: `unknown command: ${command}`
			};
		}
	}));
}
//#endregion
export { Config, apply, inject, name };
