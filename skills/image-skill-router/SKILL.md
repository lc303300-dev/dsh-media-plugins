---
name: image-skill-router
description: 用受治理的图片业务 Skill 完成图片任务的完整流程：检索/确认 Skill → 确认画幅比例/场景数/每场景候选数 → 建项目（契约素材槽）→ 收集素材 → 业务 Skill 写提示词 V1 → 确认 → 单候选 generate_image 或多候选付费批次 batch_image。业务 Skill 由 image_skill_curator 治理、skill_registry 检索。
whenToUse: 用户想用受治理图片业务 Skill（九宫格分镜、场景一致性组图、产品组图等）来生成图片时；先检索候选 Skill 而不是直接生成图片；不得根据用户已有文件反向决定创作目标。
---

# 图片业务 Skill 路由（Codex_IS 流程）

1. **先检索**：用 `skill_registry` 的 `search` 按用户创作意图检索已发布图片业务 Skill；最多展示三个接近候选，列给用户并取得**明确确认**。**素材不能作为主要路由依据**——先定 Skill，再谈素材；没有可靠匹配时说明正式库不覆盖，不得临时扩展某个 Skill 的素材契约。
2. **确认 Skill、比例、数量**：用户确认正式 Skill 名后，用 `image_skill_pipeline` 的 `create`（`skill_confirmed=true`，`display_name` 必须与 contract 一致）。画幅比例必须在 `contract.output.supported_ratios` 内；场景数与每场景候选数必须在 `contract.workload` 范围内；多场景或多候选时该 Skill 必须 `batch_allowed`。即使用户点名 Skill 也不得跳过比例和数量确认。
3. **收集素材**：`add_material` 逐槽加入用户素材（只接受 `reference_policy.allowed_slot_ids` 声明的槽，拒绝未声明图片；校验每场景参考图上限；复制到槽的 source 目录，不覆盖原图）。观察素材**必须先建最长边 ≤1024px 的预览**（`image_preview`），不得直接观察原图；发送给生成层前校正 EXIF 方向，最长边超过 1920px 的副本等比缩小到项目私有目录。
4. **锁定素材**：`lock_materials`（`use_source=true` 把 source 复制到 final 并锁定）。素材变化会作废提示词与确认。
5. **提示词 V1（必须完整加载业务 Skill 知识）**：由所选业务 Skill 产出提示词 V1——**创作前必须完整读取该 Skill 的 `contract.json`（严格按素材槽顺序绑定）、`SKILL.md`、以及 `references/` 下全部文件：`creative-guidance.md`（事实账本/创作指导）、`failure-cases.md`（定稿前规避）、`examples.md`（纯文字提示词范例，绝不定义契约、绝不覆盖用户指令）**。用 `image_skill_pipeline` 的 `set_prompt` 写入（`author=business_skill`），然后 `confirm_prompt` 锁定素材哈希与提示词哈希。
6. **确认后分流**：总任务量 = 场景数 × 每场景候选数。等于 1 → `start_generation`（dry-run 清单 `entry=generate_image`），交统一 `generate_image` 执行；大于 1 → `confirm_prompt` 后进入 `awaiting_paid_batch_confirmation`，**先取得用户明确付费批次确认**（`confirm_paid_batch`）再 `start_generation`（`entry=batch-image-generation`），交 `batch_image` 执行。
7. **记录与停止**：记录成功、失败或放弃项；不自动重试、不做审美排名、不把部分成功伪装为完整成功。生成结果放入项目 `results/`；提示词正文只存项目 `prompts/`，操作日志只记版本、作者、长度与 sha256。

## 决策边界

- 业务 Skill 只负责写提示词并等待确认；不选择供应商、模型、分辨率、价格、并发、轮询、下载或重试策略。
- 只在用户明确指定且统一工具支持时传 `image_provider`；否则用统一路由默认顺序。
- 提示词正文不得包含供应商名、实际模型、分辨率、费用、下载路径或内部工作流说明。
- 批量调度由 `batch_image` 的确定性调度器负责，不能用生成子 Agent 替代。
