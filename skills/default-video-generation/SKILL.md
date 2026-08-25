---
name: default-video-generation
description: 统一生视频：通过 generate_video 的统一视频生成管线（即梦 Dreamina/Seedance）生成视频（文生视频/图生视频/多图、首尾帧、参考视频或参考音频）。单条与批量是同一条管线；默认视频工具，只使用 Seedance/Dreamina。
whenToUse: 用户要生成视频、文生视频、图片生视频、多图/参考视频/参考音频生成视频时。
---

# 默认视频生成（Seedance/Dreamina 统一管线）

> **下游付费执行层**：接在 `dt-video-prompt` 编排器之后。`dt-video-prompt` 负责"按用户意图判断 → 用户明确不修改时只做语义保真规范化，否则导演+语料补全"；本技能只负责把定稿/规范化后的提示词交给统一 `generate_video` 执行，**不自行改写、翻译、重排、归纳或追加创意内容**。

generate_video 是**一条统一管线**，不区分单条与批量：任何一次调用都会分解成 N 个隔离任务（各占独立下载目录），先并发提交，再（production 模式）统一轮询、按各自 submit_id 精确取回视频，绝不会把 A 任务的视频当成 B 任务的结果。

1. **默认与边界**：默认模型 `seedance2.5`、默认分辨率 `480p`、默认比例 `16:9`、默认时长 `5` 秒。seedance2.5 支持 `480p/720p/1080p`、4-30 秒；seedance2.0_vip 支持 `480p/720p/1080p/4k`。只有当前用户明确要求时才能使用 seedance2.0 系列（普通显式 2.0 会归一化为 `seedance2.0_vip`）。
2. **参考模式**：只传 `prompt` → text2video；传任意 `images`/`videos`/`audios` 参考 → 全能参考模式 multimodal2video。`multiframe2video` 是禁用的遗留命令，不得选择或提交。素材顺序即素材编号，prompt 中用中文裸标签（图片1、视频1、音频1）引用素材，序号对应该类素材传入顺序。
3. **确认门（正式提交前必须）**：production / production_submit_only 提交前，用户须明确确认**模型、分辨率、时长**，并把三者以 `video_confirmation_model`、`video_confirmation_resolution`、`video_confirmation_duration` 传入，且必须与最终解析值完全一致，否则工具拒绝提交。test_submit_only 跳过确认门。
4. **执行模式**：普通请求用默认 `production`（提交+轮询+下载）；仅当用户明确要求"只提交/测试通道"时用 `production_submit_only` 或 `test_submit_only`（测试通道返回 submit_id 后请用户到即梦后台查看，绝不自动轮询下载；测试通道必须提供 `video_group`，且只允许 1 个任务）。
5. **多份/多任务**：
   - 同一 prompt+参考生成 N 份：`video_count`（1-10）。
   - 不同素材/不同 prompt 的 N 个任务：`tasks` 数组 `[{prompt, image?, images?, videos?, audios?}]`（提供时忽略 video_count；模型/分辨率/时长/比例在调用级共享）。两种都走同一条管线，一次提交、一次轮询。
6. **分组**：`video_group` 指定会话分组名（自动加 `YYYY_MM_DD-` 日期前缀），管线复用或新建即梦会话，**同组所有任务共享同一 session**；不传则用默认会话 0。
7. **任务状态**：任务状态与 `submit_id` 持久化在私有运行目录，同一任务绝不重复提交；不确定提交（needs_review）绝不自动重试。
8. 每次调用消耗积分：正式提交前确认意图与时长/比例/分辨率/模型。
