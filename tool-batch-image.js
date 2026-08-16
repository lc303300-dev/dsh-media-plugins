import { i as SUPPORTED_RESOLUTIONS, n as SUPPORTED_IMAGE_PROVIDERS, o as runImageRouter, r as SUPPORTED_RATIOS, t as ADAPTER_ALIASES } from "./adapters.js";
import { a as ensureDir, d as resolvePrivateRoot, r as appendSafeLog } from "./private-runtime.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
/** Structural validation; throws with a precise message. */
function validateManifest(raw) {
	const m = raw ?? {};
	if (!Array.isArray(m.groups) || m.groups.length === 0) throw new Error("manifest.groups must be a non-empty array");
	const ids = /* @__PURE__ */ new Set();
	let total = 0;
	for (const g of m.groups) {
		if (typeof g.id !== "string" || g.id.trim().length === 0) throw new Error("each group requires a unique id");
		if (ids.has(g.id)) throw new Error(`duplicate group id: ${g.id}`);
		ids.add(g.id);
		if (typeof g.prompt !== "string" || g.prompt.trim().length === 0) throw new Error(`group ${g.id}: prompt must be non-empty`);
		if (!Number.isInteger(g.candidates) || g.candidates < 1) throw new Error(`group ${g.id}: candidates must be an integer >= 1`);
		const ratio = g.image_ratio ?? m.image_ratio;
		if (!ratio || !SUPPORTED_RATIOS.includes(ratio)) throw new Error(`group ${g.id}: image_ratio is required and must be one of ${SUPPORTED_RATIOS.join(", ")}`);
		if (g.reference_images !== void 0) {
			if (!Array.isArray(g.reference_images) || g.reference_images.some((p) => typeof p !== "string" || p.trim().length === 0)) throw new Error(`group ${g.id}: reference_images must be a non-empty array of paths`);
		}
		if (g.original_image !== void 0 && (typeof g.original_image !== "string" || g.original_image.trim().length === 0)) throw new Error(`group ${g.id}: original_image must be a path string`);
		total += g.candidates;
	}
	const concurrency = m.concurrency ?? 10;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error(`concurrency must be an integer 1..10, got ${concurrency}`);
	if (m.image_resolution !== void 0 && !SUPPORTED_RESOLUTIONS.includes(m.image_resolution)) throw new Error(`image_resolution must be one of ${SUPPORTED_RESOLUTIONS.join(", ")}, got ${m.image_resolution}`);
	if (m.image_provider !== void 0) {
		const canonical = ADAPTER_ALIASES[m.image_provider] ?? m.image_provider;
		if (!SUPPORTED_IMAGE_PROVIDERS.includes(canonical)) throw new Error(`image_provider must be a supported unified image route, got ${m.image_provider}`);
	}
	if (m.completion_grace_seconds !== void 0) {
		const grace = m.completion_grace_seconds;
		if (!Number.isFinite(grace) || grace <= 0 || grace > 120) throw new Error(`completion_grace_seconds must be > 0 and <= 120, got ${grace}`);
	}
	return m;
}
/** Stable job key: sha256 of the normalized manifest (order-insensitive groups). */
function jobKeyFor(manifest) {
	const normalized = {
		groups: [...manifest.groups].map((g) => ({
			id: g.id,
			prompt: g.prompt.trim(),
			candidates: g.candidates,
			image_ratio: g.image_ratio ?? manifest.image_ratio,
			reference_images: g.reference_images ?? null,
			original_image: g.original_image ?? null
		})).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		image_resolution: manifest.image_resolution ?? null,
		image_provider: manifest.image_provider ?? null,
		concurrency: manifest.concurrency ?? 10
	};
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 24);
}
/** Deadline math: dispatch cutoff = ceil(total/concurrency)*60s*1.5 (or explicit
*  override); completion grace follows it (default 120 s, max 120 s). */
function computeDeadline(manifest, now = Date.now()) {
	const total = manifest.groups.reduce((acc, g) => acc + g.candidates, 0);
	const concurrency = manifest.concurrency ?? 10;
	const estimateSeconds = Math.ceil(total / concurrency) * 60;
	const deadlineSeconds = manifest.deadline_seconds ?? Math.ceil(estimateSeconds * 1.5);
	const completionGraceSeconds = manifest.completion_grace_seconds ?? 120;
	return {
		jobKey: jobKeyFor(manifest),
		total,
		concurrency,
		estimateSeconds,
		deadlineSeconds,
		completionGraceSeconds,
		maxRuntimeSeconds: deadlineSeconds + completionGraceSeconds,
		deadlineAtMs: now + deadlineSeconds * 1e3
	};
}
/** Contact sheet HTML: slot 0 shows the group's original/reference image, then fixed numbered candidate slots. */
function buildContactSheetHtml(plan, groups, landed) {
	const byGroup = /* @__PURE__ */ new Map();
	for (const item of landed) {
		if (!byGroup.has(item.groupId)) byGroup.set(item.groupId, /* @__PURE__ */ new Map());
		byGroup.get(item.groupId).set(item.slot, item);
	}
	const rows = [];
	rows.push("<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\"><title>Batch contact sheet</title>");
	rows.push("<style>body{font-family:system-ui;margin:24px}table{border-collapse:collapse;margin-bottom:24px}td{border:1px solid #ccc;padding:8px;text-align:center;vertical-align:top}img{max-width:180px;max-height:180px;display:block}.slot{font-size:12px;color:#666;margin-top:4px}</style>");
	rows.push("</head><body>");
	rows.push(`<h1>Batch ${plan.jobKey}</h1><p>total ${plan.total} · concurrency ${plan.concurrency} · deadline ${plan.deadlineSeconds}s · landed ${landed.length}</p>`);
	for (const group of groups) {
		const items = byGroup.get(group.id) ?? /* @__PURE__ */ new Map();
		const cells = [];
		if (group.original_image !== void 0) cells.push(`<td><img src="${relPath(group.original_image)}" alt="original"><div class="slot">${group.id} · 原始图</div></td>`);
		for (let slot = 1; slot <= group.candidates; slot += 1) {
			const item = items.get(slot);
			cells.push(item ? `<td><img src="${relPath(item.path)}" alt="slot ${slot}"><div class="slot">${group.id} · #${slot} ✓</div></td>` : `<td style="color:#bbb"><div>—</div><div class="slot">${group.id} · #${slot} ∅</div></td>`);
		}
		rows.push(`<h2>${group.id} (${group.image_ratio ?? ""}, ${group.candidates} 张)</h2><table><tr>${cells.join("")}</tr></table>`);
	}
	rows.push("</body></html>");
	return rows.join("\n");
}
/** Relative path from the HTML file's directory (forward slashes); the sheet
 *  lives in <outputDir>/contact-<key>.html and outputs sit under
 *  <outputDir>/<jobKey>/..., so strip the workspace-root "outputs" segment. */
