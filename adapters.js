import { n as MediaError, r as mediaErrors, t as FALLBACK_ALLOWED } from "./failure.js";
import { a as ensureDir, l as recordProviderOutcome, n as acquireSlot, o as isCircuitOpen, r as appendSafeLog, s as newTaskId } from "./private-runtime.js";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { ProxyAgent, fetch } from "undici";
//#region src/shared/media-client.ts
/**
* Shared OpenAI-compatible media client (Comfly / APIMart) plus image
* download + signature validation + atomic staging. This is the single
* HTTP entry the image adapters and the batch scheduler both use, so the
* paid call path stays centralized (no per-tool HTTP drift).
*
* @module dsh-media-plugins/shared/media-client
*/
/** HTTP error carrying its status so adapters can classify it. */
var HttpStatusError = class extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.name = "HttpStatusError";
		this.status = status;
	}
};
/** Browser-like headers; Comfly URLs may 403 or return a non-image page otherwise. */
const DOWNLOAD_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
	Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
	Referer: "https://ai.comfly.org/"
};
/** Build an undici dispatcher honoring an explicit proxy or HTTPS_PROXY/HTTP_PROXY. */
function proxyDispatcher(explicit) {
	const proxy = explicit !== void 0 && explicit.length > 0 ? explicit : process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
	if (proxy === void 0 || proxy.length === 0) return void 0;
	try {
		return new ProxyAgent({ uri: proxy });
	} catch {
		return;
	}
}
/** Raster file signature check: PNG / JPEG / GIF / WEBP. */
function hasImageSignature(bytes) {
	if (bytes.length < 4) return false;
	if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return true;
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return true;
	if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return true;
	if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70) return bytes.length >= 12 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
	return false;
}
/** Extension for a detected signature; default .png. */
function extensionFor(bytes) {
	if (bytes[0] === 255 && bytes[1] === 216) return ".jpg";
	if (bytes[0] === 71 && bytes[1] === 73) return ".gif";
	if (bytes[0] === 82 && bytes[1] === 73) return ".webp";
	if (bytes[0] === 137 && bytes[1] === 80) return ".png";
	return ".png";
}
/** Parse `payload.data[0].url` with validation. */
function extractImageUrl(payload) {
	const data = payload?.data;
	if (!Array.isArray(data) || data.length === 0) throw new Error("response contains no image data");
	const url = data[0]?.url;
	if (typeof url !== "string" || url.trim().length === 0) throw new Error("response contains no image URL");
	return url.trim();
}
/**
* POST /images/generations (text) or /images/edits (with references,
* multipart) and return the remote image URL.
*/
async function openAiImageUrl(options) {
	const { baseURL, apiKey, model, prompt, size, resolution, images = [], proxyUrl, signal, timeoutMs = 12e4 } = options;
	const dispatcher = proxyDispatcher(proxyUrl);
	const auth = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/json"
	};
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const common = {
			signal: controller.signal,
			...dispatcher === void 0 ? {} : { dispatcher }
		};
		let response;
		if (images.length > 0) {
			const boundary = `----DshMedia${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
			const chunks = [];
			const fields = [
				["model", model],
				["prompt", prompt],
				["n", "1"],
				["size", size]
			];
			if (model !== "gpt-image-2" && resolution !== void 0) fields.push(["resolution", resolution.toLowerCase()]);
			fields.push(["response_format", "url"]);
			for (const [fieldName, fieldValue] of fields) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${fieldValue}\r\n`, "utf8"));
			const fs = await import("node:fs/promises");
			const mimeMap = {
				".png": "image/png",
				".jpg": "image/jpeg",
				".jpeg": "image/jpeg",
				".webp": "image/webp",
				".gif": "image/gif"
			};
			for (const imagePath of images) {
				const name = imagePath.split(/[\\/]/).pop() ?? "ref.png";
				const ext = (name.slice(name.lastIndexOf(".")) || ".png").toLowerCase();
				const data = await fs.readFile(imagePath);
				chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: ${mimeMap[ext] ?? "image/png"}\r\n\r\n`, "ascii"));
				chunks.push(data);
				chunks.push(Buffer.from("\r\n", "ascii"));
			}
			chunks.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));
			response = await fetch(`${baseURL.replace(/\/+$/, "")}/images/edits`, {
				method: "POST",
				headers: {
					...auth,
					"Content-Type": `multipart/form-data; boundary=${boundary}`
				},
				body: Buffer.concat(chunks),
				...common
			});
		} else {
			const payload = {
				model,
				prompt,
				n: 1,
				size,
				response_format: "url"
			};
			if (model !== "gpt-image-2" && resolution !== void 0) payload.resolution = resolution.toLowerCase();
			response = await fetch(`${baseURL.replace(/\/+$/, "")}/images/generations`, {
				method: "POST",
				headers: {
					...auth,
					"Content-Type": "application/json; charset=utf-8"
				},
				body: JSON.stringify(payload),
				...common
			});
		}
		if (!response.ok) throw new HttpStatusError(response.status, `image request failed with HTTP ${response.status}`);
		return extractImageUrl(await response.json());
	} catch (error) {
		if (signal?.aborted) throw error;
		if (timedOut) throw mediaErrors.timeoutBeforeSubmit(`provider ${model} did not return an image within ${Math.round(timeoutMs / 1e3)}s`);
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
/** Download a remote image, validate its signature, stage atomically. */
async function downloadImageTo(url, destDir, options = {}) {
	const { proxyUrl, signal, timeoutMs = 12e4 } = options;
	const dispatcher = proxyDispatcher(proxyUrl);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const download = await fetch(url, {
			headers: DOWNLOAD_HEADERS,
			signal: controller.signal,
			...dispatcher === void 0 ? {} : { dispatcher }
		});
		if (!download.ok) throw new Error(`image download failed with HTTP ${download.status}`);
		const bytes = new Uint8Array(await download.arrayBuffer());
		if (!hasImageSignature(bytes)) throw new Error("downloaded content is not a valid image");
		await mkdir(destDir, { recursive: true });
		const finalPath = join(destDir, `img-${Date.now()}${extensionFor(bytes)}`);
		const tmpPath = `${finalPath}.tmp`;
		await writeFile(tmpPath, bytes);
		await rename(tmpPath, finalPath);
		return finalPath;
	} catch (error) {
		if (signal?.aborted) throw error;
		if (timedOut) throw mediaErrors.download(`image download timed out after ${Math.round(timeoutMs / 1e3)}s`);
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
//#endregion
//#region src/shared/adapters.ts
/**
* Image adapters + serial image router.
*
* Contract (UNIFIED_MEDIA_TOOL_REFACTOR_BLUEPRINT §1.2/§9, media-router.defaults.json):
* - strictly serial per-adapter attempts, never parallel/hedged;
* - per-adapter budget default 120 s, whole-task default 300 s;
* - fallback only for FALLBACK_ALLOWED classes; indeterminate stops with needs_review;
* - default concurrency 6 per adapter; `seedance-cli` capacity shared by
*   dreamina image + video;
* - `image_ratio` is required and never inferred; `image_resolution`
*   (1K/2K/4K) is optional with provider-specific defaults (Gemini routes
*   default 2K, GPT routes default 4K, Dreamina defaults 1K);
* - `image_provider` is a user-explicit restricted route: only that adapter
*   runs, there is no cross-route fallback, and unknown/disabled routes are
*   rejected as input_error before any paid call.
*
* @module dsh-media-plugins/shared/adapters
*/
const execFileAsync = promisify(execFile);
/** The 8 supported image ratios (contract: never infer, never extend). */
const SUPPORTED_RATIOS = [
	"21:9",
	"16:9",
	"3:2",
	"4:3",
	"1:1",
	"3:4",
	"2:3",
	"9:16"
];
/** The 3 supported image resolution classes (contract). */
const SUPPORTED_RESOLUTIONS = [
	"1K",
	"2K",
	"4K"
];
/** Public image route ids accepted by `image_provider` (DSH canonical ids). */
const SUPPORTED_IMAGE_PROVIDERS = [
	"comfly-gemini-flash-preview",
	"comfly-gpt-image-2",
	"dreamina-image"
];
/** 1K-only pixel allowlist for the supported ratios (identical to Codex GEMINI_LITE_1K_SIZES). */
const RATIO_SIZES = {
	"21:9": "1584x672",
	"16:9": "1376x768",
	"3:2": "1264x848",
	"4:3": "1200x896",
	"1:1": "1024x1024",
	"3:4": "896x1200",
	"2:3": "848x1264",
	"9:16": "768x1376"
};
/** Comfly Gemini models per resolution class (contract: models_by_resolution). */
const GEMINI_MODELS_BY_RESOLUTION = {
	"1K": "gemini-3.1-flash-image-preview",
	"2K": "gemini-3.1-flash-image-preview-2k",
	"4K": "gemini-3.1-flash-image-preview-4k"
};
/** GPT Image 2 concrete pixel sizes per ratio x resolution (contract: GPT_IMAGE_2_SIZES). */
const GPT_IMAGE_2_SIZES = {
	"1K": {
		"21:9": "1280x544",
		"16:9": "1280x720",
		"3:2": "1200x800",
		"4:3": "1152x864",
		"1:1": "1024x1024",
		"3:4": "864x1152",
		"2:3": "800x1200",
		"9:16": "720x1280"
	},
	"2K": {
		"21:9": "2048x880",
		"16:9": "2048x1152",
		"3:2": "1920x1280",
		"4:3": "1920x1440",
		"1:1": "2048x2048",
		"3:4": "1440x1920",
		"2:3": "1280x1920",
		"9:16": "1152x2048"
	},
	"4K": {
		"21:9": "3840x1648",
		"16:9": "3840x2160",
		"3:2": "3520x2352",
		"4:3": "3312x2480",
		"1:1": "2880x2880",
		"3:4": "2480x3312",
		"2:3": "2352x3520",
		"9:16": "2160x3840"
	}
};
/** Resolve an explicit ratio to a pixel size; throws input_error otherwise. */
function ratioToSize(ratio) {
	const value = (ratio ?? "").trim();
	const mapped = RATIO_SIZES[value];
	if (mapped !== void 0) return mapped;
	throw mediaErrors.input(`unsupported image_ratio "${value}"; supported values: ${SUPPORTED_RATIOS.join(", ")}`);
}
/** Validate a user-supplied resolution class; throws input_error for anything else. */
function assertSupportedResolution(resolution) {
	if (resolution !== void 0 && !SUPPORTED_RESOLUTIONS.includes(resolution)) throw mediaErrors.input(`Unsupported image_resolution "${resolution}"; supported values: ${SUPPORTED_RESOLUTIONS.join(", ")}`);
}
/** Gemini pixel size: scale the 1K ratio allowlist by the resolution class. */
function geminiSizeFor(ratio, resolution) {
	const scale = {
		"1K": 1,
		"2K": 2,
		"4K": 4
	}[resolution];
	if (scale === void 0) throw mediaErrors.input(`Unsupported image_resolution "${resolution}"; supported values: ${SUPPORTED_RESOLUTIONS.join(", ")}`);
	const base = RATIO_SIZES[ratio];
	if (base === void 0) throw mediaErrors.input(`Unsupported image_ratio "${ratio}"; supported values: ${SUPPORTED_RATIOS.join(", ")}`);
	const [width, height] = base.split("x").map(Number);
	return `${width * scale}x${height * scale}`;
}
/** GPT Image 2 pixel size: table lookup per ratio x resolution. */
function gptImage2SizeFor(ratio, resolution) {
	const sizes = GPT_IMAGE_2_SIZES[resolution];
	if (sizes === void 0) throw mediaErrors.input(`Unsupported image_resolution "${resolution}"; supported values: ${SUPPORTED_RESOLUTIONS.join(", ")}`);
	const px = sizes[ratio];
	if (px === void 0) throw mediaErrors.input(`Unsupported image_ratio "${ratio}" for ${resolution} output; supported values: ${SUPPORTED_RATIOS.join(", ")}`);
	return px;
}
/** Classify an HTTP status into the failure taxonomy. */
function classifyHttp(status) {
	switch (status) {
		case 400:
		case 422: return mediaErrors.policy(`HTTP ${status}: request rejected by provider policy`);
		case 401:
		case 403: return mediaErrors.auth(`HTTP ${status}: provider rejected credentials`);
		case 402:
		case 429: return mediaErrors.quota(`HTTP ${status}: provider quota or rate limit`);
		default:
			if (status >= 500) return mediaErrors.provider(`HTTP ${status}: provider server error`);
			return mediaErrors.provider(`HTTP ${status}: unexpected provider failure`);
	}
}
/** Resolve a credential: injected map (DSH credentials service) first, env fallback. */
function credentials(cfg, env) {
	const injected = cfg.credentials?.[env];
	if (typeof injected === "string" && injected.length > 0) return injected;
	return process.env[env] || void 0;
}
/**
* Comfly OpenAI-compatible adapter (one fixed model, one request).
*
* `options.geminiProfile` switches to the Gemini contract: the model is
* selected per resolution class (1K/2K/4K) and the body carries the
* provider-specific `resolution` field. GPT Image 2 receives a concrete
* pixel `size` and never sends `resolution`.
*/
function comflyAdapter(id, model, cfg, options = {}) {
	const defaultResolution = options.geminiProfile ? "2K" : "4K";
	return {
		id,
		model,
		capacityKey: id,
		async checkReady() {
			return {
				ready: Boolean(credentials(cfg, cfg.comflyApiKeyEnv)),
				reason: cfg.comflyApiKeyEnv
			};
		},
		async execute(input) {
			const apiKey = credentials(cfg, cfg.comflyApiKeyEnv);
			if (!apiKey) throw mediaErrors.auth(`missing credential ${cfg.comflyApiKeyEnv}`);
			const resolution = input.resolution ?? defaultResolution;
			const effectiveModel = options.geminiProfile ? GEMINI_MODELS_BY_RESOLUTION[resolution] ?? model : model;
			const size = options.geminiProfile ? geminiSizeFor(input.ratio, resolution) : gptImage2SizeFor(input.ratio, resolution);
			return {
				outputPath: await downloadImageTo(await openAiImageUrl({
					baseURL: cfg.comflyBaseURL,
					apiKey,
					model: effectiveModel,
					prompt: input.prompt,
					size,
					resolution,
					images: input.images,
					proxyUrl: cfg.proxyUrl,
					signal: input.signal,
					timeoutMs: input.budgetMs
				}), join(input.privateRoot, "jobs", "_router", "outputs"), {
					proxyUrl: cfg.proxyUrl,
					signal: input.signal,
					timeoutMs: Math.min(input.budgetMs, 12e4)
				}),
				model: effectiveModel
			};
		}
	};
}
/** Dreamina image adapter (best effort; last fallback, shared seedance-cli capacity). */
function dreaminaImageAdapter(cfg) {
	const id = "dreamina-image";
	const model = "4.0";
	return {
		id,
		model,
		capacityKey: "seedance-cli",
		async checkReady() {
			try {
				await execFileAsync(cfg.dreaminaPath, ["--help"], {
					timeout: 1e4,
					windowsHide: true
				});
				return { ready: true };
			} catch {
				return {
					ready: false,
					reason: `dreamina binary not usable: ${cfg.dreaminaPath}`
				};
			}
		},
		async execute(input) {
			const outDir = await ensureDir(join(input.privateRoot, "jobs", "_router", "outputs"));
			const resolution = (input.resolution ?? "1K").toLowerCase();
			const args = [
				...input.images.length > 0 ? [
					"image2image",
					`--prompt=${input.prompt}`,
					`--model_version=${model}`,
					...input.images.map((p) => `--image=${p}`)
				] : [
					"text2image",
					`--prompt=${input.prompt}`,
					`--model_version=${model}`
				],
				`--ratio=${input.ratio}`,
				`--resolution_type=${resolution}`
			];
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), input.budgetMs);
			try {
				await execFileAsync(cfg.dreaminaPath, args, {
					timeout: input.budgetMs,
					windowsHide: true
				});
			} catch (error) {
				if (controller.signal.aborted) throw mediaErrors.providerTimeout(`dreamina image timed out after ${Math.round(input.budgetMs / 1e3)}s`);
				throw mediaErrors.provider(`dreamina image failed: ${String(error?.stderr ?? error?.message ?? error).slice(0, 300)}`);
			} finally {
				clearTimeout(timer);
			}
			const files = (await readdir(outDir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => join(outDir, f));
			if (files.length === 0) throw mediaErrors.provider("dreamina image produced no output file");
			return { outputPath: files.sort((a, b) => b.length - a.length)[0] };
		}
	};
}
/** Legacy adapter ids -> current ids (configs written against old names keep working). */
const ADAPTER_ALIASES = { "comfly-gemini-lite": "comfly-gemini-flash-preview" };
/** Build the default adapter chain in contract priority order. */
function defaultAdapters(cfg) {
	const chain = [
		comflyAdapter("comfly-gemini-flash-preview", GEMINI_MODELS_BY_RESOLUTION["1K"], cfg, { geminiProfile: true }),
		comflyAdapter("comfly-gpt-image-2", "gpt-image-2", cfg),
		dreaminaImageAdapter(cfg)
	];
	if (!cfg.enabled || cfg.enabled.length === 0) return chain;
	const enabledIds = new Set(cfg.enabled.map((id) => ADAPTER_ALIASES[id] ?? id));
	return chain.filter((a) => enabledIds.has(a.id));
}
/**
* Resolve a user-explicit `image_provider` to exactly one adapter.
* Unknown routes and routes disabled by config fail as input_error before
* any provider is called. The explicit route never falls back elsewhere.
*/
function resolveExplicitAdapter(requested, fullChain, enabledChain) {
	const id = ADAPTER_ALIASES[requested] ?? requested;
	const adapter = fullChain.find((a) => a.id === id);
	if (adapter === void 0) throw mediaErrors.input(`Unsupported image_provider "${requested}"; supported routes: ${SUPPORTED_IMAGE_PROVIDERS.join(", ")}`);
	if (!enabledChain.some((a) => a.id === id)) throw mediaErrors.input(`Requested image_provider is disabled: ${id}`);
	return adapter;
}
/** Normalize references (EXIF + ≤1920 px) into the private inputs dir. */
async function normalizeInputs(images, privateRoot, taskId) {
	const out = [];
	const dir = await ensureDir(join(privateRoot, "jobs", taskId, "inputs"));
	for (const src of images) {
		if (!src || src.trim().length === 0) throw mediaErrors.input("empty image path in reference list");
		try {
			const pipeline = sharp(src, { failOn: "none" }).rotate();
			const meta = await pipeline.metadata();
			const w = meta.width ?? 0;
			const h = meta.height ?? 0;
			const longest = Math.max(w, h);
			let target = pipeline;
			if (longest > 1920) target = pipeline.resize({
				width: 1920,
				height: 1920,
				fit: "inside",
				withoutEnlargement: true
			});
			const ext = (src.split(".").pop() ?? "png").toLowerCase().replace("jpg", "jpeg");
			const dest = join(dir, `input-${out.length + 1}.${ext === "jpeg" ? "jpg" : ext}`);
			await target.toFile(dest);
			out.push(dest);
		} catch (error) {
			throw mediaErrors.input(`cannot read reference image ${src}: ${error?.message ?? error}`);
		}
	}
	return out;
}
/**
* Run the serial image router: validate ratio/resolution/provider, normalize
* inputs, then attempt adapters in priority order with per-adapter budget
* = min(120s, remaining) and a 300 s whole-task deadline, honoring
* per-capacity slot leases. An explicit `imageProvider` restricts the run to
* that single adapter with no cross-route fallback.
*/
async function runImageRouter(options) {
	const { prompt, images, ratio, config, privateRoot, signal, taskId = newTaskId() } = options;
	ratioToSize(ratio);
	assertSupportedResolution(options.resolution);
	const fullChain = options.adapters ?? defaultAdapters({
		...config,
		enabled: []
	});
	const enabledChain = options.adapters ?? defaultAdapters(config);
	const explicit = options.imageProvider ? resolveExplicitAdapter(options.imageProvider, fullChain, enabledChain) : void 0;
	const adapters = explicit ? [explicit] : enabledChain;
	const taskDeadline = Date.now() + config.taskTimeoutMs;
	const attempts = [];
	const startedAt = Date.now();
	const normalized = await normalizeInputs(images, privateRoot, taskId);
	for (const adapter of adapters) {
		const remaining = taskDeadline - Date.now();
		if (remaining <= 0) throw mediaErrors.taskTimeout(`image task exceeded ${Math.round(config.taskTimeoutMs / 1e3)}s deadline`);
		const adapterBudget = Math.min(config.providerTimeoutMs, remaining);
		const attemptStart = Date.now();
		if ((await isCircuitOpen(privateRoot, adapter.id)).open) {
			if (explicit) throw mediaErrors.providerTimeout(`requested image_provider ${adapter.id} is in circuit cooldown`);
			attempts.push({
				adapter: adapter.id,
				model: adapter.model,
				status: "skipped",
				failureClass: "circuit_open",
				reason: "circuit open: cooling down after repeated failures"
			});
			await appendSafeLog(privateRoot, "media-router", {
				taskId,
				event: "adapter_circuit_open",
				adapter: adapter.id
			});
			continue;
		}
		const ready = await adapter.checkReady();
		if (!ready.ready) {
			if (explicit) throw mediaErrors.auth(`requested image_provider ${adapter.id} is not ready: ${ready.reason ?? "unknown"}`);
			attempts.push({
				adapter: adapter.id,
				model: adapter.model,
				status: "skipped",
				failureClass: "auth_unavailable",
				reason: ready.reason ?? "not ready"
			});
			await appendSafeLog(privateRoot, "media-router", {
				taskId,
				event: "adapter_skipped",
				adapter: adapter.id,
				reason: ready.reason
			});
			continue;
		}
		let release;
		try {
			release = await acquireSlot(join(privateRoot, "locks"), adapter.capacityKey, config.maxConcurrency, {
				taskId,
				timeoutMs: adapterBudget
			});
		} catch (error) {
			const reason = error?.message ?? "slot busy";
			if (explicit) throw mediaErrors.providerTimeout(`requested image_provider ${adapter.id} slot busy: ${reason}`);
			attempts.push({
				adapter: adapter.id,
				model: adapter.model,
				status: "timeout",
				failureClass: "provider_timeout",
				durationMs: Date.now() - attemptStart,
				reason
			});
			continue;
		}
		try {
			const result = await adapter.execute({
				prompt,
				images: normalized,
				size: ratioToSize(ratio),
				ratio,
				resolution: options.resolution,
				privateRoot,
				proxyUrl: config.proxyUrl,
				signal,
				budgetMs: adapterBudget
			});
			const model = result.model ?? adapter.model;
			await recordProviderOutcome(privateRoot, adapter.id, true);
			attempts.push({
				adapter: adapter.id,
				model,
				status: "success",
				durationMs: Date.now() - attemptStart
			});
			await appendSafeLog(privateRoot, "media-router", {
				taskId,
				event: "adapter_success",
				adapter: adapter.id,
				model,
				durationMs: Date.now() - attemptStart
			});
			return {
				outputPath: result.outputPath,
				provider: adapter.id,
				model,
				attempts
			};
		} catch (error) {
			let cls = "definite_provider_failure";
			if (error instanceof MediaError) cls = error.cls;
			else if (error instanceof HttpStatusError) cls = classifyHttp(error.status).cls;
			await recordProviderOutcome(privateRoot, adapter.id, false);
			const durationMs = Date.now() - attemptStart;
			attempts.push({
				adapter: adapter.id,
				model: adapter.model,
				status: cls === "provider_timeout" ? "timeout" : "failed",
				failureClass: cls,
				durationMs,
				reason: String(error?.message ?? error).slice(0, 300)
			});
			await appendSafeLog(privateRoot, "media-router", {
				taskId,
				event: "adapter_failed",
				adapter: adapter.id,
				failureClass: cls,
				durationMs
			});
			if (explicit) throw error;
			if (!FALLBACK_ALLOWED.has(cls)) throw error;
		} finally {
			await release?.();
		}
	}
	throw mediaErrors.provider(`all image providers failed after ${attempts.length} attempts (${Math.round((Date.now() - startedAt) / 1e3)}s)`);
}
//#endregion
export { ratioToSize as a, SUPPORTED_RESOLUTIONS as i, SUPPORTED_IMAGE_PROVIDERS as n, runImageRouter as o, SUPPORTED_RATIOS as r, ADAPTER_ALIASES as t };
