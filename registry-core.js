import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
//#region src/shared/registry-core.ts
/**
* Skill Registry domain (Codex_CS rebuild, all-JS): node:sqlite + FTS5
* (trigram tokenizer for CJK) with ingest / search / get / publish /
* deprecate / list, contract validation, dedupe by (name, version) and
* content-hash change detection. Pure domain — no DSH imports.
*
* @module dsh-media-plugins/shared/registry-core
*/
/** Supported video ratios (project pipeline contract). */
const VIDEO_RATIOS = [
	"1:1",
	"3:4",
	"16:9",
	"4:3",
	"9:16",
	"21:9"
];
/** Structural validation of a Skill contract; throws on violation. */
function validateContract(raw) {
	const c = raw ?? {};
	if (typeof c.name !== "string" || c.name.trim().length === 0) throw new Error("contract.name is required");
	if (typeof c.version !== "string" || c.version.trim().length === 0) throw new Error("contract.version is required");
	if (c.video !== void 0) {
		if (c.video.duration_min !== void 0 && !Number.isInteger(c.video.duration_min)) throw new Error("contract.video.duration_min must be an integer");
		if (c.video.duration_max !== void 0 && !Number.isInteger(c.video.duration_max)) throw new Error("contract.video.duration_max must be an integer");
		if (Array.isArray(c.video.ratios)) {
			for (const r of c.video.ratios) if (!VIDEO_RATIOS.includes(r)) throw new Error(`contract.video.ratios contains unsupported ratio: ${r}`);
		}
	}
	if (c.slots !== void 0) {
		if (!Array.isArray(c.slots)) throw new Error("contract.slots must be an array");
		const ids = /* @__PURE__ */ new Set();
		for (const slot of c.slots) {
			if (typeof slot.id !== "string" || slot.id.trim().length === 0) throw new Error("each slot requires an id");
			if (ids.has(slot.id)) throw new Error(`duplicate slot id: ${slot.id}`);
			ids.add(slot.id);
			if (slot.min !== void 0 && (!Number.isInteger(slot.min) || slot.min < 0)) throw new Error(`slot ${slot.id}: min must be a non-negative integer`);
			if (slot.max !== void 0 && (!Number.isInteger(slot.max) || slot.max < 0)) throw new Error(`slot ${slot.id}: max must be a non-negative integer`);
			if (slot.min !== void 0 && slot.max !== void 0 && slot.min > slot.max) throw new Error(`slot ${slot.id}: min > max`);
			if (slot.planned_count !== void 0 && (!Number.isInteger(slot.planned_count) || slot.planned_count < 0)) throw new Error(`slot ${slot.id}: planned_count must be a non-negative integer`);
		}
	}
	return {
		name: c.name.trim(),
		version: c.version.trim(),
		description: typeof c.description === "string" ? c.description : "",
		taxonomy: Array.isArray(c.taxonomy) ? c.taxonomy.map(String) : [],
		video: c.video,
		slots: c.slots,
		prompt: c.prompt
	};
}
/** Content hash of a skill package for change detection. */
function skillSha256(name, version, contractJson, routingJson) {
	return createHash("sha256").update(JSON.stringify({
		name,
		version,
		contract: contractJson,
		routing: routingJson
	})).digest("hex");
}
var SkillRegistry = class {
	db;
	dbPath;
	constructor(dbPath) {
		this.dbPath = dbPath;
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.migrate();
	}
	migrate() {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        taxonomy TEXT NOT NULL DEFAULT '[]',
        contract_json TEXT NOT NULL DEFAULT '{}',
        routing_json TEXT NOT NULL DEFAULT '{}',
        package_root TEXT NOT NULL DEFAULT '',
        provenance TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name_version ON skills(name, version);
      CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
        skill_id UNINDEXED, name, description, taxonomy, contract, tokenize='trigram'
      );
    `);
	}
	rowToRecord(row) {
		return {
			id: row.id,
			name: row.name,
			version: row.version,
			description: row.description,
			status: row.status,
			taxonomy: safeJson(row.taxonomy, []),
			contract: safeJson(row.contract_json, {}),
			routing: safeJson(row.routing_json, {}),
			packageRoot: row.package_root,
			provenance: row.provenance,
			sha256: row.sha256,
			createdAt: row.created_at,
			updatedAt: row.updated_at
		};
	}
	/** Ingest a skill package; re-ingest with changed content fails unless force. */
	ingest(input, options = {}) {
		const contract = validateContract(input.contract);
		const routing = input.routing ?? {};
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const id = `${contract.name}@${contract.version}`;
		const sha = skillSha256(contract.name, contract.version, JSON.stringify(contract), JSON.stringify(routing));
		const existing = this.get(contract.name, contract.version);
		if (existing) {
			if (existing.sha256 !== sha && !options.force) throw new Error(`skill ${id} already exists with different content; pass force=true to overwrite`);
			this.db.prepare(`UPDATE skills SET description=?, status=?, taxonomy=?, contract_json=?, routing_json=?, package_root=?, provenance=?, sha256=?, updated_at=? WHERE id=?`).run(contract.description ?? "", existing.status, JSON.stringify(contract.taxonomy ?? []), JSON.stringify(contract), JSON.stringify(routing), input.packageRoot ?? existing.packageRoot, input.provenance ?? existing.provenance, sha, now, id);
			this.syncFts(id);
			return this.get(contract.name, contract.version);
		}
		this.db.prepare(`INSERT INTO skills (id, name, version, description, status, taxonomy, contract_json, routing_json, package_root, provenance, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, contract.name, contract.version, contract.description ?? "", JSON.stringify(contract.taxonomy ?? []), JSON.stringify(contract), JSON.stringify(routing), input.packageRoot ?? "", input.provenance ?? "", sha, now, now);
		this.syncFts(id);
		return this.get(contract.name, contract.version);
	}
	syncFts(id) {
		const rec = this.rowToRecord(this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id));
		this.db.prepare("DELETE FROM skills_fts WHERE skill_id = ?").run(id);
		this.db.prepare("INSERT INTO skills_fts (skill_id, name, description, taxonomy, contract) VALUES (?, ?, ?, ?, ?)").run(id, rec.name, rec.description, rec.taxonomy.join(" "), JSON.stringify(rec.contract));
	}
	get(name, version) {
		const row = version ? this.db.prepare("SELECT * FROM skills WHERE name = ? AND version = ?").get(name, version) : this.db.prepare("SELECT * FROM skills WHERE name = ? ORDER BY created_at DESC LIMIT 1").get(name);
		return row ? this.rowToRecord(row) : void 0;
	}
	/** FTS5 trigram search over name/description/taxonomy/contract. */
	search(query, limit = 10, status = "published") {
		const q = (query ?? "").trim();
		if (q.length === 0) return [];
		const quoted = q.includes("\"") ? q.replaceAll("\"", " ") : q;
		let rows = [];
		try {
			rows = this.db.prepare(`SELECT s.id, s.name, s.version, s.description, s.status, s.taxonomy, bm25(skills_fts) AS score
           FROM skills_fts JOIN skills s ON s.id = skills_fts.skill_id
           WHERE skills_fts MATCH ?
           ORDER BY score LIMIT ?`).all(`"${quoted.replaceAll("\"", " ")}"`, limit);
		} catch {
			rows = [];
		}
		if (rows.length === 0) {
			const like = `%${q}%`;
			rows = this.db.prepare(`SELECT id, name, version, description, status, taxonomy, 0 AS score FROM skills
           WHERE name LIKE ? OR description LIKE ? OR taxonomy LIKE ?
           ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END LIMIT ?`).all(like, like, like, limit);
		}
		return rows.filter((r) => status === "any" || r.status === status).map((r) => ({
			id: r.id,
			name: r.name,
			version: r.version,
			description: r.description,
			status: r.status,
			taxonomy: safeJson(r.taxonomy, []),
			score: Math.round((r.score ?? 0) * 100) / 100
		}));
	}
	setStatus(name, version, status) {
		const existing = this.get(name, version);
		if (!existing) throw new Error(`skill not found: ${name}@${version}`);
		this.db.prepare("UPDATE skills SET status = ?, updated_at = ? WHERE id = ?").run(status, (/* @__PURE__ */ new Date()).toISOString(), existing.id);
		return this.get(name, version);
	}
	list(status, limit = 100) {
		return (status ? this.db.prepare("SELECT * FROM skills WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(status, limit) : this.db.prepare("SELECT * FROM skills ORDER BY updated_at DESC LIMIT ?").all(limit)).map((r) => this.rowToRecord(r));
	}
	close() {
		try {
			this.db.close();
		} catch {}
	}
};
function safeJson(raw, fallback) {
	if (typeof raw !== "string" || raw.length === 0) return fallback;
	try {
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}
//#endregion
export { validateContract as n, SkillRegistry as t };
