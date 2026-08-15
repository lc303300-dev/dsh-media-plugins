/**
 * Project Pipeline domain (Codex_CS rebuild, all-JS): explicit state
 * machine with material/prompt hash locking and a buildable submission
 * payload. Pure domain — no DSH imports; persistence is atomic JSON.
 *
 * State sequence (Codex_Wsstudio guide §3.3):
 *   awaiting_skill_confirmation → awaiting_video_settings →
 *   project_initialized → awaiting_image_stage_choice →
 *   collecting_user_materials | generating_images → final_images_ready →
 *   authoring_prompt → awaiting_prompt_confirmation →
 *   revision_requested → dt_revision → authoring_prompt (loop) →
 *   prompt_confirmed → generating_video → completed
 *
 * @module dsh-media-plugins/shared/project-core
 */

import { createHash } from 'node:crypto'

export type ProjectStatus =
  | 'awaiting_skill_confirmation'
  | 'awaiting_video_settings'
  | 'project_initialized'
  | 'awaiting_image_stage_choice'
  | 'collecting_user_materials'
  | 'generating_images'
  | 'final_images_ready'
  | 'authoring_prompt'
  | 'awaiting_prompt_confirmation'
  | 'revision_requested'
  | 'dt_revision'
  | 'prompt_confirmed'
  | 'generating_video'
  | 'completed'
  | 'cancelled'

export interface MaterialItem {
  slot: string
  path: string
  hash: string
  addedAt: string
}

export interface PromptVersion {
  version: number
  text: string
  hash: string
  source: 'skill_v1' | 'dt_revision' | 'user'
  createdAt: string
  confirmed: boolean
}

export interface ProjectState {
  projectId: string
  status: ProjectStatus
  skillName?: string
  ratio?: string
  duration?: number
  imageStage?: 'user_materials' | 'generating_images'
  materials: MaterialItem[]
  /** Hash of the material set locked at confirmation time. */
  lockedMaterialHashes?: Record<string, string>
  prompts: PromptVersion[]
  lockedPromptHash?: string
  submissionPayload?: Record<string, unknown>
  /** Constrained revision request emitted by the DT classifier (feedback → request). */
  revisionRequest?: Record<string, unknown>
  history: Array<{ at: string; from: ProjectStatus; to: ProjectStatus; note?: string }>
  createdAt: string
  updatedAt: string
}

export const VIDEO_RATIOS = ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'] as const

