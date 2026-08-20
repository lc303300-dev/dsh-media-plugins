---
name: codex-cs-skill-curator
description: 将用户在对话中上传或指定的单个视频 Skill Markdown、旧版 Skill 包、社区经验文档或提示词资料，整理为可审计、可验证、可发布的 DSH 标准业务 Skill（默认 Codex_Flow 格式：SKILL.md + meta.yaml + workflow.yaml + references）。用于新增、迁移、修订、合并、去重或入库视频 Skill；负责保留原始专业经验与社区经验、生成确定性素材契约/工作流、识别冲突和歧义、输出审核清单，并在用户明确确认后发布。不得用于实际生成图片或视频。
whenToUse: 用户提供 Skill 资料（Markdown / 旧包 / 社区经验 / 提示词文档）表示想要入库、迁移、修订或创建业务 Skill 时。
---

# 业务 Skill 入库治理（DSH 版，Codex_Flow 格式）

把每次入库视为一次受控编译：**原始资料是不可修改的来源，标准 Skill 包是编译产物，发布凭证（intake-receipt）决定它能否进入正式 Skill 库。**

## 先读取的规范

- `refs/video-skill-package-standard.md`：标准包与字段规范（含 Codex_Flow 新格式章节）。
- `refs/intake-classification-guide.md`：如何区分契约、创意经验、社区经验、失败案例与示例。
- `refs/review-checklist.md`：发布前必须展示给用户的审核项目。
- 默认模板：`refs/codex-flow-skill-template/`（SKILL.md + meta.yaml + workflow.yaml + references，镜像上游 Codex_Flow 平台格式）；旧格式模板 `refs/skill-template/` 仅用于迁移存量包。

## 新格式（Codex_Flow）要点

- `SKILL.md`：frontmatter 只有 `name` 与 `description`；正文只写每次执行都需要的信息与禁止事项。
- `meta.yaml`（schema `codex-flow-skill/v1`）：name/version/display-name-zh/source/release-tier/primary-output/intermediate-outputs/workflow-profile（simple|staged）/interaction-profile/tags/aliases/exclude-intents/capabilities/references（每个引用声明 `path` 与 `load-at` 阶段）。
- `workflow.yaml`（schema `codex-flow-workflow/v1`，staged 必须）：stages 声明 `id/output/gate（none|decision|approval|paid-execution|batch-approval）/capability/depends-on`；付费点由 gate 推导，不写 provider/模型/分辨率。
- 平台层（provider、模型、执行、批准）不属于业务包；业务包内出现 provider/模型/DAG/凭据/本机路径即污染，校验拒绝。
- 素材槽/count_rule 概念不再存在于新格式（属于旧 contract.json）；计划数与节奏由 workflow 阶段与用户确认决定。

## 入库工作流（9 步）

1. **接收并封存来源**：读用户资料（按 UTF-8，不修改原文件）。用 `skill_curator` 的 `migrate` 把来源封存进 `intake-sources.json`（文件名 + SHA-256 + 编码）——来源是证据，不是已正确的契约。
2. **检查重复与边界**：用 `skill_registry` 的 `search` 对比正式库的 skill_id/显示名/内容相似性；完全重复则建议更新复用，高度重叠则让用户决定合并或独立发布；隔离并报告本机路径/凭据/CLI/provider/模型版本（不得进包）。
3. **提取知识并分类**（按分类指南）：确定性事实（输出、能力、引用、排除意图、阶段门禁）→ `meta.yaml` + `workflow.yaml`；简短流程与停止点 → `SKILL.md`；创作意图/别名/标签/排除词 → `meta.yaml` 的 aliases/tags/exclude-intents（不得用素材反向定义意图）；专业创意 → `references/creative-guidance.md`；社区经验 → `community-experience.md`（标记证据等级）；失败/规避 → `failure-cases.md`；正反例 → `examples.md`（示例不参与契约推导）。`migrate` 返回的 `compile_checklist` 给出各类命中计数供你分类。
4. **生成确定性工作流**：确定 primary-output 与 capabilities（视频用 `video.generate`）；staged 包必须给出 workflow.yaml（brief → 生产阶段，付费阶段 gate 为 `paid-execution` 或 `batch-approval`）；references 全部在 meta 中声明并分配 `load-at`；不在包中选 provider/模型/分辨率。
5. **创建标准包**：`skill_curator` 的 `migrate`（旧资料）或 `scaffold`（新包）生成骨架；删除所有 `CURATOR-REQUIRED` 标记；`SKILL.md` 保持简洁，详细经验放 references。旧 contract.json 存量包走旧格式校验与发布路径（validate/publish 自动识别）。
6. **创意补全检查**：若 references 缺少可执行创作方法/范例，按用户意愿请求 Codex_DT 受限补充（只补范例/指导草稿，不推断契约、不选模型）；草稿未获用户确认前不得写入正式 references。
7. **确定性验证**：`skill_curator` 的 `validate`（新格式用 flow-1.0：必需元字段/污染扫描/reference 路由/workflow 依赖完整性/收据哈希绑定；旧格式用 validator 1.2.0）；验证失败只修当前包。
8. **展示审核清单**：向用户展示 Skill 名与 id、primary-output/capabilities/paid_points、package_hash、来源文件及哈希、references 保留数量、被隔离的旧规则、重复/冲突、待决歧义、验证结果。任何 blocking 项未清零时状态必须保持待审。
9. **用户确认后发布**：只有用户明确确认审核清单后才 `publish --approved true`（无 approved 会拒绝）。发布会重新验证、生成来源与包哈希、写入 `intake-receipt.json`（schema `codex-flow-receipt/v1`，包内容变化即 STALE_RECEIPT），再入注册库（`skill_registry ingest` 后 `publish`）。更新已存在 Skill 走升级流程，不绕过审核直接覆盖。

## 不得执行

- 不生成图片或视频、不提交任何付费任务。
- 不打开或理解参考媒体内容来猜测契约。
- 不把示例人物/城市/项目/品牌/镜头数量写成通用硬规则。
- 不因原文提到某模型版本就改变实际生成模型。
- 不删除或改写原始来源文件；不在用户确认前发布。
- 不把 Codex_DT 草稿当作已确认事实或契约来源。
- 不在新包中写入 provider/模型/分辨率/轮询/付费执行策略（属平台层）。
