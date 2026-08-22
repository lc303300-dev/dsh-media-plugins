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
import { basename, isAbsolute, join } from 'node:path'
import { packageRootOf } from './shared/pkg-root.ts'
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
import {
  buildFlowIntakeReceipt,
  buildFlowReviewCard,
  flowMetaToRegistryShape,
  flowPackageSha256,
  validateCodexFlowPackage,
} from './shared/flow-format.ts'
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

/** Bundle template root: built chunk lives at the package root. Prefer the
 *  Codex_Flow skill template (SKILL.md + meta.yaml + workflow.yaml); fall back
 *  to the legacy contract template for old flows. */
function templateRoot(): string {
  const here = packageRootOf(import.meta.url)
  const candidates = [
    join(here, 'refs', 'codex-flow-skill-template'),
    join(here, '..', '..', 'refs', 'codex-flow-skill-template'),
    join(here, 'refs', 'skill-template'),
    join(here, '..', '..', 'refs', 'skill-template'),
  ]
  return (
    candidates.find((c) => existsSync(join(c, 'meta.yaml'))) ??
    candidates.find((c) => existsSync(join(c, 'contract.json'))) ??
    candidates[0]
  )
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
        '业务 Skill 录入治理（Codex_Flow 格式的 DSH 重建）：把用户上传的 Skill Markdown、旧版 Skill 包、社区经验文档或提示词资料整理为可审计、可验证、可发布的业务 Skill 包。scaffold 用标准模板生成骨架（新格式：SKILL.md/meta.yaml/workflow.yaml/references，镜像 Codex_Flow 平台格式；旧格式：contract.json/routing.json/SKILL.md/agents/references）；validate 按格式自动选择校验器（meta.yaml 存在时用 flow-1.0：必需元字段、污染扫描、reference 路由、workflow 依赖完整性、收据哈希绑定；否则 validator 1.2.0）；add_count_rules/planned_counts 仅适用于旧 contract 格式；publish 生成审阅卡（含 paid_points 与 package_hash）与 intake-receipt 并发布到注册库。全程 provider-neutral，不选择模型、不提交媒体。',
      parameters: {
        command: {
          type: 'string',
          enum: ['scaffold', 'validate', 'add_count_rules', 'planned_counts', 'migrate', 'discover', 'publish', 'prepare_dt_supplement', 'receive_dt_supplement', 'approve_dt_supplement'],
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
        draft_path: { type: 'string', description: 'receive_dt_supplement 用：DT 创意补充草稿 JSON 路径。' },
        approved_by: { type: 'string', description: 'approve_dt_supplement 用：必须为 user。' },
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
          // Codex_Flow format (meta.yaml) is authoritative when present
          if (existsSync(join(packageDir, 'meta.yaml'))) {
            const issues = validateCodexFlowPackage(packageDir, Boolean(args.published))
            return {
              ok: issues.length === 0,
              message: issues.length === 0 ? 'package valid (codex-flow)' : `${issues.length} issue(s)`,
              issues,
              package_path: packageDir,
              package_sha256: flowPackageSha256(packageDir),
            }
          }
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
          if (existsSync(join(packageDir, 'meta.yaml'))) {
            return { ok: false, message: 'add_count_rules 仅适用于旧 contract.json 格式；Codex_Flow 包不声明素材槽 count_rule' }
          }
          const contractPath = join(packageDir, 'contract.json')
          const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
          const { contract: updated, additions } = addMissingCountRules(contract)
          if (additions.length > 0) writeFileSync(contractPath, JSON.stringify(updated, null, 2) + '\n', 'utf8')
          return { ok: true, message: `${additions.length} count rule(s) added`, additions, package_path: packageDir }
        }

        if (command === 'planned_counts') {
          if (existsSync(join(packageDir, 'meta.yaml'))) {
            return { ok: false, message: 'planned_counts 仅适用于旧 contract.json 格式；Codex_Flow 包以 workflow.yaml 阶段为准，不按时长推导素材计划数' }
          }
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

        if (command === 'prepare_dt_supplement') {
          // 检查 references 是否缺少可执行创作方法/范例；生成受限补充请求（不推断契约、不选模型）
          const targets: string[] = []
          for (const [name, path] of [['creative-guidance', 'references/creative-guidance.md'], ['examples', 'references/examples.md']] as const) {
            try {
              const content = readFileSync(join(packageDir, path), 'utf8')
              const body = content.replace(/<!--[\s\S]*?-->/g, '').trim()
              if (body.length < 200) targets.push(name)
            } catch {
              targets.push(name)
            }
          }
          const request = {
            schema_version: 1,
            skill_id: basename(packageDir),
            targets,
            constraints: ['只可补充提示词范例、正例、反例、边界案例和可选创意指导草稿', '不得推断素材契约', '不得选择 provider、模型、分辨率、轮询或付费执行', '输出为草稿，须用户批准后才能写入正式 references'],
            requested_at: new Date().toISOString(),
          }
          const reviewDir = join(packageDir, 'review')
          mkdirSync(reviewDir, { recursive: true })
          writeFileSync(join(reviewDir, 'dt-supplement-request.json'), JSON.stringify(request, null, 2) + '\n', 'utf8')
          writeFileSync(join(reviewDir, 'supplement-state.json'), JSON.stringify({ status: 'draft_requested', requested_at: request.requested_at }, null, 2) + '\n', 'utf8')
          return { ok: true, message: targets.length === 0 ? 'references 已完整，无需补充' : `补充请求已生成（目标：${targets.join(', ')}）`, request }
        }

        if (command === 'receive_dt_supplement') {
          if (!args.draft_path) return { ok: false, message: 'draft_path is required' }
          const draftPath = resolvePath(String(args.draft_path))
          let draft: any
          try {
            draft = JSON.parse(readFileSync(draftPath, 'utf8'))
          } catch (error: any) {
            return { ok: false, message: `invalid draft JSON: ${error?.message ?? error}` }
          }
          if (!Array.isArray(draft?.targets) || draft.targets.length === 0 || !draft.targets.every((t: any) => t?.target && typeof t.content === 'string')) {
            return { ok: false, message: 'draft must be {targets: [{target, content}]} with content strings' }
          }
          if (draft.draft !== true) return { ok: false, message: 'DT 补充必须是草稿（draft=true），未经批准不得进入正式 references' }
          const reviewDir = join(packageDir, 'review')
          mkdirSync(reviewDir, { recursive: true })
          writeFileSync(join(reviewDir, 'dt-supplement-draft.json'), JSON.stringify(draft, null, 2) + '\n', 'utf8')
          writeFileSync(join(reviewDir, 'supplement-state.json'), JSON.stringify({ status: 'draft_received', received_at: new Date().toISOString(), targets: draft.targets.map((t: any) => t.target) }, null, 2) + '\n', 'utf8')
          return { ok: true, message: `草稿已接收（${draft.targets.length} 个目标），待用户批准；未写入正式 references`, draft }
        }

        if (command === 'approve_dt_supplement') {
          if (args.approved_by !== 'user') return { ok: false, message: 'approve 必须由用户明确批准（approved_by=user）' }
          const reviewDir = join(packageDir, 'review')
          let draft: any
          try {
            draft = JSON.parse(readFileSync(join(reviewDir, 'dt-supplement-draft.json'), 'utf8'))
          } catch {
            return { ok: false, message: 'no received draft; run receive_dt_supplement first' }
          }
          const allowedTargets = ['creative-guidance', 'examples']
          const written: string[] = []
          for (const item of draft.targets) {
            const target = String(item.target)
            if (!allowedTargets.includes(target)) return { ok: false, message: `不支持的补充目标：${target}（仅 creative-guidance / examples）` }
            const path = target === 'creative-guidance' ? 'references/creative-guidance.md' : 'references/examples.md'
            const existing = readFileSync(join(packageDir, path), 'utf8').trimEnd()
            writeFileSync(join(packageDir, path), existing + '\n\n<!-- DT 创意补充（已获用户批准）-->\n' + String(item.content).trim() + '\n', 'utf8')
            written.push(target)
          }
          writeFileSync(join(reviewDir, 'supplement-state.json'), JSON.stringify({ status: 'user_approved', approved_at: new Date().toISOString(), approved_by: 'user', targets: written }, null, 2) + '\n', 'utf8')
          return { ok: true, message: `草稿已批准并入 references（${written.join(', ')}）；仍未发布，需用户确认后 publish` }
        }

        if (command === 'publish') {
          // Codex_Flow format path (meta.yaml authoritative when present)
          if (existsSync(join(packageDir, 'meta.yaml'))) {
            const issues = validateCodexFlowPackage(packageDir, false)
            if (issues.length > 0) return { ok: false, message: `validation failed (${issues.length} issue(s)); fix before publish`, issues }
            const shape = flowMetaToRegistryShape(packageDir)
            const name = String(shape.name)
            if (args.approved !== true) {
              let card: Record<string, unknown>
              try {
                card = buildFlowReviewCard(packageDir)
              } catch (error: any) {
                return { ok: false, message: String(error?.message ?? error) }
              }
              const sealed = readIntakeSources(packageDir)
              const checklist = {
                skill_id: name,
                display_name: String(card.display_name ?? ''),
                primary_output: card.primary_output,
                capabilities: card.capabilities,
                paid_points: card.paid_points,
                workflow_profile: card.workflow_profile,
                source_hashes: sealed ? sealed.map((s) => ({ name: s.name, sha256: s.sha256.slice(0, 16) + '…' })) : null,
                package_hash: String(card.package_hash ?? ''),
                validation: `${issues.length} issue(s)`,
                instruction: '请向用户展示以上审核项并获得明确确认后，以 approved=true 重新调用 publish',
              }
              return { ok: false, message: 'publish requires explicit user approval (approved=true) after reviewing the checklist', checklist }
            }
            const sealed = readIntakeSources(packageDir)
            const sources = sealed
              ? sealed.map((s) => ({ name: s.name, sha256: s.sha256 }))
              : Array.isArray(args.sources) && args.sources.length > 0
                ? args.sources.map((s: any) => ({ name: String(s.name), sha256: String(s.sha256) }))
                : [{ name: 'curator-input', sha256: flowPackageSha256(packageDir) }]
            const receipt = buildFlowIntakeReceipt(packageDir, sources, { version: String(shape.version) })
            writeFileSync(join(packageDir, 'intake-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8')
            const publishedIssues = validateCodexFlowPackage(packageDir, true)
            if (publishedIssues.length > 0) {
              return { ok: false, message: `receipt validation failed: ${publishedIssues.join(', ')}`, issues: publishedIssues }
            }
            const { SkillRegistry } = await import('./shared/registry-core.ts')
            const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
            try {
              const contract = validateContract({
                name: String(shape.name),
                version: String(shape.version),
                description: String(shape.description),
                taxonomy: shape.taxonomy,
                flow: shape.flow as any,
              })
              const routing = { aliases: shape.taxonomy, negative_intents: Array.isArray(shape.flow.exclude_intents) ? (shape.flow.exclude_intents as string[]) : [] }
              const record = registry.ingest({ contract, routing, packageRoot: packageDir, provenance: 'curator (codex-flow)' }, { force: true })
              registry.setStatus(String(shape.name), String(shape.version), 'published')
              return { ok: true, message: `published ${record.name}@${record.version} with intake receipt (codex-flow)`, skill: { id: record.id, name: record.name, version: record.version, status: record.status } }
            } finally {
              registry.close()
            }
          }
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
