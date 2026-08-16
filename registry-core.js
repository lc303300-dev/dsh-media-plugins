import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region src/shared/registry-core.ts
/**
* Skill Registry domain (Codex_CS rebuild, all-JS): node:sqlite + FTS5
* (trigram tokenizer for CJK) with ingest / search / get / publish /
* deprecate / list, contract validation, dedupe by (name, version) and
* content-hash change detection. Pure domain — no DSH imports.
*
* @module dsh-media-plugins/shared/registry-core
*/
var registry_core_exports = /* @__PURE__ */ __exportAll({
	ROUTING_FIELDS: () => ROUTING_FIELDS,
	SkillRegistry: () => SkillRegistry,
	TAXONOMY: () => TAXONOMY,
	VIDEO_RATIOS: () => VIDEO_RATIOS,
	matchedTerms: () => matchedTerms,
	materialGuidance: () => materialGuidance,
	normalizeTerm: () => normalizeTerm,
	skillSha256: () => skillSha256,
	tokenizeSearchTerms: () => tokenizeSearchTerms,
	validateContract: () => validateContract
});
/** Taxonomy (ported from Codex_CS skill-registry/config/taxonomy.json). */
const ROUTING_FIELDS = [
	"aliases",
	"user_intents",
	"subjects",
	"styles",
	"narrative_patterns",
	"negative_intents"
];
const TAXONOMY = {
	categories: {
		intents: [
			"宣传片",
			"品牌展示",
			"城市形象",
			"地产宣传",
			"地标巡游",
			"建筑展示",
			"动态组装",
			"提示词"
		],
		subjects: [
			"城市",
			"地产",
			"楼盘",
			"建筑",
			"地标",
			"Logo",
			"品牌",
			"IP",
			"角色",
			"人居"
		],
		styles: [
			"科幻",
			"未来感",
			"晨曦",
			"云雾",
			"高奢",
			"写实",
			"电影感",
			"巨型",
			"3D"
		],
		narrative_patterns: [
			"巡游",
			"硬切",
			"一镜到底",
			"航拍",
			"穿梭",
			"组装",
			"拆解",
			"特写",
			"全貌",
			"多场景"
		]
	},
	synonyms: {
		logo: [
			"Logo",
			"LOGO",
			"标志",
			"品牌标识"
		],
		ip: [
			"IP",
			"角色",
			"吉祥物"
		],
		地产: [
			"地产",
			"房地产",
			"楼盘",
			"住宅",
			"人居"
		],
		科幻: [
			"科幻",
			"未来",
			"赛博",
			"科技感"
		],
		宣传片: [
			"宣传片",
			"宣传视频",
			"形象片",
			"推广片"
		]
	}
};
/** Normalize a string: strip non-alphanumeric/CJK, casefold (registry.py port). */
function normalizeTerm(value) {
	return String(value ?? "").replace(/[^0-9a-z\u4e00-\u9fff]+/gi, "").toLowerCase();
}
/** Match a query against routing terms with synonym expansion. */
function matchedTerms(query, routing) {
	const queryNorm = normalizeTerm(query);
	const positive = [];
	const negative = [];
	const synonymHits = /* @__PURE__ */ new Set();
	for (const [canonical, forms] of Object.entries(TAXONOMY.synonyms)) if (forms.some((form) => queryNorm.includes(normalizeTerm(form)))) synonymHits.add(canonical.toLowerCase());
	for (const field of ROUTING_FIELDS) {
		const values = Array.isArray(routing[field]) ? routing[field] : [];
		for (const term of values) {
			const key = String(term).toLowerCase();
			if (queryNorm.includes(normalizeTerm(String(term))) || synonymHits.has(key)) {
				if (field === "negative_intents") negative.push(String(term));
				else positive.push(String(term));
			}
		}
	}
	return {
		positive,
		negative
	};
}
/** Material guidance from the contract references (registry.py material_summary). */
function materialGuidance(contractJson) {
	try {
		const contract = JSON.parse(contractJson);
		return (Array.isArray(contract.references) ? contract.references : Array.isArray(contract.slots) ? contract.slots : []).map((item) => ({
			id: item.id,
			media_type: item.media_type,
			description: item.description,
			required: item.required,
			min_count: item.min_count,
			max_count: item.max_count,
			ordered: item.ordered
		}));
	} catch {
		return [];
	}
}
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
	/** FTS5 trigram search over name/description/taxonomy/contract, with
	*  CJK-friendly tokenization: trigram grams + latin words + per-term LIKE,
	*  then semantic scoring (synonyms, negative weighting, alias boost). */
	search(query, limit = 10, status = "published") {
		const q = (query ?? "").trim();
		if (q.length === 0) return [];
		const terms = tokenizeSearchTerms(q);
		let rows = [];
		try {
			const compact = normalizeTerm(q);
			const grams = [];
			for (let i = 0; i < Math.max(0, compact.length - 2); i += 1) grams.push(compact.slice(i, i + 3));
			const words = (q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(Boolean);
			const ftsTerms = [.../* @__PURE__ */ new Set([...grams, ...words])].slice(0, 64);
			if (ftsTerms.length > 0) {
				const expression = ftsTerms.map((t) => `"${t.replaceAll("\"", " ")}"`).join(" OR ");
				rows = this.db.prepare(`SELECT s.id, s.name, s.version, s.description, s.status, s.taxonomy, s.routing_json, s.contract_json, bm25(skills_fts) AS score
             FROM skills_fts JOIN skills s ON s.id = skills_fts.skill_id
             WHERE skills_fts MATCH ?
             ORDER BY score LIMIT ?`).all(expression, Math.max(limit, 20));
			}
		} catch {
			rows = [];
		}
		{
			const scored = [];
			const all = this.db.prepare("SELECT * FROM skills").all();
			for (const row of all) {
				const haystacks = [
					String(row.name ?? ""),
					String(row.description ?? ""),
					String(row.taxonomy ?? ""),
					String(row.contract_json ?? ""),
					String(row.routing_json ?? "")
				];
				let score = 0;
				const likeKeys = /* @__PURE__ */ new Set();
				for (const term of terms) {
					likeKeys.add(term.toLowerCase());
					const cjk = term.match(/[\u4e00-\u9fff]+/g) ?? [];
					for (const run of cjk) if (run.length >= 2) for (let i = 0; i < run.length - 1; i += 1) likeKeys.add(run.slice(i, i + 2).toLowerCase());
				}
				for (const key of likeKeys) for (const haystack of haystacks) {
					const lower = haystack.toLowerCase();
					let idx = lower.indexOf(key);
					while (idx >= 0) {
						score += 1;
						idx = lower.indexOf(key, idx + key.length);
					}
				}
				if (score > 0) scored.push({
					...row,
					score: -score
				});
			}
			scored.sort((a, b) => Number(a.score) - Number(b.score));
			const byId = /* @__PURE__ */ new Map();
			for (const r of rows) byId.set(String(r.id), r);
			for (const s of scored) {
				const existing = byId.get(String(s.id));
				if (!existing || Math.abs(Number(s.score)) > Math.abs(Number(existing.score))) byId.set(String(s.id), s);
			}
			rows = [...byId.values()];
		}
		if (rows.length === 0) {
			const all = this.db.prepare("SELECT * FROM skills").all();
			const semantic = [];
			for (const row of all) {
				const { positive } = matchedTerms(q, safeJson(row.routing_json, {}));
				if (positive.length > 0) semantic.push({
					...row,
					score: -1
				});
			}
			semantic.sort((a, b) => Number(a.score) - Number(b.score));
			rows = semantic.slice(0, limit);
		}
		return rows.filter((r) => status === "any" || r.status === status).map((r) => {
			const routing = safeJson(r.routing_json, {});
			const aliases = Array.isArray(routing.aliases) ? routing.aliases.map(String) : [];
			const queryNorm = normalizeTerm(q);
			const exactAlias = aliases.some((alias) => normalizeTerm(alias) === queryNorm) || normalizeTerm(String(r.name ?? "")) === queryNorm;
			const { positive, negative } = matchedTerms(q, routing);
			const score = Math.abs(Number(r.score ?? 0)) + positive.length * 12 - negative.length * 20 + Number(routing.priority ?? 50) * .1 + (exactAlias ? 100 : 0);
			const reasons = [];
			if (exactAlias) reasons.push("名称或别名精确命中");
			for (const term of positive) reasons.push(`意图命中：${term}`);
			if (reasons.length === 0) reasons.push("全文意图相似");
			return {
				id: r.id,
				name: r.name,
				version: r.version,
				description: r.description,
				status: r.status,
				taxonomy: safeJson(r.taxonomy, []),
				score: Math.round(score * 100) / 100,
				matched_reasons: reasons,
				negative_hits: negative,
				material_guidance: materialGuidance(String(r.contract_json ?? ""))
			};
		}).sort((a, b) => b.score - a.score).slice(0, limit);
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
/** Split a search query into CJK-friendly terms (whitespace + punctuation). */
function tokenizeSearchTerms(query) {
	return String(query ?? "").split(/[\s，。！？、,.;:：'"_\-()（）]+/).map((t) => t.trim()).filter((t) => t.length > 0);
}
//#endregion
export { registry_core_exports as n, validateContract as r, SkillRegistry as t };