function relPath(p) {
	return p.split("\\").join("/").replace(/^.*\/outputs\//, "");
}
/** Flatten the manifest into one task descriptor per candidate. */
function flattenTasks(manifest) {
	const tasks = [];
	for (const g of manifest.groups) {
		const ratio = g.image_ratio ?? manifest.image_ratio;
		for (let i = 1; i <= g.candidates; i += 1) tasks.push({
			groupId: g.id,
			slot: i,
			prompt: g.prompt.trim(),
			ratio,
			resolution: manifest.image_resolution,
			imageProvider: manifest.image_provider,
			references: g.reference_images ?? void 0
		});
	}
	return tasks;
}
//#endregion
//#region src/tool-batch-image.ts
/** Bundle root: the built tool file lives at the package root. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-batch-image";
const inject = ["tools", "credentials"];
const Config = z.object({
	privateDir: z.string().default(""),
	outputDir: z.string().default("outputs"),
	comflyBaseURL: z.string().default("https://ai.comfly.org/v1"),
	comflyApiKeyEnv: z.string().default("COMFLY_API_KEY"),
	apimartBaseURL: z.string().default("https://api.apimart.ai/v1"),
	apimartApiKeyEnv: z.string().default("APIMART_API_KEY"),
	geminiApiURL: z.string().default("https://generativelanguage.googleapis.com/v1beta/interactions"),
	geminiApiKeyEnv: z.string().default("GEMINI_API_KEY"),
	dreaminaPath: z.string().default(join(PACKAGE_ROOT, "bin", "dreamina.exe")),
	proxyUrl: z.string().default(""),
	maxConcurrency: z.number().default(6),
	providerTimeoutMs: z.number().default(12e4),
	taskTimeoutMs: z.number().default(3e5),
	enabled: z.array(z.string()).default([])
});
function openDb(dbPath) {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_key TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, manifest_base TEXT, status TEXT NOT NULL,
      total INTEGER NOT NULL, concurrency INTEGER NOT NULL, estimate_seconds INTEGER NOT NULL,
      deadline_seconds INTEGER NOT NULL, completion_grace_seconds INTEGER NOT NULL DEFAULT 120,
      landed INTEGER DEFAULT 0, abandoned INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      job_key TEXT NOT NULL, task_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, slot INTEGER NOT NULL,
      prompt TEXT NOT NULL, ratio TEXT NOT NULL, resolution TEXT, provider TEXT, status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT, finished_at TEXT, output_path TEXT, error TEXT, model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_key);
  `);
	const columns = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
	if (!columns.includes("completion_grace_seconds")) db.exec("ALTER TABLE jobs ADD COLUMN completion_grace_seconds INTEGER NOT NULL DEFAULT 120");
	if (!columns.includes("manifest_base")) db.exec("ALTER TABLE jobs ADD COLUMN manifest_base TEXT");
	return db;
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function apply(ctx, config) {
	const baseRouterConfig = {
		comflyBaseURL: config.comflyBaseURL,
		comflyApiKeyEnv: config.comflyApiKeyEnv,
		apimartBaseURL: config.apimartBaseURL,
		apimartApiKeyEnv: config.apimartApiKeyEnv,
		geminiApiURL: config.geminiApiURL,
		geminiApiKeyEnv: config.geminiApiKeyEnv,
		dreaminaPath: config.dreaminaPath,
		proxyUrl: config.proxyUrl,
		maxConcurrency: config.maxConcurrency,
		providerTimeoutMs: config.providerTimeoutMs,
		taskTimeoutMs: config.taskTimeoutMs,
		outputDir: config.outputDir,
		enabled: config.enabled
	};
	/** Resolve provider keys through the DSH credentials service per call. */
	async function resolveCredentials() {
		const credentials = {};
		for (const env of [
			config.comflyApiKeyEnv,
			config.apimartApiKeyEnv,
			config.geminiApiKeyEnv
		]) try {
			const resolved = await ctx.credentials?.resolve(credentialRef(env));
			if (resolved?.value) credentials[env] = String(resolved.value);
		} catch {}
		return credentials;
	}
	ctx.tools.register(defineTool({
		name: "batch_image",
		description: "确定性批量图片调度器（Codex_Batch_Image 的 DSH 重建）：manifest（组 id 唯一、每组 prompt 非空、candidates ≥ 1、image_ratio 必填 8 值之一；可选批次级 image_resolution 1K/2K/4K、image_provider 单线路、completion_grace_seconds 完成宽限期）→ 稳定 job key → SQLite 状态 → 最多 10 路并发、真实提交间隔 ≥ 1 秒 → 分派截止（默认 ceil(总数÷并发)×60 秒×1.5，可用 deadline_seconds 覆盖）：截止后不再启动新任务，未启动任务永久 abandoned（batch_deadline_not_submitted，不查询、不重试）；已在运行的任务最多再等 completion_grace_seconds（默认 120 秒、上限 120 秒、可缩短不可延长），宽限期内落地成功照常收集，超时仍未完成的运行中任务终止并标记 failed（batch_completion_grace_timeout）→ 生成固定槽位编号联系表供人工选图。付费执行全部走统一媒体路由器；同一候选绝不重复提交（job key + 任务 id 幂等）。",
		parameters: {
			command: {
				type: "string",
				enum: [
					"start",
					"status",
					"contact_sheet",
					"list"
				],
				required: true,
				description: "操作命令。"
			},
			manifest: {
				type: "object",
				additionalProperties: true,
				description: "start 用：{groups: [{id, prompt, candidates, image_ratio, reference_images?, original_image?}], image_resolution?, image_provider?, concurrency?, deadline_seconds?, completion_grace_seconds?}；reference_images 为该组所有候选的参考图（相对 manifest 所在目录解析），original_image 作为联系表槽 0 素材/风格参考；或传 manifest_path。"
			},
			manifest_path: {
				type: "string",
				description: "start 用：manifest JSON 文件路径（UTF-8）。"
			},
			job_key: {
				type: "string",
				description: "status/contact_sheet 用：稳定 job key。"
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
					job_key: { type: "string" },
					plan: {
						type: "object",
						additionalProperties: true
					},
					summary: {
						type: "object",
						additionalProperties: true
					},
					contact_sheet_path: { type: "string" },
					jobs: { type: "array" }
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
			const db = openDb(join(privateRoot, "batch", "batch.db"));
			try {
				if (command === "list") {
					const rows = db.prepare("SELECT job_key, status, total, landed, abandoned, created_at, finished_at FROM jobs ORDER BY created_at DESC LIMIT 50").all();
					return {
						ok: true,
						message: `${rows.length} job(s)`,
						jobs: rows
					};
				}
				if (command === "start") {
					let raw;
					let manifestBase;
					if (args.manifest_path) {
						const path = isAbsolute(args.manifest_path) ? args.manifest_path : join(workspaceRoot, args.manifest_path);
						const { readFile } = await import("node:fs/promises");
						raw = JSON.parse(await readFile(path, "utf8"));
						manifestBase = dirname(path);
					} else {
						raw = args.manifest;
						manifestBase = workspaceRoot;
					}
					const manifest = validateManifest(raw);
					const plan = computeDeadline(manifest);
					const existing = db.prepare("SELECT * FROM jobs WHERE job_key = ?").get(plan.jobKey);
					if (existing) return {
						ok: false,
						message: `job ${plan.jobKey} already exists (${existing.status}); stable job key prevents duplicate submission`,
						job_key: plan.jobKey,
						summary: existing
					};
					const now = (/* @__PURE__ */ new Date()).toISOString();
					db.prepare("INSERT INTO jobs (job_key, manifest_json, manifest_base, status, total, concurrency, estimate_seconds, deadline_seconds, completion_grace_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(plan.jobKey, JSON.stringify(manifest), manifestBase, "running", plan.total, plan.concurrency, plan.estimateSeconds, plan.deadlineSeconds, plan.completionGraceSeconds, now);
					const insertTask = db.prepare("INSERT OR IGNORE INTO tasks (job_key, task_id, group_id, slot, prompt, ratio, resolution, provider, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
					for (const t of flattenTasks(manifest)) insertTask.run(plan.jobKey, `${plan.jobKey}-${t.groupId}-${t.slot}`, t.groupId, t.slot, t.prompt, t.ratio, t.resolution ?? null, t.imageProvider ?? null, "pending");
					const routerConfig = {
						...baseRouterConfig,
						credentials: await resolveCredentials()
					};
					runScheduler(db, plan.jobKey, manifest, manifestBase, plan.deadlineAtMs, privateRoot, routerConfig, config.outputDir, workspaceRoot).catch((error) => {
						db.prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE job_key = ?").run((/* @__PURE__ */ new Date()).toISOString(), plan.jobKey);
						appendSafeLog(privateRoot, "batch_image", {
							jobKey: plan.jobKey,
							event: "scheduler_crashed",
							detail: String(error?.message ?? error).slice(0, 300)
						});
					});
					return {
						ok: true,
						message: `batch ${plan.jobKey} started: ${plan.total} candidate(s), concurrency ${plan.concurrency}, estimate ${plan.estimateSeconds}s, dispatch deadline ${plan.deadlineSeconds}s, completion grace ${plan.completionGraceSeconds}s (max runtime ${plan.maxRuntimeSeconds}s); scheduler runs in background, poll status`,
						job_key: plan.jobKey,
						plan: {
							jobKey: plan.jobKey,
							total: plan.total,
							concurrency: plan.concurrency,
							estimateSeconds: plan.estimateSeconds,
							deadlineSeconds: plan.deadlineSeconds,
							completionGraceSeconds: plan.completionGraceSeconds,
							maxRuntimeSeconds: plan.maxRuntimeSeconds
						}
					};
				}
				if (!args.job_key) return {
					ok: false,
					message: "job_key is required"
				};
				const job = db.prepare("SELECT * FROM jobs WHERE job_key = ?").get(args.job_key);
				if (!job) return {
					ok: false,
					message: `job not found: ${args.job_key}`
				};
				if (command === "status") {
					const tasks = db.prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE job_key = ? GROUP BY status").all(args.job_key);
					const summary = {};
					for (const t of tasks) summary[t.status] = t.n;
					return {
						ok: true,
						message: `job ${args.job_key}: ${job.status} (landed ${job.landed}/${job.total})`,
						summary: {
							...summary,
							landed: job.landed,
							abandoned: job.abandoned,
							status: job.status,
							completion_grace_seconds: job.completion_grace_seconds
						}
					};
				}
				if (command === "contact_sheet") {
					const manifest = JSON.parse(job.manifest_json);
					const base = job.manifest_base ?? workspaceRoot;
					const landed = db.prepare("SELECT group_id AS groupId, slot, output_path AS path FROM tasks WHERE job_key = ? AND status = 'success'").all(args.job_key);
					const plan = computeDeadline(manifest, 0);
					const outDir = join(workspaceRoot, config.outputDir);
					await ensureDir(outDir);
					const groups = manifest.groups.map((g) => ({
						id: g.id,
						candidates: g.candidates,
						image_ratio: g.image_ratio ?? manifest.image_ratio ?? "",
						original_image: g.original_image ? resolveBatchPath(g.original_image, base) : g.reference_images?.[0] ? resolveBatchPath(g.reference_images[0], base) : void 0
					}));
					const sheetPath = join(outDir, `contact-${args.job_key}.html`);
					await writeFile(sheetPath, buildContactSheetHtml({
						...plan,
						deadlineAtMs: job.deadline_seconds
					}, groups, landed), "utf8");
					return {
						ok: true,
						message: `contact sheet: ${sheetPath}`,
						contact_sheet_path: sheetPath,
						summary: {
							landed: job.landed,
							abandoned: job.abandoned,
							status: job.status
						}
					};
				}
				return {
					ok: false,
					message: `unknown command: ${command}`
				};
			} finally {
				db.close();
			}
		}
	}));
}
/** Resolve a manifest-relative path against the batch base directory. */
function resolveBatchPath(value, base) {
	const p = value.trim();
	return isAbsolute(p) ? p : join(base, p);
}
/** Detached scheduler loop (runs after the tool call returns). */
async function runScheduler(_db, jobKey, manifest, manifestBase, deadlineAtMs, privateRoot, routerConfig, outputDir, workspaceRoot) {
	const db = openDb(join(privateRoot, "batch", "batch.db"));
	try {
		await runSchedulerWith(db, jobKey, manifest, manifestBase, deadlineAtMs, privateRoot, routerConfig, outputDir, workspaceRoot);
	} finally {
		try {
			db.close();
		} catch {}
	}
}
async function runSchedulerWith(db, jobKey, manifest, manifestBase, deadlineAtMs, privateRoot, routerConfig, outputDir, workspaceRoot) {
	const plan = computeDeadline(manifest);
	const graceMs = plan.completionGraceSeconds * 1e3;
	const pending = db.prepare("SELECT task_id, group_id, slot, prompt, ratio, resolution, provider FROM tasks WHERE job_key = ? AND status = 'pending' ORDER BY rowid").all(jobKey);
	const inFlight = /* @__PURE__ */ new Map();
	const controllers = /* @__PURE__ */ new Map();
	let nextSubmitAt = Date.now();
	const runOne = async (task, controller) => {
		db.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE task_id = ?").run((/* @__PURE__ */ new Date()).toISOString(), task.task_id);
		try {
			const references = (manifest.groups.find((g) => g.id === task.group_id)?.reference_images ?? []).map((p) => resolveBatchPath(p, manifestBase));
			const outcome = await runImageRouter({
				prompt: task.prompt,
				images: references,
				ratio: task.ratio,
				resolution: task.resolution ?? void 0,
				imageProvider: task.provider ?? void 0,
				config: routerConfig,
				workspaceRoot,
				privateRoot,
				signal: controller.signal,
				taskId: `batch-${jobKey}-${task.group_id}-${task.slot}`
			});
			const destDir = join(workspaceRoot, outputDir, jobKey, task.group_id);
			await ensureDir(destDir);
			const { copyFile } = await import("node:fs/promises");
			const dest = join(destDir, `${task.group_id}-${String(task.slot).padStart(2, "0")}${outcome.outputPath.slice(outcome.outputPath.lastIndexOf(".")) || ".png"}`);
			await copyFile(outcome.outputPath, dest);
			db.prepare("UPDATE tasks SET status = 'success', finished_at = ?, output_path = ?, provider = ?, model = ? WHERE task_id = ?").run((/* @__PURE__ */ new Date()).toISOString(), dest, outcome.provider, outcome.model, task.task_id);
			db.prepare("UPDATE jobs SET landed = landed + 1 WHERE job_key = ?").run(jobKey);
		} catch (error) {
			db.prepare("UPDATE tasks SET status = 'failed', finished_at = ?, error = ? WHERE task_id = ?").run((/* @__PURE__ */ new Date()).toISOString(), String(error?.message ?? error).slice(0, 500), task.task_id);
			db.prepare("UPDATE jobs SET abandoned = abandoned + 1 WHERE job_key = ?").run(jobKey);
		}
	};
	try {
		while ((pending.length > 0 || inFlight.size > 0) && Date.now() < deadlineAtMs) {
			while (inFlight.size < plan.concurrency && pending.length > 0 && Date.now() < deadlineAtMs) {
				const wait = nextSubmitAt - Date.now();
				if (wait > 0) await sleep(wait);
				if (Date.now() >= deadlineAtMs) break;
				const task = pending.shift();
				const settled = db.prepare("SELECT status FROM tasks WHERE task_id = ?").get(task.task_id);
				if (settled && settled.status !== "pending") continue;
				const controller = new AbortController();
				const promise = runOne(task, controller).finally(() => {
					inFlight.delete(task.task_id);
					controllers.delete(task.task_id);
				});
				inFlight.set(task.task_id, promise);
				controllers.set(task.task_id, controller);
				nextSubmitAt = Date.now() + 1e3;
			}
			if (inFlight.size > 0) await Promise.race([...inFlight.values()]);
		}
		const abandonedCount = db.prepare("UPDATE tasks SET status = 'abandoned', finished_at = ?, error = ? WHERE job_key = ? AND status = 'pending'").run((/* @__PURE__ */ new Date()).toISOString(), "batch_deadline_not_submitted", jobKey).changes;
		if (abandonedCount > 0) db.prepare("UPDATE jobs SET abandoned = abandoned + ? WHERE job_key = ?").run(abandonedCount, jobKey);
		if (inFlight.size > 0) {
			const graceTimer = setTimeout(() => {
				for (const controller of controllers.values()) controller.abort();
			}, graceMs);
			try {
				await Promise.allSettled([...inFlight.values()]);
			} finally {
				clearTimeout(graceTimer);
			}
			const timedOut = db.prepare("UPDATE tasks SET status = 'failed', finished_at = ?, error = ? WHERE job_key = ? AND status = 'running'").run((/* @__PURE__ */ new Date()).toISOString(), "batch_completion_grace_timeout", jobKey).changes;
			if (timedOut > 0) db.prepare("UPDATE jobs SET abandoned = abandoned + ? WHERE job_key = ?").run(timedOut, jobKey);
		}
		db.prepare("UPDATE jobs SET status = 'finished', finished_at = ? WHERE job_key = ?").run((/* @__PURE__ */ new Date()).toISOString(), jobKey);
		const landed = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE job_key = ? AND status = 'success'").get(jobKey).n;
		db.prepare("UPDATE jobs SET landed = ? WHERE job_key = ?").run(landed, jobKey);
		appendSafeLog(privateRoot, "batch_image", {
			jobKey,
			event: "finished",
			landed,
			abandoned: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE job_key = ? AND status IN ('failed','abandoned')").get(jobKey).n
		});
	} finally {}
}
//#endregion
export { Config, apply, inject, name };
