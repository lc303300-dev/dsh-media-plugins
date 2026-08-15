import { access, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
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
export { videoToGif as n, resolveFfmpeg as t };
