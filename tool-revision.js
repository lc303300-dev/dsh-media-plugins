import { n as validateRevisionInput, r as validateRevisionResult, t as buildRevisionRequest } from "./revision-core.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accessSync, readFileSync } from "node:fs";
//#region src/shared/corpus-core.ts
/**
* Corpus search (seedance-forge port, all-JS): ranking mirrors the Codex_DT
* `native_score` (title×4 + category×3 + description×2 + content×1), results
* keep full provenance, and source model/version is metadata only — it must
* never select the runtime generation model. Revision usage caps at 3.
*
* @module dsh-media-plugins/shared/corpus-core
*/
let cachedRows = null;
/** Locate the bundled corpus index (built chunk at package root vs src tree). */
function resolveIndexPath(explicit) {
	if (explicit && explicit.trim().length > 0) return explicit;
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, "refs", "forge-index.jsonl"), join(here, "..", "..", "refs", "forge-index.jsonl")];
	for (const candidate of candidates) try {
		accessSync(candidate);
		return candidate;
	} catch {}
	return candidates[0];
}
/** Load corpus rows (cached); JSONL, id-keyed, tolerant of blank lines. */
function loadCorpus(indexPath) {
	if (cachedRows) return cachedRows;
	const path = resolveIndexPath(indexPath);
	const rows = [];
	const raw = readFileSync(path, "utf8");
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			if (row && typeof row.id === "string" && row.id.length > 0) rows.push(row);
		} catch {}
	}
	cachedRows = rows;
	return rows;
}
/** Ranking mirrors seedance-forge native scoring. */
function scoreCorpusRow(row, query) {
	const title = String(row.title ?? "").toLowerCase();
	const category = String(row.category ?? "").toLowerCase();
	const description = String(row.description ?? "").toLowerCase();
	const content = String(row.content ?? "").toLowerCase();
	let score = 0;
	for (const keyword of query.toLowerCase().split(/\s+/).filter(Boolean)) {
		score += (title.split(keyword).length - 1) * 4;
		score += (category.split(keyword).length - 1) * 3;
		score += (description.split(keyword).length - 1) * 2;
		score += content.split(keyword).length - 1;
	}
	return score;
}
/** Compact text to a preview. */
function compactPreview(text, limit) {
	const clean = (text ?? "").replace(/\s+/g, " ").trim();
	if (clean.length <= limit) return clean;
	return clean.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
}
/** A transferable structural hint extracted from a corpus entry (never copied wholesale). */
function portablePatternOf(row) {
	const content = String(row.content ?? "").trim();
	const description = String(row.description ?? "").trim();
	if (content.length > 0) return compactPreview(content, 200);
	if (description.length > 0) return compactPreview(description, 200);
	return String(row.title ?? "");
}
function parseAuthor(raw) {
	if (raw && typeof raw === "object") {
		const obj = raw;
		return {
			name: String(obj.name ?? ""),
			link: String(obj.link ?? "")
		};
	}
	if (typeof raw === "string" && raw.length > 0) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object") return {
				name: String(parsed.name ?? ""),
				link: String(parsed.link ?? "")
			};
		} catch {}
		return {
			name: raw,
			link: ""
		};
	}
	return {
		name: "",
		link: ""
	};
}
/** Convert a row into the revision-result match shape (provenance preserved). */
function toCorpusMatch(row, previewChars = 500) {
	const sourceModel = String(row.seedance_version ?? "");
	return {
		id: row.id,
		title: String(row.title ?? ""),
		description: String(row.description ?? ""),
		score: 0,
		length: String(row.content ?? "").length,
		content_preview: compactPreview(String(row.content ?? row.description ?? ""), previewChars),
		author: parseAuthor(row.author),
		sourceLink: String(row.sourceLink ?? ""),
		sourcePublishedAt: String(row.sourcePublishedAt ?? ""),
		source_model: sourceModel,
		source_metadata: {
			model: sourceModel,
			repository: String(row.source_repo ?? ""),
			license: String(row.source_license ?? "")
		},
		portable_pattern: portablePatternOf(row)
	};
}
/** Search the corpus; `top` capped at 3 for revision usage by contract. */
function searchCorpus(query, top = 3, indexPath) {
	const clean = (query ?? "").trim();
	if (!clean) return [];
	return loadCorpus(indexPath).map((row) => ({
		row,
		score: scoreCorpusRow(row, clean)
	})).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(top, 3))).map((entry) => ({
		...toCorpusMatch(entry.row),
		score: entry.score
	}));
}
/** Count of bundled corpus entries (readiness reporting). */
function corpusSize(indexPath) {
	return loadCorpus(indexPath).length;
}
//#endregion
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
				const matches = searchCorpus(query, Math.min(Math.max(Number(args.limit ?? 3), 1), 3), config.indexPath);
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
