import { r as validateContract, t as SkillRegistry } from "./registry-core.js";
import { d as resolvePrivateRoot } from "./private-runtime.js";
import { o as validateCodexFlowPackage, r as flowMetaToRegistryShape } from "./flow-format.js";
import { a as imageContractToRegistryContract } from "./image-skill-core.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
//#region src/tool-skill-registry.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-skill-registry";
const inject = ["tools"];
const Config = z.object({ privateDir: z.string().default("") });
/** Parse YAML frontmatter from a SKILL.md; returns {name, description} when present. */
function parseFrontmatter(text) {
	const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
	if (!m) return {};
	const out = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
		if (kv) out[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
	}
	return out;
}
async function readJsonIfExists(path) {
	try {
		await stat(path);
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return;
	}
}
function apply(ctx, config) {
	ctx.tools.register(defineTool({
		name: "skill_registry",
		description: "业务 Skill 治理（Codex_Flow 格式的 DSH 重建）：摄取/检索/获取/发布/弃用/路由/编译业务 Skill。ingest 从 package_dir 读取包：优先 Codex_Flow 格式（SKILL.md + meta.yaml + workflow.yaml + references/，校验器 flow-1.0 镜像上游 platform/skill_package.py 规则），兼容旧格式（SKILL.md + contract.json + routing.json）。search 用 SQLite FTS5 trigram 做中文友好检索（默认只搜已发布）。route 是快速路由（capability 过滤 + exclude-intents 排除 + 加权短语评分，≥60 判 specialized_skill，否则 image 能力回退 generic-image）；resolve 取运行时描述（entry/package_hash/references/load-at）；compile 把已发布记录编译为 codex-flow-registry/v2 registry.json。检索以用户创作意图为主，素材不作为主要路由依据。",
		parameters: {
			command: {
				type: "string",
				enum: [
					"ingest",
					"search",
					"get",
					"publish",
					"deprecate",
					"list",
					"route",
					"resolve",
					"compile"
				],
				required: true,
				description: "操作：ingest（摄取包目录）、search（检索）、get（取详情/契约）、publish（发布）、deprecate（弃用）、list（列出）、route（快速路由决策）、resolve（取运行时描述）、compile（编译 registry.json）。"
			},
			package_dir: {
				type: "string",
				description: "ingest 用：业务 Skill 包目录（Codex_Flow 格式：SKILL.md / meta.yaml / workflow.yaml；旧格式：SKILL.md / contract.json / routing.json）。"
			},
			query: {
				type: "string",
				description: "search 用：用户创作意图查询词。"
			},
			name: {
				type: "string",
				description: "get/publish/deprecate 用：Skill 名称。"
			},
			version: {
				type: "string",
				description: "可选：Skill 版本；缺省取最新。"
			},
			status: {
				type: "string",
				enum: [
					"draft",
					"published",
					"deprecated",
					"any"
				],
				description: "search/list 用：状态过滤，search 默认 published。"
			},
			limit: {
				type: "integer",
				description: "search/list/route 返回条数上限，默认 10。"
			},
			capability: {
				type: "string",
				description: "route 用：能力过滤（默认 image.generate；视频用 video.generate）。"
			},
			registry_path: {
				type: "string",
				description: "compile 用：registry.json 输出路径（默认 <private>/registry/registry.json）。"
			},
			force: {
				type: "boolean",
				description: "ingest 用：同名同版本内容变化时是否强制覆盖（默认拒绝）。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: { type: "string" },
					skill: {
						type: "object",
						additionalProperties: true
					},
					skills: { type: "array" },
					hits: { type: "array" },
					decision: {
						type: "object",
						additionalProperties: true
					},
					candidates: { type: "array" },
					runtime: {
						type: "object",
						additionalProperties: true
					},
					available: { type: "boolean" },
					indexed: { type: "number" },
					rejected: { type: "array" },
					registry: { type: "string" },
					issues: { type: "array" }
				}
			},
			render(_args, value) {
				if (value?.hits && Array.isArray(value.hits)) {
					const lines = value.hits.map((h, i) => {
						const reasons = Array.isArray(h.matched_reasons) ? h.matched_reasons.join("；") : "";
						const neg = Array.isArray(h.negative_hits) && h.negative_hits.length > 0 ? `（排除：${h.negative_hits.join("、")}）` : "";
						return `${i + 1}. ${h.name}@${h.version} [${h.status}] 评分${h.score ?? ""}\n   ${h.description ?? ""}${reasons ? `\n   匹配：${reasons}` : ""}${neg}`;
					});
					return [{
						type: "text",
						text: `${value.message ?? ""}\n${lines.join("\n")}`
					}];
				}
				if (value?.skills && Array.isArray(value.skills)) {
					const lines = value.skills.map((s, i) => `${i + 1}. ${s.name}@${s.version} [${s.status}]`);
					return [{
						type: "text",
						text: `${value.message ?? ""}\n${lines.join("\n")}`
					}];
				}
				if (value?.skill && typeof value.skill === "object") {
					const s = value.skill;
					const parts = [`${s.name}@${s.version} [${s.status}]`, s.description ? `描述：${s.description}` : ""];
					const contract = s.contract ?? {};
					if (contract.video) {
						const v = contract.video;
						parts.push(`视频：比例 ${(v.ratios ?? []).join("/")}，时长 ${v.duration_min ?? "?"}-${v.duration_max ?? "?"}s`);
					}
					if (contract.image) {
						const im = contract.image;
						parts.push(`图片：${im.input_mode ?? ""}，比例 ${(im.supported_ratios ?? []).join("/")}，场景 ${im.scene_count?.min ?? 1}-${im.scene_count?.max ?? 1}，候选 ${im.candidate_count_per_scene?.min ?? 1}-${im.candidate_count_per_scene?.max ?? 1}，批量${im.batch_allowed ? "支持" : "不支持"}`);
					}
					if (Array.isArray(contract.slots)) for (const slot of contract.slots) parts.push(`槽 ${slot.id}：${slot.label ?? ""} min ${slot.min ?? 0} max ${slot.max ?? 0}`);
					if (Array.isArray(contract.references)) for (const ref of contract.references) parts.push(`素材 ${ref.id}：${ref.description ?? ""} 必选${ref.required ? "是" : "否"} ${ref.min_count ?? 0}-${ref.max_count ?? 0}张`);
					return [{
						type: "text",
						text: `${value.message ?? ""}\n${parts.filter(Boolean).join("\n")}`
					}];
				}
				return [{
					type: "text",
					text: value.message ?? JSON.stringify(value)
				}];
			}
		},
		async execute(args, exec) {
			const command = args.command;
			const workspaceRoot = exec.agent?.session?.header?.cwd ?? process.cwd();
			const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir);
			const registry = new SkillRegistry(join(privateRoot, "registry", "registry.db"));
			try {
				switch (command) {
					case "ingest": {
						if (!args.package_dir) return {
							ok: false,
							message: "ingest requires package_dir"
						};
						const dir = isAbsolute(args.package_dir) ? args.package_dir : join(workspaceRoot, args.package_dir);
						const [skillMd, contractRaw, routingRaw, metaRaw] = await Promise.all([
							readFile(join(dir, "SKILL.md"), "utf8").catch(() => ""),
							readJsonIfExists(join(dir, "contract.json")),
							readJsonIfExists(join(dir, "routing.json")),
							readFile(join(dir, "meta.yaml"), "utf8").catch(() => "")
						]);
						if (metaRaw.trim().length > 0) {
							const flowIssues = validateCodexFlowPackage(dir);
							if (flowIssues.length > 0) return {
								ok: false,
								message: `Codex_Flow validation failed (${flowIssues.length} issue(s)): ${flowIssues.slice(0, 8).join(", ")}`,
								issues: flowIssues
							};
							const shape = flowMetaToRegistryShape(dir);
							const contract = validateContract({
								name: shape.name,
								version: shape.version,
								description: shape.description,
								taxonomy: shape.taxonomy,
								flow: shape.flow
							});
							const routing = {
								aliases: shape.taxonomy,
								negative_intents: shape.flow.exclude_intents ?? []
							};
							const record = registry.ingest({
								contract,
								routing,
								packageRoot: dir,
								provenance: skillMd ? "SKILL.md+meta.yaml (codex-flow)" : "meta.yaml (codex-flow)"
							}, { force: Boolean(args.force) });
							return {
								ok: true,
								message: `ingested ${record.name}@${record.version} as ${record.status} (codex-flow)`,
								skill: record
							};
						}
						if (!contractRaw) return {
							ok: false,
							message: `contract.json not found in ${dir} (no meta.yaml either)`
						};
						const fm = parseFrontmatter(skillMd);
						const isImageSkill = typeof contractRaw.skill_id === "string" && "input_mode" in contractRaw && !("name" in contractRaw);
						const contract = isImageSkill ? imageContractToRegistryContract(contractRaw, routingRaw ?? {}, String(args.version ?? "1.0.0")) : validateContract(contractRaw);
						if (!contract.description && fm.description) contract.description = fm.description;
						if (!contract.taxonomy?.length && fm.name) contract.taxonomy = [fm.name];
						const record = registry.ingest({
							contract,
							routing: routingRaw ?? {},
							packageRoot: dir,
							provenance: isImageSkill ? "SKILL.md+contract.json (image)" : skillMd ? "SKILL.md+contract.json" : "contract.json"
						}, { force: Boolean(args.force) });
						return {
							ok: true,
							message: `ingested ${record.name}@${record.version} as ${record.status}`,
							skill: record
						};
					}
					case "search": {
						const hits = registry.search(String(args.query ?? ""), args.limit ?? 10, args.status ?? "published");
						return {
							ok: true,
							message: `${hits.length} hit(s)`,
							hits
						};
					}
					case "get": {
						if (!args.name) return {
							ok: false,
							message: "get requires name"
						};
						const record = registry.get(args.name, args.version);
						return record ? {
							ok: true,
							message: `skill ${record.name}@${record.version} (${record.status})`,
							skill: record
						} : {
							ok: false,
							message: `skill not found: ${args.name}@${args.version ?? "latest"}`
						};
					}
					case "publish": {
						if (!args.name) return {
							ok: false,
							message: "publish requires name"
						};
						const record = registry.setStatus(args.name, args.version ?? "", "published");
						return {
							ok: true,
							message: `published ${record.name}@${record.version}`,
							skill: record
						};
					}
					case "deprecate": {
						if (!args.name) return {
							ok: false,
							message: "deprecate requires name"
						};
						const record = registry.setStatus(args.name, args.version ?? "", "deprecated");
						return {
							ok: true,
							message: `deprecated ${record.name}@${record.version}`,
							skill: record
						};
					}
					case "list": {
						const status = args.status === "any" ? void 0 : args.status || void 0;
						const skills = registry.list(status, args.limit ?? 100);
						return {
							ok: true,
							message: `${skills.length} skill(s)`,
							skills: skills.map((s) => ({
								id: s.id,
								name: s.name,
								version: s.version,
								status: s.status
							}))
						};
					}
					case "route": {
						const result = registry.route(String(args.query ?? ""), String(args.capability ?? "image.generate"), args.limit ?? 3);
						return {
							ok: true,
							message: `route decision: ${result.decision.mode} (${result.decision.skill_id ?? "none"})`,
							decision: result.decision,
							candidates: result.candidates
						};
					}
					case "resolve": {
						if (!args.name) return {
							ok: false,
							message: "resolve requires name"
						};
						const resolved = registry.resolve(args.name, args.version);
						return {
							ok: true,
							message: `resolved ${args.name}@${resolved.record.version}`,
							skill: resolved.record,
							runtime: resolved.runtime,
							available: resolved.available
						};
					}
					case "compile": {
						const registryPath = args.registry_path && String(args.registry_path).trim().length > 0 ? isAbsolute(args.registry_path) ? args.registry_path : join(workspaceRoot, args.registry_path) : join(privateRoot, "registry", "registry.json");
						const result = registry.compile(registryPath);
						return {
							ok: true,
							message: `compiled ${result.indexed} skill(s) to ${result.registry}`,
							indexed: result.indexed,
							rejected: result.rejected,
							registry: result.registry
						};
					}
					default: return {
						ok: false,
						message: `unknown command: ${command}`
					};
				}
			} finally {
				registry.close();
			}
		}
	}));
}
//#endregion
export { Config, apply, inject, name };
