/**
 * Project Pipeline tool (Codex_CS rebuild): explicit project state machine
 * with material/prompt hash locking and submission payload building.
 * State persists as atomic JSON under the private runtime and survives
 * session restarts; out-of-order transitions are rejected.
 *
 * @module @deepseek-ai/dsh-tool-project
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readdir } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import {
  addMaterial,
  addPrompt,
  buildSubmissionPayload,
  confirmPrompt,
  createProject,
  transition,
  validateVideoSettings,
  type ProjectState,
} from './shared/project-core.ts'
import { SkillRegistry, type SlotContract } from './shared/registry-core.ts'
import { atomicWriteJson, readJsonSafe, resolvePrivateRoot, sha256File } from './shared/private-runtime.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-project'
export const inject = ['tools']

export interface Config {
  privateDir?: string
}

export const Config: z<Config> = z.object({
  privateDir: z.string().default(''),
})

type ResolvedConfig = Required<Config>

function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'project_pipeline',
      description:
        '项目管线状态机（Codex_CS project-pipeline 的 DSH 重建）：从确认业务 Skill 到生成最终 submission_payload 的显式生命周期。状态：awaiting_skill_confirmation → awaiting_video_settings → project_initialized → awaiting_image_stage_choice → collecting_user_materials|generating_images → final_images_ready → authoring_prompt → awaiting_prompt_confirmation → revision_requested → dt_revision（可循环）→ prompt_confirmed → generating_video → completed。确认提示词时锁定最终素材清单（sha256）与提示词哈希；build_payload 提交前重新校验素材哈希未变，防止未确认版本被生成。状态持久化在私有运行目录，跨会话可恢复。',
      parameters: {
        command: {
          type: 'string',
          enum: [
            'create', 'confirm_skill', 'set_settings', 'choose_image_stage',
            'add_material', 'finalize_materials', 'set_prompt', 'request_revision',
            'begin_revision', 'confirm_prompt', 'build_payload', 'start_video',
            'complete', 'get', 'list',
          ],
          required: true,
          description: '操作命令（见工具描述的状态机）。',
        },
        project_id: { type: 'string', description: '项目 id（create 缺省自动生成）。' },
        skill_name: { type: 'string', description: 'confirm_skill 用：已确认的业务 Skill 名。' },
        ratio: { type: 'string', description: 'set_settings 用：视频比例（1:1/3:4/16:9/4:3/9:16/21:9）。' },
        duration: { type: 'integer', description: 'set_settings 用：视频时长 4-30 秒。' },
        stage: { type: 'string', enum: ['user_materials', 'generating_images'], description: 'choose_image_stage 用：素材来源。' },
        slot: { type: 'string', description: 'add_material 用：素材槽 id（对应 Skill contract 的 slot）。' },
        path: { type: 'string', description: 'add_material 用：素材文件路径。' },
        text: { type: 'string', description: 'set_prompt 用：提示词文本。' },
        source: { type: 'string', enum: ['skill_v1', 'dt_revision', 'user'], description: 'set_prompt 用：提示词来源。' },
        revision_type: { type: 'string', enum: ['explicit_local', 'ambiguous_creative', 'structural_rewrite'], description: 'request_revision 用：修订类型。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string' },
            project: { type: 'object' },
            projects: { type: 'array' },
            payload: { type: 'object' },
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
        const projectsRoot = join(privateRoot, 'projects')

        const load = async (id: string): Promise<ProjectState | undefined> => readJsonSafe(join(projectsRoot, id, 'state.json'))
        const save = async (state: ProjectState): Promise<ProjectState> => {
          await atomicWriteJson(join(projectsRoot, state.projectId, 'state.json'), state)
          return state
        }

        const projectId = (args.project_id ?? '').toString().trim()
        if (command === 'list') {
          const ids = await readdir(projectsRoot).catch(() => [] as string[])
          const states: Array<{ projectId: string; status: string; skillName?: string; updatedAt?: string }> = []
          for (const id of ids) {
            const s = await load(id)
            if (s) states.push({ projectId: s.projectId, status: s.status, skillName: s.skillName, updatedAt: s.updatedAt })
          }
          return { ok: true, message: `${states.length} project(s)`, projects: states }
        }

        if (command === 'create') {
          const id = projectId || `proj-${Date.now().toString(36)}`
          let state = createProject(id, args.skill_name)
          if (args.ratio && args.duration !== undefined) {
            validateVideoSettings(args.ratio, Number(args.duration))
            state = transition(state, 'awaiting_video_settings', 'skill confirmed')
            state = transition(state, 'project_initialized', 'settings set')
            state = { ...state, ratio: args.ratio, duration: Number(args.duration) }
          }
          await save(state)
          return { ok: true, message: `project ${id} created (${state.status})`, project: state }
        }
        if (!projectId) return { ok: false, message: 'project_id is required' }
        const state = await load(projectId)
        if (!state) return { ok: false, message: `project not found: ${projectId}` }

        switch (command) {
          case 'confirm_skill': {
            if (!args.skill_name) return { ok: false, message: 'skill_name is required' }
            const next = { ...transition(state, 'awaiting_video_settings', `skill ${args.skill_name} confirmed`), skillName: args.skill_name }
            return { ok: true, message: `status -> ${next.status}`, project: await save(next) }
          }
          case 'set_settings': {
            validateVideoSettings(args.ratio, Number(args.duration))
            const next = { ...transition(state, 'project_initialized', 'settings set'), ratio: args.ratio, duration: Number(args.duration) }
            return { ok: true, message: `status -> ${next.status}`, project: await save(next) }
          }
          case 'choose_image_stage': {
            const stage = args.stage === 'generating_images' ? 'generating_images' : 'collecting_user_materials'
            const next = { ...transition(state, stage, `stage ${stage}`), imageStage: args.stage === 'generating_images' ? 'generating_images' : 'user_materials' }
            return { ok: true, message: `status -> ${next.status}`, project: await save(next) }
          }
          case 'add_material': {
            if (!args.slot || !args.path) return { ok: false, message: 'slot and path are required' }
            const materialPath = isAbsolute(args.path) ? args.path : join(workspaceRoot, args.path)
            const hash = await sha256File(materialPath)
            // slot limits come from the skill contract when available
            let slots: SlotContract[] | undefined
            if (state.skillName) {
              const registry = new SkillRegistry(join(privateRoot, 'registry', 'registry.db'))
              try {
                const rec = registry.get(state.skillName)
                if (rec?.contract?.slots) slots = rec.contract.slots
              } finally {
                registry.close()
              }
            }
            const next = addMaterial(state, args.slot, materialPath, hash, slots)
            return { ok: true, message: `material ${args.slot} added (${hash.slice(0, 12)}…)`, project: await save(next) }
          }
          case 'finalize_materials': {
            const next = transition(state, 'final_images_ready', 'materials finalized')
            return { ok: true, message: `status -> ${next.status} (${next.materials.length} material(s))`, project: await save(next) }
          }
          case 'set_prompt': {
            if (!args.text) return { ok: false, message: 'text is required' }
            const next = addPrompt(state, args.text, (args.source ?? 'user') as any)
            return { ok: true, message: `prompt v${next.prompts.length} added (${next.status})`, project: await save(next) }
          }
          case 'request_revision': {
            const type = args.revision_type ?? 'ambiguous_creative'
            const next = transition(state, 'revision_requested', `revision ${type}`)
            return { ok: true, message: `status -> revision_requested (${type})`, project: await save(next) }
          }
          case 'begin_revision': {
            const next = transition(state, 'dt_revision', 'dt revision begins')
            return { ok: true, message: `status -> dt_revision`, project: await save(next) }
          }
          case 'confirm_prompt': {
            const next = confirmPrompt(state)
            return { ok: true, message: `prompt v${next.prompts.length} confirmed (locked)`, project: await save(next) }
          }
          case 'build_payload': {
            // recompute current material hashes; refuse when changed since lock
            const current: Record<string, string> = {}
            for (const m of state.materials) {
              current[`${m.slot}:${m.path}`] = await sha256File(m.path)
            }
            const payload = buildSubmissionPayload(state, current)
            const next = { ...state, submissionPayload: payload }
            await save(next)
            return { ok: true, message: 'submission_payload built; hashes verified', payload, project: next }
          }
          case 'start_video': {
            const next = transition(state, 'generating_video', 'video generation starts')
            return { ok: true, message: `status -> generating_video`, project: await save(next) }
          }
          case 'complete': {
            const next = transition(state, 'completed', 'project completed')
            return { ok: true, message: 'project completed', project: await save(next) }
          }
          case 'get':
            return { ok: true, message: `project ${projectId} (${state.status})`, project: state }
          default:
            return { ok: false, message: `unknown command: ${command}` }
        }
      },
    }),
  )
}

export { apply }
