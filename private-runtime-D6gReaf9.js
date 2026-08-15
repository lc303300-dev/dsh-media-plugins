import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
//#region src/shared/private-runtime.ts
/**
* Private media runtime: the DSH counterpart of `.codex-image-private`.
*
* Everything sensitive or disposable (task stores, locks, logs, caches,
* normalized inputs, validation artifacts) lives under one private root
* (default `<workspace>/.dsh-media-private/`) and never enters Git or chat.
*
* @module dsh-media-plugins/shared/private-runtime
*/
/** Default private root name inside the workspace. */
const DEFAULT_PRIVATE_DIR = ".dsh-media-private";
/** Resolve the configured private root against the workspace. */
function resolvePrivateRoot(workspaceRoot, configured) {
	if (configured && configured.trim().length > 0) return isAbsolute(configured) ? configured : join(workspaceRoot, configured);
	return join(workspaceRoot, DEFAULT_PRIVATE_DIR);
}
/** Recursively ensure a directory exists. */
async function ensureDir(path) {
	await mkdir(path, { recursive: true });
	return path;
}
/** Atomically write a UTF-8 JSON file (tmp + rename). */
async function atomicWriteJson(path, value) {
	await ensureDir(path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))));
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}
/** Read a JSON file; return undefined when missing or corrupt. */
async function readJsonSafe(path) {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw);
	} catch {
		return;
	}
}
function sha256Text(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
/** SHA-256 of a file's bytes (material hashing / integrity locks). */
async function sha256File(path) {
	const data = await readFile(path);
	return createHash("sha256").update(data).digest("hex");
}
/** Safe prompt record: never store the raw prompt outside the task request. */
function redactPrompt(prompt) {
	return {
		value: "<redacted>",
		characters: prompt.length,
		sha256: sha256Text(prompt)
	};
}
const ALLOWED_TRANSITIONS = {
	pending: [
		"running",
		"cancelled",
		"abandoned"
	],
	running: [
		"success",
		"failed",
		"needs_review",
		"cancelled",
		"abandoned"
	],
	success: [],
	failed: [],
	needs_review: [],
	cancelled: [],
	abandoned: []
};
/**
* Task store under `<private>/jobs/<batchId>/<taskId>/` with
* request.json / state.json / result.json, atomic writes and validated
* state transitions. Idempotent by taskId; recovery reads state.json.
*/
var TaskStore = class {
	jobsRoot;
	constructor(jobsRoot) {
		this.jobsRoot = jobsRoot;
	}
	async taskDir(batchId, taskId) {
		return ensureDir(join(this.jobsRoot, batchId, taskId));
	}
	async create(batchId, taskId, kind, request) {
		const dir = await this.taskDir(batchId, taskId);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const record = {
			taskId,
			batchId,
			createdAt: now,
			updatedAt: now,
			status: "pending",
			kind,
			attempts: [],
			nextAction: "none",
			requestHash: sha256Text(JSON.stringify(request ?? {}))
		};
		await atomicWriteJson(join(dir, "request.json"), request ?? {});
		await atomicWriteJson(join(dir, "state.json"), record);
		return record;
	}
	async load(batchId, taskId) {
		return readJsonSafe(join(this.jobsRoot, batchId, taskId, "state.json"));
	}
	async transition(batchId, taskId, to, patch) {
		const current = await this.load(batchId, taskId) ?? {
			taskId,
			batchId,
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			status: "pending",
			kind: "image",
			attempts: []
		};
		if (!(ALLOWED_TRANSITIONS[current.status] ?? []).includes(to)) throw new Error(`invalid task transition ${current.status} -> ${to} for ${taskId}`);
		const next = {
			...current,
			...patch,
			status: to,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await atomicWriteJson(join(this.jobsRoot, batchId, taskId, "state.json"), next);
		return next;
	}
	async saveResult(batchId, taskId, result) {
		await atomicWriteJson(join(this.jobsRoot, batchId, taskId, "result.json"), result);
	}
	async listTasks(batchId) {
		const dir = join(this.jobsRoot, batchId);
		try {
			return await readdir(dir);
		} catch {
			return [];
		}
	}
};
/**
* Cross-process slot lease via atomic exclusive file creation
* (O_CREAT | O_EXCL), the DSH/JS counterpart of the blueprint's
* `.codex-image-private/locks/providers/<capacity-key>/slot-N.lock`.
* Returns an async release function or throws MediaError on timeout.
*/
async function acquireSlot(lockRoot, capacityKey, maxSlots, options) {
	const { taskId, timeoutMs, pollMs = 250, staleMs = 6e5 } = options;
	const dir = await ensureDir(join(lockRoot, "providers", capacityKey));
	const started = Date.now();
	const tryAcquire = async () => {
		for (let n = 1; n <= maxSlots; n += 1) {
			const path = join(dir, `slot-${n}.lock`);
			try {
				const handle = await open(path, "wx", 384);
				const payload = JSON.stringify({
					pid: process.pid,
					taskId,
					createdAt: Date.now(),
					heartbeat: Date.now()
				});
				await handle.writeFile(payload, "utf8");
				await handle.close();
				return path;
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
				try {
					const st = await readFile(path, "utf8");
					const meta = JSON.parse(st);
					if (Date.now() - (meta.heartbeat ?? meta.createdAt ?? 0) > staleMs) {
						await unlink(path);
						const retry = await open(path, "wx", 384);
						const payload = JSON.stringify({
							pid: process.pid,
							taskId,
							createdAt: Date.now(),
							heartbeat: Date.now()
						});
						await retry.writeFile(payload, "utf8");
						await retry.close();
						return path;
					}
				} catch {}
			}
		}
	};
	for (;;) {
		const acquired = await tryAcquire();
		if (acquired) {
			const release = async () => {
				try {
					await unlink(acquired);
				} catch {}
			};
			return release;
		}
		if (Date.now() - started >= timeoutMs) {
			const err = /* @__PURE__ */ new Error(`no free slot on capacity "${capacityKey}" within ${Math.round(timeoutMs / 1e3)}s (task ${taskId})`);
			err.cls = "concurrency_busy";
			throw err;
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
/** Append one safe JSON log line to `<private>/logs/<name>.log`. */
async function appendSafeLog(privateRoot, name, entry) {
	const dir = await ensureDir(join(privateRoot, "logs"));
	const path = join(dir, `${name}.log`);
	await ensureDir(join(privateRoot, "logs"));
	const line = `${JSON.stringify({
		ts: (/* @__PURE__ */ new Date()).toISOString(),
		...entry
	})}\n`;
	await writeFile(path, line, { flag: "a" });
}
/** Allocate a stable task id (uuid without dashes). */
function newTaskId() {
	return randomUUID().replaceAll("-", "");
}
//#endregion
export { ensureDir as a, redactPrompt as c, atomicWriteJson as i, resolvePrivateRoot as l, acquireSlot as n, newTaskId as o, appendSafeLog as r, readJsonSafe as s, TaskStore as t, sha256File as u };
