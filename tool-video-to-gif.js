import { n as videoToGif, t as resolveFfmpeg } from "./gif-core.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
//#region src/tool-video-to-gif.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-video-to-gif";
const inject = ["tools"];
const Config = z.object({
	ffmpegPath: z.string().default(""),
	outputDir: z.string().default("outputs"),
	maxSizeMB: z.number().default(10),
	timeoutMs: z.number().default(12e4)
});
function apply(ctx, config) {
	ctx.tools.register(defineTool({
		name: "video_to_gif",
		description: "把本地视频转为 GIF（Codex_Gif 的 DSH 重建）：FFmpeg 双遍 palettegen/paletteuse，按 宽度/FPS/颜色/抖动 分阶段降级搜索，默认体积上限 10MB，超出自动降到下一档，返回满足上限的最高质量档；全部超限时返回最小产物并标记 within_budget=false。批量处理时每次调用处理一个文件，逐条报告。",
		parameters: {
			video: {
				type: "string",
				required: true,
				description: "本地视频路径（mp4/mov/webm/mkv/avi）。"
			},
			width: {
				type: "integer",
				description: "可选：固定输出宽度；省略则按档位自动（960→720→640→480→360）。"
			},
			fps: {
				type: "integer",
				description: "可选：固定帧率；省略则按档位自动（15→12→10→8→6）。"
			},
			max_size_mb: {
				type: "number",
				description: "可选：体积上限 MB，默认 10。"
			},
			output: {
				type: "string",
				description: "可选输出路径（绝对或相对会话工作目录）。"
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
					path: { type: "string" },
					size_bytes: { type: "number" },
					width: { type: "number" },
					fps: { type: "number" },
					attempts: { type: "number" },
					within_budget: { type: "boolean" },
					message: { type: "string" }
				}
			},
			render(_args, value) {
				return [{
					type: "text",
					text: value.message ?? `gif: ${value.path} (${Math.round((value.size_bytes ?? 0) / 1024)}KB, ${value.width}px@${value.fps}fps)`
				}];
			}
		},
		async execute(args, exec) {
			const video = String(args.video ?? "").trim();
			if (!video) return {
				ok: false,
				message: "video path is required"
			};
			const workspaceRoot = exec.agent?.session?.header?.cwd ?? process.cwd();
			const ffmpeg = config.ffmpegPath.trim() || await resolveFfmpeg();
			if (!ffmpeg) return {
				ok: false,
				message: "ffmpeg not found; set FFMPEG_PATH or install ffmpeg"
			};
			const outDir = join(workspaceRoot, config.outputDir, "gif");
			await mkdir(outDir, { recursive: true });
			try {
				const result = await videoToGif(video, outDir, {
					width: args.width,
					fps: args.fps,
					maxSizeMB: args.max_size_mb ?? config.maxSizeMB,
					ffmpegPath: ffmpeg,
					timeoutMs: config.timeoutMs
				});
				let finalPath = result.path;
				if (args.output && String(args.output).trim().length > 0) {
					const requested = String(args.output).trim();
					finalPath = isAbsolute(requested) ? requested : join(workspaceRoot, requested);
					const { rename } = await import("node:fs/promises");
					await mkdir(dirname(finalPath), { recursive: true });
					await rename(result.path, finalPath);
				}
				return {
					ok: true,
					path: finalPath,
					size_bytes: result.sizeBytes,
					width: result.width,
					fps: result.fps,
					attempts: result.attempts,
					within_budget: result.withinBudget,
					message: `gif ready: ${finalPath} (${Math.round(result.sizeBytes / 1024)}KB, ${result.width}px@${result.fps}fps, ${result.attempts} attempt(s))`
				};
			} catch (error) {
				return {
					ok: false,
					message: String(error?.message ?? error)
				};
			}
		}
	}));
}
//#endregion
export { Config, apply, inject, name };
