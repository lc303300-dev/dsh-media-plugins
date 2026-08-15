import { n as makePreview, t as imageDimensions } from "./image-ops.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
//#region src/tool-preview.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-preview";
const inject = ["tools"];
const Config = z.object({
	outputDir: z.string().default("outputs"),
	maxLongEdge: z.number().default(1024)
});
function apply(ctx, config) {
	ctx.tools.register(defineTool({
		name: "image_preview",
		description: "生成本地图片的 EXIF 方向归一化预览（最长边 ≤ 1024px，默认）并返回原图与预览的尺寸信息。视觉检查、审阅页与 describe_image 均应基于预览而非原始大图；原图永不被覆盖或修改。",
		parameters: {
			image: {
				type: "string",
				required: true,
				description: "本地图片路径（PNG/JPEG/WEBP/GIF）。"
			},
			max_long_edge: {
				type: "integer",
				description: "可选：预览最长边上限，默认 1024。"
			},
			output: {
				type: "string",
				description: "可选输出路径（绝对或相对会话工作目录）。"
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
					original: {
						type: "object",
						additionalProperties: true
					},
					preview_path: { type: "string" },
					preview: {
						type: "object",
						additionalProperties: true
					},
					message: { type: "string" }
				}
			},
			render(_args, value) {
				return [{
					type: "text",
					text: value.message ?? `preview: ${value.preview_path}`
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
				const original = await imageDimensions(image);
				let outDir = join(workspaceRoot, config.outputDir, "previews");
				await mkdir(outDir, { recursive: true });
				let preview = await makePreview(image, outDir, args.max_long_edge ?? config.maxLongEdge);
				if (args.output && String(args.output).trim().length > 0) {
					const requested = String(args.output).trim();
					const finalPath = isAbsolute(requested) ? requested : join(workspaceRoot, requested);
					const { rename } = await import("node:fs/promises");
					await mkdir(dirname(finalPath), { recursive: true });
					await rename(preview.path, finalPath);
					preview = {
						...preview,
						path: finalPath
					};
				}
				return {
					ok: true,
					original,
					preview_path: preview.path,
					preview,
					message: `preview ready: ${preview.path} (${preview.width}x${preview.height})`
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
export { Config, apply, inject, name };
