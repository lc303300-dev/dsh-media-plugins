/**
 * Grid-sheet split tool: split a 3×3 grid sheet into nine independent
 * panels. Community-consensus revision — morphological-style line scan to
 * locate the gutters, crop with an inset, validate, and emit a self-contained
 * review page. Extraction only: no upscaling, no redrawing, no paid calls.
 *
 * @module @deepseek-ai/dsh-tool-grid-split
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { join, basename, extname } from 'node:path'
import { splitGridSheet, resolvePath } from './shared/grid-split-core.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-grid-split'
export const inject = ['tools']

export interface Config {
  outputDir?: string
}

export const Config: z<Config> = z.object({
  outputDir: z.string().default('outputs'),
})

type ResolvedConfig = Required<Config>

function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'split_grid_sheet',
      description:
        '把一张 3×3 九宫格拼图按格线拆成 9 张独立面板：方案1 形态学线检测（阈值+整幅白色行长带分组定位横/纵格线）；方案1 检测失败时自动启用方案2 等比分割。两种方案统一按 inset_percent（默认 2%）每侧内缩（按整图宽/高），随后白占比校验。输出 r1c1..r3c3 命名面板与自包含审阅页。可选 normalize_ratio 把每个面板规范到指定比例：竖构图（如 9:16）保持高度不变、居中裁剪宽度；横构图（如 16:9、21:9）保持宽度不变、居中裁剪高度。只做拆线与规范裁剪，不做放大或重绘。',
      parameters: {
        image: {
          type: 'string',
          required: true,
          description: '3×3 九宫格拼图路径（PNG/JPEG/WEBP）。',
        },
        output_dir: {
          type: 'string',
          description: '可选输出目录（默认 <工作目录>/outputs/grid-split/<文件名>/）。',
        },
        normalize_ratio: {
          type: 'string',
          description: '可选：面板规范比例 W:H，如 16:9、9:16、21:9；竖构图高不变裁宽度，横构图宽不变裁高度（均居中）。省略则不裁剪。',
        },
        inset_percent: {
          type: 'integer',
          description: '可选：两种方案统一使用的每侧内缩百分比（按整图宽/高），默认 2；范围 0-10。',
        },
        work_edge: {
          type: 'integer',
          description: '可选：线检测工作图最长边（默认 1024），越小越快、检测精度略降。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            method: { type: 'string' },
            sheet_path: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            lines: { type: 'object', additionalProperties: true },
            normalized_ratio: { type: 'string' },
            inset_percent: { type: 'integer' },
            panels: { type: 'array', items: { type: 'object', additionalProperties: true } },
            review_page: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } },
            message: { type: 'string' },
          },
        },
        render(_args: unknown, value: any) {
          return [{ type: 'text', text: value.message ?? `split: ${value.sheet_path}` }]
        },
      },
      async execute(args: any, exec: any) {
        const image = String(args.image ?? '').trim()
        if (!image) return { ok: false, message: 'image path is required' }
        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        try {
          const sheetPath = resolvePath(image, workspaceRoot)
          const base = basename(sheetPath, extname(sheetPath)).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'grid'
          const requested = String(args.output_dir ?? '').trim()
          const outDir = requested
            ? resolvePath(requested, workspaceRoot)
            : join(workspaceRoot, config.outputDir, 'grid-split', base)
          const insetPercent = Number.isInteger(args.inset_percent) ? args.inset_percent : 2
          const workEdge = Number.isInteger(args.work_edge) ? args.work_edge : 1024
          const normalizeRatio = String(args.normalize_ratio ?? '').trim() || null
          const result = await splitGridSheet(sheetPath, outDir, { insetPercent, workEdge, normalizeRatio })
          return {
            ok: result.ok,
            method: result.method,
            sheet_path: result.sheet_path,
            width: result.width,
            height: result.height,
            lines: result.lines,
            normalized_ratio: result.normalized_ratio,
            inset_percent: result.inset_percent,
            panels: result.panels,
            review_page: result.review_page,
            warnings: result.warnings,
            message: result.message,
          }
        } catch (error: any) {
          return { ok: false, message: String(error?.message ?? error) }
        }
      },
    }),
  )
}

export { apply }

/** Re-export for standalone testing and reuse by other tools. */
export { splitGridSheet, resolvePath } from './shared/grid-split-core.ts'
