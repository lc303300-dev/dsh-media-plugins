import { a as ensureDir, d as resolvePrivateRoot } from "./private-runtime.js";
import { n as videoToGif, t as resolveFfmpeg } from "./gif-core.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
//#region src/tool-video-to-gif.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-video-to-gif";
const inject = ["tools"];
const Config = z.object({
	ffmpegPath: z.string().default(""),
	gifsiclePath: z.string().default(""),
	outputDir: z.string().default("outputs"),
	privateDir: z.string().default(""),
	maxSizeMB: z.number().default(10),
	timeoutMs: z.number().default(12e4)
});
const VIDEO_EXTENSIONS = /* @__PURE__ */ new Set([
	".mp4",
	".mov",
	".mkv",
	".webm",
	".avi",
	".m4v"
]);
async function listVideos(dir, recursive, depth = 0) {
	const out = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (recursive && depth < 8) out.push(...await listVideos(full, true, depth + 1));
		} else if (entry.isFile()) {
			const lower = entry.name.toLowerCase();
			if (VIDEO_EXTENSIONS.has(lower.slice(lower.lastIndexOf(".")))) out.push(full);
		}
	}
	return out.sort();
}
function apply(ctx, config) {
	ctx.tools.register(defineTool({
		name: "video_to_gif",
		description: "把本地视频转为 GIF（Codex_Gif 的 DSH 重建）：FFmpeg 双遍 palettegen/paletteuse，按 宽度/FPS/颜色/抖动 分阶段降级搜索，默认体积上限 10MB，超出自动降到下一档，返回满足上限的最高质量档；全部超限时返回最小产物并标记 within_budget=false。可选 strict/quality 模式、denoise、anti-moire、调色板 stats/diff 模式、bayer_scale、gifsicle lossy 优化、max_duration_sec 截断；传 input_dir 可批量处理目录下视频（recursive 递归），并生成 CSV 转换报告（私有运行目录）。",
		parameters: {
			video: {
				type: "string",
				description: "本地视频路径（mp4/mov/webm/mkv/avi/m4v）；与 input_dir 二选一。"
			},
			input_dir: {
				type: "string",
				description: "可选：批量处理目录下所有视频；与 video 二选一。"
			},
			recursive: {
				type: "boolean",
				description: "批量时是否递归子目录。"
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
			mode: {
				type: "string",
				enum: ["quality", "strict"],
				description: "quality（默认）：全超限时停在最小宽度返回最小产物；strict：低于最小宽度继续降（320/240）。"
			},
			min_width: {
				type: "integer",
				description: "quality 模式的最低尝试宽度（默认 360）。"
			},
			dither: {
				type: "string",
				enum: [
					"bayer",
					"sierra2_4a",
					"floyd_steinberg",
					"none"
				],
				description: "抖动模式，默认 bayer。"
			},
			bayer_scale: {
				type: "integer",
				description: "bayer 抖动的 bayer_scale（0-5，默认 5）。"
			},
			palette_stats_mode: {
				type: "string",
				enum: [
					"diff",
					"full",
					"single"
				],
				description: "palettegen stats_mode，默认 diff。"
			},
			diff_mode: {
				type: "string",
				enum: ["rectangle", "none"],
				description: "paletteuse diff_mode，默认 rectangle。"
			},
			color_count: {
				type: "integer",
				description: "调色板最大颜色数（max_colors）。"
			},
			max_duration_sec: {
				type: "number",
				description: "可选：截断输入到最多 N 秒（长视频）。"
			},
			denoise: {
				type: "string",
				enum: [
					"off",
					"light",
					"medium"
				],
				description: "hqdn3d 降噪：off/light/medium，默认 off。"
			},
			anti_moire: {
				type: "boolean",
				description: "缩放使用 accurate_rnd 抗摩尔纹。"
			},
			lossy: {
				type: "integer",
				description: "gifsicle --lossy 0-200（需 gifsicle_path，-O3 --careful）。"
			},
			gifsicle_path: {
				type: "string",
				description: "可选：gifsicle 二进制路径（用于 lossy 优化）。"
			},
			output: {
				type: "string",
				description: "可选输出路径（绝对或相对会话工作目录；单文件时有效）。"
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
					results: { type: "array" },
					report_path: { type: "string" },
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
			const workspaceRoot = exec.agent?.session?.header?.cwd ?? process.cwd();
			const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir);
			const ffmpeg = config.ffmpegPath.trim() || await resolveFfmpeg();
			if (!ffmpeg) return {
				ok: false,
				message: "ffmpeg not found; set FFMPEG_PATH or install ffmpeg"
			};
			const video = String(args.video ?? "").trim();
			const inputDir = String(args.input_dir ?? "").trim();
			if (!video && !inputDir) return {
				ok: false,
				message: "video path or input_dir is required"
			};
			const gifsiclePath = String(args.gifsicle_path ?? config.gifsiclePath).trim() || void 0;
			const baseOptions = {
				width: args.width,
				fps: args.fps,
				maxSizeMB: args.max_size_mb ?? config.maxSizeMB,
				mode: args.mode ?? "quality",
				minWidth: args.min_width,
				dither: args.dither ?? "bayer",
				bayerScale: args.bayer_scale,
				paletteStatsMode: args.palette_stats_mode,
				diffMode: args.diff_mode,
				colorCount: args.color_count,
				maxDurationSec: args.max_duration_sec,
				denoise: args.denoise ?? "off",
				antiMoire: Boolean(args.anti_moire),
				gifsiclePath,
				lossy: args.lossy,
				ffmpegPath: ffmpeg,
				timeoutMs: config.timeoutMs
			};
			const targets = video ? [{
				video: video.trim(),
				isSingle: true
			}] : (await listVideos(isAbsolute(inputDir) ? inputDir : join(workspaceRoot, inputDir), Boolean(args.recursive))).map((v) => ({
				video: v,
				isSingle: false
			}));
			if (targets.length === 0) return {
				ok: false,
				message: inputDir ? "no video files found in input_dir" : "video file not found"
			};
			const outDir = join(workspaceRoot, config.outputDir, "gif");
			await mkdir(outDir, { recursive: true });
			const reportDir = join(privateRoot, "reports");
			await ensureDir(reportDir);
			const rows = [[
				"input",
				"status",
				"reason",
				"width",
				"fps",
				"size_bytes",
				"within_budget"
			]];
			const results = [];
			for (const target of targets) try {
				const result = await videoToGif(target.video, outDir, baseOptions);
				let finalPath = result.path;
				if (target.isSingle && args.output && String(args.output).trim().length > 0) {
					const requested = String(args.output).trim();
					finalPath = isAbsolute(requested) ? requested : join(workspaceRoot, requested);
					const { rename } = await import("node:fs/promises");
					await mkdir(dirname(finalPath), { recursive: true });
					await rename(result.path, finalPath);
				}
				rows.push([
					target.video,
					"success",
					"",
					String(result.width),
					String(result.fps),
					String(result.sizeBytes),
					String(result.withinBudget)
				]);
				results.push({
					input: target.video,
					ok: true,
					path: finalPath,
					size_bytes: result.sizeBytes,
					width: result.width,
					fps: result.fps,
					attempts: result.attempts,
					within_budget: result.withinBudget,
					optimized: result.optimized ?? false
				});
			} catch (error) {
				const reason = String(error?.message ?? error).slice(0, 300);
				rows.push([
					target.video,
					"failed",
					reason,
					"",
					"",
					"",
					""
				]);
				results.push({
					input: target.video,
					ok: false,
					message: reason
				});
			}
			const reportPath = join(reportDir, `gif-conversion-report-${Date.now()}.csv`);
			await writeFile(reportPath, rows.map((r) => r.map((c) => `"${String(c).replaceAll("\"", "\"\"")}"`).join(",")).join("\n"), "utf8");
			if (targets.length === 1 && targets[0].isSingle) {
				const single = results[0];
				if (!single.ok) return {
					ok: false,
					message: single.message,
					report_path: reportPath
				};
				return {
					...single,
					report_path: reportPath,
					message: `gif ready: ${single.path} (${Math.round(single.size_bytes / 1024)}KB, ${single.width}px@${single.fps}fps, ${single.attempts} attempt(s))`
				};
			}
			const okCount = results.filter((r) => r.ok).length;
			return {
				ok: okCount > 0,
				results,
				report_path: reportPath,
				message: `batch gif: ${okCount}/${results.length} ok; report: ${reportPath}`
			};
		}
	}));
}
//#endregion
export { Config, apply, inject, name };
