---
name: video-to-gif
description: 把本地视频转成 GIF（质量优先的 FFmpeg 双遍 palette 流水线，默认 ≤10MB），支持宽高比保持、临时目录隔离与批量逐条报告。
whenToUse: 用户要把视频片段转成 GIF、控制 GIF 体积上限、或批量转换时。
---

# 视频转 GIF

1. 调用 `video_to_gif`，传入本地视频路径（mp4/mov/webm/mkv/avi）。
2. 默认体积上限 10MB；用户有明确体积要求时传 `max_size_mb`。
3. 工具按 宽度/FPS/抖动 分档自动降级（960→720→640→480→360），返回满足上限的最高质量档；全部超限时返回最小产物并标记 `within_budget=false`，如实告知用户。
4. 批量时逐文件调用、逐条报告；不要用子 Agent 并行做同一文件的多个档位（工具内部已做分档搜索）。
5. 需要 ffmpeg：优先 `FFMPEG_PATH` 环境变量，其次 PATH，再常见安装位置；缺失时先安装或配置再调用。
