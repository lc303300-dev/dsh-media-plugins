import {
  IMAGE_SKILL_ID_PATTERN,
  approveImageIntakeReport,
  auditImageSkill,
  imageContractToRegistryContract,
  imageCoreSha256,
  imageFileSha256,
  imagePackageSha256,
  scaffoldImageSkill,
  stageImagePublish,
  utcNow,
  validateImagePackage,
  validateImageReceipt,
} from './shared/image-skill-core.ts'
import { resolvePrivateRoot } from './shared/private-runtime.ts'
import { SkillRegistry } from './shared/registry-core.ts'
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

function apply(ctx: any, config: any) {
  ctx.tools.register(defineTool({
    name: 'image_skill_curator',
    description: '图片业务 Skill 录入治理（Codex_IS image-skill-curator 的 DSH 重建）：把用户上传的图片业务 Skill 资料整理为可审计、可验证、可发布的受治理图片业务 Skill 包。scaffold 用 image-skill-template 生成骨架（contract.json/routing.json/SKILL.md/agents/references）；audit 生成 intake-report.json（validator 2.0.0：契约/路由/收据 schema、反泛化与反污染扫描、来源哈希）；approve 由用户明确批准（approved_by=user）；validate 复验；publish 原子发布到图片 Skill 库并重建注册表（禁覆盖）；upgrade 原子升级已发布包（备份+回滚）；seed_library 把插件自带的正式图片 Skill 库同步进私有库并注册。全程 provider-neutral，不选择模型、不提交媒体。',
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
          const template = join(pluginRoot(), 'refs', 'image-skill-template')
          if (!existsSync(join(template, 'contract.json'))) return { ok: false, message: `image-skill-template not found: ${template}` }
          try {
            const destination = scaffoldImageSkill(template, skillId, outputRoot, args.display_name ? String(args.display_name) : undefined)
            return { ok: true, message: `scaffolded: ${destination}`, package_path: destination }
          } catch (error) {
            return { ok: false, message: String(error instanceof Error ? error.message : error) }
          }
        }
        if (command === 'audit') {
          if (!args.package_dir) return { ok: false, message: 'package_dir is required' }
          const packageDir = resolvePath(String(args.package_dir))
          const sources = Array.isArray(args.sources) && args.sources.length > 0 ? args.sources.map((p: string) => resolvePath(String(p))) : []
          if (sources.length === 0) return { ok: false, message: 'audit requires at least one source path' }
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
