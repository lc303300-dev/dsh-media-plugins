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
