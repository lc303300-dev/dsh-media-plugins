/**
 * Image Project Pipeline domain (Codex_IS project-pipeline rebuild, all-JS):
 * the contract-driven project state machine for governed image business
 * Skills — ratio/scene/candidate settings vs contract workload, per-scene
 * material slots from `references`, sha256 material snapshots, prompt
 * versioning with hash binding, confirmation, paid-batch confirmation, and
 * dry-run execution manifests. Pure domain — no fs, no DSH imports; the tool
 * layer persists state and handles directories/hashes.
 *
 * States (project.schema.json):
 *   awaiting_materials → materials_ready → awaiting_prompt_confirmation →
 *   (ready_for_generation | awaiting_paid_batch_confirmation →
 *    ready_for_batch_generation) → generating → completed /
 *   partially_completed / failed
 *
 * @module dsh-media-plugins/shared/image-project-core
 */

import { createHash } from 'node:crypto'
import { IMAGE_RATIOS } from './ratios.ts'

export { IMAGE_RATIOS }
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'])
export const IMAGE_PROJECT_STATES = [
  'awaiting_materials',
  'materials_ready',
  'awaiting_prompt_confirmation',
  'ready_for_generation',
  'awaiting_paid_batch_confirmation',
  'ready_for_batch_generation',
  'generating',
  'completed',
  'partially_completed',
  'failed',
]

export interface ImageReference {
  id: string
  role: string
  scope: 'project' | 'scene'
  required: boolean
  min_count: number
  max_count: number | null
  ordered: boolean
  observation_required: boolean
  send_to_generation: boolean
  description: string
}

export interface ImageSkillBinding {
  skill_id: string
  display_name: string
  package_root: string
  package_hash: string
  contract_hash: string
}

export interface ImageMaterialSlot {
  id: string
  role: string
  scope: string
  required: boolean
  min_count: number
  max_count: number | null
  send_to_generation: boolean
  description: string
  position: number
  scene_index: number | null
  source_dir: string
  final_dir: string
  files: string[]
}

export interface ImagePromptRecord {
  version: number
  author: string
  content: string
  length: number
  prompt_hash: string
  material_hash: string
  status: 'draft' | 'superseded' | 'confirmed'
  created_at: string
  confirmed_at?: string
}

export interface ImageProject {
  schema_version: 1
  project_id: string
  state: string
  state_history: Array<{ state: string; at: string }>
  created_at: string
  updated_at: string
  skill: ImageSkillBinding
  image_settings: { ratio: string; candidate_count: number; scene_count: number }
  material_slots: ImageMaterialSlot[]
  materials: Array<{ slot_id: string; slot_position: number; scene_index: number | null; send_to_generation: boolean; file_position: number; path: string; sha256: string }> | null
  material_hash: string | null
  prompts: ImagePromptRecord[]
  archived_prompts: ImagePromptRecord[]
  active_prompt_version: number | null
  confirmation: { prompt_version: number; prompt_hash: string; material_hash: string; confirmed_at: string } | null
  paid_batch_confirmation: { confirmed: true; at: string } | null
  generation: { status: string; manifest: Record<string, unknown>; started_at: string } | null
}

export function imageUtcNow(): string {
  return new Date().toISOString()
}

export function imageSha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** project_id may contain only letters, numbers, hyphens, and underscores. */
export function imageSafeId(value?: string): string {
  if (value && value.trim().length > 0) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('project_id may contain only letters, numbers, hyphens, and underscores')
    return value
  }
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const suffix = Math.random().toString(16).slice(2, 10)
  return `${stamp}-${suffix}`
}

function requireImageState(state: ImageProject, allowed: string[]): void {
  if (!allowed.includes(state.state)) throw new Error(`state ${state.state} does not allow this action`)
}

