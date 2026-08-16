---
name: video-skill-router
description: 用治理过的业务 Skill 创建视频的完整流程：检索/确认 Skill → 确认比例时长 → 建项目 → 收集素材 → 提示词 V1 → 确认 → 提交视频。业务 Skill 由 skill_registry 治理。
whenToUse: 用户想用业务 Skill（发布过的视频经验包）来创作视频时；先检索候选 Skill 而不是直接生视频。
---

# 视频业务 Skill 路由（Codex_CS 流程）

1. **先检索**：用 `skill_registry` 的 `search` 按用户创作意图检索已发布业务 Skill；把候选列给用户。**素材不能作为主要路由依据**——先定 Skill，再谈素材。
2. **确认 Skill、比例、时长**：用户明确确认 Skill 名后，用 `project_pipeline` 走状态机：`create` → `confirm_skill` → `set_settings`（比例与时长 4-30 秒）。各 Skill 素材槽数量由各自 contract 的 `count_rule` 推导，**不用统一"每秒几张图"规则**。
3. **收集素材**：`choose_image_stage` 选择用户供图或生成图片，`add_material` 逐槽加入（会自动校验 contract 的 min/max），`finalize_materials` 锁定素材清单。
4. **提示词 V1（必须完整加载 Skill 知识）**：由业务 Skill 产出中文提示词 V1。**创作前必须完整读取该 Skill 的 `contract.json`（严格按素材槽顺序绑定）、`SKILL.md`、以及 `references/` 下全部 4 个文件：`creative-guidance.md`（输出结构/强制规则）、`community-experience.md`（按当前条件适用的经验）、`failure-cases.md`（定稿前规避）、`examples.md`（提示词范例，含正例/反例/边界案例/质量审计）**。范例用于对照组织方式与合格写法，绝不定义素材契约、绝不覆盖用户当前指令。V1 结构须与范例一致：参考素材绑定与逐张唯一语义声明（普通场景参考/严格起始帧/严格结束帧，未指定不升级）→ 全局身份/材质/转场/音频默认项（"不生成音乐，仅生成音效。"）→ 逐段时间轴（按 contract 的 count_rule 推导，每段分别写摄影机动作与主体动作、物理反馈、段末状态）→ 整体约束 → 负面约束（只含当前有效要求的反面）。写作用 `set_prompt`（source=skill_v1）写入，然后 `confirm_prompt` 锁定素材哈希与提示词哈希。
5. **修订**：用户要求修改时自动进入 DT：`project_pipeline` 的 `request_revision` 传 `feedback` 原文 → 确定性分类并存储受约束修订请求（explicit_local 明确局部修改跳过语料；ambiguous_creative / structural_rewrite 最多检索 3 条相关语料，用 `prompt_revision` 的 `search_corpus`）→ `begin_revision` → 修订后 `set_prompt`（source=dt_revision）→ 再次 `confirm_prompt`。**每个版本都必须再次确认；修订结果必须回显同一 locked_context_sha256（`prompt_revision` 的 `validate_result` 校验）。**
6. **提交**：`build_payload` 生成标准 submission_payload（提交前重新校验素材哈希未变），交给 `generate_video`；执行层负责素材规范化、模型策略、提交与结果状态。不确定提交停在 needs_review，人工核对。
