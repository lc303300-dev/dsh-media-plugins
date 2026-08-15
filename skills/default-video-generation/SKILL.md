---
name: default-video-generation
description: 统一生视频：通过 generate_video 工具用即梦 Seedance 生成视频（文生视频/图生视频/多图、首尾帧、参考视频或参考音频）。默认视频工具，只使用 Seedance/Dreamina。
whenToUse: 用户要生成视频、文生视频、图片生视频、多图/参考视频/参考音频生成视频时。
---

# 默认视频生成（Seedance/Dreamina）

1. 默认模型 `seedance2.5`、默认分辨率 `480p`。只有当前用户明确要求时才能使用 seedance2.0 系列（普通显式 2.0 会归一化为 `seedance2.0_vip`）。
2. 只传 `prompt` → text2video；传任意 `images`/`videos`/`audios` 参考 → 全能参考模式 multimodal2video。两张图且用户明确表达首尾帧语义 → frames2video。`multiframe2video` 是禁用的遗留命令，不得选择或提交。
3. 每个真实提交前用相应子命令 `-h` 做本地校验（generate_video 已内置）。
4. 执行模式：普通请求用默认 production（提交+轮询+下载）；仅当用户明确要求"只提交/测试通道"时用 `production_submit_only` 或 `test_submit_only`（测试通道返回 submit_id 后请用户到即梦后台查看，绝不自动轮询下载）。
5. 素材顺序即素材编号；prompt 中用中文裸标签（图片1、视频1、音频1）引用素材，序号对应该类素材传入顺序。
6. 每次调用消耗积分：生成前确认意图与时长/比例；不确定结果（needs_review）绝不重复提交。
