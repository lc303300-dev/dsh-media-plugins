/**
 * Skill Curator tool (Codex_CS codex-cs-skill-curator port): turn raw
 * materials (docs, legacy skills, community experience) into auditable
 * standard business-Skill packages — scaffold, count rules, validation,
 * planned counts, migration, discovery, publication with intake receipt.
 * Provider-neutral: never selects a model or submits media.
 *
 * @module @deepseek-ai/dsh-tool-curator
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addMissingCountRules,
  buildIntakeReceipt,
  compileChecklist,
  packageSha256,
  plannedCount,
  readIntakeSources,
  sealSources,
  validatePackage,
  validateScaffoldInput,
} from './shared/curator-core.ts'
import { validateContract, type SlotContract } from './shared/registry-core.ts'
import { resolvePrivateRoot } from './shared/private-runtime.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-curator'
export const inject = ['tools']

export interface Config {
  privateDir?: string
}

export const Config: z<Config> = z.object({
  privateDir: z.string().default(''),
})

type ResolvedConfig = Required<Config>

/** Bundle template root: built chunk lives at the package root. */
function templateRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'refs', 'skill-template'),
    join(here, '..', '..', 'refs', 'skill-template'),
  ]
  return candidates.find((c) => existsSync(join(c, 'contract.json'))) ?? candidates[0]
}

