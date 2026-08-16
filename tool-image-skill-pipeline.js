import { t as SkillRegistry } from "./registry-core.js";
import { a as ensureDir, c as readJsonSafe, d as resolvePrivateRoot, f as sha256File, i as atomicWriteJson } from "./private-runtime.js";
import { o as imagePackageSha256, u as validateImageReceipt } from "./image-skill-core.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
//#region src/shared/image-project-core.ts
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
const IMAGE_RATIOS = [
	"21:9",
	"16:9",
	"3:2",
	"4:3",
	"1:1",
	"3:4",
	"2:3",
	"9:16"
];
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
	".jpg",
	".jpeg",
	".png",
	".webp",
	".bmp",
	".tif",
	".tiff"
]);
function imageUtcNow() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function imageSha256Text(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
/** project_id may contain only letters, numbers, hyphens, and underscores. */
function imageSafeId(value) {
	if (value && value.trim().length > 0) {
		if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("project_id may contain only letters, numbers, hyphens, and underscores");
		return value;
	}
	return `${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${Math.random().toString(16).slice(2, 10)}`;
}
function requireImageState(state, allowed) {
	if (!allowed.includes(state.state)) throw new Error(`state ${state.state} does not allow this action`);
}
/** Validate settings against the selected Skill contract (create port). */
function validateImageSettings(contract, options) {
	if (String(contract.display_name) !== options.displayName) throw new Error("display_name does not match contract");
	const output = isObject(contract.output) ? contract.output : {};
	const supported = Array.isArray(output.supported_ratios) ? output.supported_ratios.map(String) : [];
	if (!IMAGE_RATIOS.includes(options.ratio) || !supported.includes(options.ratio)) throw new Error("unsupported or unconfirmed image ratio");
	if (options.candidateCount < 1 || options.sceneCount < 1) throw new Error("candidate_count and scene_count must be positive");
	const workload = isObject(contract.workload) ? contract.workload : {};
	for (const [value, key] of [[options.sceneCount, "scene_count"], [options.candidateCount, "candidate_count_per_scene"]]) {
		const bounds = isObject(workload[key]) ? workload[key] : {};
		const min = typeof bounds.min === "number" ? bounds.min : 1;
		const max = bounds.max === null ? null : typeof bounds.max === "number" ? bounds.max : null;
		if (value < min || max !== null && value > max) throw new Error(`${key} is outside the selected Skill contract`);
	}
	if (options.sceneCount * options.candidateCount > 1 && workload.batch_allowed !== true) throw new Error("the selected Skill does not allow batch workloads");
}
/** Build the initial project JSON (create port; directories are created by
*  the tool layer from materialSlots dirs). */
function createImageProject(options) {
	const now = options.now ?? imageUtcNow();
	const identifier = imageSafeId(options.projectId);
	const references = Array.isArray(options.contract.references) ? options.contract.references : [];
	const slots = [];
	for (const [position, reference] of references.entries()) {
		const scope = String(reference.scope ?? "project");
		const sceneIndexes = scope === "scene" ? Array.from({ length: options.sceneCount }, (_, index) => index + 1) : [null];
		for (const sceneIndex of sceneIndexes) {
			let base = joinPath(options.materialsRoot);
			if (sceneIndex !== null) base = joinPath(base, `scene_${String(sceneIndex).padStart(3, "0")}`);
			const sourceDir = joinPath(base, String(reference.id), "source");
			const finalDir = joinPath(base, String(reference.id), "final");
			slots.push({
				id: String(reference.id),
				role: String(reference.role ?? ""),
				scope,
				required: reference.required === true,
				min_count: typeof reference.min_count === "number" ? reference.min_count : 0,
				max_count: reference.max_count === null ? null : typeof reference.max_count === "number" ? reference.max_count : null,
				send_to_generation: reference.send_to_generation !== false,
				description: String(reference.description ?? ""),
				position,
				scene_index: sceneIndex,
				source_dir: sourceDir,
				final_dir: finalDir,
				files: []
			});
		}
	}
	const initialState = slots.length > 0 ? "awaiting_materials" : "materials_ready";
	return {
		schema_version: 1,
		project_id: identifier,
		state: initialState,
		state_history: [
			{
				state: "awaiting_skill_confirmation",
				at: now
			},
			{
				state: "awaiting_ratio_and_count",
				at: now
			},
			{
				state: initialState,
				at: now
			}
		],
		created_at: now,
		updated_at: now,
		skill: { ...options.skill },
		image_settings: {
			ratio: options.ratio,
			candidate_count: options.candidateCount,
			scene_count: options.sceneCount
		},
		material_slots: slots,
		materials: null,
		material_hash: null,
		prompts: [],
		archived_prompts: [],
		active_prompt_version: null,
		confirmation: null,
		paid_batch_confirmation: null,
		generation: null
	};
}
/** Pure path join helper (avoids importing node:path in the pure domain). */
function joinPath(...parts) {
	return parts.join("/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}
/** Build the canonical material snapshot (snapshot port). Takes per-slot
*  final files (path + sha256) provided by the tool layer, validates counts
*  against the contract, and returns the ordered list + material hash. */
function imageMaterialSnapshot(project, finalFilesBySlot) {
	const ordered = [];
	const sortedSlots = [...project.material_slots].sort((a, b) => (a.scene_index ?? 0) - (b.scene_index ?? 0) || a.position - b.position);
	for (const slot of sortedSlots) {
		const files = finalFilesBySlot[`${slot.id}@${slot.scene_index ?? "project"}`] ?? [];
		if (files.length < slot.min_count || slot.max_count !== null && files.length > slot.max_count) throw new Error(`slot ${slot.id} contains ${files.length} image(s); allowed ${slot.min_count}..${slot.max_count === null ? "∞" : slot.max_count}`);
		const filePaths = files.map((file) => file.path);
		const slotWithFiles = {
			...slot,
			files: filePaths
		};
		const index = sortedSlots.indexOf(slot);
		project.material_slots[index] = slotWithFiles;
		for (const [fileIndex, file] of files.entries()) ordered.push({
			slot_id: slot.id,
			slot_position: slot.position,
			scene_index: slot.scene_index,
			send_to_generation: slot.send_to_generation,
			file_position: fileIndex,
			path: file.path,
			sha256: file.sha256
		});
	}
	return {
		materials: ordered,
		materialHash: imageSha256Text(JSON.stringify(ordered.map((item) => {
			const out = {};
			for (const key of Object.keys(item).sort()) out[key] = item[key];
			return out;
		})))
	};
}
/** Lock the material set; a changed digest archives prompts and clears all
*  confirmations (lock_materials port). */
function lockImageMaterials(project, materials, materialHash) {
	requireImageState(project, [
		"awaiting_materials",
		"materials_ready",
		"awaiting_prompt_confirmation",
		"ready_for_generation",
		"awaiting_paid_batch_confirmation",
		"ready_for_batch_generation"
	]);
	const changed = project.material_hash !== null && project.material_hash !== materialHash;
	const next = {
		...project,
		materials,
		material_hash: materialHash,
		archived_prompts: changed ? [...project.archived_prompts, ...project.prompts] : project.archived_prompts,
		prompts: changed ? [] : project.prompts,
		active_prompt_version: changed ? null : project.active_prompt_version,
		confirmation: changed ? null : project.confirmation,
		paid_batch_confirmation: changed ? null : project.paid_batch_confirmation,
		state: "materials_ready",
		updated_at: imageUtcNow()
	};
	next.state_history = [...project.state_history, {
		state: "materials_ready",
		at: next.updated_at
	}];
	return next;
}
/** Add a prompt version (set_prompt port); every new version supersedes the
*  previous one and clears confirmation. */
function setImagePrompt(project, content, author) {
	requireImageState(project, ["materials_ready", "awaiting_prompt_confirmation"]);
	const clean = String(content ?? "").trim();
	if (clean.length === 0) throw new Error("prompt must not be empty");
	if (!project.material_hash) throw new Error("materials must be locked before authoring a prompt");
	const now = imageUtcNow();
	const prompts = project.prompts.map((prompt) => ({
		...prompt,
		status: "superseded"
	}));
	const version = prompts.length + 1;
	const record = {
		version,
		author: author || "business_skill",
		content: clean,
		length: clean.length,
		prompt_hash: imageSha256Text(clean),
		material_hash: project.material_hash,
		status: "draft",
		created_at: now
	};
	return {
		...project,
		prompts: [...prompts, record],
		active_prompt_version: version,
		confirmation: null,
		paid_batch_confirmation: null,
		state: "awaiting_prompt_confirmation",
		updated_at: now,
		state_history: [...project.state_history, {
			state: "awaiting_prompt_confirmation",
			at: now
		}]
	};
}
/** Confirm the active prompt; verifies the material hash did not drift
*  (confirm_prompt port). Single workload → ready_for_generation; otherwise
*  awaiting_paid_batch_confirmation. */
function confirmImagePrompt(project, currentMaterialHash) {
	requireImageState(project, ["awaiting_prompt_confirmation"]);
	const prompt = project.prompts[project.active_prompt_version - 1];
	if (!prompt) throw new Error("no active prompt to confirm");
	if (currentMaterialHash !== project.material_hash || prompt.material_hash !== currentMaterialHash) throw new Error("materials changed after prompt authoring");
	const now = imageUtcNow();
	const confirmed = {
		...prompt,
		status: "confirmed",
		confirmed_at: now
	};
	const nextState = project.image_settings.candidate_count * project.image_settings.scene_count > 1 ? "awaiting_paid_batch_confirmation" : "ready_for_generation";
	return {
		...project,
		prompts: project.prompts.map((item, index) => index === project.active_prompt_version - 1 ? confirmed : item),
		confirmation: {
			prompt_version: confirmed.version,
			prompt_hash: confirmed.prompt_hash,
			material_hash: currentMaterialHash,
			confirmed_at: now
		},
		state: nextState,
		updated_at: now,
		state_history: [...project.state_history, {
			state: nextState,
			at: now
		}]
	};
}
/** Confirm the paid batch (confirm_paid_batch port). */
function confirmImagePaidBatch(project) {
	requireImageState(project, ["awaiting_paid_batch_confirmation"]);
	const now = imageUtcNow();
	return {
		...project,
		paid_batch_confirmation: {
			confirmed: true,
			at: now
		},
		state: "ready_for_batch_generation",
		updated_at: now,
		state_history: [...project.state_history, {
			state: "ready_for_batch_generation",
			at: now
		}]
	};
}
/** Build the execution manifest and move to generating (start_generation
*  port; dry_run only validates and writes the manifest). */
function startImageGeneration(project, dryRun, materials) {
	requireImageState(project, ["ready_for_generation", "ready_for_batch_generation"]);
	if (!project.confirmation) throw new Error("prompt is not confirmed");
	const prompt = project.prompts[project.active_prompt_version - 1];
	if (!prompt) throw new Error("no active prompt");
	if (project.material_hash !== project.confirmation.material_hash || prompt.prompt_hash !== project.confirmation.prompt_hash) throw new Error("prompt or materials changed after confirmation");
	const entry = project.image_settings.candidate_count * project.image_settings.scene_count === 1 ? "generate_image" : "batch-image-generation";
	const sent = materials.filter((item) => item.send_to_generation);
	const grouped = Array.from({ length: project.image_settings.scene_count }, (_, index) => {
		const sceneIndex = index + 1;
		return {
			scene_index: sceneIndex,
			reference_images: sent.filter((item) => item.scene_index === null || item.scene_index === sceneIndex).map((item) => item.path)
		};
	});
	const manifest = {
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
		automatic_visual_ranking: false
	};
	const now = imageUtcNow();
	return {
		...project,
		generation: {
			status: dryRun ? "dry_run_ready" : "ready_for_external_submission",
			manifest,
			started_at: now
		},
		state: "generating",
		updated_at: now,
		state_history: [...project.state_history, {
			state: "generating",
			at: now
		}]
	};
}
/** Public view with Windows-clickable link targets (public port). */
function imageProjectPublicView(project, projectRoot) {
	const link = (path) => path.split("\\").join("/");
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
			final_dir_link_target: link(slot.final_dir)
		})),
		image_settings: project.image_settings,
		active_prompt_version: project.active_prompt_version,
		generation: project.generation
	};
}
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region src/tool-image-skill-pipeline.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-image-skill-pipeline";
const inject = ["tools"];
const Config = z.object({ privateDir: z.string().default("") });
/** Windows 本地可点击链接目标：绝对路径 + 正斜杠。 */
function linkTarget(path) {
	return path.split("\\").join("/");
}
/** Key identifying a material slot instance (slot id + scene). */
function slotKey(id, sceneIndex) {
	return `${id}@${sceneIndex ?? "project"}`;
}
function isImageFile(path) {
	const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
	return IMAGE_EXTENSIONS.has(ext);
}
/** Resolve the published image Skill package from the registry and verify
*  its receipt + package hash (verify_skill port). */
async function resolveSkill(registry, skillId, privateRoot) {
	const record = registry.get(skillId);
	if (!record?.packageRoot) throw new Error(`published Skill not found in registry: ${skillId}`);
	const packageRoot = record.packageRoot;
	if (!existsSync(join(packageRoot, "contract.json"))) throw new Error(`published Skill contract not found: ${join(packageRoot, "contract.json")}`);
	const { receipt, issues } = validateImageReceipt(packageRoot, skillId);
	if (issues.length > 0 || !receipt) throw new Error(`published Skill receipt is missing or invalid: ${issues.join(", ")}`);
	const packageHash = imagePackageSha256(packageRoot);
	if (String(receipt.package_sha256) !== packageHash) throw new Error("published Skill package changed after publication receipt generation");
	const contractRaw = await readFile(join(packageRoot, "contract.json"), "utf8");
	return {
		packageRoot,
		contract: JSON.parse(contractRaw),
		packageHash,
		contractHash: imageSha256Text(contractRaw)
	};
}
function apply(ctx, config) {
	ctx.tools.register(defineTool({
		name: "image_skill_pipeline",
		description: "图片业务 Skill 项目管线（Codex_IS project-pipeline 的 DSH 重建）：契约驱动、哈希锁定的图片项目状态机。create 校验已发布图片 Skill 的收据与包哈希、比例/场景数/候选数须落在 contract 的 workload 与 supported_ratios 内，按 references 声明逐场景生成素材槽目录（含可点击链接）；add_material 只接受 reference_policy.allowed_slot_ids 声明的槽（reject_uncontracted_images），并校验每场景参考图上限；lock_materials 计算最终素材 sha256 快照，素材变化会作废提示词与确认；set_prompt/confirm_prompt 锁定提示词哈希与素材哈希（变化即拒绝确认）；多场景或多候选在确认提示词后进入 awaiting_paid_batch_confirmation，须 confirm_paid_batch 付费批次确认；start_generation --dry-run 生成执行清单（单候选 generate_image / 多候选 batch-image-generation），不调用付费工具。状态持久化在私有运行目录，跨会话可恢复。",
		parameters: {
			command: {
				type: "string",
				enum: [
					"create",
					"add_material",
					"lock_materials",
					"set_prompt",
					"confirm_prompt",
					"confirm_paid_batch",
					"start_generation",
					"get",
					"list"
				],
				required: true,
				description: "操作命令。"
			},
			project_id: {
				type: "string",
				description: "项目 id（create 缺省自动生成；仅字母数字连字符下划线）。"
			},
			skill_id: {
				type: "string",
				description: "create 用：已发布图片业务 Skill 的 skill_id（先经 skill_registry search 并取得用户确认）。"
			},
			display_name: {
				type: "string",
				description: "create 用：正式名称，必须与 contract.display_name 一致。"
			},
			ratio: {
				type: "string",
				description: "create 用：用户确认的画幅比例，须在 contract.output.supported_ratios 内（21:9/16:9/3:2/4:3/1:1/3:4/2:3/9:16）。"
			},
			candidate_count: {
				type: "integer",
				description: "create 用：每个场景的候选数（≥1，须在 workload.candidate_count_per_scene 内）。"
			},
			scene_count: {
				type: "integer",
				description: "create 用：场景数（≥1，须在 workload.scene_count 内）。"
			},
			skill_confirmed: {
				type: "boolean",
				description: "create 用：用户已明确确认 Skill 正式名称；缺省拒绝。"
			},
			slot: {
				type: "string",
				description: "add_material 用：素材槽 id（必须属于 contract 声明的 allowed_slot_ids）。"
			},
			scene_index: {
				type: "integer",
				description: "add_material 用：场景序号（1..scene_count）；仅当槽 scope=scene 且多场景时需要。"
			},
			path: {
				type: "string",
				description: "add_material 用：用户素材文件路径（复制到槽的 source 目录，不覆盖原图）。"
			},
			use_source: {
				type: "boolean",
				description: "lock_materials 用：true 表示把 source 目录素材复制到 final 并锁定；false 用 final 目录已有结果。"
			},
			text: {
				type: "string",
				description: "set_prompt 用：提示词正文（记录版本、作者、长度与 sha256；正文仅存项目 prompts/ 目录）。"
			},
			author: {
				type: "string",
				description: "set_prompt 用：提示词作者（默认 business_skill）。"
			},
			dry_run: {
				type: "boolean",
				description: "start_generation 用：仅校验状态并写入执行清单，不调用任何付费工具。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: { type: "string" },
					project: {
						type: "object",
						additionalProperties: true
					},
					projects: { type: "array" },
					manifest: {
						type: "object",
						additionalProperties: true
					},
					material_hash: { type: "string" },
					prompts: { type: "array" }
				}
			},
			render(_args, value) {
				return [{
					type: "text",
					text: value.message ?? JSON.stringify(value)
				}];
			}
		},
		async execute(args, exec) {
			const command = args.command;
			const workspaceRoot = exec.agent?.session?.header?.cwd ?? process.cwd();
			const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir);
			const projectsRoot = join(privateRoot, "image-projects");
			const load = async (id) => readJsonSafe(join(projectsRoot, id, "project.json"));
			const save = async (project) => {
				await atomicWriteJson(join(projectsRoot, project.project_id, "project.json"), project);
				return project;
			};
			const loadOrError = async (id) => {
				const state = await load(id);
				if (!state) throw new Error(`project not found: ${id}`);
				return state;
			};
			const projectId = (args.project_id ?? "").toString().trim();
			if (command === "list") {
				const ids = await readdir(projectsRoot).catch(() => []);
				const projects = [];
				for (const id of ids) {
					const state = await load(id);
					if (state) projects.push({
						projectId: state.project_id,
						state: state.state,
						skill_id: state.skill.skill_id,
						updatedAt: state.updated_at
					});
				}
				return {
					ok: true,
					message: `${projects.length} image project(s)`,
					projects
				};
			}
			if (command === "create") {
				if (args.skill_confirmed !== true) return {
					ok: false,
					message: "Skill name must be explicitly confirmed (skill_confirmed=true)"
				};
				const skillId = String(args.skill_id ?? "");
				const displayName = String(args.display_name ?? "");
				const ratio = String(args.ratio ?? "");
				const candidateCount = Number(args.candidate_count);
				const sceneCount = Number(args.scene_count);
				if (!skillId) return {
					ok: false,
					message: "skill_id is required"
				};
				if (!Number.isInteger(candidateCount) || candidateCount < 1 || !Number.isInteger(sceneCount) || sceneCount < 1) return {
					ok: false,
					message: "candidate_count and scene_count must be positive integers"
				};
				const registry = new SkillRegistry(join(privateRoot, "registry", "registry.db"));
				try {
					const skill = await resolveSkill(registry, skillId, privateRoot);
					validateImageSettings(skill.contract, {
						displayName,
						ratio,
						candidateCount,
						sceneCount
					});
					const identifier = imageSafeId(projectId || void 0);
					const root = join(projectsRoot, identifier);
					if (existsSync(root)) return {
						ok: false,
						message: `project already exists: ${root}`
					};
					const project = createImageProject({
						projectId: identifier,
						contract: skill.contract,
						skill: {
							skill_id: skillId,
							display_name: displayName,
							package_root: skill.packageRoot,
							package_hash: skill.packageHash,
							contract_hash: skill.contractHash
						},
						ratio,
						candidateCount,
						sceneCount,
						materialsRoot: join(root, "materials"),
						promptsRoot: join(root, "prompts"),
						executionRoot: join(root, "execution"),
						resultsRoot: join(root, "results")
					});
					for (const slot of project.material_slots) {
						await ensureDir(slot.source_dir);
						await ensureDir(slot.final_dir);
					}
					await ensureDir(join(root, "prompts"));
					await ensureDir(join(root, "execution"));
					await ensureDir(join(root, "results", "images"));
					await ensureDir(join(root, "results", "review"));
					await save(project);
					return {
						ok: true,
						message: `project ${identifier} created (${project.state})`,
						project: imageProjectPublicView(project, root)
					};
				} catch (error) {
					return {
						ok: false,
						message: String(error instanceof Error ? error.message : error)
					};
				} finally {
					registry.close();
				}
			}
			if (!projectId) return {
				ok: false,
				message: "project_id is required"
			};
			try {
				const project = await loadOrError(projectId);
				const root = join(projectsRoot, projectId);
				if (command === "get") return {
					ok: true,
					message: `project ${projectId} (${project.state})`,
					project: imageProjectPublicView(project, root)
				};
				if (command === "add_material") {
					const slotId = String(args.slot ?? "");
					const path = String(args.path ?? "");
					if (!slotId || !path) return {
						ok: false,
						message: "slot and path are required"
					};
					const sourcePath = isAbsolute(path) ? path : join(workspaceRoot, path);
					if (!(await stat(sourcePath).catch(() => null))?.isFile()) return {
						ok: false,
						message: `material file not found: ${sourcePath}`
					};
					const registry = new SkillRegistry(join(privateRoot, "registry", "registry.db"));
					try {
						const skill = await resolveSkill(registry, project.skill.skill_id, privateRoot);
						const references = Array.isArray(skill.contract.references) ? skill.contract.references : [];
						const policy = skill.contract.reference_policy ?? {};
						if (!(Array.isArray(policy.allowed_slot_ids) ? policy.allowed_slot_ids.map(String) : []).includes(slotId)) return {
							ok: false,
							message: `slot ${slotId} is not declared in the Skill contract (reject_uncontracted_images)`
						};
						const reference = references.find((item) => String(item.id) === slotId);
						const scope = String(reference?.scope ?? "project");
						const matches = project.material_slots.filter((slot) => slot.id === slotId);
						let target;
						if (scope === "project" || matches.length === 1) target = matches.find((slot) => slot.scene_index === null) ?? matches[0];
						else {
							const sceneIndex = Number(args.scene_index);
							if (!Number.isInteger(sceneIndex) || sceneIndex < 1 || sceneIndex > project.image_settings.scene_count) return {
								ok: false,
								message: `scene_index must be an integer 1..${project.image_settings.scene_count} for scene-scoped slot ${slotId}`
							};
							target = matches.find((slot) => slot.scene_index === sceneIndex);
						}
						if (!target) return {
							ok: false,
							message: `no material slot for ${slotId} in this project`
						};
						const maxPerScene = policy.maximum_reference_images_per_scene;
						const existingImages = (await readdir(target.source_dir).catch(() => [])).filter((item) => isImageFile(item)).length;
						if (typeof maxPerScene === "number" && existingImages >= maxPerScene) return {
							ok: false,
							message: `scene already at maximum_reference_images_per_scene (${maxPerScene})`
						};
						const fileName = sourcePath.split(/[\\/]/).pop() ?? "material";
						const destination = join(target.source_dir, fileName);
						if (existsSync(destination)) return {
							ok: false,
							message: `a file with this name already exists in the slot: ${destination}`
						};
						await copyFile(sourcePath, destination);
						return {
							ok: true,
							message: `material added to ${slotId}（scene ${target.scene_index ?? "project"}）: ${linkTarget(destination)}`,
							project: imageProjectPublicView(project, root)
						};
					} finally {
						registry.close();
					}
				}
				if (command === "lock_materials") {
					const registry = new SkillRegistry(join(privateRoot, "registry", "registry.db"));
					try {
						await resolveSkill(registry, project.skill.skill_id, privateRoot);
						if (args.use_source === true) for (const slot of project.material_slots) {
							const sources = (await readdir(slot.source_dir).catch(() => [])).filter((item) => isImageFile(item));
							for (const file of sources) {
								const from = join(slot.source_dir, file);
								const to = join(slot.final_dir, file);
								const sourceHash = await sha256File(from);
								if (existsSync(to) && await sha256File(to) !== sourceHash) throw new Error(`refusing to overwrite different final image: ${to}`);
								if (!existsSync(to)) await copyFile(from, to);
							}
						}
						const finalFilesBySlot = {};
						for (const slot of project.material_slots) {
							const files = (await readdir(slot.final_dir).catch(() => [])).filter((item) => isImageFile(item));
							const key = slotKey(slot.id, slot.scene_index);
							finalFilesBySlot[key] = [];
							for (const file of files) {
								const path = join(slot.final_dir, file);
								finalFilesBySlot[key].push({
									path,
									sha256: await sha256File(path)
								});
							}
						}
						const { materials, materialHash } = imageMaterialSnapshot(project, finalFilesBySlot);
						const next = lockImageMaterials(project, materials, materialHash);
						await save(next);
						return {
							ok: true,
							message: `materials locked (${materials.length} image(s), hash ${materialHash.slice(0, 12)}…)`,
							project: imageProjectPublicView(next, root),
							material_hash: materialHash
						};
					} finally {
						registry.close();
					}
				}
				if (command === "set_prompt") {
					const text = String(args.text ?? "");
					if (!text.trim()) return {
						ok: false,
						message: "text is required"
					};
					const registry = new SkillRegistry(join(privateRoot, "registry", "registry.db"));
					try {
						await resolveSkill(registry, project.skill.skill_id, privateRoot);
						const next = setImagePrompt(project, text, String(args.author ?? "business_skill"));
						const prompt = next.prompts[next.prompts.length - 1];
						await atomicWriteJson(join(root, "prompts", `v${prompt.version}.json`), prompt);
						await save(next);
						return {
							ok: true,
							message: `prompt v${prompt.version} added (${next.state})`,
							project: imageProjectPublicView(next, root)
						};
					} finally {
						registry.close();
					}
				}
				if (command === "confirm_prompt") {
					const finalFilesBySlot = {};
					for (const slot of project.material_slots) {
						const files = (await readdir(slot.final_dir).catch(() => [])).filter((item) => isImageFile(item));
						const key = slotKey(slot.id, slot.scene_index);
						finalFilesBySlot[key] = [];
						for (const file of files) finalFilesBySlot[key].push({
							path: join(slot.final_dir, file),
							sha256: await sha256File(join(slot.final_dir, file))
						});
					}
					const { materialHash } = imageMaterialSnapshot(project, finalFilesBySlot);
					const next = confirmImagePrompt(project, materialHash);
					const prompt = next.prompts[next.prompts.length - 1];
					await writeFile(join(root, "prompts", "confirmed.json"), JSON.stringify(prompt, null, 2) + "\n", "utf8");
					await save(next);
					return {
						ok: true,
						message: `prompt v${prompt.version} confirmed (${next.state})`,
						project: imageProjectPublicView(next, root)
					};
				}
				if (command === "confirm_paid_batch") {
					const next = confirmImagePaidBatch(project);
					await save(next);
					return {
						ok: true,
						message: `paid batch confirmed (${next.state})`,
						project: imageProjectPublicView(next, root)
					};
				}
				if (command === "start_generation") {
					const registry = new SkillRegistry(join(privateRoot, "registry", "registry.db"));
					try {
						await resolveSkill(registry, project.skill.skill_id, privateRoot);
						const finalFilesBySlot = {};
						for (const slot of project.material_slots) {
							const files = (await readdir(slot.final_dir).catch(() => [])).filter((item) => isImageFile(item));
							const key = slotKey(slot.id, slot.scene_index);
							finalFilesBySlot[key] = [];
							for (const file of files) finalFilesBySlot[key].push({
								path: join(slot.final_dir, file),
								sha256: await sha256File(join(slot.final_dir, file))
							});
						}
						const { materials, materialHash } = imageMaterialSnapshot(project, finalFilesBySlot);
						const next = startImageGeneration(project, args.dry_run === true, materials);
						await writeFile(join(root, "execution", "manifest.json"), JSON.stringify(next.generation?.manifest ?? {}, null, 2) + "\n", "utf8");
						await save(next);
						return {
							ok: true,
							message: args.dry_run === true ? "dry-run manifest written（未调用付费工具）" : `generation started: ${String(next.generation?.manifest?.entry)}`,
							project: imageProjectPublicView(next, root),
							manifest: next.generation?.manifest
						};
					} finally {
						registry.close();
					}
				}
				return {
					ok: false,
					message: `unknown command: ${command}`
				};
			} catch (error) {
				return {
					ok: false,
					message: String(error instanceof Error ? error.message : error)
				};
			}
		}
	}));
}
//#endregion
export { Config, apply, inject, name };
