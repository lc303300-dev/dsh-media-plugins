/**
 * Grid-sheet split tool: split 3×3 grid sheets into nine independent panels
 * each. Two detectors run in order — a morphological white-line scan, then a
 * luminance-profile peak scan that also handles soft/grey gutters, uneven
 * panel heights and bright-content rejection; when both fail it falls back to
 * an even split. Panels are cut on the outside of the detected gutter band,
 * so none of the line leaks into a panel. Supports a single sheet, or a
 * batched, group-organised run that writes every panel flat into one folder
 * per group. Extraction only: no upscaling, no redrawing, no paid calls.
 *
 * @module @deepseek-ai/dsh-tool-grid-split
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { join, basename, extname } from 'node:path'
import { splitGridSheet, splitGridSheets, resolvePath, type SplitGroupSpec } from './shared/grid-split-core.ts'

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
        '把 3×3 九宫格拼图按格线拆成 9 张独立面板。检测按顺序尝试：方案1 形态学线检测（阈值+整幅白色行长带分组，对纯白格线最快最准）→ 方案2 亮度曲线峰值检测（整行/整列平均亮度找峰，带突出度判据，可处理浅灰/柔和格线、行高列宽不均匀的图，并拒绝把大面积亮内容误判为格线）→ 两者都失败才回退方案3 等比分割。检测成功时按格线带**外侧**切割，格线像素不会进入任何面板。支持单张，也支持批量分组：groups=[{group, images}] 会把每组所有图的面板**平铺**写入 <output_dir>/<group>/（不再嵌套子目录）。可选 normalize_ratio 把每个面板规范到指定比例（竖构图高不变裁宽度，横构图宽不变裁高度，均居中）。只做拆线与规范裁剪，不做放大或重绘。',
      parameters: {
        image: {
          type: 'string',
          description: '单张 3×3 九宫格拼图路径（PNG/JPEG/WEBP）；与 groups 二选一。',
        },
        groups: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '批量分组：[{ group: "场景1-…", images: ["a.png","b.png"] }]。每组图的面板平铺写入 <output_dir>/<group>/，组内不再建子目录。',
        },
        output_dir: {
          type: 'string',
          description: '可选输出目录。单张默认 <工作目录>/outputs/grid-split/<文件名>/；批量时为输出根目录，每组一个子目录。',
        },
        normalize_ratio: {
          type: 'string',
          description: '可选：面板规范比例 W:H，如 16:9、9:16、21:9；竖构图高不变裁宽度，横构图宽不变裁高度（均居中）。省略则不裁剪。',
        },
        inset_percent: {
          type: 'integer',
          description: '可选：等比分割（方案3）时每侧内缩百分比（按整图宽/高），默认 2；范围 0-10。检测成功时不使用该值。',
        },
        inset_px: {
          type: 'integer',
          description: '可选：检测到格线时，在格线带外侧再保留的安全边距（整图像素），默认 2；范围 0-64。',
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
            gutter_bands: { type: 'object', additionalProperties: true },
            normalized_ratio: { type: 'string' },
            inset_percent: { type: 'integer' },
            panels: { type: 'array', items: { type: 'object', additionalProperties: true } },
            review_page: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } },
            output_root: { type: 'string' },
            group_count: { type: 'integer' },
            image_count: { type: 'integer' },
            panel_count: { type: 'integer' },
            failed: { type: 'integer' },
            results: { type: 'array', items: { type: 'object', additionalProperties: true } },
            message: { type: 'string' },
          },
        },
        render(_args: unknown, value: any) {
          return [{ type: 'text', text: value.message ?? `split: ${value.sheet_path}` }]
        },
      },
      async execute(args: any, exec: any) {
        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const insetPercent = Number.isInteger(args.inset_percent) ? args.inset_percent : 2
        const insetPx = Number.isInteger(args.inset_px) ? args.inset_px : 2
        const workEdge = Number.isInteger(args.work_edge) ? args.work_edge : 1024
        const normalizeRatio = String(args.normalize_ratio ?? '').trim() || null
        const requested = String(args.output_dir ?? '').trim()

        try {
          // ---- batched, group-organised run -------------------------------
          const rawGroups = Array.isArray(args.groups) ? args.groups : []
          if (rawGroups.length > 0) {
            const specs: SplitGroupSpec[] = rawGroups.map((g: any) => ({
              group: String(g?.group ?? '').trim() || 'group',
              images: (Array.isArray(g?.images) ? g.images : []).map((i: any) => resolvePath(String(i ?? '').trim(), workspaceRoot)).filter(Boolean),
            }))
            const outRoot = requested ? resolvePath(requested, workspaceRoot) : join(workspaceRoot, config.outputDir, 'grid-split')
            const result = await splitGridSheets(specs, outRoot, { insetPercent, insetPx, workEdge, normalizeRatio })
            return {
              ok: result.ok,
              output_root: result.output_root,
              group_count: result.group_count,
              image_count: result.image_count,
              panel_count: result.panel_count,
              failed: result.failed,
              results: result.results,
              warnings: result.results.flatMap((r) => r.warnings),
              message: result.message,
            }
          }

          // ---- single sheet ------------------------------------------------
          const image = String(args.image ?? '').trim()
          if (!image) return { ok: false, message: 'image path is required (or pass groups for a batched run)' }
          const sheetPath = resolvePath(image, workspaceRoot)
          const base = basename(sheetPath, extname(sheetPath)).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'grid'
          const outDir = requested
            ? resolvePath(requested, workspaceRoot)
            : join(workspaceRoot, config.outputDir, 'grid-split', base)
          const result = await splitGridSheet(sheetPath, outDir, { insetPercent, insetPx, workEdge, normalizeRatio })
          // 省略未规范比例时的 null 字段，避免输出 schema（string 类型）校验失败
          return {
            ok: result.ok,
            method: result.method,
            sheet_path: result.sheet_path,
            width: result.width,
            height: result.height,
            lines: result.lines,
            gutter_bands: result.gutter_bands,
            ...(result.normalized_ratio ? { normalized_ratio: result.normalized_ratio } : {}),
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
export { splitGridSheet, splitGridSheets, resolvePath } from './shared/grid-split-core.ts'
export type { SplitGroupSpec, BatchSplitResult } from './shared/grid-split-core.ts'
