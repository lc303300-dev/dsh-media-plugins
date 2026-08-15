import { createHash } from "node:crypto";
//#region src/shared/project-core.ts
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
const VIDEO_RATIOS = [
	"1:1",
	"3:4",
	"16:9",
	"4:3",
	"9:16",
	"21:9"
];
/** Allowed transitions (only the guide's arcs are legal). */
const TRANSITIONS = {
	awaiting_skill_confirmation: ["awaiting_video_settings", "cancelled"],
	awaiting_video_settings: ["project_initialized", "cancelled"],
	project_initialized: ["awaiting_image_stage_choice", "cancelled"],
	awaiting_image_stage_choice: [
		"collecting_user_materials",
		"generating_images",
		"cancelled"
	],
	collecting_user_materials: [
		"final_images_ready",
		"generating_images",
		"cancelled"
	],
	generating_images: [
		"final_images_ready",
		"collecting_user_materials",
		"cancelled"
	],
	final_images_ready: ["authoring_prompt", "cancelled"],
	authoring_prompt: [
		"awaiting_prompt_confirmation",
		"revision_requested",
		"cancelled"
	],
	awaiting_prompt_confirmation: [
		"prompt_confirmed",
		"revision_requested",
		"cancelled"
	],
	revision_requested: ["dt_revision", "cancelled"],
	dt_revision: ["authoring_prompt", "cancelled"],
	prompt_confirmed: [
		"generating_video",
		"revision_requested",
		"cancelled"
	],
	generating_video: ["completed", "cancelled"],
	completed: [],
	cancelled: []
};
function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
function createProject(projectId, skillName) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return {
		projectId,
		status: "awaiting_skill_confirmation",
		skillName,
		materials: [],
		prompts: [],
		history: [{
			at: now,
			from: "awaiting_skill_confirmation",
			to: "awaiting_skill_confirmation",
			note: "created"
		}],
		createdAt: now,
		updatedAt: now
	};
}
function canTransition(state, to) {
	return (TRANSITIONS[state] ?? []).includes(to);
}
function transition(state, to, note) {
	if (!canTransition(state.status, to)) throw new Error(`invalid project transition ${state.status} -> ${to} (project ${state.projectId})`);
	return {
		...state,
		status: to,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		history: [...state.history, {
			at: (/* @__PURE__ */ new Date()).toISOString(),
			from: state.status,
			to,
			note
		}]
	};
}
function validateVideoSettings(ratio, duration) {
	if (!VIDEO_RATIOS.includes(ratio)) throw new Error(`unsupported video ratio ${ratio}; supported: ${VIDEO_RATIOS.join(", ")}`);
	if (!Number.isInteger(duration) || duration < 4 || duration > 30) throw new Error(`duration must be an integer between 4 and 30 seconds, got ${duration}`);
}
/**
* Add a material to a slot; verifies the current stage allows collection
* and enforces slot min/max from the skill contract when provided.
*/
function addMaterial(state, slot, path, hash, contractSlots) {
	if (state.status !== "collecting_user_materials" && state.status !== "generating_images") throw new Error(`materials can only be added while collecting; current status ${state.status}`);
	if (!slot || slot.trim().length === 0) throw new Error("material slot id is required");
	const slotDef = contractSlots?.find((s) => s.id === slot);
	const current = state.materials.filter((m) => m.slot === slot);
	if (slotDef?.max !== void 0 && current.length >= slotDef.max) throw new Error(`slot ${slot} already at max ${slotDef.max}`);
	const item = {
		slot,
		path,
		hash,
		addedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	return {
		...state,
		materials: [...state.materials, item],
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
/** Lock the material set at confirmation: snapshot slot->hash. */
function lockMaterials(state) {
	const locked = {};
	for (const m of state.materials) locked[`${m.slot}:${m.path}`] = m.hash;
	return locked;
}
/** Verify the locked material set still matches the current files (hashes). */
function verifyMaterialsUnchanged(state, currentHashes) {
	if (!state.lockedMaterialHashes) return false;
	for (const [key, hash] of Object.entries(state.lockedMaterialHashes)) if (currentHashes[key] !== hash) return false;
	return true;
}
/** Add a prompt version (skill V1 or DT revision). */
function addPrompt(state, text, source) {
	const clean = (text ?? "").trim();
	if (clean.length === 0) throw new Error("prompt must not be empty");
	const nextVersion = state.prompts.length + 1;
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const prompt = {
		version: nextVersion,
		text: clean,
		hash: sha256(clean),
		source,
		createdAt: now,
		confirmed: false
	};
	const next = {
		...state,
		prompts: [...state.prompts, prompt],
		updatedAt: now
	};
	if (state.status === "dt_revision" || state.status === "final_images_ready" || state.status === "revision_requested") return transition(next, "authoring_prompt", `prompt v${nextVersion} authored (${source})`);
	if (state.status === "authoring_prompt") return next;
	throw new Error(`cannot author prompt in status ${state.status}`);
}
/** Confirm the current prompt: locks prompt hash and material hashes. */
function confirmPrompt(state) {
	const current = state.prompts[state.prompts.length - 1];
	if (!current) throw new Error("no prompt to confirm");
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return transition({
		...state,
		prompts: state.prompts.map((p, i) => i === state.prompts.length - 1 ? {
			...p,
			confirmed: true
		} : p),
		lockedPromptHash: current.hash,
		lockedMaterialHashes: lockMaterials(state),
		updatedAt: now
	}, "prompt_confirmed", `prompt v${current.version} confirmed`);
}
/**
* Build the standard submission payload; only from prompt_confirmed and
* only when the locked material hashes still match the current files.
*/
function buildSubmissionPayload(state, currentHashes) {
	if (state.status !== "prompt_confirmed") throw new Error(`submission payload requires prompt_confirmed; current status ${state.status}`);
	const prompt = state.prompts[state.prompts.length - 1];
	if (!prompt?.confirmed) throw new Error("prompt is not confirmed");
	if (prompt.hash !== state.lockedPromptHash) throw new Error("locked prompt hash mismatch");
	if (!verifyMaterialsUnchanged(state, currentHashes)) throw new Error("material hashes changed since confirmation; re-confirm before submission");
	return {
		project_id: state.projectId,
		skill_name: state.skillName,
		ratio: state.ratio,
		duration: state.duration,
		materials: state.materials.map((m) => ({
			slot: m.slot,
			path: m.path,
			hash: m.hash
		})),
		prompt: prompt.text,
		prompt_hash: prompt.hash,
		prompt_version: prompt.version,
		locked_material_hashes: state.lockedMaterialHashes,
		confirmed_at: state.updatedAt
	};
}
//#endregion
export { confirmPrompt as a, validateVideoSettings as c, buildSubmissionPayload as i, addMaterial as n, createProject as o, addPrompt as r, transition as s, VIDEO_RATIOS as t };
