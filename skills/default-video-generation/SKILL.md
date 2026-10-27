---
name: default-video-generation
description: 统一生视频：通过 generate_video 的统一视频生成管线（即梦 Dreamina/Seedance）生成视频（文生视频/图生视频/多图、首尾帧、参考视频或参考音频）。单条与批量是同一条管线；默认视频工具，只使用 Seedance/Dreamina。
whenToUse: 用户要生成视频、文生视频、图片生视频、多图/参考视频/参考音频生成视频时。
---

# 默认视频生成（Seedance/Dreamina 统一管线）

> **下游付费执行层**：接在 `video-prompt-orchestrator` 编排器之后。`video-prompt-orchestrator` 负责"按用户意图判断 → 用户明确不修改时只做语义保真规范化，否则导演+语料补全"；本技能只负责把定稿/规范化后的提示词交给统一 `generate_video` 执行，**不自行改写、翻译、重排、归纳或追加创意内容**。

generate_video 是**一条统一管线**，不区分单条与批量：任何一次调用都会分解成 N 个隔离任务（各占独立下载目录），先并发提交，再（production 模式）统一轮询、按各自 submit_id 精确取回视频，绝不会把 A 任务的视频当成 B 任务的结果。

1. **默认与边界**：默认模型 `seedance_2.5`、默认分辨率 `480p`、默认比例 `16:9`、默认时长 `5` 秒。seedance_2.5 支持 `480p/720p/1080p`、4-30 秒；seedance_2.0_vip 支持 `480p/720p/1080p/4k`。只有当前用户明确要求时才能使用 seedance2.0 系列（普通显式 2.0 会归一化为 `seedance_2.0_vip`）。
2. **参考模式**：只传 `prompt` → text2video；传任意 `images`/`videos`/`audios` 参考 → 全能参考模式 multimodal2video。`multiframe2video` 是禁用的遗留命令，不得选择或提交。素材顺序即素材编号，prompt 中用中文裸标签（图片1、视频1、音频1）引用素材，序号对应该类素材传入顺序。
   - **默认就是全能参考（m2v）**：只要有参考素材就走 m2v，**不得**因为"一张起点图 + 一张终点图"就自动改成首尾帧。`first_last_frame` 只在用户明确要求时使用。
   - **画布直调同一个默认**：`--mode m2v`；纯文字才 `t2v`；`first_last_frame` 只吃图片、且只在用户点名时使用。
   - **一条 vs 多条**：用户给的是一个整体时长（"一条 15 秒"）就只建**一个**视频节点、一次生成；分段写进同一条提示词内部，不拆节点。真要多条时说明原因。
3. **确认门（正式提交前必须）**：production / production_submit_only 提交前，用户须明确确认**模型、分辨率、时长**，并把三者以 `video_confirmation_model`、`video_confirmation_resolution`、`video_confirmation_duration` 传入，且必须与最终解析值完全一致，否则工具拒绝提交。test_submit_only 跳过确认门。
4. **执行模式**：普通请求用默认 `production`（提交+轮询+下载）；仅当用户明确要求"只提交/测试通道"时用 `production_submit_only` 或 `test_submit_only`（测试通道返回 submit_id 后请用户到即梦后台查看，绝不自动轮询下载；测试通道必须提供 `video_group`，且只允许 1 个任务）。
5. **多份/多任务**：
   - 同一 prompt+参考生成 N 份：`video_count`（1-10）。
   - 不同素材/不同 prompt 的 N 个任务：`tasks` 数组 `[{prompt, image?, images?, videos?, audios?}]`（提供时忽略 video_count；模型/分辨率/时长/比例在调用级共享）。两种都走同一条管线，一次提交、一次轮询。
6. **分组**：`video_group` 指定会话分组名（自动加 `YYYY_MM_DD-` 日期前缀），管线复用或新建即梦会话，**同组所有任务共享同一 session**；不传则用默认会话 0。
7. **任务状态**：任务状态与 `submit_id` 持久化在私有运行目录，同一任务绝不重复提交；不确定提交（needs_review）绝不自动重试。
8. 每次调用消耗积分：正式提交前确认意图与时长/比例/分辨率/模型。

## 创作门（视频端硬门）

> `generate_video` 在 **production / production_submit_only** 提交前会检查本工作区最近 24 小时是否有 `creative_writer` 记录（`kind ∈ {prompt, script, story, copy}`）；没有就**拒绝提交**。图片提示词不在此门范围。

- **正常路径**：先按契约调 `creative_writer` 产出提示词，再提交，记录自动满足。
- **用户自带提示词 / 明确要求不改写（normalize-only）**：传 `allow_manual_prompts: true`，并**必须**传 `manual_prompts_reason`（如“用户自带提示词，要求原样提交”）；结果会回 `manual_prompts: true` 留痕。缺 reason 会被拒绝。
- **Agent 自写是最终兜底**：`creative_writer` 不可用、或失败一次后，Agent 可以直接写提示词并提交，但必须走同一条豁免（`allow_manual_prompts: true` + reason 说明“Gemini 失败后的 Agent 兜底”）。**不得静默手写**。
- **test_submit_only**：豁免（测试通道不交付内容）。
- 被拒时不要反复重试同一次提交：先补 `creative_writer`，或按上两条显式豁免。

## 画布项目唯一性（默认，硬规则）

> 用户 2026-10-14 明确：**一个对话窗口默认只使用同一个即梦画布项目**。

1. **默认锚定**：本会话第一次需要画布时就确定**唯一**的 canvas project（优先复用当前项目或用户已确认的项目；`video_group`/`canvas_project_id` 都指向它），此后本次会话的**所有**卡片创建、素材上传登记、生成、下载都落在同一个项目里，给用户的画布链接也始终是这一个。**既没有当前项目、也没有用户确认过的项目时，用 `canvas ls` 列出已有项目让用户挑一个——仍然不新建。**
2. **不得为了新任务新建**：新素材、新卡片、新提示词、新时长、新批次都不构成新建项目的理由；用户没有明确要求时**不得**调用 `dreamina-canvas canvas create`。
3. **只有用户显式要求才新建**（"新建项目 / 新画布 / 开个新画布"）：建之前先确认名称与用途，建成后它即本会话的唯一项目；用 `--use` 设为当前。
4. **会话恢复或换窗口**：先用 `canvas ls` 或持久化的 projectId 认下已有项目再继续，不要另起一个。
5. **例外**：原项目不可用时（无权限、已删除、状态异常）先报告原因，再新建。
6. **不要混淆**：这里指的是**即梦画布项目**（canvas project）；Skill 线的 `project_pipeline` 项目是治理层状态机，两者不是一回事。

## 生成启动门（硬门，不可跳过）

视频提交（`generate_video`，以及 `dreamina_canvas` 的 `node run` / `--run`）强制校验一次性票据 `launch_ticket`：

1. 写计划并登记：`node scripts/launch-gate.mjs plan --json plan.json` → `pl_xxx`；
2. 由用户本人在终端运行 `node scripts/launch-gate.mjs ask --plan pl_xxx`，输入「自动开始任务」→ `lt_xxx`；
3. 带 `launch_ticket=lt_xxx` 调用 `generate_video`。

票据一次性、30 分钟过期、范围锁定（工具 / 项数 / 总时长），提交时消费。Agent 没有 TTY，**不得代批、不得复用、不得绕过**；拿不到票据就停下，把计划与 `pl_xxx` 交给用户批准。
图片线路（`generate_image` / `batch_image` / upscale / 图片节点）不过门。