/** Allowed transitions (only the guide's arcs are legal). */
const TRANSITIONS: Readonly<Record<ProjectStatus, ReadonlyArray<ProjectStatus>>> = {
  awaiting_skill_confirmation: ['awaiting_video_settings', 'cancelled'],
  awaiting_video_settings: ['project_initialized', 'cancelled'],
  project_initialized: ['awaiting_image_stage_choice', 'cancelled'],
  awaiting_image_stage_choice: ['collecting_user_materials', 'generating_images', 'cancelled'],
  collecting_user_materials: ['final_images_ready', 'generating_images', 'cancelled'],
  generating_images: ['final_images_ready', 'collecting_user_materials', 'cancelled'],
  final_images_ready: ['authoring_prompt', 'cancelled'],
  authoring_prompt: ['awaiting_prompt_confirmation', 'revision_requested', 'cancelled'],
  awaiting_prompt_confirmation: ['prompt_confirmed', 'revision_requested', 'cancelled'],
  revision_requested: ['dt_revision', 'cancelled'],
  dt_revision: ['authoring_prompt', 'cancelled'],
  prompt_confirmed: ['generating_video', 'revision_requested', 'cancelled'],
  generating_video: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function createProject(projectId: string, skillName?: string): ProjectState {
  const now = new Date().toISOString()
  return {
    projectId,
    status: 'awaiting_skill_confirmation',
    skillName,
    materials: [],
    prompts: [],
    history: [{ at: now, from: 'awaiting_skill_confirmation', to: 'awaiting_skill_confirmation', note: 'created' }],
    createdAt: now,
    updatedAt: now,
  }
}

export function canTransition(state: ProjectStatus, to: ProjectStatus): boolean {
  return (TRANSITIONS[state] ?? []).includes(to)
}

export function transition(state: ProjectState, to: ProjectStatus, note?: string): ProjectState {
  if (!canTransition(state.status, to)) {
    throw new Error(`invalid project transition ${state.status} -> ${to} (project ${state.projectId})`)
  }
  const next: ProjectState = {
    ...state,
    status: to,
    updatedAt: new Date().toISOString(),
    history: [...state.history, { at: new Date().toISOString(), from: state.status, to, note }],
  }
  return next
}

export function validateVideoSettings(ratio: string, duration: number): void {
  if (!VIDEO_RATIOS.includes(ratio as any)) {
    throw new Error(`unsupported video ratio ${ratio}; supported: ${VIDEO_RATIOS.join(', ')}`)
  }
  if (!Number.isInteger(duration) || duration < 4 || duration > 30) {
    throw new Error(`duration must be an integer between 4 and 30 seconds, got ${duration}`)
  }
}

/**
 * Add a material to a slot; verifies the current stage allows collection
 * and enforces slot min/max from the skill contract when provided.
 */
export function addMaterial(
  state: ProjectState,
  slot: string,
  path: string,
  hash: string,
  contractSlots?: Array<{ id: string; min?: number; max?: number }>,
): ProjectState {
  if (state.status !== 'collecting_user_materials' && state.status !== 'generating_images') {
    throw new Error(`materials can only be added while collecting; current status ${state.status}`)
  }
  if (!slot || slot.trim().length === 0) throw new Error('material slot id is required')
  const slotDef = contractSlots?.find((s) => s.id === slot)
  const current = state.materials.filter((m) => m.slot === slot)
  if (slotDef?.max !== undefined && current.length >= slotDef.max) {
    throw new Error(`slot ${slot} already at max ${slotDef.max}`)
  }
  const item: MaterialItem = { slot, path, hash, addedAt: new Date().toISOString() }
  return { ...state, materials: [...state.materials, item], updatedAt: new Date().toISOString() }
}

/** Lock the material set at confirmation: snapshot slot->hash. */
export function lockMaterials(state: ProjectState): Record<string, string> {
  const locked: Record<string, string> = {}
  for (const m of state.materials) {
    locked[`${m.slot}:${m.path}`] = m.hash
  }
  return locked
}

/** Verify the locked material set still matches the current files (hashes). */
export function verifyMaterialsUnchanged(state: ProjectState, currentHashes: Record<string, string>): boolean {
  if (!state.lockedMaterialHashes) return false
  for (const [key, hash] of Object.entries(state.lockedMaterialHashes)) {
    if (currentHashes[key] !== hash) return false
  }
  return true
}

/** Add a prompt version (skill V1 or DT revision). */
export function addPrompt(state: ProjectState, text: string, source: PromptVersion['source']): ProjectState {
  const clean = (text ?? '').trim()
  if (clean.length === 0) throw new Error('prompt must not be empty')
  const nextVersion = state.prompts.length + 1
  const now = new Date().toISOString()
  const prompt: PromptVersion = {
    version: nextVersion,
    text: clean,
    hash: sha256(clean),
    source,
    createdAt: now,
    confirmed: false,
  }
  const next: ProjectState = {
    ...state,
    prompts: [...state.prompts, prompt],
    updatedAt: now,
  }
  // authoring a prompt moves back into authoring_prompt from dt_revision
  if (state.status === 'dt_revision' || state.status === 'final_images_ready' || state.status === 'revision_requested') {
    return transition(next, 'authoring_prompt', `prompt v${nextVersion} authored (${source})`)
  }
  if (state.status === 'authoring_prompt') return next
  throw new Error(`cannot author prompt in status ${state.status}`)
}

/** Confirm the current prompt: locks prompt hash and material hashes. */
export function confirmPrompt(state: ProjectState): ProjectState {
  const current = state.prompts[state.prompts.length - 1]
  if (!current) throw new Error('no prompt to confirm')
  const now = new Date().toISOString()
  let next: ProjectState = {
    ...state,
    prompts: state.prompts.map((p, i) => (i === state.prompts.length - 1 ? { ...p, confirmed: true } : p)),
    lockedPromptHash: current.hash,
    lockedMaterialHashes: lockMaterials(state),
    updatedAt: now,
  }
  // the review step (awaiting_prompt_confirmation) may be implicit in the UI
  if (next.status === 'authoring_prompt') {
    next = transition(next, 'awaiting_prompt_confirmation', 'prompt submitted for confirmation')
  }
  if (next.status !== 'awaiting_prompt_confirmation') {
    throw new Error(`cannot confirm prompt in status ${state.status}`)
  }
  return transition(next, 'prompt_confirmed', `prompt v${current.version} confirmed`)
}

/**
 * Build the standard submission payload; only from prompt_confirmed and
 * only when the locked material hashes still match the current files.
 */
export function buildSubmissionPayload(state: ProjectState, currentHashes: Record<string, string>): Record<string, unknown> {
  if (state.status !== 'prompt_confirmed') {
    throw new Error(`submission payload requires prompt_confirmed; current status ${state.status}`)
  }
  const prompt = state.prompts[state.prompts.length - 1]
  if (!prompt?.confirmed) throw new Error('prompt is not confirmed')
  if (prompt.hash !== state.lockedPromptHash) throw new Error('locked prompt hash mismatch')
  if (!verifyMaterialsUnchanged(state, currentHashes)) {
    throw new Error('material hashes changed since confirmation; re-confirm before submission')
  }
  return {
    project_id: state.projectId,
    skill_name: state.skillName,
    ratio: state.ratio,
    duration: state.duration,
    materials: state.materials.map((m) => ({ slot: m.slot, path: m.path, hash: m.hash })),
    prompt: prompt.text,
    prompt_hash: prompt.hash,
    prompt_version: prompt.version,
    locked_material_hashes: state.lockedMaterialHashes,
    confirmed_at: state.updatedAt,
  }
}
