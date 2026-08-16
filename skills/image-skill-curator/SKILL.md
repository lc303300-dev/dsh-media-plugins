---
name: image-skill-curator
description: 将用户指定的图片业务 Skill Markdown、工作流蓝图、提示词经验或现有 Skill 包整理为可审计、可验证、可发布的 Codex_IS 受治理图片业务 Skill。用于新增、迁移、修订、去重、审核或入库图片业务 Skill；负责区分平台通用规则与业务局部规则、生成素材契约与路由元数据、保留专业经验、识别冲突、输出审核报告，并仅在用户明确批准后原子发布。不得生成图片、选择供应商或调用付费执行层。
whenToUse: 用户提供图片业务 Skill 资料（Markdown / 蓝图 / 经验文档 / 提示词资料）表示想要入库、迁移、修订或创建受治理图片业务 Skill 时。
---

# 图片业务 Skill 入库治理（DSH 版）

把每次入库视为一次受控编译：**原始资料是不可修改的来源，标准 Skill 包是编译产物，intake-report 是审核记录，intake-receipt 决定它能否进入正式图片 Skill 库。**

## 先读取的规范

- `refs/image-skill-standard.md`：图片业务 Skill 包结构与事实归属标准。
- `refs/image-review-checklist.md`：发布前必须展示给用户的审核项目。
- 唯一模板：`refs/image-skill-template/`（不要从某个已有 Skill 复制结构）。

## 入库工作流（9 步）

1. **接收并封存来源**：读用户资料，记录来源文件名与 SHA-256。用 `image_skill_curator` 的 `audit`（`sources` 传来源路径列表）把来源哈希写入 `intake-report.json`。不得把未指定的历史图片或提示词秘密并入。
2. **检查重复与边界**：用 `skill_registry` 的 `search` 对比正式库的 skill_id/正式名称/别名/意图，判断新增、修订、合并或重复；发现近似包先报告差异。隔离并报告本机路径/凭据/provider/模型版本（不得进契约）。
3. **提取知识并分类**：把来源事实分类为 contract facts、workflow rules、creative guidance、failure cases、examples、platform rules。确定性素材事实 → `contract.json`；搜索召回 → `routing.json`；创作经验 → `references/creative-guidance.md`；失败/规避 → `failure-cases.md`；纯文字示范 → `examples.md`（示例绝不定义契约）。
4. **生成确定性契约**：`scaffold` 从 `image-skill-template` 创建骨架，删除所有 `CURATOR-REQUIRED` 标记并补全。素材槽来自业务事实而非模板习惯；`allowed_slot_ids` 与槽顺序一致；必选槽 `min_count >= 1`；`min_count <= max_count`；`workload.scene_count` / `candidate_count_per_scene` 用 `{min, max}` 声明；不支持批量时 `batch_allowed=false` 且两范围 max 均 ≤1；输出声明 `media_type: image`、比例确认与 `supported_ratios`（8 个平台比例之一）。**反泛化**：具体槽名/槽数/布局/面板数/镜头池/材质/主体类别是当前 Skill 局部规则，不得写成全库 schema。
5. **保持 provider-neutral**：`execution.provider_neutral=true`、`single_candidate_entry=generate_image`、`batch_entry=batch-image-generation`、`requires_paid_batch_confirmation=true`、`automatic_retry=false`、`automatic_visual_ranking=false`。包内不得保存密钥、指定 provider 模型，或实现并发、轮询、下载、重试和视觉排名。
6. **审核与验证**：`audit` 复跑生成 `intake-report.json`（validator 2.0.0：契约/路由/收据 schema、反泛化与反污染扫描、来源哈希）；`validate` 复验。存在阻断问题、来源矛盾或缺失知识时保持 `needs_review`，不得进入批准。
7. **展示审核清单**：向用户展示正式名称与 id、来源文件及哈希、素材槽与数量、输出契约、局部规则、明确排除的泛化项、验证问题和目标路径。任何阻断项未清零时状态必须保持待审。
8. **用户批准**：只有用户明确批准后才 `approve`（`approved_by=user`）；`approve` 不能代替当前对话中真实发生的用户批准。
9. **原子发布**：`publish`（`approved=true`）在 staging 中重新校验、写入含来源哈希与包哈希的 `intake-receipt.json`，原子移动到正式库并重建注册表；**禁止覆盖已有正式包**（新包覆盖会拒绝）。修订已发布 Skill 走 `upgrade`（备份+原子替换+回滚），不绕过审核直接覆盖。插件自带正式库用 `seed_library` 同步。

## 不得执行

- 不生成或编辑图片，不调用 `generate_image` 或 `batch_image`。
- 不选择 provider、模型、分辨率、费用、并发、轮询、下载或重试策略。
- 不把范例图作为隐性知识上传到生成引用链；图片是否允许、数量与用途只由当前 contract 决定。
- 不把 `scene-storyboard-grid` 的双槽、3×3、九格、同一时刻、镜头池、事实账本或提示词模块当作全库默认。
- 不因模板存在字段就臆造业务事实；无法确定时写入阻断问题并停在批准前。
