import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { access, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/shared/gif-core.ts
/**
* Video→GIF domain (Codex_Gif rebuild, all-JS): ffmpeg two-pass
* palettegen/paletteuse with a staged quality search (width/FPS/dither)
* and a size budget. Pure computation + exec; no DSH imports.
*
* @module dsh-media-plugins/shared/gif-core
*/
const execFileAsync = promisify(execFile);
/** Candidate (width, fps) stages, highest quality first. */
const QUALITY_STAGES = [
	{
		width: 960,
		fps: 15
	},
	{
		width: 720,
		fps: 12
	},
	{
		width: 640,
		fps: 10
	},
	{
		width: 480,
		fps: 8
	},
	{
		width: 360,
		fps: 6
	}
];
/** Run ffmpeg; throws on non-zero exit with stderr. */
async function runFfmpeg(ffmpegPath, args, timeoutMs = 12e4) {
	try {
		const { stdout } = await execFileAsync(ffmpegPath, args, {
			timeout: timeoutMs,
			maxBuffer: 16777216,
			windowsHide: true
		});
		return stdout;
	} catch (error) {
		const detail = error?.stderr?.trim() || error?.message || "ffmpeg error";
		throw new Error(String(detail).slice(0, 600));
	}
}
/** Resolve an ffmpeg binary: explicit path, FFMPEG_PATH env, PATH, common installs. */
async function resolveFfmpeg(explicit) {
	const candidates = [
		explicit,
		process.env.FFMPEG_PATH,
		"ffmpeg",
		"C:\\Program Files\\oopz\\ffmpeg.exe",
		"C:\\Program Files\\Topaz Labs LLC\\Topaz Video\\ffmpeg.exe",
		"C:\\Program Files\\Virtual Desktop Streamer\\ffmpeg.exe"
	].filter((p) => Boolean(p));
	for (const candidate of candidates) try {
		await access(candidate);
		return candidate;
	} catch {}
}
/** Convert a video to GIF with staged quality search under the size budget. */
async function videoToGif(videoPath, outDir, options) {
	await mkdir(outDir, { recursive: true });
	const maxBytes = (options.maxSizeMB ?? 10) * 1024 * 1024;
	const ffmpeg = options.ffmpegPath;
	const stages = options.width || options.fps ? [{
		width: options.width ?? 720,
		fps: options.fps ?? 10
	}] : QUALITY_STAGES;
	const attempts = [];
	for (const stage of stages) {
		const width = stage.width;
		const fps = stage.fps;
		const palette = join(outDir, `palette-${width}-${fps}.png`);
		const gif = join(outDir, `out-${width}-${fps}.gif`);
		try {
			await runFfmpeg(ffmpeg, [
				"-y",
				"-i",
				videoPath,
				"-vf",
				`fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=stats_mode=diff`,
				palette
			], options.timeoutMs ?? 12e4);
			const dither = options.dither ?? "bayer";
			await runFfmpeg(ffmpeg, [
				"-y",
				"-i",
				videoPath,
				"-i",
				palette,
				"-lavfi",
				`fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=${dither === "none" ? "none" : dither === "floyd_steinberg" ? "floyd_steinberg" : "bayer:bayer_scale=5"}`,
				gif
			], options.timeoutMs ?? 12e4);
			const size = (await stat(gif)).size;
			attempts.push(`${width}px@${fps}fps=${Math.round(size / 1024)}KB`);
			await unlink(palette).catch(() => void 0);
			if (size <= maxBytes) return {
				path: gif,
				sizeBytes: size,
				width,
				fps,
				attempts: attempts.length,
				withinBudget: true
			};
			await unlink(gif).catch(() => void 0);
		} catch (error) {
			attempts.push(`${width}px@${fps}fps=error:${String(error?.message ?? error).slice(0, 80)}`);
		}
	}
	const files = (await readdir(outDir)).filter((f) => f.endsWith(".gif"));
	if (files.length > 0) {
		const sized = [];
		for (const f of files) sized.push({
			path: join(outDir, f),
			size: (await stat(join(outDir, f))).size
		});
		sized.sort((a, b) => a.size - b.size);
		const smallest = sized[0];
		const m = smallest.path.match(/out-(\d+)-(\d+)\.gif/);
		return {
			path: smallest.path,
			sizeBytes: smallest.size,
			width: m ? Number(m[1]) : 0,
			fps: m ? Number(m[2]) : 0,
			attempts: attempts.length,
			withinBudget: smallest.size <= maxBytes
		};
	}
	throw new Error(`video-to-gif failed at all stages: ${attempts.join(" | ")}`);
}
//#endregion
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
