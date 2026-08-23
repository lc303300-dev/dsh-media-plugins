---
name: video-skill-router
description: 用治理过的业务 Skill 创建视频的完整流程：检索/确认 Skill → 确认比例时长 → 建项目 → 收集素材 → 提示词 V1 → 确认 → 提交视频。业务 Skill 由 skill_registry 治理。
whenToUse: 用户想用业务 Skill（发布过的视频经验包）来创作视频时；先检索候选 Skill 而不是直接生视频。
---

# 视频业务 Skill 路由（Codex_CS 流程）

1. **先检索**：用 `skill_registry` 的 `search` 按用户创作意图检索已发布业务 Skill；把候选列给用户。**素材不能作为主要路由依据**——先定 Skill，再谈素材。
2. **确认 Skill、比例、时长**：用户明确确认 Skill 名后，用 `project_pipeline` 走状态机：`create` → `confirm_skill` → `set_settings`（比例与时长 4-30 秒）。各 Skill 素材槽数量由各自 contract 的 `count_rule` 推导，**不用统一"每秒几张图"规则**。
3. **收集素材**：`choose_image_stage` 选择用户供图或生成图片，`add_material` 逐槽加入（会自动校验 contract 的 min/max），`finalize_materials` 锁定素材清单。
4. **提示词 V1（必须完整加载 Skill 知识）**：由业务 Skill 产出中文提示词 V1。**旧格式包：创作前必须完整读取该 Skill 的 `contract.json`（严格按素材槽顺序绑定）、`SKILL.md`、以及 `references/` 下全部 4 个文件：`creative-guidance.md`（输出结构/强制规则）、`community-experience.md`（按当前条件适用的经验）、`failure-cases.md`（定稿前规避）、`examples.md`（提示词范例，含正例/反例/边界案例/质量审计）**。**flow 包（见下节）：无 contract.json，创作前必须完整读取 `SKILL.md` + `meta.yaml` + `workflow.yaml`，并按 `meta.yaml` 的 `references` 声明（`load-at` 阶段含 authoring 的文件）读取对应知识文件**。范例用于对照组织方式与合格写法，绝不定义素材契约、绝不覆盖用户当前指令。V1 结构须与范例一致：参考素材绑定与逐张唯一语义声明（普通场景参考/严格起始帧/严格结束帧，未指定不升级）→ 全局身份/材质/转场/音频默认项（"不生成音乐，仅生成音效。"）→ 逐段时间轴（旧格式按 contract 的 count_rule 推导；flow 包按 Skill 知识指导推导，每段分别写摄影机动作与主体动作、物理反馈、段末状态）→ 整体约束 → 负面约束（只含当前有效要求的反面）。**导演通用层：创作前同时加载 `video-director-prompt` 技能**（调用 `skill` 工具），按其 `references` 路由：`directing-methods.md`（可视化/场面调度/表演/光色/物理/声音，每次必读）、`prompt-structure.md`（区块/剪辑/素材语义）、`community-techniques.md`（特殊视角/高速/复杂转场/极端 FOV/社区技巧）、`structure-guide.md`，并对照"交付前检查清单"。用 `set_prompt`（source=skill_v1）写入，然后 `confirm_prompt` 锁定素材哈希与提示词哈希。
5. **修订**：用户要求修改时自动进入 DT：`project_pipeline` 的 `request_revision` 传 `feedback` 原文 → 确定性分类并存储受约束修订请求（explicit_local 明确局部修改跳过语料；ambiguous_creative / structural_rewrite 最多检索 3 条相关语料，用 `prompt_revision` 的 `search_corpus`）→ `begin_revision` → 修订后 `set_prompt`（source=dt_revision）→ 再次 `confirm_prompt`。**每个版本都必须再次确认；修订结果必须回显同一 locked_context_sha256（`prompt_revision` 的 `validate_result` 校验）。**
6. **提交**：`build_payload` 生成标准 submission_payload（提交前重新校验素材哈希未变），交给 `generate_video`（统一管线：单条与批量同一条路径，每任务隔离下载、按 submit_id 精确轮询）。正式 production 提交前必须把已确认的模型/分辨率/时长作为 `video_confirmation_model` / `video_confirmation_resolution` / `video_confirmation_duration` 传入，且须与最终解析值一致。多个不同素材用 `tasks` 数组一次提交（设置项共享），同一素材多份用 `video_count`。执行层负责素材规范化、模型策略、提交与结果状态。不确定提交停在 needs_review，人工核对。

## flow 包（Codex_Flow 格式）适配说明

治理层自 Phase 1 起同时支持旧格式（`SKILL.md + contract.json + routing.json + agents/`）与 Codex_Flow 格式（`SKILL.md + meta.yaml + workflow.yaml + references/`，经 `skill_registry` 的 `ingest` 自动识别）。视频项目管线对 flow 包的适配：

- **识别**：`project_pipeline` 的 `create`/`confirm_skill` 边界查询注册库：`skill.contract.flow` 存在且 `capabilities` 含 `video.generate`（或 `primary_output === 'video'`）即为 flow 视频包，项目状态标注 `skillFormat: 'flow'`（旧格式为 `'legacy'`）。
- **通用素材槽**：flow 包不声明素材槽与 count_rule。项目管线合成**单个通用槽 `reference-material`**（图片，min 1、无上限、推荐节奏）：按业务 Skill 知识指导收集用户参考图，数量不设硬上限，`lock_final` 只做推荐校验（recommended），不做硬性数量要求。
- **知识加载（V1 创作前）**：flow 包无 contract.json。创作前完整读取 `SKILL.md` + `meta.yaml` + `workflow.yaml`，并按 `meta.yaml` 的 `references` 声明读取对应知识文件（每个条目含 `path` 与 `load-at` 阶段，如 `authoring`）；`load-at` 含 authoring 的文件（如 `creative-guidance.md`、`examples.md`）在创作前加载。时间轴节奏按 Skill 知识指导推导（无 count_rule 可依）。
- 其余步骤（比例时长确认、素材收集、V1 写作、确认锁定、修订、提交）与旧格式完全一致，哈希锁定与 15 状态机不变。
