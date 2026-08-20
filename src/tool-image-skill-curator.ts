import {
  IMAGE_SKILL_ID_PATTERN,
  approveImageIntakeReport,
  auditImageSkill,
  imageContractToRegistryContract,
  imageCoreSha256,
  imageFileSha256,
  imagePackageSha256,
  isCodexFlowImagePackage,
  scaffoldImageSkill,
  sealImageSources,
  stageImagePublish,
  utcNow,
  validateCodexFlowImagePackage,
  validateImagePackage,
  validateImageReceipt,
} from './shared/image-skill-core.ts'
import { resolvePrivateRoot } from './shared/private-runtime.ts'
import { SkillRegistry, validateContract } from './shared/registry-core.ts'
import {
  buildFlowIntakeReceipt,
  buildFlowReviewCard,
  flowMetaToRegistryShape,
  flowPackageSha256,
} from './shared/flow-format.ts'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

/** Cordis plugin name used by loader diagnostics. */
const name = 'Ws_tool-image-skill-curator'
const inject = ['tools']
const Config = z.object({ privateDir: z.string().default(''), libraryRoot: z.string().default('') })

/** Bundle template root: built chunk lives at the package root. */
function pluginRoot(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/** Default library root for published image business Skills (private runtime). */
function libraryRoot(workspaceRoot: string, privateRoot: string, configured: string): string {
  if (configured && configured.trim().length > 0) return isAbsolute(configured) ? configured : join(workspaceRoot, configured)
  return join(privateRoot, 'image-skill-library')
}

/** Recursive directory copy (async). */
async function copyTree(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src)
  for (const entry of entries) {
    const from = join(src, entry)
    const to = join(dst, entry)
    const st = await stat(from)
    if (st.isDirectory()) await copyTree(from, to)
    else await copyFile(from, to)
  }
}

