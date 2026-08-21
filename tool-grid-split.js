import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import sharp from "sharp";
//#region src/shared/grid-split-core.ts
/**
* Grid-sheet split core (Codex_IS community-revision port): split a 3×3
* grid-sheet image into nine independent panels by locating the grid lines
* with a morphological-style line scan (threshold + full-width white-run
* band grouping), cropping with a small inset, and validating the result.
* Falls back to an even split when line detection fails. No upscaling is
* performed — this is extraction only, per the community consensus that
* enlarging is not redrawing.
*
* @module dsh-media-plugins/shared/grid-split-core
*/
/** Threshold ladder: try strict white first, loosen only if nothing found. */
const THRESHOLDS = [
	235,
	250,
	220,
	200
];
/** White-line row/column flag: fraction of white pixels along the axis. */
const ROW_FRACTION = .85;
/** Longest contiguous white run must span this share of the axis (kills
*  sky-only rows inside one panel, which only span ~1/3 of the width). */
const RUN_FRACTION = .6;
/** Bands whose centers lie within [INNER_MIN, INNER_MAX] of the axis are
*  candidates for the two inner gutter lines (outer borders excluded). */
const INNER_MIN = .15;
const INNER_MAX = .85;
/** Group 1-D flagged indices into bands, merging gaps of at most `gap`. */
function groupBands(flags, gap) {
	const bands = [];
	for (const idx of flags) {
		const last = bands[bands.length - 1];
		if (last && idx <= last.end + gap) last.end = idx;
		else bands.push({
			start: idx,
			end: idx
		});
	}
	return bands;
}
/** Detect the two inner horizontal/vertical gutter lines on a downscaled
*  grayscale buffer. Returns line positions (in working-scale pixels) or
*  null when the sheet does not look like a clean 3×3 grid. */
function detectGridLines(gray, w, h, threshold) {
	const bin = new Uint8Array(w * h);
	for (let i = 0; i < bin.length; i++) bin[i] = gray[i] >= threshold ? 1 : 0;
	const rowFlags = [];
	for (let y = 0; y < h; y++) {
		let sum = 0;
		let run = 0;
		let maxRun = 0;
		for (let x = 0; x < w; x++) {
			const v = bin[y * w + x];
			sum += v;
			if (v) {
				run++;
				if (run > maxRun) maxRun = run;
			} else run = 0;
		}
		if (sum / w > ROW_FRACTION && maxRun / w > RUN_FRACTION) rowFlags.push(y);
	}
	const hBands = groupBands(rowFlags, 2).filter((b) => {
		const c = (b.start + b.end) / 2 / h;
		return c >= INNER_MIN && c <= INNER_MAX;
	});
	const colFlags = [];
	for (let x = 0; x < w; x++) {
		let sum = 0;
		let run = 0;
		let maxRun = 0;
		for (let y = 0; y < h; y++) {
			const v = bin[y * w + x];
			sum += v;
			if (v) {
				run++;
				if (run > maxRun) maxRun = run;
			} else run = 0;
		}
		if (sum / h > ROW_FRACTION && maxRun / h > RUN_FRACTION) colFlags.push(x);
	}
	const vBands = groupBands(colFlags, 2).filter((b) => {
		const c = (b.start + b.end) / 2 / w;
		return c >= INNER_MIN && c <= INNER_MAX;
	});
	if (hBands.length !== 2 || vBands.length !== 2) return null;
	const hPos = hBands.map((b) => Math.round((b.start + b.end) / 2));
	const vPos = vBands.map((b) => Math.round((b.start + b.end) / 2));
	if (Math.abs(hPos[1] - hPos[0]) < .2 * h) return null;
	if (Math.abs(vPos[1] - vPos[0]) < .2 * w) return null;
	return {
		h: hPos,
		v: vPos
	};
}
/** White share of a working-scale region; used for validation only. */
function regionWhiteRatio(bin, w, x0, y0, x1, y1) {
	let white = 0;
	let total = 0;
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
		total++;
		if (bin[y * w + x] === 1) white++;
	}
	return total === 0 ? 1 : white / total;
}
function safeExtract(width, height, left, top, w, h) {
	const L = Math.max(0, Math.min(width - 1, left));
	const T = Math.max(0, Math.min(height - 1, top));
	return {
		left: L,
		top: T,
		width: Math.max(1, Math.min(width - L, w)),
		height: Math.max(1, Math.min(height - T, h))
	};
}
/** Parse a "W:H" aspect-ratio string into { w, h }; null when malformed. */
function parseRatio(s) {
	const m = String(s ?? "").trim().match(/^(\d+)\s*:\s*(\d+)$/);
	if (!m) return null;
	const w = Number(m[1]);
	const h = Number(m[2]);
	if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
	return {
		w,
		h
	};
}
/**
* Center-crop a panel of pw×ph to the target ratio. Rule per user:
* portrait (w < h) → keep height, crop width; landscape (w >= h) → keep
* width, crop height. When the panel is already narrower/taller than the
* target (cropping the preferred axis cannot reach the ratio), fall back to
* cropping the other axis and report it via `warnings`.
*/
function normalizeCrop(pw, ph, ratio, warnings, label) {
	const r = ratio.w / ratio.h;
	if ((r >= 1 ? "landscape" : "portrait") === "landscape") {
		const targetH = Math.round(pw / r);
		if (targetH <= ph) return safeExtract(pw, ph, 0, Math.floor((ph - targetH) / 2), pw, targetH);
		const targetW = Math.round(ph * r);
		if (targetW <= pw) {
			warnings.push(`${label} 已比目标比例更扁（${pw}×${ph}），改用高不变、裁宽度`);
			return safeExtract(pw, ph, Math.floor((pw - targetW) / 2), 0, targetW, ph);
		}
		warnings.push(`${label} 无法裁剪到 ${ratio.w}:${ratio.h}（${pw}×${ph}），保持原样`);
		return null;
	}
	const targetW = Math.round(ph * r);
	if (targetW <= pw) return safeExtract(pw, ph, Math.floor((pw - targetW) / 2), 0, targetW, ph);
	const targetH = Math.round(pw / r);
	if (targetH <= ph) {
		warnings.push(`${label} 已比目标比例更瘦高（${pw}×${ph}），改用宽不变、裁高度`);
		return safeExtract(pw, ph, 0, Math.floor((ph - targetH) / 2), pw, targetH);
	}
	warnings.push(`${label} 无法裁剪到 ${ratio.w}:${ratio.h}（${pw}×${ph}），保持原样`);
	return null;
}
/**
* Split a 3×3 grid sheet into nine panels.
*
* @param image    sheet image path (PNG/JPEG/WEBP)
* @param outputDir directory for the nine panels + review page
* @param opts.insetPx  full-res margin cut inside each grid line (default 2)
* @param opts.workEdge longest edge of the working scan image (default 1024)
*/
async function splitGridSheet(image, outputDir, opts = {}) {
	const insetPercent = Math.max(0, Math.min(10, Math.round(opts.insetPercent ?? 2)));
	const workEdge = Math.max(256, Math.round(opts.workEdge ?? 1024));
	const warnings = [];
	const ratio = opts.normalizeRatio && String(opts.normalizeRatio).trim().length > 0 ? parseRatio(String(opts.normalizeRatio)) : null;
	if (opts.normalizeRatio && String(opts.normalizeRatio).trim().length > 0 && !ratio) return {
		ok: false,
		method: "fallback_even",
		sheet_path: image,
		width: 0,
		height: 0,
		lines: {
			horizontal: [],
			vertical: []
		},
		normalized_ratio: null,
		inset_percent: insetPercent,
		panels: [],
		review_page: "",
		warnings: [`无效比例：${opts.normalizeRatio}（应为 W:H，如 16:9 / 9:16 / 21:9）`],
		message: `invalid normalize_ratio: ${opts.normalizeRatio}`
	};
	const normalizedRatioLabel = ratio ? `${ratio.w}:${ratio.h}` : null;
	const meta = await sharp(image, { failOn: "none" }).rotate().metadata();
	const fullW = meta.width ?? 0;
	const fullH = meta.height ?? 0;
	if (fullW === 0 || fullH === 0) return {
		ok: false,
		method: "fallback_even",
		sheet_path: image,
		width: 0,
		height: 0,
		lines: {
			horizontal: [],
			vertical: []
		},
		normalized_ratio: null,
		inset_percent: insetPercent,
		panels: [],
		review_page: "",
		warnings: ["cannot read image dimensions"],
		message: `cannot read image: ${image}`
	};
	const tryDetectAt = async (targetScale) => {
		const s = Math.min(1, targetScale);
		const ww = Math.max(1, Math.round(fullW * s));
		const wh = Math.max(1, Math.round(fullH * s));
		const { data } = await sharp(image, { failOn: "none" }).rotate().resize({
			width: ww,
			height: wh,
			fit: "fill"
		}).removeAlpha().toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });
		const g = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		let found = null;
		for (const T of THRESHOLDS) {
			const d = detectGridLines(g, ww, wh, T);
			if (d) {
				found = d;
				break;
			}
		}
		return {
			gray: g,
			workW: ww,
			workH: wh,
			scale: s,
			detected: found
		};
	};
	const fastScale = Math.min(1, workEdge / Math.max(fullW, fullH));
	let scan = await tryDetectAt(fastScale);
	if (!scan.detected && fastScale < 1) {
		const hiScale = Math.min(1, 2400 / Math.max(fullW, fullH));
		if (hiScale > fastScale + .05) scan = await tryDetectAt(hiScale);
	}
	const { gray, workW, workH, scale } = scan;
	const detected = scan.detected;
	let method;
	let hCuts;
	let vCuts;
	let hLinesFull = [];
	let vLinesFull = [];
	const insetW = Math.max(0, Math.round(fullW * insetPercent / 100));
	const insetH = Math.max(0, Math.round(fullH * insetPercent / 100));
	if (detected) {
		method = "morphological_lines";
		const inv = 1 / scale;
		hLinesFull = detected.h.map((y) => Math.round(y * inv));
		vLinesFull = detected.v.map((x) => Math.round(x * inv));
		hCuts = [
			0,
			hLinesFull[0],
			hLinesFull[1],
			fullH
		];
		vCuts = [
			0,
			vLinesFull[0],
			vLinesFull[1],
			fullW
		];
	} else {
		method = "fallback_even";
		warnings.push(`未检测到清晰的横/纵格线，已启用方案2 等比分割（每侧内缩 ${insetPercent}%，即 ${insetW}px / ${insetH}px）；请核对面板边界`);
		hCuts = [
			0,
			Math.round(fullH / 3),
			Math.round(2 * fullH / 3),
			fullH
		];
		vCuts = [
			0,
			Math.round(fullW / 3),
			Math.round(2 * fullW / 3),
			fullW
		];
	}
	await mkdir(outputDir, { recursive: true });
	const base = basename(image, extname(image)).replace(/[^\w.-]+/g, "_").slice(0, 60) || "grid";
	const panels = [];
	for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
		const id = `r${row + 1}c${col + 1}`;
		const x0 = vCuts[col] + insetW;
		const x1 = vCuts[col + 1] - insetW;
		const y0 = hCuts[row] + insetH;
		const y1 = hCuts[row + 1] - insetH;
		const box = safeExtract(fullW, fullH, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
		let finalBox = box;
		if (ratio) {
			const inner = normalizeCrop(box.width, box.height, ratio, warnings, id);
			if (inner) finalBox = safeExtract(fullW, fullH, box.left + inner.left, box.top + inner.top, inner.width, inner.height);
		}
		const dest = join(outputDir, `${base}-${id}.png`);
		const out = await sharp(image, { failOn: "none" }).rotate().extract(finalBox).png().toFile(dest);
		const wx0 = Math.round(finalBox.left / fullW * workW);
		const wy0 = Math.round(finalBox.top / fullH * workH);
		const wx1 = Math.max(wx0 + 1, Math.round((finalBox.left + finalBox.width) / fullW * workW));
		const wy1 = Math.max(wy0 + 1, Math.round((finalBox.top + finalBox.height) / fullH * workH));
		let whiteRatio = 0;
		try {
			whiteRatio = regionWhiteRatio(gray, workW, wx0, wy0, wx1, wy1);
		} catch {}
		panels.push({
			id,
			row: row + 1,
			col: col + 1,
			path: dest,
			width: out.width,
			height: out.height,
			whiteRatio
		});
	}
	for (const p of panels) if (p.whiteRatio > .55) warnings.push(`${p.id} 大面积空白（白占比 ${(p.whiteRatio * 100).toFixed(0)}%），疑似格线检测偏移`);
	const reviewPage = await buildReviewPage(image, panels, method, hLinesFull, vLinesFull, fullW, fullH, warnings, outputDir, base);
	const lines = {
		horizontal: hLinesFull,
		vertical: vLinesFull
	};
	const ratioNote = normalizedRatioLabel ? `，比例已规范为 ${normalizedRatioLabel}` : "";
	const message = `拆格完成（${method}${ratioNote}）：9 张面板 → ${outputDir}；审阅页 → ${reviewPage}`;
	return {
		ok: true,
		method,
		sheet_path: image,
		width: fullW,
		height: fullH,
		lines,
		normalized_ratio: normalizedRatioLabel,
		inset_percent: insetPercent,
		panels,
		review_page: reviewPage,
		warnings,
		message
	};
}
/** Self-contained review page: original thumbnail + 3×3 panel grid, all
*  images embedded as data URIs so the file opens anywhere. */
async function buildReviewPage(sheet, panels, method, hLines, vLines, fullW, fullH, warnings, outputDir, base) {
	const thumb = async (p, edge) => {
		return `data:image/jpeg;base64,${(await sharp(p, { failOn: "none" }).rotate().resize({
			width: edge,
			height: edge,
			fit: "inside",
			withoutEnlargement: true
		}).jpeg({ quality: 80 }).toBuffer()).toString("base64")}`;
	};
	const sheetThumb = await thumb(sheet, 720);
	const cells = [];
	for (const p of panels) {
		const t = await thumb(p.path, 360);
		cells.push(`<td><img src="${t}" alt="${p.id}"><div class="slot">${p.id} · ${p.width}×${p.height} · 白占比 ${(p.whiteRatio * 100).toFixed(0)}%</div></td>`);
	}
	const warnHtml = warnings.length ? `<p style="color:#b06000">⚠ ${warnings.map((w) => ` ${w}`).join("；")}</p>` : "<p style=\"color:#2a7a2a\">✓ 无异常</p>";
	const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>拆格审阅 ${base}</title>
<style>body{font-family:system-ui;margin:24px}table{border-collapse:collapse;margin:12px 0}td{border:1px solid #ccc;padding:6px;text-align:center;vertical-align:top}img{max-width:320px;width:100%;height:auto;display:block}.slot{font-size:12px;color:#555;margin-top:4px}h3{margin-bottom:4px}</style>
</head><body>
<h1>拆格审阅：${base}</h1>
<p>方法：${method} · 原图 ${fullW}×${fullH} · ${method === "morphological_lines" ? `横格线(px): ${hLines.join(", ")}；纵格线(px): ${vLines.join(", ")}` : "等分均分（未检测到格线）"}</p>
${warnHtml}
<h3>原图</h3><img src="${sheetThumb}" style="max-width:640px">
<h3>九宫格面板（r行c列：行1=上/全景行，行3=下/近景行；列1=左，列3=右）</h3>
<table>${cells.slice(0, 3).join("")}</table>
<table>${cells.slice(3, 6).join("")}</table>
<table>${cells.slice(6, 9).join("")}</table>
</body></html>`;
	const pagePath = join(outputDir, `${base}-review.html`);
	await writeFile(pagePath, html, "utf8");
	return pagePath;
}
/** Resolve a possibly-relative path against the workspace root. */
function resolvePath(p, workspaceRoot) {
	return isAbsolute(p) ? p : join(workspaceRoot, p);
}
//#endregion
//#region src/tool-grid-split.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-grid-split";
const inject = ["tools"];
const Config = z.object({ outputDir: z.string().default("outputs") });
function apply(ctx, config) {
	ctx.tools.register(defineTool({
		name: "split_grid_sheet",
		description: "把一张 3×3 九宫格拼图按格线拆成 9 张独立面板：方案1 形态学线检测（阈值+整幅白色行长带分组定位横/纵格线）；方案1 检测失败时自动启用方案2 等比分割。两种方案统一按 inset_percent（默认 2%）每侧内缩（按整图宽/高），随后白占比校验。输出 r1c1..r3c3 命名面板与自包含审阅页。可选 normalize_ratio 把每个面板规范到指定比例：竖构图（如 9:16）保持高度不变、居中裁剪宽度；横构图（如 16:9、21:9）保持宽度不变、居中裁剪高度。只做拆线与规范裁剪，不做放大或重绘。",
		parameters: {
			image: {
				type: "string",
				required: true,
				description: "3×3 九宫格拼图路径（PNG/JPEG/WEBP）。"
			},
			output_dir: {
				type: "string",
				description: "可选输出目录（默认 <工作目录>/outputs/grid-split/<文件名>/）。"
			},
			normalize_ratio: {
				type: "string",
				description: "可选：面板规范比例 W:H，如 16:9、9:16、21:9；竖构图高不变裁宽度，横构图宽不变裁高度（均居中）。省略则不裁剪。"
			},
			inset_percent: {
				type: "integer",
				description: "可选：两种方案统一使用的每侧内缩百分比（按整图宽/高），默认 2；范围 0-10。"
			},
			work_edge: {
				type: "integer",
				description: "可选：线检测工作图最长边（默认 1024），越小越快、检测精度略降。"
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
					method: { type: "string" },
					sheet_path: { type: "string" },
					width: { type: "integer" },
					height: { type: "integer" },
					lines: {
						type: "object",
						additionalProperties: true
					},
					normalized_ratio: { type: "string" },
					inset_percent: { type: "integer" },
					panels: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true
						}
					},
					review_page: { type: "string" },
					warnings: {
						type: "array",
						items: { type: "string" }
					},
					message: { type: "string" }
				}
			},
			render(_args, value) {
				return [{
					type: "text",
					text: value.message ?? `split: ${value.sheet_path}`
				}];
			}
		},
		async execute(args, exec) {
			const image = String(args.image ?? "").trim();
			if (!image) return {
				ok: false,
				message: "image path is required"
			};
			const workspaceRoot = exec.agent?.session?.header?.cwd ?? process.cwd();
			try {
				const sheetPath = resolvePath(image, workspaceRoot);
				const base = basename(sheetPath, extname(sheetPath)).replace(/[^\w.-]+/g, "_").slice(0, 60) || "grid";
				const requested = String(args.output_dir ?? "").trim();
				const result = await splitGridSheet(sheetPath, requested ? resolvePath(requested, workspaceRoot) : join(workspaceRoot, config.outputDir, "grid-split", base), {
					insetPercent: Number.isInteger(args.inset_percent) ? args.inset_percent : 2,
					workEdge: Number.isInteger(args.work_edge) ? args.work_edge : 1024,
					normalizeRatio: String(args.normalize_ratio ?? "").trim() || null
				});
				return {
					ok: result.ok,
					method: result.method,
					sheet_path: result.sheet_path,
					width: result.width,
					height: result.height,
					lines: result.lines,
					...result.normalized_ratio ? { normalized_ratio: result.normalized_ratio } : {},
					inset_percent: result.inset_percent,
					panels: result.panels,
					review_page: result.review_page,
					warnings: result.warnings,
					message: result.message
				};
			} catch (error) {
				return {
					ok: false,
					message: String(error?.message ?? error)
				};
			}
		}
	}));
}
//#endregion
export { Config, apply, inject, name, resolvePath, splitGridSheet };