/** Copy the template tree and render {{placeholders}}. */
function renderTemplate(destination: string, replacements: Record<string, string>): void {
  if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`)
  const root = templateRoot()
  const copyRecursive = (src: string, dst: string): void => {
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src)) {
      const from = join(src, entry)
      const to = join(dst, entry)
      if (statSync(from).isDirectory()) copyRecursive(from, to)
      else copyFileSync(from, to)
    }
  }
  copyRecursive(root, destination)
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
      if (!['.md', '.json', '.yaml', '.yml'].includes(ext)) continue
      let text = readFileSync(path, 'utf8')
      for (const [key, value] of Object.entries(replacements)) {
        text = text.split(`{{${key}}}`).join(value)
      }
      writeFileSync(path, text, 'utf8')
    }
  }
  walk(destination)
}

function parseFrontmatterName(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\s*\r?\n(.*?)\r?\n---(?:\r?\n|$)/s)
  if (!match) return {}
  const out: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/)
    if (kv) out[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'skill_curator',
      description:
        '业务 Skill 录入治理（Codex_CS codex-cs-skill-curator 的 DSH 重建）：把用户上传的 Skill Markdown、旧版 Skill 包、社区经验文档或提示词资料整理为可审计、可验证、可发布的标准业务 Skill 包。scaffold 用标准模板生成骨架（contract.json/routing.json/SKILL.md/agents/references）；add_count_rules 为素材槽补齐审计式 count_rule（固定角色固定数量、其余默认每约 5 秒一项）；validate 按 validator 1.1.0 校验（必需文件、占位符/密钥/终端输出/绝对路径扫描、执行层泄漏、禁止 text2video、authoring 策略、intake-receipt 哈希绑定）；planned_counts 按确认时长推导各槽素材计划数；migrate 从旧版 Markdown 迁移；publish 生成 intake-receipt 并发布到注册库。全程 provider-neutral，不选择模型、不提交媒体。',
      parameters: {
        command: {
          type: 'string',
          enum: ['scaffold', 'validate', 'add_count_rules', 'planned_counts', 'migrate', 'discover', 'publish'],
          required: true,
          description: '操作命令。',
        },
        skill_id: { type: 'string', description: 'scaffold/migrate 用：小写连字符 id（≤64 字符）。' },
        display_name: { type: 'string', description: 'scaffold 用：展示名。' },
        description: { type: 'string', description: 'scaffold 用：能力与触发条件描述（≥20 字符）。' },
        short_description: { type: 'string', description: 'scaffold 用：短描述（25-64 字符）。' },
        output_dir: { type: 'string', description: 'scaffold/migrate 用：输出根目录（包目录 = <output>/<skill_id>）。' },
        package_dir: { type: 'string', description: 'validate/add_count_rules/planned_counts/publish 用：包目录。' },
        duration: { type: 'integer', description: 'planned_counts 用：确认的视频时长（秒）。' },
        source_path: { type: 'string', description: 'migrate 用：旧版 Skill Markdown 或资料路径。' },
        published: { type: 'boolean', description: 'validate 用：要求 intake-receipt.json（发布态）。' },
        version: { type: 'string', description: 'publish 用：注册库版本号（默认 1.0.0）。' },
        sources: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'publish 用：来源 [{name, sha256}]（有 intake-sources.json 时优先用封存来源）。' },
        approved: { type: 'boolean', description: 'publish 用：用户过目审核清单后明确确认；缺省拒绝发布。' },
        status: { type: 'string', enum: ['draft', 'published', 'deprecated', 'any'], description: 'discover 用：状态过滤（默认 published）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string' },
            package_path: { type: 'string' },
            issues: { type: 'array' },
            additions: { type: 'array' },
            plan: { type: 'object', additionalProperties: true },
            skills: { type: 'array' },
          },
        },
        render(_args: unknown, value: any) {
          return [{ type: 'text', text: value.message ?? JSON.stringify(value) }]
        },
      },
      async execute(args: any, exec: any) {
        const command = args.command as string
        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)
        const resolvePath = (p: string): string => (isAbsolute(p) ? p : join(workspaceRoot, p))

        if (command === 'discover') {
          const { SkillRegistry } = await import('./shared/registry-core.ts')
          const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
          try {
            const status = args.status === 'any' ? undefined : (args.status as 'draft' | 'published' | 'deprecated' | undefined) || undefined
            const skills = registry.list(status)
            return { ok: true, message: `${skills.length} skill(s)`, skills: skills.map((s) => ({ id: s.id, name: s.name, version: s.version, status: s.status })) }
          } finally {
            registry.close()
          }
        }

        if (command === 'scaffold') {
          try {
            validateScaffoldInput(String(args.skill_id ?? ''), String(args.display_name ?? ''), String(args.description ?? ''), args.short_description)
            const outputRoot = resolvePath(String(args.output_dir ?? 'outputs/skills'))
            const destination = join(outputRoot, String(args.skill_id))
            const short = (args.short_description ?? `根据已确认素材与专业规则生成${args.display_name}视频提示词`).trim()
            renderTemplate(destination, {
              skill_id: String(args.skill_id),
              display_name: String(args.display_name),
              description: String(args.description),
              short_description: short,
            })
            return { ok: true, message: `scaffolded: ${destination}`, package_path: destination }
          } catch (error: any) {
            return { ok: false, message: String(error?.message ?? error) }
          }
        }

        if (command === 'migrate') {
          try {
            const source = resolvePath(String(args.source_path ?? ''))
            const text = readFileSync(source, 'utf8')
            const fm = parseFrontmatterName(text)
            const skillId = args.skill_id ?? (fm.name ?? basename(source, '.md')).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
            const displayName = args.display_name ?? fm.name ?? skillId
            const description = args.description ?? fm.description ?? `根据用户资料生成的 ${displayName} 视频创作 Skill，负责按已确认素材与专业规则编写可执行中文提示词。`
            validateScaffoldInput(skillId, displayName, description, args.short_description)
            const outputRoot = resolvePath(String(args.output_dir ?? 'outputs/skills'))
            const destination = join(outputRoot, skillId)
            renderTemplate(destination, {
              skill_id: skillId,
              display_name: displayName,
              description,
              short_description: (args.short_description ?? `根据已确认素材与专业规则生成${displayName}视频提示词`).trim(),
            })
            // 封存来源（文件名 + SHA-256 + 编码），来源是不可修改的证据
            const sealed = sealSources([source])
            writeFileSync(join(destination, 'intake-sources.json'), JSON.stringify({ schema_version: 1, sources: sealed }, null, 2) + '\n', 'utf8')
            // 编译清单：源内容应分类进哪些包文件
            const checklist = compileChecklist(text)
            return {
              ok: true,
              message: `migrated to: ${destination}；来源已封存（${sealed[0].sha256.slice(0, 12)}…，${sealed[0].encoding}）。请按编译清单把源资料分类补入模板 references 后 validate`,
              package_path: destination,
              sources: sealed,
              compile_checklist: checklist,
            }
          } catch (error: any) {
            return { ok: false, message: String(error?.message ?? error) }
          }
        }

        if (!args.package_dir) return { ok: false, message: 'package_dir is required' }
        const packageDir = resolvePath(String(args.package_dir))

        if (command === 'validate') {
          const issues = validatePackage(packageDir, Boolean(args.published))
          return {
            ok: issues.length === 0,
            message: issues.length === 0 ? 'package valid' : `${issues.length} issue(s)`,
            issues,
            package_path: packageDir,
            package_sha256: packageSha256(packageDir),
          }
        }

        if (command === 'add_count_rules') {
          const contractPath = join(packageDir, 'contract.json')
          const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
          const { contract: updated, additions } = addMissingCountRules(contract)
          if (additions.length > 0) writeFileSync(contractPath, JSON.stringify(updated, null, 2) + '\n', 'utf8')
          return { ok: true, message: `${additions.length} count rule(s) added`, additions, package_path: packageDir }
        }

        if (command === 'planned_counts') {
          const duration = Number(args.duration)
          if (!Number.isInteger(duration) || duration < 4 || duration > 30) return { ok: false, message: 'duration must be an integer 4-30' }
          const contract = JSON.parse(readFileSync(join(packageDir, 'contract.json'), 'utf8'))
          const plan = (contract.references ?? []).map((ref: any) => ({
            slot: ref.id,
            role: ref.role,
            required: ref.required,
            min_count: ref.min_count,
            max_count: ref.max_count,
            count_rule_type: ref.count_rule?.type,
            planned_count: plannedCount(ref.count_rule, duration),
          }))
          return { ok: true, message: `planned counts for ${duration}s`, plan }
        }

        if (command === 'publish') {
          const issues = validatePackage(packageDir, false)
          if (issues.length > 0) return { ok: false, message: `validation failed (${issues.length} issue(s)); fix before publish`, issues }
          const contract = JSON.parse(readFileSync(join(packageDir, 'contract.json'), 'utf8'))
          const name = String(contract.skill_id)
          // 审核门：publish 前必须用户明确确认（review checklist）
          if (args.approved !== true) {
            const sealed = readIntakeSources(packageDir)
            const checklist = {
              skill_id: name,
              display_name: String(contract.display_name ?? ''),
              source_hashes: sealed ? sealed.map((s) => ({ name: s.name, sha256: s.sha256.slice(0, 16) + '…' })) : null,
              slots: (contract.references ?? []).map((ref: any) => ({
                id: ref.id,
                media_type: ref.media_type,
                role: ref.role,
                required: ref.required,
                min_count: ref.min_count,
                max_count: ref.max_count,
                count_rule: ref.count_rule?.type,
              })),
              isolated_legacy_rules: '请人工核对源资料中是否含本机路径/凭据/CLI/provider/模型版本，已从契约隔离',
              validation: `${issues.length} issue(s)`,
              instruction: '请向用户展示以上审核项并获得明确确认后，以 approved=true 重新调用 publish',
            }
            return { ok: false, message: 'publish requires explicit user approval (approved=true) after reviewing the checklist', checklist }
          }
          // 来源：优先用封存的 intake-sources.json，其次显式 sources 参数
          const sealed = readIntakeSources(packageDir)
          const sources = sealed
            ? sealed.map((s) => ({ name: s.name, sha256: s.sha256 }))
            : Array.isArray(args.sources) && args.sources.length > 0
              ? args.sources.map((s: any) => ({ name: String(s.name), sha256: String(s.sha256) }))
              : [{ name: 'curator-input', sha256: packageSha256(packageDir) }]
          const receipt = buildIntakeReceipt(packageDir, sources)
          writeFileSync(join(packageDir, 'intake-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8')
          const publishedIssues = validatePackage(packageDir, true)
          if (publishedIssues.length > 0) {
            return { ok: false, message: `receipt validation failed: ${publishedIssues.map((i) => i.code).join(', ')}`, issues: publishedIssues }
          }
          // ingest into the registry (provider-neutral: name=skill_id, version param)
          const { SkillRegistry } = await import('./shared/registry-core.ts')
          const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
          try {
            const routingRaw = JSON.parse(readFileSync(join(packageDir, 'routing.json'), 'utf8'))
            const version = String(args.version ?? '1.0.0')
            const taxonomy = Array.isArray(routingRaw.user_intents) ? routingRaw.user_intents.map(String) : []
            const contractForRegistry = {
              name,
              version,
              description: String(contract.description ?? ''),
              taxonomy,
              video: contract.video ? { ratios: ['16:9', '9:16', '1:1'], duration_min: 4, duration_max: 30 } : undefined,
              slots: (contract.references ?? []).map((ref: any): SlotContract => ({
                id: String(ref.id),
                label: String(ref.role ?? ref.id),
                min: ref.min_count,
                max: ref.max_count ?? undefined,
                count_rule: ref.count_rule?.type,
              })),
              prompt: { lang: 'zh', corpus_policy: 'up_to_3_examples' },
            }
            validateContract(contractForRegistry)
            const record = registry.ingest({ contract: contractForRegistry, routing: routingRaw, packageRoot: packageDir, provenance: 'curator' }, { force: true })
            registry.setStatus(name, version, 'published')
            return { ok: true, message: `published ${record.name}@${record.version} with intake receipt`, skill: { id: record.id, name: record.name, version: record.version, status: record.status } }
          } finally {
            registry.close()
          }
        }

        return { ok: false, message: `unknown command: ${command}` }
      },
    }),
  )
}

export { apply }