/** Copy a package into the private library root (seed_library). */
async function copyPackageToLibrary(source: string, libraryDir: string): Promise<string> {
  const skillId = basename(source)
  const destination = join(libraryDir, skillId)
  await mkdir(libraryDir, { recursive: true })
  const temp = await mkdtemp(join(libraryDir, '.seed-'))
  try {
    await copyTree(source, temp)
    if (existsSync(destination)) await rm(destination, { recursive: true, force: true })
    await rename(temp, destination)
    return destination
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** Codex_Flow 发布来源：优先 intake-sources.json 封存来源，其次显式 sources 参数。 */
function flowSealedSources(packageDir: string, args: any, resolvePath: (p: string) => string): Array<{ name: string; sha256: string }> {
  try {
    const raw = JSON.parse(readFileSync(join(packageDir, 'intake-sources.json'), 'utf8'))
    if (Array.isArray(raw.sources) && raw.sources.length > 0) {
      return raw.sources.map((s: any) => ({ name: String(s.name), sha256: String(s.sha256) }))
    }
  } catch {
    /* 无 intake-sources.json 时走显式 sources 参数 */
  }
  if (Array.isArray(args.sources) && args.sources.length > 0) {
    return args.sources.map((p: string) => ({ name: basename(String(p)), sha256: imageFileSha256(resolvePath(String(p))) }))
  }
  return []
}

/** 图片版 flow 模板根目录：优先打包目录（built chunk 位于包根），其次源码仓库 refs/。 */
function flowImageTemplateRoot(): string {
  const here = pluginRoot()
  const candidates = [
    join(here, 'refs', 'codex-flow-image-template'),
    join(here, '..', 'refs', 'codex-flow-image-template'),
  ]
  return candidates.find((c) => existsSync(join(c, 'meta.yaml'))) ?? candidates[0]
}

function apply(ctx: any, config: any) {
  ctx.tools.register(defineTool({
    name: 'image_skill_curator',
    description: '图片业务 Skill 录入治理（Codex_IS image-skill-curator 的 DSH 重建）：把用户上传的图片业务 Skill 资料整理为可审计、可验证、可发布的受治理图片业务 Skill 包。双格式：scaffold 默认生成 Codex_Flow 图片格式（SKILL.md/meta.yaml/workflow.yaml/references）；包内存在 meta.yaml 时 audit/validate/publish/upgrade 走 flow 校验（validateCodexFlowImagePackage + buildFlowReviewCard + buildFlowIntakeReceipt + flowMetaToRegistryShape 入注册库），否则走旧 contract.json 路径（validator 2.0.0：契约/路由/收据 schema、反泛化与反污染扫描、来源哈希）。audit 生成来源封存（flow）或 intake-report.json（旧格式）；approve 仅旧格式使用（approved_by=user）；publish 需 approved=true 审核门，原子发布到图片 Skill 库并重建注册表（禁覆盖）；upgrade 原子升级已发布包（备份+回滚）；seed_library 把插件自带的正式图片 Skill 库同步进私有库并注册。全程 provider-neutral，不选择模型、不提交媒体。',
    parameters: {
      command: {
        type: 'string',
        enum: ['scaffold', 'audit', 'approve', 'validate', 'publish', 'upgrade', 'seed_library'],
        required: true,
        description: '操作命令。',
      },
      skill_id: {
        type: 'string',
        description: 'scaffold 用：小写连字符 id（≤63 字符）。',
      },
      display_name: {
        type: 'string',
        description: 'scaffold 用：展示名（缺省保留模板占位符）。',
      },
      description: {
        type: 'string',
        description: 'scaffold 用：能力与触发条件描述（flow 模板渲染 {{description}}；缺省保留模板占位符）。',
      },
      package_dir: {
        type: 'string',
        description: 'audit/approve/validate/publish/upgrade 用：图片业务 Skill 包目录。',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: 'audit/publish/upgrade 用：来源文件路径列表（audit 必填；publish/upgrade 缺省用 intake-report 封存来源）。',
      },
      output_dir: {
        type: 'string',
        description: 'scaffold 用：输出根目录（包目录 = <output>/<skill_id>）。',
      },
      approved: {
        type: 'boolean',
        description: 'publish/upgrade 用：用户过目审核清单后明确确认；缺省拒绝。',
      },
      approved_by: {
        type: 'string',
        description: 'approve 用：必须为 user。',
      },
      require_report: {
        type: 'boolean',
        description: 'validate 用：要求 intake-report.json。',
      },
      version: {
        type: 'string',
        description: 'publish/upgrade 用：注册库版本号（默认 1.0.0）。',
      },
      library_dir: {
        type: 'string',
        description: 'publish/upgrade/seed_library 用：图片 Skill 库根目录（缺省 <private>/image-skill-library）。',
      },
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
          report: { type: 'object', additionalProperties: true },
          receipt: { type: 'object', additionalProperties: true },
          checklist: { type: 'object', additionalProperties: true },
          skill: { type: 'object', additionalProperties: true },
          skills: { type: 'array' },
          library: { type: 'array' },
        },
      },
      render(_args: any, value: any) {
        return [{ type: 'text', text: value.message ?? JSON.stringify(value) }]
      },
    },
    async execute(args: any, exec: any) {
      const command = args.command
      const workspaceRoot = exec.agent?.session?.header?.cwd ?? process.cwd()
      const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)
      const libRoot = libraryRoot(workspaceRoot, privateRoot, config.libraryRoot ?? args.library_dir ?? '')
      const resolvePath = (p: string) => (isAbsolute(p) ? p : join(workspaceRoot, p))
      const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
      try {
        if (command === 'seed_library') {
          const pluginLib = join(pluginRoot(), 'refs', 'image-skill-library')
          if (!existsSync(pluginLib)) return { ok: false, message: `plugin image-skill-library not found: ${pluginLib}` }
          const seeded: string[] = []
          const failed: Array<Record<string, unknown>> = []
          for (const entry of await readdir(pluginLib)) {
            const source = join(pluginLib, entry)
            const st = await stat(source)
            if (!st.isDirectory()) continue
            if (!existsSync(join(source, 'contract.json'))) continue
            try {
              const copied = await copyPackageToLibrary(source, libRoot)
              const issues = validateImagePackage(copied, { requireReport: true, requireReceipt: true })
              if (issues.length > 0) {
                failed.push({ skill_id: entry, issues })
                continue
              }
              const contract = JSON.parse(readFileSync(join(copied, 'contract.json'), 'utf8'))
              const routing = JSON.parse(readFileSync(join(copied, 'routing.json'), 'utf8'))
              const version = String(args.version ?? '1.0.0')
              const record = registry.ingest({
                contract: imageContractToRegistryContract(contract, routing, version),
                routing,
                packageRoot: copied,
                provenance: 'image-skill-curator:seed_library',
              }, { force: true })
              registry.setStatus(record.name, record.version, 'published')
              seeded.push(entry)
            } catch (error) {
              failed.push({ skill_id: entry, error: String(error instanceof Error ? error.message : error) })
            }
          }
          return {
            ok: failed.length === 0,
            message: `seeded ${seeded.length} skill(s)${failed.length > 0 ? `; ${failed.length} failed` : ''}`,
            skills: seeded.map((id) => ({ id, status: 'published' })),
            library: libRoot,
            issues: failed,
          }
        }
        if (command === 'scaffold') {
          const skillId = String(args.skill_id ?? '')
          if (!IMAGE_SKILL_ID_PATTERN.test(skillId) || skillId.length > 63) return { ok: false, message: 'skill_id must be lowercase hyphen-case and at most 63 characters' }
          const outputRoot = resolvePath(String(args.output_dir ?? 'outputs/image-skills'))
          // 默认模板 = Codex_Flow 图片格式（SKILL.md + meta.yaml + workflow.yaml + references）
          const template = flowImageTemplateRoot()
          if (!existsSync(join(template, 'meta.yaml'))) return { ok: false, message: `codex-flow-image-template not found: ${template}` }
          try {
            const destination = scaffoldImageSkill(
              template,
              skillId,
              outputRoot,
              args.display_name ? String(args.display_name) : undefined,
              args.description ? String(args.description) : undefined,
            )
            return { ok: true, message: `scaffolded (codex-flow): ${destination}`, package_path: destination }
          } catch (error) {
            return { ok: false, message: String(error instanceof Error ? error.message : error) }
          }
        }
        if (command === 'audit') {
          if (!args.package_dir) return { ok: false, message: 'package_dir is required' }
          const packageDir = resolvePath(String(args.package_dir))
          const sources = Array.isArray(args.sources) && args.sources.length > 0 ? args.sources.map((p: string) => resolvePath(String(p))) : []
          if (sources.length === 0) return { ok: false, message: 'audit requires at least one source path' }
          if (isCodexFlowImagePackage(packageDir)) {
            // Codex_Flow 包：校验 + 封存来源到 intake-sources.json（无 intake-report 概念）
            const issues = validateCodexFlowImagePackage(packageDir)
            const sealed = sealImageSources(sources)
            await writeFile(join(packageDir, 'intake-sources.json'), JSON.stringify({ schema_version: 1, sources: sealed }, null, 2) + '\n', 'utf8')
            const ok = issues.length === 0
            return {
              ok,
              message: ok ? 'intake-sources written (codex-flow, ready_for_approval)' : `flow validation: ${issues.length} issue(s)`,
              report: {
                schema_version: 1,
                status: ok ? 'ready_for_approval' : 'needs_review',
                skill_id: basename(packageDir),
                sources: sealed,
                validation_issues: issues,
              },
              issues,
              package_path: packageDir,
            }
          }
          const report = auditImageSkill(packageDir, sources)
          await writeFile(join(packageDir, 'intake-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
          const ok = (report.validation_issues as unknown[]).length === 0
          return {
            ok,
            message: ok ? 'intake-report written (ready_for_approval)' : `intake-report written (needs_review, ${(report.validation_issues as unknown[]).length} issue(s))`,
            report,
            package_path: packageDir,
            issues: report.validation_issues,
          }
        }
        if (command === 'approve') {
          if (args.approved_by !== 'user') return { ok: false, message: 'approve 必须由用户明确批准（approved_by=user）' }
          if (!args.package_dir) return { ok: false, message: 'package_dir is required' }
          const packageDir = resolvePath(String(args.package_dir))
          if (isCodexFlowImagePackage(packageDir)) {
            // Codex_Flow 包无 intake-report 审核记录：批准由 publish（approved=true）审核门完成
            return { ok: false, message: 'Codex_Flow 包无 intake-report；批准通过 publish（approved=true）审核门完成' }
          }
          try {
            const report = approveImageIntakeReport(packageDir)
            await writeFile(join(packageDir, 'intake-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
            return { ok: true, message: 'intake-report approved by user', report, package_path: packageDir }
          } catch (error) {
            return { ok: false, message: String(error instanceof Error ? error.message : error) }
          }
        }
        if (command === 'validate') {
          if (!args.package_dir) return { ok: false, message: 'package_dir is required' }
          const packageDir = resolvePath(String(args.package_dir))
          if (isCodexFlowImagePackage(packageDir)) {
            // flow 模式：require_report=true 表示发布态（要求 intake-receipt 且 STALE_RECEIPT 绑定）
            const issues = validateCodexFlowImagePackage(packageDir, Boolean(args.require_report))
            return {
              ok: issues.length === 0,
              message: issues.length === 0 ? 'package valid (codex-flow image)' : `${issues.length} issue(s)`,
              issues,
              package_path: packageDir,
              package_sha256: flowPackageSha256(packageDir),
            }
          }
          const issues = validateImagePackage(packageDir, { requireReport: Boolean(args.require_report) })
          return {
            ok: issues.length === 0,
            message: issues.length === 0 ? 'package valid' : `${issues.length} issue(s)`,
            issues,
            package_path: packageDir,
            package_sha256: imagePackageSha256(packageDir),
          }
        }
        if (command === 'publish' || command === 'upgrade') {
          if (!args.package_dir) return { ok: false, message: 'package_dir is required' }
          const packageDir = resolvePath(String(args.package_dir))
          if (isCodexFlowImagePackage(packageDir)) {
            // Codex_Flow 图片包发布：flow 校验 + 审核卡（paid_points/package_hash）+ intake-receipt
            // + 原子入库（禁覆盖/备份回滚）+ flowMetaToRegistryShape 入注册库
            const issues = validateCodexFlowImagePackage(packageDir, false)
            if (issues.length > 0) return { ok: false, message: `validation failed (${issues.length} issue(s)); fix before publish`, issues }
            const shape = flowMetaToRegistryShape(packageDir)
            const name = String(shape.name)
            const version = String(args.version ?? shape.version)
            if (args.approved !== true) {
              let card: Record<string, unknown>
              try {
                card = buildFlowReviewCard(packageDir)
              } catch (error) {
                return { ok: false, message: String(error instanceof Error ? error.message : error) }
              }
              const sealed = flowSealedSources(packageDir, args, resolvePath)
              return {
                ok: false,
                message: 'publish requires explicit user approval (approved=true) after reviewing the checklist',
                checklist: {
                  skill_id: name,
                  display_name: String(card.display_name ?? ''),
                  primary_output: card.primary_output,
                  capabilities: card.capabilities,
                  paid_points: card.paid_points,
                  workflow_profile: card.workflow_profile,
                  source_hashes: sealed.length > 0 ? sealed.map((s: { name: string; sha256: string }) => ({ name: s.name, sha256: s.sha256.slice(0, 16) + '…' })) : null,
                  package_hash: String(card.package_hash ?? ''),
                  validation: `${issues.length} issue(s)`,
                  instruction: '请向用户展示以上审核项并获得明确确认后，以 approved=true 重新调用 publish/upgrade',
                },
              }
            }
            const sources = flowSealedSources(packageDir, args, resolvePath)
            if (sources.length === 0) return { ok: false, message: 'no sealed sources; run audit with sources first' }
            await mkdir(libRoot, { recursive: true })
            const staging = await mkdtemp(join(libRoot, '.stage-'))
            let moved = false
            try {
              const stagedPath = join(staging, name)
              await copyTree(packageDir, stagedPath)
              const receipt = buildFlowIntakeReceipt(stagedPath, sources, { version })
              await writeFile(join(stagedPath, 'intake-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8')
              const publishedIssues = validateCodexFlowImagePackage(stagedPath, true)
              if (publishedIssues.length > 0) {
                return { ok: false, message: `receipt validation failed: ${publishedIssues.join(', ')}`, issues: publishedIssues }
              }
              const destination = join(libRoot, name)
              if (command === 'publish') {
                if (existsSync(destination)) {
                  return { ok: false, message: `Refusing to overwrite published Skill: ${destination}（修订请走 upgrade）` }
                }
                await rename(stagedPath, destination)
                moved = true
              } else {
                const backup = join(libRoot, `${name}.upgrade-backup`)
                if (existsSync(backup)) return { ok: false, message: `Backup path already exists: ${backup}` }
                if (!existsSync(destination)) return { ok: false, message: `published Skill not found: ${destination}` }
                await rename(destination, backup)
                try {
                  await rename(stagedPath, destination)
                } catch (error) {
                  if (!existsSync(destination)) await rename(backup, destination)
                  throw error
                }
                await rm(backup, { recursive: true, force: true })
                moved = true
              }
              // 以正式库位置重算 registry shape，保证 flow.entry 指向目标目录
              const destShape = flowMetaToRegistryShape(destination)
              const record = registry.ingest({
                contract: validateContract({
                  name: String(destShape.name),
                  version,
                  description: String(destShape.description),
                  taxonomy: destShape.taxonomy,
                  flow: destShape.flow as any,
                }),
                routing: {
                  aliases: destShape.taxonomy,
                  negative_intents: Array.isArray(destShape.flow.exclude_intents) ? (destShape.flow.exclude_intents as string[]) : [],
                },
                packageRoot: destination,
                provenance: command === 'upgrade' ? 'image-skill-curator:upgrade (codex-flow)' : 'image-skill-curator:publish (codex-flow)',
              }, { force: command === 'upgrade' })
              registry.setStatus(record.name, record.version, 'published')
              return {
                ok: true,
                message: `${command === 'upgrade' ? 'upgraded' : 'published'} ${record.name}@${record.version} with intake receipt (codex-flow)`,
                skill: { id: record.id, name: record.name, version: record.version, status: record.status },
                receipt,
                package_path: destination,
              }
            } catch (error) {
              if (moved) {
                await rm(join(libRoot, name), { recursive: true, force: true }).catch(() => undefined)
              }
              return { ok: false, message: String(error instanceof Error ? error.message : error) }
            } finally {
              await rm(staging, { recursive: true, force: true }).catch(() => undefined)
            }
          }
          const report = JSON.parse(readFileSync(join(packageDir, 'intake-report.json'), 'utf8'))
          const skillId = String(report.skill_id ?? basename(packageDir))
          const sealedSources = Array.isArray(report.sources) ? report.sources.map((s: any) => ({ name: String(s.name), sha256: String(s.sha256) })) : []
          if (args.approved !== true) {
            const issues = validateImagePackage(packageDir, { requireReport: true })
            return {
              ok: false,
              message: 'publish requires explicit user approval (approved=true) after reviewing the checklist',
              checklist: {
                skill_id: skillId,
                display_name: String(report.display_name ?? ''),
                source_hashes: sealedSources.map((s: { name: string; sha256: string }) => ({ name: s.name, sha256: s.sha256.slice(0, 16) + '…' })),
                slots: (Array.isArray(report.reference_summary) ? report.reference_summary : []).map((item: any) => ({
                  id: item.id,
                  role: item.role,
                  scope: item.scope,
                  required: item.required,
                  min_count: item.min_count,
                  max_count: item.max_count,
                })),
                output_summary: report.output_summary,
                isolated_legacy_rules: '请人工核对源资料中是否含本机路径/凭据/provider/模型版本，已从契约隔离',
                validation: `${issues.length} issue(s)`,
                instruction: '请向用户展示以上审核项并获得明确确认后，以 approved=true 重新调用 publish/upgrade',
              },
            }
          }
          let sources = sealedSources
          if (Array.isArray(args.sources) && args.sources.length > 0) {
            sources = args.sources.map((p: string) => ({ name: basename(String(p)), sha256: imageFileSha256(resolvePath(String(p))) }))
          }
          if (sources.length === 0) return { ok: false, message: 'no sealed sources; run audit with sources first' }
          await mkdir(libRoot, { recursive: true })
          const staging = await mkdtemp(join(libRoot, '.stage-'))
          let moved = false
          try {
            const staged = stageImagePublish(packageDir, staging, sources)
            const stagedPath = staged.stagingPath
            const destination = join(libRoot, skillId)
            if (command === 'publish') {
              if (existsSync(destination)) {
                return { ok: false, message: `Refusing to overwrite published Skill: ${destination}（修订请走 upgrade）` }
              }
              await rename(stagedPath, destination)
              moved = true
            } else {
              const backup = join(libRoot, `${skillId}.upgrade-backup`)
              if (existsSync(backup)) return { ok: false, message: `Backup path already exists: ${backup}` }
              if (!existsSync(destination)) return { ok: false, message: `published Skill not found: ${destination}` }
              await rename(destination, backup)
              try {
                await rename(stagedPath, destination)
              } catch (error) {
                if (!existsSync(destination)) await rename(backup, destination)
                throw error
              }
              await rm(backup, { recursive: true, force: true })
              moved = true
            }
            const contract = JSON.parse(readFileSync(join(destination, 'contract.json'), 'utf8'))
            const routing = JSON.parse(readFileSync(join(destination, 'routing.json'), 'utf8'))
            const version = String(args.version ?? '1.0.0')
            const record = registry.ingest({
              contract: imageContractToRegistryContract(contract, routing, version),
              routing,
              packageRoot: destination,
              provenance: command === 'upgrade' ? 'image-skill-curator:upgrade' : 'image-skill-curator:publish',
            }, { force: command === 'upgrade' })
            registry.setStatus(record.name, record.version, 'published')
            return {
              ok: true,
              message: `${command === 'upgrade' ? 'upgraded' : 'published'} ${record.name}@${record.version} with intake receipt`,
              skill: { id: record.id, name: record.name, version: record.version, status: record.status },
              receipt: staged.receipt,
              package_path: destination,
            }
          } catch (error) {
            if (moved) {
              await rm(join(libRoot, skillId), { recursive: true, force: true }).catch(() => undefined)
            }
            return { ok: false, message: String(error instanceof Error ? error.message : error) }
          } finally {
            await rm(staging, { recursive: true, force: true }).catch(() => undefined)
          }
        }
        return { ok: false, message: `unknown command: ${command}` }
      } finally {
        registry.close()
      }
    },
  }))
}

export { Config, apply, inject, name }
