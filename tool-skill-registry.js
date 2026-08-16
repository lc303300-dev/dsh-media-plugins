import { r as validateContract, t as SkillRegistry } from "./registry-core.js";
import { l as resolvePrivateRoot } from "./private-runtime.js";
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
		description: "业务 Skill 治理（Codex_CS 的 DSH 重建）：摄取/检索/获取/发布/弃用业务视频 Skill。ingest 从 package_dir 读取 SKILL.md（frontmatter）、contract.json（名称、版本、视频比例/时长、素材槽 min/max/planned_count/count_rule）与 routing.json，做结构校验与去重（name@version + 内容哈希），发布前为 draft。search 用 SQLite FTS5 trigram 做中文友好检索（默认只搜已发布）。检索以用户创作意图为主，素材不作为主要路由依据。",
		parameters: {
			command: {
				type: "string",
				enum: [
					"ingest",
					"search",
					"get",
					"publish",
					"deprecate",
					"list"
				],
				required: true,
				description: "操作：ingest（摄取包目录）、search（检索）、get（取详情/契约）、publish（发布）、deprecate（弃用）、list（列出）。"
			},
			package_dir: {
				type: "string",
				description: "ingest 用：业务 Skill 包目录（含 SKILL.md / contract.json / routing.json）。"
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
				description: "search/list 返回条数上限，默认 10。"
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
					hits: { type: "array" }
				}
			},
			render(_args, value) {
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
						const [skillMd, contractRaw, routingRaw] = await Promise.all([
							readFile(join(dir, "SKILL.md"), "utf8").catch(() => ""),
							readJsonIfExists(join(dir, "contract.json")),
							readJsonIfExists(join(dir, "routing.json"))
						]);
						if (!contractRaw) return {
							ok: false,
							message: `contract.json not found in ${dir}`
						};
						const fm = parseFrontmatter(skillMd);
						const contract = validateContract(contractRaw);
						if (!contract.description && fm.description) contract.description = fm.description;
						if (!contract.taxonomy?.length && fm.name) contract.taxonomy = [fm.name];
						const record = registry.ingest({
							contract,
							routing: routingRaw ?? {},
							packageRoot: dir,
							provenance: skillMd ? "SKILL.md+contract.json" : "contract.json"
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
