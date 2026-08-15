import { a as ensureDir } from "./private-runtime-D6gReaf9.js";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
//#region src/shared/image-ops.ts
/**
* Local image operations via sharp: EXIF orientation normalization,
* proportional downscale to a max long edge (1920 px provider inputs,
* 1024 px previews), and provider-input staging. Originals are never
* overwritten; staged copies go into the private runtime.
*
* @module dsh-media-plugins/shared/image-ops
*/
/** Map sharp format names to safe file extensions. */
function formatToExt(format) {
	switch (format) {
		case "jpeg":
		case "jpg": return "jpg";
		case "webp": return "webp";
		case "gif": return "gif";
		case "tiff": return "tiff";
		default: return "png";
	}
}
/**
* Create a preview whose longest edge is at most `maxEdge` (default 1024),
* EXIF-oriented, stored under `outDir`. Used for vision checks and review
* pages; the original is never inspected directly.
*/
async function makePreview(src, outDir, maxEdge = 1024) {
	await ensureDir(outDir);
	const pipeline = sharp(src, { failOn: "none" }).rotate();
	const meta = await pipeline.metadata();
	const width = meta.width ?? 0;
	const height = meta.height ?? 0;
	const longest = Math.max(width, height);
	let target = pipeline;
	if (longest > maxEdge) target = pipeline.resize({
		width: maxEdge,
		height: maxEdge,
		fit: "inside",
		withoutEnlargement: true
	});
	const ext = formatToExt(meta.format);
	const base = basename(src, extname(src)).replace(/[^\w.-]+/g, "_").slice(0, 80);
	const dest = join(outDir, `${base}-preview.${ext}`);
	const info = await target.toFile(dest);
	return {
		path: dest,
		width: info.width,
		height: info.height
	};
}
/** Read basic dimensions of an image without decoding pixels. */
async function imageDimensions(src) {
	const meta = await sharp(src, { failOn: "none" }).metadata();
	return {
		width: meta.width ?? 0,
		height: meta.height ?? 0
	};
}
//#endregion
export { makePreview as n, imageDimensions as t };
