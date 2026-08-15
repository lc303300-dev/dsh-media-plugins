import { r as mediaErrors } from "./failure-BLDFEPKr.js";
import { c as redactPrompt, l as resolvePrivateRoot, o as newTaskId, r as appendSafeLog, t as TaskStore } from "./private-runtime-D6gReaf9.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { access, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
//#region src/tool-video-gen.ts
const execFileAsync = promisify(execFile);
/** Bundle root: the built tool file lives at the package root. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-video-gen";
/** Services required by the video tool. */
const inject = ["tools"];
const VIDEO_EXECUTION_MODES = [
	"production",
	"production_submit_only",
	"test_submit_only"
];
const Config = z.object({
	dreaminaPath: z.string().default(join(PACKAGE_ROOT, "bin", "dreamina.exe")),
	model: z.string().default("seedance2.5"),
	resolution: z.string().default("480p"),
	outputDir: z.string().default("outputs"),
	privateDir: z.string().default(""),
	pollTimeoutMs: z.number().default(42e4),
	executionMode: z.enum(VIDEO_EXECUTION_MODES).default("production"),
	runHelpBeforeSubmit: z.boolean().default(true)
});
const VIDEO_EXTENSIONS = /* @__PURE__ */ new Set([
	".mp4",
	".mov",
	".webm",
	".mkv",
	".avi"
]);
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
	".png",
	".jpg",
	".jpeg",
	".webp",
	".gif",
	".bmp"
]);
const REF_VIDEO_EXTENSIONS = /* @__PURE__ */ new Set([
	".mp4",
	".mov",
	".webm",
	".mkv",
	".avi",
	".m4v"
]);
const AUDIO_EXTENSIONS = /* @__PURE__ */ new Set([
	".mp3",
	".wav",
	".m4a",
	".aac",
	".flac",
	".ogg"
]);
/** Model alias -> official CLI model id (auto-completes the seedance prefix). */
const MODEL_ALIASES = {
	"2.0": "seedance2.0",
	"2.0fast": "seedance2.0fast",
	"2.0_vip": "seedance2.0_vip",
	"2.0fast_vip": "seedance2.0fast_vip",
	"2.0mini": "seedance2.0mini",
	"2.5": "seedance2.5"
};
/** Non-VIP 2.0-series models: only reachable through the test channel. */
const NON_VIP_2_0 = /* @__PURE__ */ new Set([
	"seedance2.0",
	"seedance2.0fast",
	"seedance2.0mini"
]);
const LIMITS_SEEDANCE_2_5 = {
	total: 50,
	durationMin: 4,
	durationMax: 30,
	resolutions: ["480p", "720p"],
	ratios: [
		"1:1",
		"3:4",
		"16:9",
		"4:3",
		"9:16",
		"21:9"
	],
	audioOnlyAllowed: true
};
const LIMITS_SEEDANCE_2_0 = {
	total: 12,
	durationMin: 4,
	durationMax: 15,
	resolutions: [
		"720p",
		"1080p",
		"4k"
	],
	ratios: [
		"1:1",
		"3:4",
		"16:9",
		"4:3",
		"9:16",
		"21:9"
	],
	audioOnlyAllowed: false
};
const LIMITS_OTHER = {
	total: 12,
	durationMin: 4,
	durationMax: 15,
	resolutions: ["720p"],
	ratios: [
		"1:1",
		"3:4",
		"16:9",
		"4:3",
		"9:16",
		"21:9"
	],
	audioOnlyAllowed: false
};
function normalizeModel(value) {
	if (!value) return value;
	return MODEL_ALIASES[value] ?? value;
}
function limitsFor(model) {
	if (model === "seedance2.5") return LIMITS_SEEDANCE_2_5;
	if (model === "seedance2.0_vip" || model === "seedance2.0fast_vip") return LIMITS_SEEDANCE_2_0;
	return LIMITS_OTHER;
}
/** Validate reference files: extension allowlist + existence. */
async function validateRefFiles(kind, paths) {
	const accepted = kind === "image" ? IMAGE_EXTENSIONS : kind === "video" ? REF_VIDEO_EXTENSIONS : AUDIO_EXTENSIONS;
	const label = kind === "image" ? "图片" : kind === "video" ? "参考视频" : "参考音频";
	for (const p of paths) {
		const lower = p.toLowerCase();
		if (!accepted.has(lower.slice(lower.lastIndexOf(".")))) throw mediaErrors.input(`不支持的${label}文件类型：${p}`);
		try {
			await access(p);
		} catch {
			throw mediaErrors.input(`${label}文件不存在或不可读：${p}`);
		}
	}
}
async function runDreamina(binary, args, timeoutMs) {
	try {
		const { stdout } = await execFileAsync(binary, args, {
			timeout: timeoutMs,
			maxBuffer: 16777216,
			windowsHide: true
		});
		return stdout;
	} catch (error) {
		const detail = error?.stderr?.trim() || error?.stdout?.trim() || error?.message || "unknown CLI error";
		throw new Error(String(detail).slice(0, 800));
	}
}
function parseJson(stdout) {
	const text = stdout.trim();
	if (text.length === 0) return void 0;
	try {
		return JSON.parse(text);
	} catch {
		const start = text.indexOf("{");
		if (start < 0) return void 0;
		try {
			return JSON.parse(text.slice(start));
		} catch {
			return;
		}
	}
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function newestVideo(dir) {
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	const videos = entries.filter((n) => VIDEO_EXTENSIONS.has(n.slice(n.lastIndexOf(".")).toLowerCase())).map((n) => join(dir, n));
	if (videos.length === 0) return void 0;
	videos.sort((a, b) => b.length - a.length);
	return videos[0];
}
/** Register the `generate_video` tool. */
function apply(ctx, config) {
	ctx.tools.register(defineTool({
		name: "generate_video",
		description: "用即梦 Dreamina（Seedance）本地 CLI 生成视频：默认走全能参考模式 multimodal2video（传任意 image/images/videos/audios 参考即启用，支持多图、参考视频与音频）；只传 prompt 时走 text2video。默认模型 seedance2.5、默认 480p；仅当前用户明确选择时才使用 seedance2.0 系列（普通 2.0 归一化为 seedance2.0_vip）。video_execution_mode：production（提交并轮询下载）、production_submit_only（仅提交返回 submit_id，不自动查询）、test_submit_only（强制非 VIP seedance2.0 + 720p，只返回 submit_id，请到即梦网站后台查看，绝不自动查询下载）。任务状态持久化在私有运行目录，同一任务绝不重复提交。",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "视频提示词，UTF-8，不能为空。全能参考模式下建议用中文裸标签引用素材（如 图片1、视频1、音频1），标签序号对应该类素材的传入顺序。"
			},
			image: {
				type: "string",
				description: "可选：单张参考图路径（PNG/JPEG/WebP）。旧参数，与 images 等价；传了任意参考即走全能参考模式。"
			},
			images: {
				type: "array",
				items: { type: "string" },
				description: "可选：本地图片参考路径列表（PNG/JPEG/WebP），可多张。seedance2.5 总参考输入（图+视频+音频）≤ 50；其余模型最多 9 张。"
			},
			videos: {
				type: "array",
				items: { type: "string" },
				description: "可选：本地参考视频路径列表（mp4/mov/webm/mkv/avi/m4v）。seedance2.5 单个/总时长 2-30 秒（计入 50 个总参考上限）；其余模型最多 3 个且 2-15 秒。"
			},
			audios: {
				type: "array",
				items: { type: "string" },
				description: "可选：本地参考音频路径列表（mp3/wav/m4a/aac/flac/ogg）。seedance2.5 允许纯音频参考、2-30 秒（计入 50 个总参考上限）；其余模型最多 3 个且 2-15 秒，且必须同时有至少一个图片或视频参考。"
			},
			duration: {
				type: "integer",
				description: "视频时长（秒），默认 5；seedance2.5 为 4-30，其余模型为 4-15。"
			},
			ratio: {
				type: "string",
				description: "画面比例，如 16:9、9:16、1:1、4:3、3:4、21:9；默认 16:9。"
			},
			video_resolution: {
				type: "string",
				description: "分辨率：seedance2.5 仅支持 480p/720p；seedance2.0_vip 支持 720p/1080p/4k；其余模型仅 720p。默认 480p（test 模式固定 720p）。"
			},
			model_version: {
				type: "string",
				description: "视频模型，默认 seedance2.5；可选 2.5 / 2.0 / 2.0fast / 2.0_vip / 2.0fast_vip / 2.0mini（自动补全 seedance 前缀）。普通请求显式选 2.0 系列会归一化为 seedance2.0_vip。"
			},
			video_execution_mode: {
				type: "string",
				enum: [...VIDEO_EXECUTION_MODES],
				description: "执行模式：production（默认，提交+轮询+下载）、production_submit_only（仅提交）、test_submit_only（测试通道，强制非 VIP 2.0/720p，仅返回 submit_id）。"
			},
			output: {
				type: "string",
				description: "可选输出路径（绝对路径，或相对会话工作目录的路径）。指定后产出视频会被重命名到该路径并可点击打开；省略则用 CLI 生成的文件名。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string" },
					submit_id: { type: "string" },
					done: {
						type: "boolean",
						required: true
					},
					execution_mode: { type: "string" },
					model: { type: "string" }
				}
			},
			render(_args, value) {
				if (value.done && value.path !== void 0) return [{
					type: "text",
					text: `generated video: ${value.path}`
				}];
				return [{
					type: "text",
					text: `video task submitted; submit_id=${value.submit_id ?? "unknown"} (${value.execution_mode ?? "production"}). Check progress in the Dreamina dashboard.`
				}];
			}
		},
		async execute(args, exec) {
			const prompt = String(args.prompt ?? "").trim();
			if (prompt.length === 0) throw mediaErrors.input("prompt must be a non-empty string");
			const mode = args.video_execution_mode ?? config.executionMode;
			if (!VIDEO_EXECUTION_MODES.includes(mode)) throw mediaErrors.input(`unsupported video_execution_mode: ${mode}`);
			const userModel = normalizeModel(args.model_version ?? config.model);
			const model = mode === "test_submit_only" ? "seedance2.0" : NON_VIP_2_0.has(userModel) ? "seedance2.0_vip" : userModel;
			const resolution = mode === "test_submit_only" ? "720p" : args.video_resolution ?? config.resolution;
			const duration = Number(args.duration ?? 5);
			const ratio = String(args.ratio ?? "16:9");
			const images = [];
			if (typeof args.image === "string" && args.image.trim().length > 0) images.push(args.image.trim());
			for (const p of args.images ?? []) if (typeof p === "string" && p.trim().length > 0) images.push(p.trim());
			const videos = (args.videos ?? []).filter((p) => typeof p === "string" && p.trim().length > 0);
			const audios = (args.audios ?? []).filter((p) => typeof p === "string" && p.trim().length > 0);
			const totalRefs = images.length + videos.length + audios.length;
			const limits = limitsFor(model);
			if (totalRefs > 0) {
				await validateRefFiles("image", images);
				await validateRefFiles("video", videos);
				await validateRefFiles("audio", audios);
				if (images.length === 0 && videos.length === 0 && audios.length > 0 && !limits.audioOnlyAllowed) throw mediaErrors.input(`纯音频参考仅支持 seedance2.5 全能参考模式（当前模型 ${model}）。请指定 model_version=2.5，或补充图片/视频参考。`);
				if (limits.total !== void 0 && totalRefs > limits.total) throw mediaErrors.input(`全能参考模式（${model}）参考输入总计最多 ${limits.total} 个，当前 ${totalRefs} 个。`);
			}
			if (!Number.isFinite(duration) || duration < limits.durationMin || duration > limits.durationMax) throw mediaErrors.input(`（${model}）时长必须在 ${limits.durationMin}-${limits.durationMax} 秒之间，当前 ${duration} 秒。`);
			if (!limits.resolutions.includes(resolution)) throw mediaErrors.input(`（${model}）不支持分辨率 ${resolution}，可选：${limits.resolutions.join(" / ")}。`);
			if (!limits.ratios.includes(ratio)) throw mediaErrors.input(`（${model}）不支持比例 ${ratio}，可选：${limits.ratios.join(" / ")}。`);
			const workspaceRoot = exec.agent?.session?.header?.cwd ?? process.cwd();
			const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir);
			const taskId = newTaskId();
			const store = new TaskStore(join(privateRoot, "jobs"));
			const request = {
				prompt: redactPrompt(prompt),
				mode,
				model,
				resolution,
				duration,
				ratio,
				images: images.map((p) => p),
				videos: videos.map((p) => p),
				audios: audios.map((p) => p)
			};
			await store.create("video", taskId, "video", request);
			await store.transition("video", taskId, "running", {
				model,
				provider: "dreamina"
			});
			const outDir = join(workspaceRoot, config.outputDir);
			try {
				const subcommand = totalRefs > 0 ? "multimodal2video" : "text2video";
				if (config.runHelpBeforeSubmit) try {
					await runDreamina(config.dreaminaPath, [subcommand, "-h"], 15e3);
				} catch (error) {
					await appendSafeLog(privateRoot, "generate_video", {
						taskId,
						event: "help_check_failed",
						detail: String(error?.message ?? error).slice(0, 200)
					});
				}
				const submitArgs = totalRefs > 0 ? [
					"multimodal2video",
					...images.map((p) => `--image=${p}`),
					...videos.map((p) => `--video=${p}`),
					...audios.map((p) => `--audio=${p}`),
					`--prompt=${prompt}`,
					`--model_version=${model}`,
					`--video_resolution=${resolution}`,
					`--duration=${duration}`,
					`--ratio=${ratio}`,
					"--poll=0"
				] : [
					"text2video",
					`--prompt=${prompt}`,
					`--model_version=${model}`,
					`--video_resolution=${resolution}`,
					`--duration=${duration}`,
					`--ratio=${ratio}`,
					"--poll=0"
				];
				const submitOut = await runDreamina(config.dreaminaPath, submitArgs, 24e4);
				const submitted = parseJson(submitOut);
				if (submitted === void 0 || typeof submitted.submit_id !== "string" || submitted.submit_id.length === 0) throw mediaErrors.provider(`dreamina submit returned no submit_id: ${String(submitOut).slice(0, 300)}`);
				const submitId = submitted.submit_id;
				if (submitted.gen_status === "fail") throw mediaErrors.provider(`dreamina task failed: ${String(submitted.fail_reason ?? "unknown reason")}`);
				await store.saveResult("video", taskId, {
					status: "submitted",
					submitId,
					model,
					mode
				});
				await store.transition("video", taskId, "running", {
					submitId,
					provider: "dreamina",
					model,
					nextAction: mode === "production" ? "none" : "query_later"
				});
				await appendSafeLog(privateRoot, "generate_video", {
					taskId,
					event: "submitted",
					submitId,
					model,
					mode
				});
				if (mode !== "production") {
					const base = {
						submit_id: submitId,
						done: false,
						execution_mode: mode,
						model
					};
					if (mode === "test_submit_only") {
						await store.transition("video", taskId, "success", {
							submitId,
							outputPath: void 0,
							nextAction: "user_check_backend"
						});
						return {
							...base,
							path: void 0
						};
					}
					await store.transition("video", taskId, "success", {
						submitId,
						nextAction: "query_later"
					});
					return base;
				}
				const deadline = Date.now() + config.pollTimeoutMs;
				while (Date.now() < deadline) {
					if (exec.signal?.aborted) {
						await store.transition("video", taskId, "cancelled", { nextAction: "query_later" });
						throw mediaErrors.cancelled("generate_video aborted");
					}
					const queried = parseJson(await runDreamina(config.dreaminaPath, [
						"query_result",
						`--submit_id=${submitId}`,
						`--download_dir=${outDir}`
					], 9e4));
					if (queried?.gen_status === "fail") {
						await store.transition("video", taskId, "failed", { failureMessage: String(queried.fail_reason ?? "unknown") });
						throw mediaErrors.provider(`dreamina task failed: ${String(queried.fail_reason ?? "unknown reason")}`);
					}
					if (queried?.gen_status === "success") {
						const video = await newestVideo(outDir);
						if (video !== void 0) {
							let finalPath = video;
							const requested = args.output?.trim();
							if (requested !== void 0 && requested.length > 0) {
								finalPath = isAbsolute(requested) ? requested : join(workspaceRoot, requested);
								await mkdir(dirname(finalPath), { recursive: true });
								await rename(video, finalPath);
							}
							await store.saveResult("video", taskId, {
								status: "success",
								submitId,
								outputPath: finalPath,
								model
							});
							await store.transition("video", taskId, "success", {
								submitId,
								outputPath: finalPath,
								model
							});
							return {
								path: finalPath,
								submit_id: submitId,
								done: true,
								execution_mode: mode,
								model
							};
						}
					}
					await sleep(5e3);
				}
				await store.transition("video", taskId, "needs_review", {
					nextAction: "query_later",
					submitId
				});
				return {
					submit_id: submitId,
					done: false,
					execution_mode: mode,
					model
				};
			} catch (error) {
				if (error?.cls === "cancelled") throw error;
				await store.saveResult("video", taskId, {
					status: "failed",
					message: String(error?.message ?? error)
				});
				await store.transition("video", taskId, "failed", { failureMessage: String(error?.message ?? error) });
				await appendSafeLog(privateRoot, "generate_video", {
					taskId,
					event: "failed",
					detail: String(error?.message ?? error).slice(0, 300)
				});
				throw error;
			}
		},
		presentCall(args) {
			const requested = args?.output?.trim();
			if (requested === void 0 || requested.length === 0) return void 0;
			return {
				card: "generic",
				kind: "edit",
				title: `生成视频 ${requested}`,
				locations: [{ path: requested }]
			};
		}
	}));
}
//#endregion
export { Config, VIDEO_EXECUTION_MODES, apply, inject, name };