/** Validate settings against the selected Skill contract (create port). */
export function validateImageSettings(contract: Record<string, unknown>, options: { displayName: string; ratio: string; candidateCount: number; sceneCount: number }): void {
  if (String(contract.display_name) !== options.displayName) throw new Error('display_name does not match contract')
  const output = isObject(contract.output) ? contract.output : {}
  const supported = Array.isArray(output.supported_ratios) ? output.supported_ratios.map(String) : []
  if (!IMAGE_RATIOS.includes(options.ratio) || !supported.includes(options.ratio)) throw new Error('unsupported or unconfirmed image ratio')
  if (options.candidateCount < 1 || options.sceneCount < 1) throw new Error('candidate_count and scene_count must be positive')
  const workload = isObject(contract.workload) ? contract.workload : {}
  for (const [value, key] of [[options.sceneCount, 'scene_count'], [options.candidateCount, 'candidate_count_per_scene']] as const) {
    const bounds = isObject(workload[key]) ? workload[key] as Record<string, unknown> : {}
    const min = typeof bounds.min === 'number' ? bounds.min : 1
    const max = bounds.max === null ? null : typeof bounds.max === 'number' ? bounds.max : null
    if (value < min || (max !== null && value > max)) throw new Error(`${key} is outside the selected Skill contract`)
  }
  if (options.sceneCount * options.candidateCount > 1 && workload.batch_allowed !== true) throw new Error('the selected Skill does not allow batch workloads')
}

/** Build the initial project JSON (create port; directories are created by
 *  the tool layer from materialSlots dirs). */
export function createImageProject(options: {
  projectId?: string
  contract: Record<string, unknown>
  skill: ImageSkillBinding
  ratio: string
  candidateCount: number
  sceneCount: number
  materialsRoot: string
  promptsRoot: string
  executionRoot: string
  resultsRoot: string
  now?: string
}): ImageProject {
  const now = options.now ?? imageUtcNow()
  const identifier = imageSafeId(options.projectId)
  const references = Array.isArray(options.contract.references) ? (options.contract.references as Array<Record<string, unknown>>) : []
  const slots: ImageMaterialSlot[] = []
  for (const [position, reference] of references.entries()) {
    const scope = String(reference.scope ?? 'project')
    const sceneIndexes = scope === 'scene' ? Array.from({ length: options.sceneCount }, (_, index) => index + 1) : [null]
    for (const sceneIndex of sceneIndexes) {
      let base = joinPath(options.materialsRoot)
      if (sceneIndex !== null) base = joinPath(base, `scene_${String(sceneIndex).padStart(3, '0')}`)
      const sourceDir = joinPath(base, String(reference.id), 'source')
      const finalDir = joinPath(base, String(reference.id), 'final')
      slots.push({
        id: String(reference.id),
        role: String(reference.role ?? ''),
        scope,
        required: reference.required === true,
        min_count: typeof reference.min_count === 'number' ? reference.min_count : 0,
        max_count: reference.max_count === null ? null : typeof reference.max_count === 'number' ? reference.max_count : null,
        send_to_generation: reference.send_to_generation !== false,
        description: String(reference.description ?? ''),
        position,
        scene_index: sceneIndex,
        source_dir: sourceDir,
        final_dir: finalDir,
        files: [],
      })
    }
  }
  const initialState = slots.length > 0 ? 'awaiting_materials' : 'materials_ready'
  return {
    schema_version: 1,
    project_id: identifier,
    state: initialState,
    state_history: [
      { state: 'awaiting_skill_confirmation', at: now },
      { state: 'awaiting_ratio_and_count', at: now },
      { state: initialState, at: now },
    ],
    created_at: now,
    updated_at: now,
    skill: { ...options.skill },
    image_settings: { ratio: options.ratio, candidate_count: options.candidateCount, scene_count: options.sceneCount },
    material_slots: slots,
    materials: null,
    material_hash: null,
    prompts: [],
    archived_prompts: [],
    active_prompt_version: null,
    confirmation: null,
    paid_batch_confirmation: null,
    generation: null,
  }
}

/** Pure path join helper (avoids importing node:path in the pure domain). */
function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/').replace(/\/$/, '')
}

/** Build the canonical material snapshot (snapshot port). Takes per-slot
 *  final files (path + sha256) provided by the tool layer, validates counts
 *  against the contract, and returns the ordered list + material hash. */
