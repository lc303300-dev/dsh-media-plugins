import { d as resolvePrivateRoot } from "./private-runtime.js";
import { t as corpusSize } from "./corpus-core.js";
import { t as resolveFfmpeg } from "./gif-core.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/tool-status.ts
const execFileAsync = promisify(execFile);
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-status";
const inject = ["tools", "credentials"];
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const Config = z.object({
	privateDir: z.string().default(""),
	dreaminaPath: z.string().default(join(PACKAGE_ROOT, "bin", "dreamina.exe"))
});
function apply(ctx, config) {
	ctx.tools.register(defineTool({
		name: "media_status",
		description: "媒体与业务工具就绪检查（get-pipeline-setup-status / verify-deployment 的 DSH 重建，只读）：status 按 ready/degraded/unavailable 报告各工具状态（图片工具=任一适配器可用即 degraded、主通道 Comfly 就绪即 ready；视频工具=Dreamina 可用才 ready；skill_registry=SQLite 注册库；prompt_revision=语料库；video_to_gif=ffmpeg）；verify 做部署验证（凭证存在性只报变量名、dreamina 二进制/登录/只读 user_credit、ffmpeg、私有运行目录可写、语料可加载、注册库可开）。绝不输出密钥值或完整登录材料。",
		parameters: { command: {
			type: "string",
			enum: ["status", "verify"],
			required: true,
			description: "操作命令：status（工具状态）或 verify（部署验证）。"
		} },
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
					tools: {
						type: "object",
						additionalProperties: true
					},
					providers: {
						type: "object",
						additionalProperties: true
					},
					deployment: {
						type: "object",
						additionalProperties: true
					}
				}
			},
			render(_args, value) {
				return [{
					type: "text",
					text: value.message ?? JSON.stringify(value)
				}];
			}
		},
		async execute(_args, exec) {
			const workspaceRoot = exec.agent?.session?.header?.cwd ?? process.cwd();
			const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir);
			const creds = {};
			for (const env of [
				"COMFLY_API_KEY",
				"APIMART_API_KEY",
				"GEMINI_API_KEY",
				"VOLCANO_ENGINE_API_KEY"
			]) try {
				const resolved = await ctx.credentials?.resolve(credentialRef(env));
				creds[env] = Boolean(resolved?.value);
			} catch {
				creds[env] = false;
			}
			let dreaminaBinary = false;
			let dreaminaLogin = false;
			let dreaminaCredit = null;
			try {
				await access(config.dreaminaPath);
				dreaminaBinary = true;
				try {
					const out = await execFileAsync(config.dreaminaPath, ["user_credit"], {
						timeout: 2e4,
						windowsHide: true
					});
					const start = out.stdout.indexOf("{");
					if (start >= 0) {
						const parsed = JSON.parse(out.stdout.slice(start));
						dreaminaLogin = true;
						dreaminaCredit = Number(parsed.total_credit ?? null);
					}
				} catch {
					dreaminaLogin = false;
				}
			} catch {
				dreaminaBinary = false;
			}
			const ffmpeg = Boolean(await resolveFfmpeg());
			let corpusOk = false;
			let corpusCount = 0;
			try {
				corpusCount = corpusSize();
				corpusOk = corpusCount > 0;
			} catch {
				corpusOk = false;
			}
			let registryOk = false;
			try {
				const { SkillRegistry } = await import("./registry-core.js").then((n) => n.n);
				const registry = new SkillRegistry(join(privateRoot, "registry", "registry.db"));
				registry.list(void 0, 1);
				registry.close();
				registryOk = true;
			} catch {
				registryOk = false;
			}
			let privateOk = false;
			try {
				await mkdir(join(privateRoot, "locks"), { recursive: true });
				privateOk = true;
			} catch {
				privateOk = false;
			}
			const tools = {
				generate_image: creds.COMFLY_API_KEY ? "ready" : creds.APIMART_API_KEY || creds.GEMINI_API_KEY || dreaminaBinary && dreaminaLogin ? "degraded" : "unavailable",
				generate_video: dreaminaBinary && dreaminaLogin ? "ready" : dreaminaBinary ? "degraded" : "unavailable",
				describe_image: creds.VOLCANO_ENGINE_API_KEY ? "ready" : "unavailable",
				skill_registry: registryOk ? "ready" : "unavailable",
				prompt_revision: corpusOk ? "ready" : "degraded",
				video_to_gif: ffmpeg ? "ready" : "unavailable",
				batch_image: creds.COMFLY_API_KEY ? "ready" : "degraded"
			};
			const toolReasons = {
				generate_image: !creds.COMFLY_API_KEY ? "主通道缺少 COMFLY_API_KEY" : "ready",
				generate_video: !dreaminaBinary ? "dreamina 二进制缺失" : !dreaminaLogin ? "dreamina 未登录" : "ready",
				describe_image: !creds.VOLCANO_ENGINE_API_KEY ? "缺少 VOLCANO_ENGINE_API_KEY" : "ready",
				skill_registry: !registryOk ? "注册库不可用" : "ready",
				prompt_revision: !corpusOk ? "语料未加载" : "ready",
				video_to_gif: !ffmpeg ? "ffmpeg 未找到" : "ready",
				batch_image: !creds.COMFLY_API_KEY ? "主通道缺少 COMFLY_API_KEY" : "ready"
			};
			let proxyOpen = false;
			try {
				const { createConnection } = await import("node:net");
				proxyOpen = await new Promise((resolve) => {
					const socket = createConnection({
						host: "127.0.0.1",
						port: 7897,
						timeout: 3e3
					});
					socket.once("connect", () => {
						socket.destroy();
						resolve(true);
					});
					socket.once("error", () => resolve(false));
					socket.once("timeout", () => {
						socket.destroy();
						resolve(false);
					});
				});
			} catch {
				proxyOpen = false;
			}
			const providers = {
				"comfly-gemini-flash-preview": {
					ready: creds.COMFLY_API_KEY,
					reason: creds.COMFLY_API_KEY ? "ok" : "missing COMFLY_API_KEY",
					model: "gemini-3.1-flash-image-preview (1K/2K/4K 分辨率路由)",
					default_resolution: "2K"
				},
				"comfly-gpt-image-2": {
					ready: creds.COMFLY_API_KEY,
					reason: creds.COMFLY_API_KEY ? "ok" : "missing COMFLY_API_KEY",
					model: "gpt-image-2",
					default_resolution: "4K"
				},
				"apimart-gpt-image-2": {
					ready: creds.APIMART_API_KEY,
					reason: creds.APIMART_API_KEY ? "ok" : "missing APIMART_API_KEY (回退链第 3 级跳过)",
					model: "gpt-image-2",
					default_resolution: "4K"
				},
				"google-gemini-image": {
					ready: creds.GEMINI_API_KEY,
					reason: creds.GEMINI_API_KEY ? "ok" : "missing GEMINI_API_KEY (回退链第 4 级跳过)",
					model: "gemini-3.1-flash-image",
					default_resolution: "2K"
				},
				"dreamina-image": {
					ready: dreaminaBinary && dreaminaLogin,
					reason: dreaminaBinary && dreaminaLogin ? "ok" : "dreamina 未就绪（共享 seedance-cli 容量）",
					model: "image 4.0",
					default_resolution: "1K"
				},
				"dreamina-video": {
					ready: dreaminaBinary && dreaminaLogin,
					reason: dreaminaBinary && dreaminaLogin ? "ok" : "dreamina 未就绪"
				}
			};
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const deployment = {
				private_runtime_writable: privateOk,
				dreamina_binary: dreaminaBinary,
				dreamina_login: dreaminaLogin,
				dreamina_credit: dreaminaCredit,
				ffmpeg,
				corpus_entries: corpusCount,
				registry_db: registryOk,
				proxy_port_7897: proxyOpen,
				last_checked: now
			};
			const readyCount = Object.values(tools).filter((t) => t === "ready").length;
			const degradedCount = Object.values(tools).filter((t) => t === "degraded").length;
			const unavailableCount = Object.values(tools).filter((t) => t === "unavailable").length;
			return {
				ok: unavailableCount === 0,
				message: `tools: ${readyCount} ready / ${degradedCount} degraded / ${unavailableCount} unavailable`,
				tools,
				tool_reasons: toolReasons,
				providers,
				deployment
			};
		}
	}));
}
//#endregion
export { Config, apply, inject, name };
