import { access, mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/shared/gif-core.ts
/**
* Video→GIF domain (Codex_Gif rebuild, all-JS): ffmpeg two-pass
* palettegen/paletteuse with a staged quality search (width/FPS/dither),
* a size budget, optional denoise/anti-moire/color tuning and optional
* gifsicle lossy optimization. Pure computation + exec; no DSH imports.
*
* Contract (Codex_Gif convert-video-to-gif.ps1):
* - default size budget 10 MB, quality-first staged downgrade;
* - `strict` mode keeps trying below the minimum width when nothing fits;
* - `quality` mode stops at the minimum width and returns the smallest hit;
* - palettegen `stats_mode`, paletteuse `diff_mode` + dither configurable;
* - optional `-t` duration cap for long inputs;
* - optional gifsicle `-O3 --careful --lossy=N` post-optimization.
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
/** Extra stages tried only in `strict` mode after the default plan is exhausted. */
const STRICT_EXTRA_STAGES = [{
	width: 320,
	fps: 4
}, {
	width: 240,
	fps: 3
}];
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
function ditherExpression(dither, bayerScale) {
	switch (dither) {
		case "none": return "none";
		case "sierra2_4a": return "sierra2_4a";
		case "floyd_steinberg": return "floyd_steinberg";
		default: return `bayer:bayer_scale=${bayerScale}`;
	}
}
function denoiseExpression(level) {
	if (level === "off") return void 0;
	return level === "light" ? "hqdn3d=1.5:1.5:4:4" : "hqdn3d=3:3:6:6";
}
/** Build the stage plan honoring custom stages / fixed params / mode. */
function stagePlan(options) {
	if (options.stages && options.stages.length > 0) return options.stages;
	if (options.width !== void 0 || options.fps !== void 0) return [{
		width: options.width ?? 720,
		fps: options.fps ?? 10
	}];
	const plan = [...QUALITY_STAGES];
	if (options.mode === "strict") plan.push(...STRICT_EXTRA_STAGES);
	return plan;
}
/** Convert a video to GIF with staged quality search under the size budget. */
async function videoToGif(videoPath, outDir, options) {
	await mkdir(outDir, { recursive: true });
	const maxBytes = (options.maxSizeMB ?? 10) * 1024 * 1024;
	const ffmpeg = options.ffmpegPath;
	const stages = stagePlan(options);
	const statsMode = options.paletteStatsMode ?? "diff";
	const diffMode = options.diffMode ?? "rectangle";
	const bayerScale = Math.max(0, Math.min(5, options.bayerScale ?? 5));
	const dither = options.dither ?? "bayer";
	const denoise = options.denoise ?? "off";
	const attempts = [];
	const kept = [];
	const durationArg = options.maxDurationSec && options.maxDurationSec > 0 ? ["-t", String(options.maxDurationSec)] : [];
	const scaleFlags = `flags=lanczos${options.antiMoire ? "+accurate_rnd" : ""}`;
	const denoiseFilter = denoiseExpression(denoise);
	for (const stage of stages) {
		const width = stage.width;
		const fps = stage.fps;
		const palette = join(outDir, `palette-${width}-${fps}.png`);
		const gif = join(outDir, `out-${width}-${fps}.gif`);
		try {
			const palettegen = `${[denoiseFilter, `fps=${fps},scale=${width}:-1:${scaleFlags}`].filter(Boolean).join(",")},palettegen=stats_mode=${statsMode}${options.colorCount && options.colorCount > 0 ? `:max_colors=${options.colorCount}` : ""}`;
			await runFfmpeg(ffmpeg, [
				"-y",
				...durationArg,
				"-i",
				videoPath,
				"-vf",
				palettegen,
				palette
			], options.timeoutMs ?? 12e4);
			const paletteuse = `fps=${fps},scale=${width}:-1:${scaleFlags}[x];[x][1:v]paletteuse=dither=${ditherExpression(dither, bayerScale)}${diffMode === "none" ? "" : `:diff_mode=${diffMode}`}`;
			await runFfmpeg(ffmpeg, [
				"-y",
				...durationArg,
				"-i",
				videoPath,
				"-i",
				palette,
				"-lavfi",
				paletteuse,
				gif
			], options.timeoutMs ?? 12e4);
			let finalFile = gif;
			let optimized = false;
			if (options.gifsiclePath && (options.lossy ?? -1) >= 0) try {
				const optimizedFile = join(outDir, `opt-${width}-${fps}.gif`);
				await execFileAsync(options.gifsiclePath, [
					"-O3",
					"--careful",
					`--lossy=${options.lossy}`,
					"-o",
					optimizedFile,
					gif
				], {
					timeout: 12e4,
					windowsHide: true
				});
				await unlink(gif).catch(() => void 0);
				finalFile = optimizedFile;
				optimized = true;
			} catch {}
			const size = (await stat(finalFile)).size;
			attempts.push(`${width}px@${fps}fps=${Math.round(size / 1024)}KB${optimized ? "(opt)" : ""}`);
			await unlink(palette).catch(() => void 0);
			kept.push({
				path: finalFile,
				size,
				width,
				fps
			});
			if (size <= maxBytes) return {
				path: finalFile,
				sizeBytes: size,
				width,
				fps,
				attempts: attempts.length,
				withinBudget: true,
				optimized,
				stagesTried: attempts
			};
		} catch (error) {
			attempts.push(`${width}px@${fps}fps=error:${String(error?.message ?? error).slice(0, 80)}`);
		}
	}
	if (kept.length > 0) {
		kept.sort((a, b) => a.size - b.size);
		const smallest = kept[0];
		return {
			path: smallest.path,
			sizeBytes: smallest.size,
			width: smallest.width,
			fps: smallest.fps,
			attempts: attempts.length,
			withinBudget: smallest.size <= maxBytes,
			stagesTried: attempts
		};
	}
	throw new Error(`video-to-gif failed at all stages: ${attempts.join(" | ")}`);
}
//#endregion
export { videoToGif as n, resolveFfmpeg as t };