export function imageMaterialSnapshot(project: ImageProject, finalFilesBySlot: Record<string, Array<{ path: string; sha256: string }>>): { materials: NonNullable<ImageProject['materials']>; materialHash: string } {
  const ordered: NonNullable<ImageProject['materials']> = []
  const sortedSlots = [...project.material_slots].sort((a, b) => (a.scene_index ?? 0) - (b.scene_index ?? 0) || a.position - b.position)
  for (const slot of sortedSlots) {
    const key = `${slot.id}@${slot.scene_index ?? 'project'}`
    const files = finalFilesBySlot[key] ?? []
    if (files.length < slot.min_count || (slot.max_count !== null && files.length > slot.max_count)) {
      throw new Error(`slot ${slot.id} contains ${files.length} image(s); allowed ${slot.min_count}..${slot.max_count === null ? '∞' : slot.max_count}`)
    }
    const filePaths = files.map((file) => file.path)
    const slotWithFiles = { ...slot, files: filePaths }
    const index = sortedSlots.indexOf(slot)
    project.material_slots[index] = slotWithFiles
    for (const [fileIndex, file] of files.entries()) {
      ordered.push({
        slot_id: slot.id,
        slot_position: slot.position,
        scene_index: slot.scene_index,
        send_to_generation: slot.send_to_generation,
        file_position: fileIndex,
        path: file.path,
        sha256: file.sha256,
      })
    }
  }
  // canonical form: json.dumps(sort_keys=True, separators=(",", ":")) port —
  // each item's keys sorted, compact separators, no whitespace stripping
  // (paths may contain spaces).
  const canonicalJson = JSON.stringify(
    ordered.map((item) => {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(item).sort()) out[key] = (item as unknown as Record<string, unknown>)[key]
      return out
    }),
  )
  return { materials: ordered, materialHash: imageSha256Text(canonicalJson) }
}

/** Lock the material set; a changed digest archives prompts and clears all
 *  confirmations (lock_materials port). */
export function lockImageMaterials(project: ImageProject, materials: NonNullable<ImageProject['materials']>, materialHash: string): ImageProject {
  requireImageState(project, ['awaiting_materials', 'materials_ready', 'awaiting_prompt_confirmation', 'ready_for_generation', 'awaiting_paid_batch_confirmation', 'ready_for_batch_generation'])
  const changed = project.material_hash !== null && project.material_hash !== materialHash
  const next: ImageProject = {
    ...project,
    materials,
    material_hash: materialHash,
    archived_prompts: changed ? [...project.archived_prompts, ...project.prompts] : project.archived_prompts,
    prompts: changed ? [] : project.prompts,
    active_prompt_version: changed ? null : project.active_prompt_version,
    confirmation: changed ? null : project.confirmation,
    paid_batch_confirmation: changed ? null : project.paid_batch_confirmation,
    state: 'materials_ready',
    updated_at: imageUtcNow(),
  }
  next.state_history = [...project.state_history, { state: 'materials_ready', at: next.updated_at }]
  return next
}

/** Add a prompt version (set_prompt port); every new version supersedes the
 *  previous one and clears confirmation. */
export function setImagePrompt(project: ImageProject, content: string, author: string): ImageProject {
  requireImageState(project, ['materials_ready', 'awaiting_prompt_confirmation'])
  const clean = String(content ?? '').trim()
  if (clean.length === 0) throw new Error('prompt must not be empty')
  if (!project.material_hash) throw new Error('materials must be locked before authoring a prompt')
  const now = imageUtcNow()
  const prompts = project.prompts.map((prompt) => ({ ...prompt, status: 'superseded' as const }))
  const version = prompts.length + 1
  const record: ImagePromptRecord = {
    version,
    author: author || 'business_skill',
    content: clean,
    length: clean.length,
    prompt_hash: imageSha256Text(clean),
    material_hash: project.material_hash,
    status: 'draft',
    created_at: now,
  }
  return {
    ...project,
    prompts: [...prompts, record],
    active_prompt_version: version,
    confirmation: null,
    paid_batch_confirmation: null,
    state: 'awaiting_prompt_confirmation',
    updated_at: now,
    state_history: [...project.state_history, { state: 'awaiting_prompt_confirmation', at: now }],
  }
}

/** Confirm the active prompt; verifies the material hash did not drift
 *  (confirm_prompt port). Single workload → ready_for_generation; otherwise
 *  awaiting_paid_batch_confirmation. */
