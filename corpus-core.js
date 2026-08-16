import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accessSync, readFileSync } from "node:fs";
//#region src/shared/corpus-core.ts
/**
* Corpus search (seedance-forge port, all-JS): ranking mirrors the Codex_DT
* `native_score` (title×4 + category×3 + description×2 + content×1), results
* keep full provenance, and source model/version is metadata only — it must
* never select the runtime generation model. Revision usage caps at 3.
*
* @module dsh-media-plugins/shared/corpus-core
*/
let cachedRows = null;
/** Locate the bundled corpus index (built chunk at package root vs src tree). */
function resolveIndexPath(explicit) {
	if (explicit && explicit.trim().length > 0) return explicit;
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, "refs", "forge-index.jsonl"), join(here, "..", "..", "refs", "forge-index.jsonl")];
	for (const candidate of candidates) try {
		accessSync(candidate);
		return candidate;
	} catch {}
	return candidates[0];
}
/** Load corpus rows (cached); JSONL, id-keyed, tolerant of blank lines. */
function loadCorpus(indexPath) {
	if (cachedRows) return cachedRows;
	const path = resolveIndexPath(indexPath);
	const rows = [];
	const raw = readFileSync(path, "utf8");
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			if (row && typeof row.id === "string" && row.id.length > 0) rows.push(row);
		} catch {}
	}
	cachedRows = rows;
	return rows;
}
/** CJK bigrams of a token (2-char sliding windows over CJK runs). */
function cjkBigrams(token) {
	const cjk = token.match(/[\u4e00-\u9fff]+/g) ?? [];
	const bigrams = [];
	for (const run of cjk) {
		if (run.length === 1) bigrams.push(run);
		for (let i = 0; i < run.length - 1; i += 1) bigrams.push(run.slice(i, i + 2));
	}
	return bigrams;
}
/** Ranking mirrors seedance-forge native scoring, with CJK bigram tokenization. */
function scoreCorpusRow(row, query) {
	const title = String(row.title ?? "").toLowerCase();
	const category = String(row.category ?? "").toLowerCase();
	const description = String(row.description ?? "").toLowerCase();
	const content = String(row.content ?? "").toLowerCase();
	let score = 0;
	for (const raw of query.toLowerCase().split(/\s+/).filter(Boolean)) {
		const keywords = raw.length > 2 && /[\u4e00-\u9fff]/.test(raw) ? [raw, ...cjkBigrams(raw)] : [raw];
		for (const keyword of keywords) {
			score += (title.split(keyword).length - 1) * 4;
			score += (category.split(keyword).length - 1) * 3;
			score += (description.split(keyword).length - 1) * 2;
			score += content.split(keyword).length - 1;
		}
	}
	return score;
}
/** Compact text to a preview. */
function compactPreview(text, limit) {
	const clean = (text ?? "").replace(/\s+/g, " ").trim();
	if (clean.length <= limit) return clean;
	return clean.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
}
/** A transferable structural hint extracted from a corpus entry (never copied wholesale). */
function portablePatternOf(row) {
	const content = String(row.content ?? "").trim();
	const description = String(row.description ?? "").trim();
	if (content.length > 0) return compactPreview(content, 200);
	if (description.length > 0) return compactPreview(description, 200);
	return String(row.title ?? "");
}
function parseAuthor(raw) {
	if (raw && typeof raw === "object") {
		const obj = raw;
		return {
			name: String(obj.name ?? ""),
			link: String(obj.link ?? "")
		};
	}
	if (typeof raw === "string" && raw.length > 0) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object") return {
				name: String(parsed.name ?? ""),
				link: String(parsed.link ?? "")
			};
		} catch {}
		return {
			name: raw,
			link: ""
		};
	}
	return {
		name: "",
		link: ""
	};
}
/** Convert a row into the revision-result match shape (provenance preserved). */
function toCorpusMatch(row, previewChars = 500) {
	const sourceModel = String(row.seedance_version ?? "");
	return {
		id: row.id,
		title: String(row.title ?? ""),
		description: String(row.description ?? ""),
		score: 0,
		length: String(row.content ?? "").length,
		content_preview: compactPreview(String(row.content ?? row.description ?? ""), previewChars),
		author: parseAuthor(row.author),
		sourceLink: String(row.sourceLink ?? ""),
		sourcePublishedAt: String(row.sourcePublishedAt ?? ""),
		source_model: sourceModel,
		source_metadata: {
			model: sourceModel,
			repository: String(row.source_repo ?? ""),
			license: String(row.source_license ?? "")
		},
		portable_pattern: portablePatternOf(row)
	};
}
/** Search the corpus; `top` capped at 3 for revision usage by contract. */
function searchCorpus(query, top = 3, indexPath) {
	const clean = (query ?? "").trim();
	if (!clean) return [];
	return loadCorpus(indexPath).map((row) => ({
		row,
		score: scoreCorpusRow(row, clean)
	})).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(top, 3))).map((entry) => ({
		...toCorpusMatch(entry.row),
		score: entry.score
	}));
}
/** Count of bundled corpus entries (readiness reporting). */
function corpusSize(indexPath) {
	return loadCorpus(indexPath).length;
}
//#endregion
export { searchCorpus as n, corpusSize as t };
