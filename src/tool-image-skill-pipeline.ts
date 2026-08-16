import {
  IMAGE_EXTENSIONS,
  confirmImagePaidBatch,
  confirmImagePrompt,
  createImageProject,
  imageMaterialSnapshot,
  imageProjectPublicView,
  imageSafeId,
  imageSha256Text,
  lockImageMaterials,
  setImagePrompt,
  startImageGeneration,
  validateImageSettings,
  type ImageProject,
} from './shared/image-project-core.ts'
import { imagePackageSha256, validateImageReceipt } from './shared/image-skill-core.ts'
import { atomicWriteJson, ensureDir, readJsonSafe, resolvePrivateRoot, sha256File } from './shared/private-runtime.ts'
import { SkillRegistry } from './shared/registry-core.ts'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { copyFile, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
const name = 'Ws_tool-image-skill-pipeline'
const inject = ['tools']
const Config = z.object({ privateDir: z.string().default('') })

/** Windows 本地可点击链接目标：绝对路径 + 正斜杠。 */
function linkTarget(path: string): string {
  return path.split('\\').join('/')
}

/** Key identifying a material slot instance (slot id + scene). */
function slotKey(id: string, sceneIndex: number | null): string {
  return `${id}@${sceneIndex ?? 'project'}`
}

function isImageFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

/** Resolve the published image Skill package from the registry and verify
 *  its receipt + package hash (verify_skill port). */
async function resolveSkill(registry: SkillRegistry, skillId: string, privateRoot: string): Promise<{ packageRoot: string; contract: Record<string, unknown>; packageHash: string; contractHash: string }> {
  const record = registry.get(skillId)
  if (!record?.packageRoot) throw new Error(`published Skill not found in registry: ${skillId}`)
  const packageRoot = record.packageRoot
  if (!existsSync(join(packageRoot, 'contract.json'))) throw new Error(`published Skill contract not found: ${join(packageRoot, 'contract.json')}`)
  const { receipt, issues } = validateImageReceipt(packageRoot, skillId)
  if (issues.length > 0 || !receipt) throw new Error(`published Skill receipt is missing or invalid: ${issues.join(', ')}`)
  const packageHash = imagePackageSha256(packageRoot)
  if (String(receipt.package_sha256) !== packageHash) throw new Error('published Skill package changed after publication receipt generation')
  const contractRaw = await readFile(join(packageRoot, 'contract.json'), 'utf8')
  return {
    packageRoot,
    contract: JSON.parse(contractRaw),
    packageHash,
    contractHash: imageSha256Text(contractRaw),
  }
}

function apply(ctx: any, config: any) {
  ctx.tools.register(defineTool({
    name: 'image_skill_pipeline',
    description: '图片业务 Skill 项目管线（Codex_IS project-pipeline 的 DSH 重建）：契约驱动、哈希锁定的图片项目状态机。create 校验已发布图片 Skill 的收据与包哈希、比例/场景数/候选数须落在 contract 的 workload 与 supported_ratios 内，按 references 声明逐场景生成素材槽目录（含可点击链接）；add_material 只接受 reference_policy.allowed_slot_ids 声明的槽（reject_uncontracted_images），并校验每场景参考图上限；lock_materials 计算最终素材 sha256 快照，素材变化会作废提示词与确认；set_prompt/confirm_prompt 锁定提示词哈希与素材哈希（变化即拒绝确认）；多场景或多候选在确认提示词后进入 awaiting_paid_batch_confirmation，须 confirm_paid_batch 付费批次确认；start_generation --dry-run 生成执行清单（单候选 generate_image / 多候选 batch-image-generation），不调用付费工具。状态持久化在私有运行目录，跨会话可恢复。',
    parameters: {
      command: {
        type: 'string',
        enum: ['create', 'add_material', 'lock_materials', 'set_prompt', 'confirm_prompt', 'confirm_paid_batch', 'start_generation', 'get', 'list'],
        required: true,
        description: '操作命令。',
      },
      project_id: {
        type: 'string',
        description: '项目 id（create 缺省自动生成；仅字母数字连字符下划线）。',
      },
      skill_id: {
        type: 'string',
        description: 'create 用：已发布图片业务 Skill 的 skill_id（先经 skill_registry search 并取得用户确认）。',
      },
      display_name: {
        type: 'string',
        description: 'create 用：正式名称，必须与 contract.display_name 一致。',
      },
      ratio: {
        type: 'string',
        description: 'create 用：用户确认的画幅比例，须在 contract.output.supported_ratios 内（21:9/16:9/3:2/4:3/1:1/3:4/2:3/9:16）。',
      },
      candidate_count: {
        type: 'integer',
        description: 'create 用：每个场景的候选数（≥1，须在 workload.candidate_count_per_scene 内）。',
      },
      scene_count: {
        type: 'integer',
        description: 'create 用：场景数（≥1，须在 workload.scene_count 内）。',
      },
      skill_confirmed: {
        type: 'boolean',
        description: 'create 用：用户已明确确认 Skill 正式名称；缺省拒绝。',
      },
      slot: {
        type: 'string',
        description: 'add_material 用：素材槽 id（必须属于 contract 声明的 allowed_slot_ids）。',
      },
      scene_index: {
        type: 'integer',
        description: 'add_material 用：场景序号（1..scene_count）；仅当槽 scope=scene 且多场景时需要。',
      },
      path: {
        type: 'string',
        description: 'add_material 用：用户素材文件路径（复制到槽的 source 目录，不覆盖原图）。',
      },
      use_source: {
        type: 'boolean',
        description: 'lock_materials 用：true 表示把 source 目录素材复制到 final 并锁定；false 用 final 目录已有结果。',
      },
      text: {
        type: 'string',
        description: 'set_prompt 用：提示词正文（记录版本、作者、长度与 sha256；正文仅存项目 prompts/ 目录）。',
      },
      author: {
        type: 'string',
        description: 'set_prompt 用：提示词作者（默认 business_skill）。',
      },
      dry_run: {
        type: 'boolean',
        description: 'start_generation 用：仅校验状态并写入执行清单，不调用任何付费工具。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string' },
          project: { type: 'object', additionalProperties: true },
          projects: { type: 'array' },
          manifest: { type: 'object', additionalProperties: true },
          material_hash: { type: 'string' },
          prompts: { type: 'array' },
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
      const projectsRoot = join(privateRoot, 'image-projects')
      const load = async (id: string): Promise<ImageProject | undefined> => readJsonSafe(join(projectsRoot, id, 'project.json'))
      const save = async (project: ImageProject) => {
        await atomicWriteJson(join(projectsRoot, project.project_id, 'project.json'), project)
        return project
      }
      const loadOrError = async (id: string): Promise<ImageProject> => {
        const state = await load(id)
        if (!state) throw new Error(`project not found: ${id}`)
        return state
      }
      const projectId = (args.project_id ?? '').toString().trim()

      if (command === 'list') {
        const ids = await readdir(projectsRoot).catch(() => [] as string[])
        const projects = []
        for (const id of ids) {
          const state = await load(id)
          if (state) projects.push({
            projectId: state.project_id,
            state: state.state,
            skill_id: state.skill.skill_id,
            updatedAt: state.updated_at,
          })
        }
        return { ok: true, message: `${projects.length} image project(s)`, projects }
      }

      if (command === 'create') {
        if (args.skill_confirmed !== true) return { ok: false, message: 'Skill name must be explicitly confirmed (skill_confirmed=true)' }
        const skillId = String(args.skill_id ?? '')
        const displayName = String(args.display_name ?? '')
        const ratio = String(args.ratio ?? '')
        const candidateCount = Number(args.candidate_count)
        const sceneCount = Number(args.scene_count)
        if (!skillId) return { ok: false, message: 'skill_id is required' }
        if (!Number.isInteger(candidateCount) || candidateCount < 1 || !Number.isInteger(sceneCount) || sceneCount < 1) return { ok: false, message: 'candidate_count and scene_count must be positive integers' }
        const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
        try {
          const skill = await resolveSkill(registry, skillId, privateRoot)
          validateImageSettings(skill.contract, { displayName, ratio, candidateCount, sceneCount })
          const identifier = imageSafeId(projectId || undefined)
          const root = join(projectsRoot, identifier)
          if (existsSync(root)) return { ok: false, message: `project already exists: ${root}` }
          const project = createImageProject({
            projectId: identifier,
            contract: skill.contract,
            skill: {
              skill_id: skillId,
              display_name: displayName,
              package_root: skill.packageRoot,
              package_hash: skill.packageHash,
              contract_hash: skill.contractHash,
            },
            ratio,
            candidateCount,
            sceneCount,
            materialsRoot: join(root, 'materials'),
            promptsRoot: join(root, 'prompts'),
            executionRoot: join(root, 'execution'),
            resultsRoot: join(root, 'results'),
          })
          for (const slot of project.material_slots) {
            await ensureDir(slot.source_dir)
            await ensureDir(slot.final_dir)
          }
          await ensureDir(join(root, 'prompts'))
          await ensureDir(join(root, 'execution'))
          await ensureDir(join(root, 'results', 'images'))
          await ensureDir(join(root, 'results', 'review'))
          await save(project)
          return {
            ok: true,
            message: `project ${identifier} created (${project.state})`,
            project: imageProjectPublicView(project, root),
          }
        } catch (error) {
          return { ok: false, message: String(error instanceof Error ? error.message : error) }
        } finally {
          registry.close()
        }
      }

      if (!projectId) return { ok: false, message: 'project_id is required' }

      try {
        const project = await loadOrError(projectId)
        const root = join(projectsRoot, projectId)

        if (command === 'get') {
          return { ok: true, message: `project ${projectId} (${project.state})`, project: imageProjectPublicView(project, root) }
        }

        if (command === 'add_material') {
          const slotId = String(args.slot ?? '')
          const path = String(args.path ?? '')
          if (!slotId || !path) return { ok: false, message: 'slot and path are required' }
          const sourcePath = isAbsolute(path) ? path : join(workspaceRoot, path)
          const st = await stat(sourcePath).catch(() => null)
          if (!st?.isFile()) return { ok: false, message: `material file not found: ${sourcePath}` }
          const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
          try {
            const skill = await resolveSkill(registry, project.skill.skill_id, privateRoot)
            const references = Array.isArray(skill.contract.references) ? skill.contract.references as Array<Record<string, unknown>> : []
            const policy = (skill.contract.reference_policy ?? {}) as Record<string, unknown>
            const allowed = Array.isArray(policy.allowed_slot_ids) ? policy.allowed_slot_ids.map(String) : []
            if (!allowed.includes(slotId)) return { ok: false, message: `slot ${slotId} is not declared in the Skill contract (reject_uncontracted_images)` }
            const reference = references.find((item) => String(item.id) === slotId)
            const scope = String(reference?.scope ?? 'project')
            const matches = project.material_slots.filter((slot) => slot.id === slotId)
            let target: (typeof project.material_slots)[number] | undefined
            if (scope === 'project' || matches.length === 1) {
              target = matches.find((slot) => slot.scene_index === null) ?? matches[0]
            } else {
              const sceneIndex = Number(args.scene_index)
              if (!Number.isInteger(sceneIndex) || sceneIndex < 1 || sceneIndex > project.image_settings.scene_count) return { ok: false, message: `scene_index must be an integer 1..${project.image_settings.scene_count} for scene-scoped slot ${slotId}` }
              target = matches.find((slot) => slot.scene_index === sceneIndex)
            }
            if (!target) return { ok: false, message: `no material slot for ${slotId} in this project` }
            const maxPerScene = policy.maximum_reference_images_per_scene
            const existing = await readdir(target.source_dir).catch(() => [] as string[])
            const existingImages = existing.filter((item) => isImageFile(item)).length
            if (typeof maxPerScene === 'number' && existingImages >= maxPerScene) return { ok: false, message: `scene already at maximum_reference_images_per_scene (${maxPerScene})` }
            const fileName = sourcePath.split(/[\\/]/).pop() ?? 'material'
            const destination = join(target.source_dir, fileName)
            if (existsSync(destination)) return { ok: false, message: `a file with this name already exists in the slot: ${destination}` }
            await copyFile(sourcePath, destination)
            return {
              ok: true,
              message: `material added to ${slotId}（scene ${target.scene_index ?? 'project'}）: ${linkTarget(destination)}`,
              project: imageProjectPublicView(project, root),
            }
          } finally {
            registry.close()
          }
        }

        if (command === 'lock_materials') {
          const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
          try {
            const skill = await resolveSkill(registry, project.skill.skill_id, privateRoot)
            void skill
            if (args.use_source === true) {
              for (const slot of project.material_slots) {
                const sources = (await readdir(slot.source_dir).catch(() => [] as string[])).filter((item) => isImageFile(item))
                for (const file of sources) {
                  const from = join(slot.source_dir, file)
                  const to = join(slot.final_dir, file)
                  const sourceHash = await sha256File(from)
                  if (existsSync(to) && (await sha256File(to)) !== sourceHash) throw new Error(`refusing to overwrite different final image: ${to}`)
                  if (!existsSync(to)) await copyFile(from, to)
                }
              }
            }
            const finalFilesBySlot: Record<string, Array<{ path: string; sha256: string }>> = {}
            for (const slot of project.material_slots) {
              const files = (await readdir(slot.final_dir).catch(() => [] as string[])).filter((item) => isImageFile(item))
              const key = slotKey(slot.id, slot.scene_index)
              finalFilesBySlot[key] = []
              for (const file of files) {
                const path = join(slot.final_dir, file)
                finalFilesBySlot[key].push({ path, sha256: await sha256File(path) })
              }
            }
            const { materials, materialHash } = imageMaterialSnapshot(project, finalFilesBySlot)
            const next = lockImageMaterials(project, materials, materialHash)
            await save(next)
            return {
              ok: true,
              message: `materials locked (${materials.length} image(s), hash ${materialHash.slice(0, 12)}…)`,
              project: imageProjectPublicView(next, root),
              material_hash: materialHash,
            }
          } finally {
            registry.close()
          }
        }

        if (command === 'set_prompt') {
          const text = String(args.text ?? '')
          if (!text.trim()) return { ok: false, message: 'text is required' }
          const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
          try {
            await resolveSkill(registry, project.skill.skill_id, privateRoot)
            const next = setImagePrompt(project, text, String(args.author ?? 'business_skill'))
            const prompt = next.prompts[next.prompts.length - 1]
            await atomicWriteJson(join(root, 'prompts', `v${prompt.version}.json`), prompt)
            await save(next)
            return {
              ok: true,
              message: `prompt v${prompt.version} added (${next.state})`,
              project: imageProjectPublicView(next, root),
            }
          } finally {
            registry.close()
          }
        }

        if (command === 'confirm_prompt') {
          const finalFilesBySlot: Record<string, Array<{ path: string; sha256: string }>> = {}
          for (const slot of project.material_slots) {
            const files = (await readdir(slot.final_dir).catch(() => [] as string[])).filter((item) => isImageFile(item))
            const key = slotKey(slot.id, slot.scene_index)
            finalFilesBySlot[key] = []
            for (const file of files) finalFilesBySlot[key].push({ path: join(slot.final_dir, file), sha256: await sha256File(join(slot.final_dir, file)) })
          }
          const { materialHash } = imageMaterialSnapshot(project, finalFilesBySlot)
          const next = confirmImagePrompt(project, materialHash)
          const prompt = next.prompts[next.prompts.length - 1]
          await writeFile(join(root, 'prompts', 'confirmed.json'), JSON.stringify(prompt, null, 2) + '\n', 'utf8')
          await save(next)
          return {
            ok: true,
            message: `prompt v${prompt.version} confirmed (${next.state})`,
            project: imageProjectPublicView(next, root),
          }
        }

        if (command === 'confirm_paid_batch') {
          const next = confirmImagePaidBatch(project)
          await save(next)
          return {
            ok: true,
            message: `paid batch confirmed (${next.state})`,
            project: imageProjectPublicView(next, root),
          }
        }

        if (command === 'start_generation') {
          const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
          try {
            await resolveSkill(registry, project.skill.skill_id, privateRoot)
            const finalFilesBySlot: Record<string, Array<{ path: string; sha256: string }>> = {}
            for (const slot of project.material_slots) {
              const files = (await readdir(slot.final_dir).catch(() => [] as string[])).filter((item) => isImageFile(item))
              const key = slotKey(slot.id, slot.scene_index)
              finalFilesBySlot[key] = []
              for (const file of files) finalFilesBySlot[key].push({ path: join(slot.final_dir, file), sha256: await sha256File(join(slot.final_dir, file)) })
            }
            const { materials, materialHash } = imageMaterialSnapshot(project, finalFilesBySlot)
            const next = startImageGeneration(project, args.dry_run === true, materials)
            void materialHash
            await writeFile(join(root, 'execution', 'manifest.json'), JSON.stringify(next.generation?.manifest ?? {}, null, 2) + '\n', 'utf8')
            await save(next)
            return {
              ok: true,
              message: args.dry_run === true ? 'dry-run manifest written（未调用付费工具）' : `generation started: ${String(next.generation?.manifest?.entry)}`,
              project: imageProjectPublicView(next, root),
              manifest: next.generation?.manifest,
            }
          } finally {
            registry.close()
          }
        }

        return { ok: false, message: `unknown command: ${command}` }
      } catch (error) {
        return { ok: false, message: String(error instanceof Error ? error.message : error) }
      }
    },
  }))
}

export { Config, apply, inject, name }
