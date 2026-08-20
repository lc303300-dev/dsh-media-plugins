# Codex_IS 图片业务 Skill 通用入库标准（DSH 版）

## 适用范围

本标准规范进入图片业务 Skill 库（默认 `<workspace>/.dsh-media-private/image-skill-library/`，由 `image_skill_curator` 管理）的图片业务 Skill 包结构、事实归属、素材契约、路由、知识文件、审核和发布。它不规定槽位数量、布局、面板数、时序或具体创作方法。

## 标准包结构

```text
<skill-id>/
├── SKILL.md
├── contract.json
├── routing.json
├── intake-report.json
├── intake-receipt.json       # 仅由发布器生成
├── agents/openai.yaml
└── references/
    ├── creative-guidance.md
    ├── failure-cases.md
    └── examples.md
```

不得包含凭据、provider 适配器、付费提交、轮询、下载、运行日志、用户素材或生成结果。

## 身份规范

- 目录名、frontmatter `name`、contract、routing 和 receipt 的 `skill_id` 完全一致。
- `skill_id` 使用小写字母、数字和连字符，最长 63 字符。
- frontmatter 只能有 `name` 与 `description`。
- description 同时说明能力和触发场景，不写内部实现或供应商。
- 正式名称稳定且可区分；别名不得抢占其他 Skill 的精确名称。

## 事实归属

| 内容 | 唯一归属 |
| --- | --- |
| 素材槽、类型、数量、顺序、角色 | `contract.json` |
| 输出媒体和确定性结构 | `contract.json` |
| 核心操作步骤与停止点 | `SKILL.md` |
| 专业创作经验 | `creative-guidance.md` |
| 失败症状、原因、修复、停止 | `failure-cases.md` |
| 纯文字示范 | `examples.md` |
| 搜索召回信息 | `routing.json` |
| 来源、冲突、问题与批准 | `intake-report.json` |
| 发布身份与完整性 | `intake-receipt.json` |

确定性事实不能只存在于示例或 Markdown。示例永远不能改变 contract。

## 素材契约

平台不设全局槽数。每个 Skill 自行声明槽 ID、媒体类型（image）、角色、作用域（project/scene）、必选性、最小/最大数量、顺序、观察要求、是否发送到生成层和描述。

通用门禁：

- `allowed_slot_ids` 与 `references` 的顺序完全一致；
- `reject_uncontracted_images` 固定为 `true`；
- `min_count <= max_count`，必选槽 `min_count >= 1`，可选槽 `min_count == 0`；
- 角色权威清晰，重叠时写明冲突裁决；
- 运行时不得临时增加未声明的风格图、范例图或灵感图；
- 场景作用域（`scope: scene`）的槽在项目创建时为每个场景复制一份，且受 `maximum_reference_images_per_scene` 约束。

## 工作负载与输出

- `workload.scene_count` 与 `candidate_count_per_scene` 用 `{min, max}` 声明（min ≥ 1，max 可 null）；max 越界或与 `batch_allowed=false` 冲突（任何范围 max > 1）会被校验拒绝。
- 输出声明 `media_type: image`、`requires_ratio_confirmation: true` 和 `supported_ratios`（`21:9/16:9/3:2/4:3/1:1/3:4/2:3/9:16` 的子集）。
- 布局、面板数、单张/多张、方向及时序只有在确为业务硬约束时才声明到 `business_constraints`。

## 作者与执行

- 作者契约必须要求提示词确认（`requires_prompt_confirmation: true`），并说明素材绑定（`requires_reference_binding`）与用户指令优先级（`user_instruction_priority: highest`）。
- 每包必须 `provider_neutral: true`。单任务交给 `generate_image`；多场景或多候选经付费确认后交给 `batch-image-generation`。
- 业务包不得保存密钥，指定 provider 模型，或实现并发、轮询、下载、重试和视觉排名。

## 知识质量

- creative guidance 写可迁移经验和适用条件，不把案例颜色、主体、场景或布局写成默认。
- failure cases 每项包含症状、原因、修复和停止条件，并有强停止条件。
- examples 开头声明"不定义契约"，至少包含正例、反例和边界例。
- 不保存或要求上传优秀范例图，除非它本身是 contract 明确声明的业务输入。

## 反泛化原则

从单个 Skill 提取标准时，以下默认是局部规则：具体槽名/数量、面板数、网格、拼版方式、时序模式、closed-world、身份裁决、镜头池、构图、材质、主体类别、提示词模块和语言。

可进入平台通用层的通常只有：明确契约、拒绝未声明素材、比例确认、提示词确认、provider-neutral、统一执行、审计哈希和用户批准。

## 发布门禁

只有同时满足以下条件才能发布：来源哈希存在；重复检查完成；确定性事实已进入 contract；知识文件完整；无 provider 或凭据实现；JSON Schema 与语义校验通过；审核报告无阻断问题；用户明确批准正式名称、契约和发布。

发布收据在 staging 中生成，对排除收据后的规范化包计算 SHA-256（`codex-is-package-sha256-v2`）。注册表只索引有效收据且当前包哈希一致的正式包；已发布包修订必须重新审核、重新批准并通过 `upgrade` 原子升级。

## 10. Codex_Flow 新格式（默认）

> 第 1-9 节描述旧版 `contract.json` 格式（存量兼容），本节描述 **Codex_Flow 图片格式**（新入库默认，镜像上游 `packages/Codex_Flow` 平台）。新包优先按本节创建；`image_skill_curator` 与 `image_skill_pipeline` 自动识别：包内存在 `meta.yaml` 即按 flow 校验/发布/合成。

