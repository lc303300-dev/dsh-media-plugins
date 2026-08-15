# Codex_CS 视频业务 Skill 包标准

## 1. 设计目标

标准只统一确定性接口，不统一创意内容。不同 Skill 可以拥有完全不同的视觉语言、镜头方法和社区经验，但必须使用相同的素材契约、知识分层、验证与发布机制。

规范词：`必须`表示发布硬要求；`建议`表示默认做法；`可以`表示可选能力。

## 2. 标准目录

```text
<skill-id>/
├─ SKILL.md
├─ contract.json
├─ routing.json
├─ intake-receipt.json
├─ agents/
│  └─ openai.yaml
└─ references/
   ├─ creative-guidance.md
   ├─ community-experience.md
   ├─ failure-cases.md
   └─ examples.md
```

暂存包在用户批准前不得包含 `intake-receipt.json`。正式注册器只发现带有效凭证的包。

`routing.json` 只描述用户创作意图的检索入口，包括别名、用途、主体、风格、叙事模式和反向排除词。它不根据用户当前已有素材选择 Skill，也不替代 `contract.json`。选定 Skill 后，素材指导仍以 `contract.json` 为唯一权威。

## 3. 命名

- 文件夹与 `skill_id` 必须一致，只使用小写字母、数字和连字符，长度不超过 64。
- `SKILL.md` frontmatter 的 `name` 必须等于 `skill_id`。
- 中文人类可读名称写入 `contract.json.display_name`、正文标题和 `agents/openai.yaml.display_name`。
- 显示名称在正式库内必须唯一。

## 4. SKILL.md

Frontmatter 只能包含：

```yaml
---
name: example-video-skill
description: 说明该 Skill 做什么，以及哪些用户请求应触发它。
---
```

正文只保留每次执行都需要的信息：核心任务、知识加载路由、执行顺序、用户指令优先级和禁止事项。正文不得复制完整社区语料或大量示例。

## 5. contract.json

契约只描述确定性事实：

- Skill 身份和显示信息；
- 参考素材槽及数量；
- 可接受的视频引用模式；
- 创作阶段需要的确认和观察；
- 四类知识文件的位置。

每个 `references` 项必须包含：

| 字段 | 含义 |
|---|---|
| `id` | 稳定、唯一的英文槽位标识 |
| `media_type` | `image`、`video` 或 `audio` |
| `role` | 规范角色，如 `identity`、`scene`、`style`、`start_frame`、`end_frame`、`footage`、`music`、`sound`、`other` |
| `description` | 给用户和 Agent 的准确业务说明 |
| `required` | 是否必填 |
| `min_count` | 最少数量 |
| `max_count` | 最大数量；未知上限为 `null` |
| `count_rule` | 该槽如何根据视频时长计算目标数量，以及规则来源、置信度和是否硬性执行 |
| `ordered` | 同一槽内多项素材是否有顺序语义 |
| `observation_required` | 创作前是否必须观察媒体内容 |

所有视频业务 Skill 的参考素材最小总数必须大于零。禁止 `text2video`。平台支持上限、实际模型和分辨率由 Wsstudio 统一执行层决定，不写入业务契约。

每个槽必须声明 `count_rule`，不得留给运行时猜测：

- `fixed`：固定数量，适合 Logo、IP 身份图、首尾帧等不随时长增加的素材。
- `duration_formula`：按 `duration × duration_share ÷ seconds_per_item` 计算，并使用 `ceil`、`floor` 或 `round` 取整。
- `duration_lookup`：按 Skill 明确提供的时长—数量锚点选择最近值，适合非线性镜头结构。
- `bounded_recommendation`：计算推荐数量，但只用 `min_count` / `max_count` 作为硬边界。

`enforcement` 为 `required` 时，项目锁定素材必须与计算数量完全一致；为 `recommended` 时只展示建议数量。`provenance` 必须区分 `source_explicit`、`curator_default` 或 `user_approved_inference`。来源未明确节奏时，入库流程自动补充保守默认规则并标为 `curator_default`，同时在审核报告中展示，不得伪装成来源事实。

## 6. 知识分层

- `creative-guidance.md`：经过整理的专业创作方法。
- `community-experience.md`：保留社区结论、适用条件、证据等级与来源背景。
- `failure-cases.md`：失败表现、可能原因、修复策略。
- `examples.md`：正例、反例、边界案例；不得定义素材契约。

一个事实只保存在最合适的一处。不要在四个文件间重复长段内容。

## 7. 优先级

统一优先级为：

```text
用户当前明确指令
> 已确认的确定性素材契约
> 当前业务 Skill 的专业规则
> 有适用条件的社区经验
> 示例
```

示例永远不能覆盖用户指令或契约。

## 8. 发布凭证

`intake-receipt.json` 必须由发布脚本生成，不手写。凭证记录：

- 验证器版本；
- 用户批准主体；
- 原始来源路径标签和 SHA-256；
- 不含凭证自身的标准包 SHA-256；
- 发布时间和验证状态。

包内容变化后，旧凭证立即失效，必须重新走审核和发布流程。

## 9. 禁止内容

执行入口文件 `SKILL.md` 和 `contract.json` 中不得包含：

- 本机绝对路径；
- API Key、Cookie、Authorization 等凭据；
- provider 或 CLI 直调命令；
- `model_version`、轮询、下载或付费执行策略；
- `text2video`；
- 终端输出和异常日志；
- `START OF FILE` 等导出包装；
- 未处理的模板占位符。

历史模型或平台经验可以保留在参考文档，但必须标记为来源背景，不得决定当前执行。
