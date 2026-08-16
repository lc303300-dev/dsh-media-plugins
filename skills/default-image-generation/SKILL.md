---
name: default-image-generation
description: 统一生图/改图：通过 generate_image 工具按用户明确选择的比例生成或编辑图片。默认图片工具，不主动要求用户选择供应商；用户明确点名线路时通过 image_provider 直达。
whenToUse: 用户要生成图片、画图、文生图，或用一张或多张参考图编辑/合成/改图时。
---

# 默认图片生成（统一媒体路由器）

1. **比例必填**：调用 `generate_image` 前，要求用户明确选择 8 个支持比例之一：`21:9`、`16:9`、`3:2`、`4:3`、`1:1`、`3:4`、`2:3`、`9:16`。用户未明确时**停止并询问**；绝不从参考图方向、提示词、历史轮次、文件名或供应商默认推断。通过结构化 `image_ratio` 字段传入。
2. **分辨率可选**：`image_resolution` 只接受 `1K`/`2K`/`4K`；用户未明确时缺省（Gemini 线路 2K、GPT 线路 4K、Dreamina 1K）。用户点名分辨率时原样传入，不要改写。
3. **线路选择**：不主动询问供应商。仅当用户在当前请求中明确点名一个受支持且无歧义的线路（`comfly-gemini-flash-preview`/`comfly-gemini-lite`、`comfly-gpt-image-2`、`apimart-gpt-image-2`、`google-gemini-image`、`dreamina-image`）时，才通过 `image_provider` 传入该线路；指定后只走该线路、失败不回退。不要猜模糊名称（如"Gemini"在 Comfly 与官方 Google 之间是歧义的）。
4. 传非空 `prompt`；图生图时把参考图路径按语义顺序放入 `image` 列表。
5. 不要把 API 参数暴露给用户；默认回退顺序、并发、超时由路由器内部处理。默认串行回退顺序：comfly-gemini-flash-preview → comfly-gpt-image-2 → apimart-gpt-image-2 → google-gemini-image → dreamina-image。
6. 每次调用都是外部付费操作：生成前确认用户意图；不做投机性生成。
7. 返回结果后直接使用工具返回的路径；不要用原始 Windows 反斜杠路径拼 Markdown 链接。
8. 提交结果不确定（needs_review）时禁止自动重试或换供应商重试，提示用户人工核对后台。
9. 参考图会自动做 EXIF 方向归一化与最长边 1920px 等比缩放后提交，绝不覆盖原图。