新入库的图片业务 Skill 使用 Codex_Flow 平台格式，把"业务创意"与"平台执行"分离：业务包只描述输出、能力、排除意图、工作流门禁与知识引用；provider、模型、执行入口与付费批准由平台层决定。

### 10.1 标准目录

```text
<skill-id>/
├─ SKILL.md
├─ meta.yaml
├─ workflow.yaml          # staged profile 必须
├─ intake-receipt.json    # 仅由发布器生成
└─ references/
   ├─ creative-guidance.md
   ├─ failure-cases.md
   └─ examples.md
```

图片版无 `community-experience.md`（与旧图片体系的 knowledge 三件套一致）。不得包含凭据、provider 适配器、付费提交、轮询、下载、运行日志、用户素材或生成结果。

### 10.2 meta.yaml（schema `codex-flow-skill/v1`）

必须字段：`schema`、`name`、`version`、`primary-output`（必须为 `image`）、`workflow-profile`（`simple`|`staged`）、`interaction-profile`（`conversation`|`gui`|`hybrid`）。建议字段：`display-name-zh`、`source`、`release-tier`、`intermediate-outputs`（如 `prompt`）、`tags`、`aliases`、`exclude-intents`、`capabilities`（必须含 `image.generate`；支持批量时再加 `image.batch-generate`）、`references`（每个引用声明 `path` 与 `load-at` 阶段，如 `authoring`/`final-qc`）。

### 10.3 workflow.yaml（schema `codex-flow-workflow/v1`）

`stages` 列表，每阶段声明 `id`、`output`、`gate`（`none`/`decision`/`approval`/`paid-execution`/`batch-approval`）、可选 `capability` 与 `depends-on`。依赖必须完整且无环。`brief`（gate `decision`）→ 生产阶段（声明 capability 的阶段）；**图片生产阶段的 gate 只能是 `paid-execution` 或 `batch-approval`**。付费点由 `paid-execution`/`batch-approval` 门禁推导，`intake-receipt` 审阅卡展示 `paid_points`。

### 10.4 命名与一致性

目录名、frontmatter `name`、meta `name` 三者必须一致。frontmatter 只能有 `name` 与 `description`。`skill_id` 小写连字符 ≤63 字符。

### 10.5 禁止内容（污染扫描 + 图片专属检查）

`SKILL.md` frontmatter+正文与 `meta.yaml` 中不得出现：provider 名（Seedance/Dreamina/Jimeng/Gemini/Kling 等）、模型标识、DAG/工作流 id 泄漏、API Key/Authorization/Cookie、本机绝对路径、危险命令。图片专属校验（`validateCodexFlowImagePackage`，issue 码 `FLOW_IMAGE_`）：capabilities 必须含 `image.generate`；`primary-output` 必须为 `image`；生产阶段 gate 只能是 `paid-execution` 或 `batch-approval`。平台执行细节（模型版本、分辨率、轮询、下载、付费策略）一律不进业务包。

### 10.6 发布凭证

`intake-receipt.json`（schema `codex-flow-receipt/v1`）由发布器生成：skill_id、version、validator、approved_by、来源哈希、`package_hash`（全包 SHA-256，跳过 `.codex-flow-private` 与收据自身）、创建时间。包内容变化后旧凭证立即失效（`STALE_RECEIPT`），必须重新审核与发布。flow 包无 `intake-report` 批准步骤：用户批准由 `publish`（`approved=true`）审核门完成。

### 10.7 项目管线适配（flow 包的用户确认制）

`image_skill_pipeline` 的 `create` 在创建边界把 flow 合成现有内部图片契约形状（状态机与哈希锁定机制不变）：

- 素材槽：flow 无槽声明，使用一个通用场景槽 `image-material`（scope=scene、必选、min 1、max null、有序、需观察）；
- 工作量：`scene_count` 1..6、`candidate_count_per_scene` 1..4；capabilities 含 `image.batch-generate` 时 `batch_allowed=true`，否则候选 max 强制 1（非批量包实际只允许单场景单候选）；
- 输出比例：`supported_ratios` 用全部 8 个平台比例——**比例、场景数、候选数为用户确认制，无契约上界约束**（在平台范围内由用户逐项确认）；
- 作者与执行默认：zh-CN / 用户指令最高优先 / 提示词确认 true；provider-neutral、单候选 `generate_image`、批量 `batch-image-generation`、付费批次确认 true、绝不自动重试/视觉排名。

### 10.8 与旧格式的关系

- `image_skill_curator` 的 `audit`/`validate`/`publish`/`upgrade` 自动识别：包内存在 `meta.yaml` 即按 Codex_Flow 校验与发布（`validateCodexFlowImagePackage` + `buildFlowReviewCard` + `buildFlowIntakeReceipt` + `flowMetaToRegistryShape` 入注册库），否则走旧 contract 路径（validator 2.0.0）。
- `scaffold` 默认生成 `codex-flow-image-template` 骨架；旧格式模板仅用于迁移存量包。
- `approve` 仅旧格式使用；flow 包的批准由 `publish --approved true` 完成。
- `image_skill_pipeline` 的 `create`/`add_material`/`lock_materials`/`set_prompt`/`confirm_prompt`/`start_generation` 自动识别 flow 记录（registry record 含 `contract.flow` 且 `primary_output=image`），其余机制不变。
