import { t as SkillRegistry } from "./registry-core.js";
import { a as ensureDir, i as atomicWriteJson, l as resolvePrivateRoot, s as readJsonSafe, u as sha256File } from "./private-runtime.js";
import { a as buildSubmissionPayload, c as lockFinalMaterials, d as transition, f as validateVideoSettings, i as assessSlotCounts, l as mediaExtensions, n as addMaterial, o as confirmPrompt, r as addPrompt, s as createProject, u as planSlots } from "./project-core.js";
import { t as buildRevisionRequest } from "./revision-core.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
//#region src/tool-project.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "Ws_tool-project";
const inject = ["tools"];
const Config = z.object({ privateDir: z.string().default("") });
/**
* Build per-slot collection plans from the skill's published contract
* (read from the registry package) and create source/final directories.
*/
async function applySlotPlans(state, duration, privateRoot, projectsRoot, workspaceRoot) {
	const { readFileSync } = await import("node:fs");
	if (!state.skillName || !state.duration) return state;
	const registry = new SkillRegistry(join(privateRoot, "registry", "registry.db"));
	try {
		const rec = registry.get(state.skillName);
		if (!rec?.packageRoot) return state;
		const contract = JSON.parse(readFileSync(join(rec.packageRoot, "contract.json"), "utf8"));
		const refs = Array.isArray(contract.references) ? contract.references : [];
		if (refs.length === 0) return state;
		const slotsRoot = join(projectsRoot, state.projectId, "slots");
		const plans = planSlots(refs, Number(duration), slotsRoot);
		for (const plan of plans) {
			await ensureDir(plan.source_dir);
			await ensureDir(plan.final_dir);
		}
		return {
			...state,
			slotPlans: plans
		};
	} finally {
		registry.close();
	}
}
/** Windows 本地可点击链接目标：绝对路径 + 正斜杠（禁止 file:// / 反斜杠）。 */
function linkTarget(path) {
	return path.replaceAll("\\", "/");
}
/** 把槽计划转成带链接目标的输出（source_dir_link_target / final_dir_link_target）。 */
function slotDirOutput(plans) {
	return (plans ?? []).map((plan) => ({
		slot: plan.slot,
		role: plan.role,
		media_type: plan.media_type,
		min: plan.min,
		max: plan.max,
		planned_count: plan.planned_count,
		count_enforcement: plan.count_enforcement,
		source_dir: plan.source_dir,
		source_dir_link_target: linkTarget(plan.source_dir),
		final_dir: plan.final_dir,
		final_dir_link_target: linkTarget(plan.final_dir),
		locked: plan.locked
	}));
}
/** Count files in a slot's final dir matching the media type. */
async function countSlotFiles(plan) {
	const { readdir } = await import("node:fs/promises");
	const exts = mediaExtensions(plan.media_type);
	try {
		return (await readdir(plan.final_dir)).filter((name) => exts.includes(name.slice(name.lastIndexOf(".")).toLowerCase())).length;
	} catch {
		return 0;
	}
}
/** Copy source files into a slot's final dir (use-source lock). */
async function copySourceToFinal(plan) {
	const { readdir, copyFile, mkdir } = await import("node:fs/promises");
	const exts = mediaExtensions(plan.media_type);
	const copied = [];
	await mkdir(plan.final_dir, { recursive: true });
	const media = (await readdir(plan.source_dir).catch(() => [])).filter((name) => exts.includes(name.slice(name.lastIndexOf(".")).toLowerCase()));
	for (const name of media) {
		const dest = join(plan.final_dir, name);
		await copyFile(join(plan.source_dir, name), dest);
		copied.push(dest);
	}
	return copied;
}
/** List media files already present in a slot's final dir. */
async function listFinalFiles(plan) {
	const { readdir } = await import("node:fs/promises");
	const exts = mediaExtensions(plan.media_type);
	return (await readdir(plan.final_dir).catch(() => [])).filter((name) => exts.includes(name.slice(name.lastIndexOf(".")).toLowerCase())).map((name) => join(plan.final_dir, name));
}
function apply(ctx, config) {
	ctx.tools.register(defineTool({
		name: "project_pipeline",
		description: "项目管线状态机（Codex_CS project-pipeline 的 DSH 重建）：从确认业务 Skill 到生成最终 submission_payload 的显式生命周期。状态：awaiting_skill_confirmation → awaiting_video_settings → project_initialized → awaiting_image_stage_choice → collecting_user_materials|generating_images → final_images_ready → authoring_prompt → awaiting_prompt_confirmation → revision_requested → dt_revision（可循环）→ prompt_confirmed → generating_video → completed。确认提示词时锁定最终素材清单（sha256）与提示词哈希；build_payload 提交前重新校验素材哈希未变，防止未确认版本被生成。状态持久化在私有运行目录，跨会话可恢复。",
		parameters: {
			command: {
				type: "string",
				enum: [
					"create",
					"confirm_skill",
					"set_settings",
					"choose_image_stage",
					"add_material",
					"finalize_materials",
					"scan_materials",
					"lock_final",
					"set_prompt",
					"request_revision",
					"begin_revision",
					"confirm_prompt",
					"build_payload",
					"start_video",
					"complete",
					"get",
					"list"
				],
				required: true,
				description: "操作命令（见工具描述的状态机）。"
			},
			project_id: {
				type: "string",
				description: "项目 id（create 缺省自动生成）。"
			},
			skill_name: {
				type: "string",
				description: "confirm_skill 用：已确认的业务 Skill 名。"
			},
			ratio: {
				type: "string",
				description: "set_settings 用：视频比例（1:1/3:4/16:9/4:3/9:16/21:9）。"
			},
			duration: {
				type: "integer",
				description: "set_settings 用：视频时长 4-30 秒。"
			},
			stage: {
				type: "string",
				enum: ["user_materials", "generating_images"],
				description: "choose_image_stage 用：素材来源。"
			},
			slot: {
				type: "string",
				description: "add_material 用：素材槽 id（对应 Skill contract 的 slot）。"
			},
			path: {
				type: "string",
				description: "add_material 用：素材文件路径。"
			},
			text: {
				type: "string",
				description: "set_prompt 用：提示词文本。"
			},
			source: {
				type: "string",
				enum: [
					"skill_v1",
					"dt_revision",
					"user"
				],
				description: "set_prompt 用：提示词来源。"
			},
			revision_type: {
				type: "string",
				enum: [
					"explicit_local",
					"ambiguous_creative",
					"structural_rewrite"
				],
				description: "request_revision 用：修订类型（与 feedback 二选一）。"
			},
			feedback: {
				type: "string",
				description: "request_revision 用：用户修改意见原文；提供后自动分类并生成受约束修订请求。"
			},
			use_source: {
				type: "boolean",
				description: "lock_final 用：true 表示把 source 目录素材复制到 final 并锁定（用户供图）；false 用 final 目录已有生成结果。"
			},
			external_result: {
				type: "string",
				description: "complete 用：视频生成结果引用。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
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
					payload: {
						type: "object",
						additionalProperties: true
					},
					slot_dirs: { type: "array" },
					scan: { type: "array" }
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
			const projectsRoot = join(privateRoot, "projects");
			const load = async (id) => readJsonSafe(join(projectsRoot, id, "state.json"));
			const save = async (state) => {
				await atomicWriteJson(join(projectsRoot, state.projectId, "state.json"), state);
				return state;
			};
			const projectId = (args.project_id ?? "").toString().trim();
			if (command === "list") {
				const ids = await readdir(projectsRoot).catch(() => []);
				const states = [];
				for (const id of ids) {
					const s = await load(id);
					if (s) states.push({
						projectId: s.projectId,
						status: s.status,
						skillName: s.skillName,
						updatedAt: s.updatedAt
					});
				}
				return {
					ok: true,
					message: `${states.length} project(s)`,
					projects: states
				};
			}
			if (command === "create") {
				const id = projectId || `proj-${Date.now().toString(36)}`;
				let state = createProject(id, args.skill_name);
				if (args.ratio && args.duration !== void 0) {
					validateVideoSettings(args.ratio, Number(args.duration));
					state = transition(state, "awaiting_video_settings", "skill confirmed");
					state = transition(state, "project_initialized", "settings set");
					state = {
						...state,
						ratio: args.ratio,
						duration: Number(args.duration)
					};
					state = await applySlotPlans(state, args.duration, privateRoot, projectsRoot, workspaceRoot);
				}
				await save(state);
				return {
					ok: true,
					message: `project ${id} created (${state.status})`,
					project: state,
					slot_dirs: slotDirOutput(state.slotPlans)
				};
			}
			if (!projectId) return {
				ok: false,
				message: "project_id is required"
			};
			const state = await load(projectId);
			if (!state) return {
				ok: false,
				message: `project not found: ${projectId}`
			};
			switch (command) {
				case "confirm_skill": {
					if (!args.skill_name) return {
						ok: false,
						message: "skill_name is required"
					};
					const next = {
						...transition(state, "awaiting_video_settings", `skill ${args.skill_name} confirmed`),
						skillName: args.skill_name
					};
					return {
						ok: true,
						message: `status -> ${next.status}`,
						project: await save(next)
					};
				}
				case "set_settings": {
					validateVideoSettings(args.ratio, Number(args.duration));
					let next = {
						...transition(state, "project_initialized", "settings set"),
						ratio: args.ratio,
						duration: Number(args.duration)
					};
					next = await applySlotPlans(next, args.duration, privateRoot, projectsRoot, workspaceRoot);
					return {
						ok: true,
						message: `status -> ${next.status}（${next.slotPlans?.length ?? 0} 个素材槽已规划）`,
						project: await save(next),
						slot_dirs: slotDirOutput(next.slotPlans)
					};
				}
				case "choose_image_stage": {
					const stage = args.stage === "generating_images" ? "generating_images" : "collecting_user_materials";
					const next = {
						...transition(state, stage, `stage ${stage}`),
						imageStage: args.stage === "generating_images" ? "generating_images" : "user_materials"
					};
					return {
						ok: true,
						message: `status -> ${next.status}`,
						project: await save(next)
					};
				}
				case "add_material": {
					if (!args.slot || !args.path) return {
						ok: false,
						message: "slot and path are required"
					};
					const materialPath = isAbsolute(args.path) ? args.path : join(workspaceRoot, args.path);
					const hash = await sha256File(materialPath);
					let slots;
					if (state.skillName) {
						const registry = new SkillRegistry(join(privateRoot, "registry", "registry.db"));
						try {
							const rec = registry.get(state.skillName);
							if (rec?.contract?.slots) slots = rec.contract.slots;
						} finally {
							registry.close();
						}
					}
					const next = addMaterial(state, args.slot, materialPath, hash, slots);
					return {
						ok: true,
						message: `material ${args.slot} added (${hash.slice(0, 12)}…)`,
						project: await save(next)
					};
				}
				case "finalize_materials": {
					const next = transition(state, "final_images_ready", "materials finalized");
					return {
						ok: true,
						message: `status -> ${next.status} (${next.materials.length} material(s))`,
						project: await save(next)
					};
				}
				case "scan_materials": {
					const found = {};
					for (const plan of state.slotPlans ?? []) found[plan.slot] = await countSlotFiles(plan);
					const assessment = assessSlotCounts(state.slotPlans ?? [], found);
					return {
						ok: assessment.every((a) => a.ok),
						message: assessment.every((a) => a.ok) ? "all required slots match planned_count" : `${assessment.filter((a) => !a.ok).length} slot(s) mismatch`,
						scan: assessment
					};
				}
				case "lock_final": {
					const plans = state.slotPlans ?? [];
					if (plans.length === 0) return {
						ok: false,
						message: "no slot plans; run set_settings with the confirmed skill first"
					};
					const finalItems = [];
					const found = {};
					for (const plan of plans) {
						const finals = args.use_source ? await copySourceToFinal(plan) : await countSlotFiles(plan) >= 0 ? await listFinalFiles(plan) : [];
						found[plan.slot] = finals.length;
						for (const path of finals) finalItems.push({
							slot: plan.slot,
							path,
							hash: await sha256File(path)
						});
					}
					const assessment = assessSlotCounts(plans, found);
					const failing = assessment.filter((a) => !a.ok);
					if (failing.length > 0) return {
						ok: false,
						message: `lock refused: ${failing.map((a) => a.issue).join("; ")}`,
						scan: assessment
					};
					let next = lockFinalMaterials(state, finalItems);
					next = transition(next, "final_images_ready", `final materials locked (${finalItems.length})`);
					return {
						ok: true,
						message: `locked ${finalItems.length} final material(s) across ${plans.length} slot(s)`,
						project: await save(next),
						scan: assessment
					};
				}
				case "set_prompt": {
					if (!args.text) return {
						ok: false,
						message: "text is required"
					};
					const next = addPrompt(state, args.text, args.source ?? "user");
					return {
						ok: true,
						message: `prompt v${next.prompts.length} added (${next.status})`,
						project: await save(next)
					};
				}
				case "request_revision": {
					const feedback = String(args.feedback ?? "").trim();
					if (feedback) {
						const contractRules = state.skillName ? [`skill:${state.skillName}`] : [];
						const request = buildRevisionRequest({
							current_prompt: state.prompts[state.prompts.length - 1]?.text ?? "",
							user_feedback: feedback,
							locked_context: {
								contract_rules: contractRules,
								material_order: state.materials.map((m) => `${m.slot}:${m.path.split(/[\\/]/).pop() ?? m.path}`),
								ratio: state.ratio ?? "16:9",
								duration_seconds: state.duration ?? 5
							}
						});
						const next = {
							...transition(state, "revision_requested", `revision ${request.classification}`),
							revisionRequest: request
						};
						return {
							ok: true,
							message: `status -> revision_requested (${request.classification})`,
							project: await save(next)
						};
					}
					const type = args.revision_type ?? "ambiguous_creative";
					const next = transition(state, "revision_requested", `revision ${type}`);
					return {
						ok: true,
						message: `status -> revision_requested (${type})`,
						project: await save(next)
					};
				}
				case "begin_revision": return {
					ok: true,
					message: `status -> dt_revision`,
					project: await save(transition(state, "dt_revision", "dt revision begins"))
				};
				case "confirm_prompt": {
					const next = confirmPrompt(state);
					return {
						ok: true,
						message: `prompt v${next.prompts.length} confirmed (locked)`,
						project: await save(next)
					};
				}
				case "build_payload": {
					const current = {};
					for (const m of state.materials) current[`${m.slot}:${m.path}`] = await sha256File(m.path);
					const payload = buildSubmissionPayload(state, current);
					const next = {
						...state,
						submissionPayload: payload
					};
					await save(next);
					return {
						ok: true,
						message: "submission_payload built; hashes verified",
						payload,
						project: next
					};
				}
				case "start_video": return {
					ok: true,
					message: `status -> generating_video`,
					project: await save(transition(state, "generating_video", "video generation starts"))
				};
				case "complete": return {
					ok: true,
					message: "project completed",
					project: await save({
						...transition(state, "completed", "project completed"),
						generationResult: {
							status: "completed",
							external_result: args.external_result,
							completed_at: (/* @__PURE__ */ new Date()).toISOString()
						}
					})
				};
				case "get": return {
					ok: true,
					message: `project ${projectId} (${state.status})`,
					project: state
				};
				default: return {
					ok: false,
					message: `unknown command: ${command}`
				};
			}
		}
	}));
}
//#endregion
export { Config, apply, inject, linkTarget, name, slotDirOutput };