export function confirmImagePrompt(project: ImageProject, currentMaterialHash: string): ImageProject {
  requireImageState(project, ['awaiting_prompt_confirmation'])
  const prompt = project.prompts[project.active_prompt_version! - 1]
  if (!prompt) throw new Error('no active prompt to confirm')
  if (currentMaterialHash !== project.material_hash || prompt.material_hash !== currentMaterialHash) throw new Error('materials changed after prompt authoring')
  const now = imageUtcNow()
  const confirmed = { ...prompt, status: 'confirmed' as const, confirmed_at: now }
  const batch = project.image_settings.candidate_count * project.image_settings.scene_count > 1
  const nextState = batch ? 'awaiting_paid_batch_confirmation' : 'ready_for_generation'
  return {
    ...project,
    prompts: project.prompts.map((item, index) => (index === project.active_prompt_version! - 1 ? confirmed : item)),
    confirmation: { prompt_version: confirmed.version, prompt_hash: confirmed.prompt_hash, material_hash: currentMaterialHash, confirmed_at: now },
    state: nextState,
    updated_at: now,
    state_history: [...project.state_history, { state: nextState, at: now }],
  }
}

/** Confirm the paid batch (confirm_paid_batch port). */
export function confirmImagePaidBatch(project: ImageProject): ImageProject {
  requireImageState(project, ['awaiting_paid_batch_confirmation'])
  const now = imageUtcNow()
  return {
    ...project,
    paid_batch_confirmation: { confirmed: true, at: now },
    state: 'ready_for_batch_generation',
    updated_at: now,
    state_history: [...project.state_history, { state: 'ready_for_batch_generation', at: now }],
  }
}

/** Build the execution manifest and move to generating (start_generation
 *  port; dry_run only validates and writes the manifest). */
export function startImageGeneration(project: ImageProject, dryRun: boolean, materials: NonNullable<ImageProject['materials']>): ImageProject {
  requireImageState(project, ['ready_for_generation', 'ready_for_batch_generation'])
  if (!project.confirmation) throw new Error('prompt is not confirmed')
  const prompt = project.prompts[project.active_prompt_version! - 1]
  if (!prompt) throw new Error('no active prompt')
  if (project.material_hash !== project.confirmation.material_hash || prompt.prompt_hash !== project.confirmation.prompt_hash) throw new Error('prompt or materials changed after confirmation')
  const total = project.image_settings.candidate_count * project.image_settings.scene_count
  const entry = total === 1 ? 'generate_image' : 'batch-image-generation'
  const sent = materials.filter((item) => item.send_to_generation)
  const grouped = Array.from({ length: project.image_settings.scene_count }, (_, index) => {
    const sceneIndex = index + 1
    return {
      scene_index: sceneIndex,
      reference_images: sent.filter((item) => item.scene_index === null || item.scene_index === sceneIndex).map((item) => item.path),
    }
  })
  const manifest: Record<string, unknown> = {
    dry_run: dryRun,
    entry,
    image_ratio: project.image_settings.ratio,
    reference_images_by_scene: grouped,
    prompt_version: prompt.version,
    prompt_hash: prompt.prompt_hash,
    material_hash: project.material_hash,
    scene_count: project.image_settings.scene_count,
    candidate_count: project.image_settings.candidate_count,
    automatic_retry: false,
    automatic_visual_ranking: false,
  }
  const now = imageUtcNow()
  return {
    ...project,
    generation: { status: dryRun ? 'dry_run_ready' : 'ready_for_external_submission', manifest, started_at: now },
    state: 'generating',
    updated_at: now,
    state_history: [...project.state_history, { state: 'generating', at: now }],
  }
}

/** Public view with Windows-clickable link targets (public port). */
export function imageProjectPublicView(project: ImageProject, projectRoot: string): Record<string, unknown> {
  const link = (path: string) => path.split('\\').join('/')
  return {
    project_id: project.project_id,
    state: project.state,
    project_dir: projectRoot,
    project_dir_link_target: link(projectRoot),
    material_directories: project.material_slots.map((slot) => ({
      id: slot.id,
      scope: slot.scope,
      scene_index: slot.scene_index,
      required: slot.required,
      source_dir: slot.source_dir,
      source_dir_link_target: link(slot.source_dir),
      final_dir: slot.final_dir,
      final_dir_link_target: link(slot.final_dir),
    })),
    image_settings: project.image_settings,
    active_prompt_version: project.active_prompt_version,
    generation: project.generation,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
