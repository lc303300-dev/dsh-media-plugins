---
name: image-skill-curator
description: 将用户指定的图片业务 Skill Markdown、工作流蓝图、提示词经验或现有 Skill 包整理为可审计、可验证、可发布的 DSH 受治理图片业务 Skill（默认 Codex_Flow 图片格式：SKILL.md + meta.yaml + workflow.yaml + references）。用于新增、迁移、修订、去重、审核或入库图片业务 Skill；负责区分平台通用规则与业务局部规则、生成确定性素材契约/工作流与路由元数据、保留专业经验、识别冲突、输出审核清单，并仅在用户明确批准后原子发布。不得生成图片、选择供应商或调用付费执行层。
whenToUse: 用户提供图片业务 Skill 资料（Markdown / 蓝图 / 经验文档 / 提示词资料）表示想要入库、迁移、修订或创建受治理图片业务 Skill 时。
---

# 图片业务 Skill 入库治理（DSH 版）

把每次入库视为一次受控编译：**原始资料是不可修改的来源，标准 Skill 包是编译产物，intake-report/intake-sources 是审核记录，intake-receipt 决定它能否进入正式图片 Skill 库。**

## 先读取的规范

- `refs/image-skill-standard.md`：图片业务 Skill 包结构与事实归属标准（含 Codex_Flow 新格式章节）。
- `refs/image-review-checklist.md`：发布前必须展示给用户的审核项目。
- 默认模板：`refs/codex-flow-image-template/`（SKILL.md + meta.yaml + workflow.yaml + references，镜像上游 Codex_Flow 平台格式）；旧格式模板 `refs/image-skill-template/` 仅用于存量图片包。

## 新格式（Codex_Flow 图片）要点

- `SKILL.md`：frontmatter 只有 `name` 与 `description`；正文只写每次执行都需要的信息与禁止事项。
- `meta.yaml`（schema `codex-flow-skill/v1`）：`primary-output: image`、`capabilities: [image.generate, image.batch-generate]`、`workflow-profile: staged`、`interaction-profile: conversation`、aliases/tags/exclude-intents、references（每个引用声明 `path` 与 `load-at` 阶段）。图片版无 `community-experience`。
- `workflow.yaml`（schema `codex-flow-workflow/v1`，staged 必须）：`brief`（gate decision）→ 生产阶段（gate 只能是 `paid-execution` 或 `batch-approval`）；需要批量时再加一个 `image.batch-generate` 阶段（gate `batch-approval`）。
- 平台层（provider、模型、执行、批准）不属于业务包；业务包内出现 provider/模型/DAG/凭据/本机路径即污染，校验拒绝（图片专属 issue 码 `FLOW_IMAGE_`）。
- 素材槽概念不再存在于新格式；项目管线在创建边界把 flow 合成内部契约：通用槽 `image-material`（scene 作用域）、场景数 1..6、候选数 1..4（capabilities 含 `image.batch-generate` 才允许批量，否则候选 max 强制 1）、比例用全部 8 个（用户确认制）。

## 入库工作流（9 步）

1. **接收并封存来源**：读用户资料，记录来源文件名与 SHA-256。用 `image_skill_curator` 的 `audit`（`sources` 传来源路径列表）：新格式写入 `intake-sources.json`（文件名 + SHA-256），旧格式写入 `intake-report.json`。不得把未指定的历史图片或提示词秘密并入。
2. **检查重复与边界**：用 `skill_registry` 的 `search` 对比正式库的 skill_id/正式名称/别名/意图，判断新增、修订、合并或重复；发现近似包先报告差异。隔离并报告本机路径/凭据/provider/模型版本（不得进包）。
3. **提取知识并分类**：把来源事实分类为确定性事实（输出、能力、排除意图、阶段门禁）、创作经验、失败案例、示例、平台规则。新格式：确定性事实 → `meta.yaml` + `workflow.yaml`；创作意图 → aliases/tags/exclude-intents；创作经验 → `references/creative-guidance.md`；失败/规避 → `failure-cases.md`；纯文字示范 → `examples.md`（示例绝不定义契约）。旧格式：确定性素材事实 → `contract.json`；搜索召回 → `routing.json`。
4. **生成确定性工作流**：确定 `primary-output: image` 与 capabilities（`image.generate` 必含，支持批量再加 `image.batch-generate`）；staged 包必须给出 workflow.yaml（brief → 生产阶段，gate 为 `paid-execution` 或 `batch-approval`）；references 全部在 meta 中声明并分配 `load-at`；不在包中选 provider/模型/分辨率。
5. **创建标准包**：`image_skill_curator` 的 `scaffold`（默认 `codex-flow-image-template`）生成骨架；删除所有 `CURATOR-REQUIRED` 标记并补全。旧 contract.json 存量包走旧格式校验与发布路径（audit/validate/publish 自动识别：包内存在 `meta.yaml` 即按 flow）。
6. **反泛化与 provider-neutral**：具体槽名/槽数/布局/面板数/镜头池/材质/主体类别是当前 Skill 局部规则，不得写成全库 schema。新格式不声明素材槽、不写 provider/模型/并发/轮询/下载/重试/视觉排名；执行入口由平台层按 workflow 阶段决定（单候选 `generate_image` / 多候选付费批次 `batch-image-generation`）。
7. **确定性验证**：`validate` 复验（flow 包用 `validateCodexFlowImagePackage`：flow-1.0 必需元字段/污染扫描/reference 路由/workflow 依赖完整性/收据哈希绑定 + 图片专属检查；旧格式用 validator 2.0.0）。存在阻断问题时保持待审，不得进入批准。
8. **展示审核清单**：向用户展示正式名称与 id、来源文件及哈希、primary-output/capabilities/paid_points、package_hash、素材槽与数量（旧格式）、输出契约、局部规则、明确排除的泛化项、验证问题和目标路径。任何阻断项未清零时状态必须保持待审。
9. **用户确认后发布**：只有用户明确确认审核清单后才 `publish --approved true`（无 approved 会拒绝；flow 包无 intake-report 批准步骤，批准即由该审核门完成）。发布会重新验证、生成来源与包哈希、写入 `intake-receipt.json`（flow 为 schema `codex-flow-receipt/v1`，包内容变化即 STALE_RECEIPT），再原子入库并重建注册表；**禁止覆盖已有正式包**（修订走 `upgrade`，备份+原子替换+回滚）。插件自带正式库用 `seed_library` 同步（存量 legacy 库保留兼容）。

## 不得执行

- 不生成或编辑图片，不调用 `generate_image` 或 `batch_image`。
- 不选择 provider、模型、分辨率、费用、并发、轮询、下载或重试策略。
- 不把范例图作为隐性知识上传到生成引用链；图片是否允许、数量与用途只由当前契约决定。
- 不把 `scene-storyboard-grid` 的双槽、3×3、九格、同一时刻、镜头池、事实账本或提示词模块当作全库默认。
- 不因模板存在字段就臆造业务事实；无法确定时写入阻断问题并停在批准前。
