import { n as MediaError, r as mediaErrors, t as FALLBACK_ALLOWED } from "./failure.js";
import { a as ensureDir, n as acquireSlot, o as newTaskId, r as appendSafeLog } from "./private-runtime.js";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { ProxyAgent, fetch as fetch$1 } from "undici";
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
	const { baseURL, apiKey, model, prompt, size, images = [], proxyUrl, signal, timeoutMs = 12e4 } = options;
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
			const form = new FormData();
			form.append("model", model);
			form.append("prompt", prompt);
			form.append("n", "1");
			form.append("size", size);
			form.append("response_format", "url");
			for (const imagePath of images) {
				const data = await (await import("node:fs/promises")).readFile(imagePath);
				const name = imagePath.split(/[\\/]/).pop() ?? "ref.png";
				const ext = (name.slice(name.lastIndexOf(".")) || ".png").toLowerCase();
				form.append("image", new Blob([data], { type: {
					".png": "image/png",
					".jpg": "image/jpeg",
					".jpeg": "image/jpeg",
					".webp": "image/webp",
					".gif": "image/gif"
				}[ext] ?? "image/png" }), name);
			}
			response = await fetch$1(`${baseURL.replace(/\/+$/, "")}/images/edits`, {
				method: "POST",
				headers: auth,
				body: form,
				...common
			});
		} else response = await fetch$1(`${baseURL.replace(/\/+$/, "")}/images/generations`, {
			method: "POST",
			headers: {
				...auth,
				"Content-Type": "application/json; charset=utf-8"
			},
			body: JSON.stringify({
				model,
				prompt,
				n: 1,
				size,
				response_format: "url"
			}),
			...common
		});
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
		const download = await fetch$1(url, {
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
*   dreamina image + video.
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
/** 1K-only pixel allowlist for the supported ratios. */
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
/** Resolve an explicit ratio to a pixel size; throws input_error otherwise. */
function ratioToSize(ratio) {
	const value = (ratio ?? "").trim();
	const mapped = RATIO_SIZES[value];
	if (mapped !== void 0) return mapped;
	throw mediaErrors.input(`unsupported image_ratio "${value}"; supported values: ${SUPPORTED_RATIOS.join(", ")}`);
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
/** Comfly OpenAI-compatible adapter (one fixed model, one request). */
function comflyAdapter(id, model, cfg) {
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
			return { outputPath: await downloadImageTo(await openAiImageUrl({
				baseURL: cfg.comflyBaseURL,
				apiKey,
				model,
				prompt: input.prompt,
				size: input.size,
				images: input.images,
				proxyUrl: cfg.proxyUrl,
				signal: input.signal,
				timeoutMs: input.budgetMs
			}), join(input.privateRoot, "jobs", "_router", "outputs"), {
				proxyUrl: cfg.proxyUrl,
				signal: input.signal,
				timeoutMs: Math.min(input.budgetMs, 12e4)
			}) };
		}
	};
}
/** APIMart OpenAI-compatible adapter (references as base64 data URIs). */
function apimartAdapter(cfg) {
	const id = "apimart-gpt-image-2";
	const model = "gpt-image-2";
	return {
		id,
		model,
		capacityKey: id,
		async checkReady() {
			return {
				ready: Boolean(credentials(cfg, cfg.apimartApiKeyEnv)),
				reason: cfg.apimartApiKeyEnv
			};
		},
		async execute(input) {
			const apiKey = credentials(cfg, cfg.apimartApiKeyEnv);
			if (!apiKey) throw mediaErrors.auth(`missing credential ${cfg.apimartApiKeyEnv}`);
			const base = cfg.apimartBaseURL.replace(/\/+$/, "");
			const headers = {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json; charset=utf-8"
			};
			const body = {
				model,
				prompt: input.prompt,
				n: 1,
				size: input.size,
				response_format: "url"
			};
			if (input.images.length > 0) {
				const image = input.images[0];
				const data = await readFile(image);
				body.image = `data:${`image/${image.split(".").pop()?.toLowerCase() === "png" ? "png" : "jpeg"}`};base64,${data.toString("base64")}`;
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), input.budgetMs);
			input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
			try {
				const response = await fetch(`${base}/images/generations`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: controller.signal
				});
				if (!response.ok) throw new HttpStatusError(response.status, `APIMart request failed with HTTP ${response.status}`);
				const data = (await response.json())?.data;
				if (!Array.isArray(data) || !data[0]?.url) throw mediaErrors.download("APIMart response contains no image URL");
				const dest = join(input.privateRoot, "jobs", "_router", "outputs");
				return { outputPath: await downloadImageTo(data[0].url, dest, {
					proxyUrl: cfg.proxyUrl,
					signal: input.signal,
					timeoutMs: Math.min(input.budgetMs, 12e4)
				}) };
			} finally {
				clearTimeout(timer);
			}
		}
	};
}
/** Official Google Gemini image adapter (interactions API, base64 output). */
function geminiAdapter(cfg) {
	const id = "google-gemini-image";
	const model = "gemini-3.1-flash-image";
	return {
		id,
		model,
		capacityKey: id,
		async checkReady() {
			return {
				ready: Boolean(credentials(cfg, cfg.geminiApiKeyEnv)),
				reason: cfg.geminiApiKeyEnv
			};
		},
		async execute(input) {
			const apiKey = credentials(cfg, cfg.geminiApiKeyEnv);
			if (!apiKey) throw mediaErrors.auth(`missing credential ${cfg.geminiApiKeyEnv}`);
			const ratioKey = Object.entries(RATIO_SIZES).find(([, px]) => px === input.size)?.[0] ?? "16:9";
			const inputParts = [{
				type: "text",
				text: input.prompt
			}];
			for (const path of input.images) {
				const data = await readFile(path);
				const mime = `image/${path.split(".").pop()?.toLowerCase() === "png" ? "png" : "jpeg"}`;
				inputParts.push({
					type: "image",
					data: data.toString("base64"),
					mime_type: mime
				});
			}
			const body = {
				model,
				input: inputParts,
				response_format: {
					type: "image",
					mime_type: "image/jpeg",
					aspect_ratio: ratioKey,
					image_size: "1K"
				}
			};
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), input.budgetMs);
			input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
			try {
				const response = await fetch(cfg.geminiApiURL, {
					method: "POST",
					headers: {
						"x-goog-api-key": apiKey,
						"Content-Type": "application/json"
					},
					body: JSON.stringify(body),
					signal: controller.signal
				});
				if (!response.ok) throw new HttpStatusError(response.status, `Gemini request failed with HTTP ${response.status}`);
				const found = extractGeminiImage(await response.json());
				if (!found) throw mediaErrors.download("Gemini response contains no image data");
				const bytes = Buffer.from(found.data, "base64");
				if (!hasImageSignature(new Uint8Array(bytes))) throw mediaErrors.download("Gemini image data failed signature check");
				const dest = await ensureDir(join(input.privateRoot, "jobs", "_router", "outputs"));
				const finalPath = join(dest, `gemini-${Date.now()}${extensionFor(new Uint8Array(bytes))}`);
				await writeFile(finalPath, bytes);
				return { outputPath: finalPath };
			} finally {
				clearTimeout(timer);
			}
		}
	};
}
/** Deep-walk a Gemini payload for the first base64 image. */
function extractGeminiImage(payload) {
	const direct = [payload?.output_image, payload?.output?.image];
	for (const item of direct) if (item && typeof item.data === "string" && item.data.length > 0) return {
		data: item.data,
		mimeType: item.mime_type
	};
	const walk = (value) => {
		if (Array.isArray(value)) {
			for (const child of value) {
				const found = walk(child);
				if (found) return found;
			}
			return;
		}
		if (value && typeof value === "object") {
			if (typeof value.data === "string" && value.data.length > 0 && (value.type === "image" || String(value.mime_type ?? "").startsWith("image/"))) return {
				data: value.data,
				mimeType: value.mime_type
			};
			for (const key of Object.keys(value)) {
				const found = walk(value[key]);
				if (found) return found;
			}
		}
	};
	return walk(payload);
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
			const args = input.images.length > 0 ? [
				"image2image",
				`--prompt=${input.prompt}`,
				`--model_version=${model}`,
				...input.images.map((p) => `--image=${p}`)
			] : [
				"text2image",
				`--prompt=${input.prompt}`,
				`--model_version=${model}`
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
/** Build the default adapter chain in contract priority order. */
function defaultAdapters(cfg) {
	const chain = [
		comflyAdapter("comfly-gemini-lite", "gemini-3.1-flash-image-preview", cfg),
		comflyAdapter("comfly-gpt-image-2-all", "gpt-image-2-all", cfg),
		comflyAdapter("comfly-gpt-image-2", "gpt-image-2", cfg),
		apimartAdapter(cfg),
		geminiAdapter(cfg),
		dreaminaImageAdapter(cfg)
	];
	if (!cfg.enabled || cfg.enabled.length === 0) return chain;
	return chain.filter((a) => cfg.enabled.includes(a.id));
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
* Run the serial image router: normalize inputs, then attempt adapters in
* priority order with per-adapter budget = min(120s, remaining) and a
* 300 s whole-task deadline, honoring per-capacity slot leases.
*/
async function runImageRouter(options) {
	const { prompt, images, ratio, config, privateRoot, signal, taskId = newTaskId() } = options;
	const size = ratioToSize(ratio);
	const adapters = options.adapters ?? defaultAdapters(config);
	const taskDeadline = Date.now() + config.taskTimeoutMs;
	const attempts = [];
	const startedAt = Date.now();
	const normalized = await normalizeInputs(images, privateRoot, taskId);
	for (const adapter of adapters) {
		const remaining = taskDeadline - Date.now();
		if (remaining <= 0) throw mediaErrors.taskTimeout(`image task exceeded ${Math.round(config.taskTimeoutMs / 1e3)}s deadline`);
		const adapterBudget = Math.min(config.providerTimeoutMs, remaining);
		const attemptStart = Date.now();
		const ready = await adapter.checkReady();
		if (!ready.ready) {
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
				size,
				privateRoot,
				proxyUrl: config.proxyUrl,
				signal,
				budgetMs: adapterBudget
			});
			attempts.push({
				adapter: adapter.id,
				model: adapter.model,
				status: "success",
				durationMs: Date.now() - attemptStart
			});
			await appendSafeLog(privateRoot, "media-router", {
				taskId,
				event: "adapter_success",
				adapter: adapter.id,
				model: adapter.model,
				durationMs: Date.now() - attemptStart
			});
			return {
				outputPath: result.outputPath,
				provider: adapter.id,
				model: adapter.model,
				attempts
			};
		} catch (error) {
			let cls = "definite_provider_failure";
			if (error instanceof MediaError) cls = error.cls;
			else if (error instanceof HttpStatusError) cls = classifyHttp(error.status).cls;
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
			if (!FALLBACK_ALLOWED.has(cls)) throw error;
		} finally {
			await release?.();
		}
	}
	throw mediaErrors.provider(`all image providers failed after ${attempts.length} attempts (${Math.round((Date.now() - startedAt) / 1e3)}s)`);
}
//#endregion
export { ratioToSize as n, runImageRouter as r, SUPPORTED_RATIOS as t };
