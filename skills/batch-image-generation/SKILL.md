---
name: batch-image-generation
description: 分组批量生图（每组多张候选、多组并发、人工选图）：用 batch_image 工具的确定性调度器，代替子 Agent 生图。需要明确比例与付费批次确认。
whenToUse: 用户要求"每组生成 N 张""10 路并发生图""多组候选图""编号选图板"等批量场景时。
---

# 批量图片候选生成（确定性调度器）

1. **明确比例**：先让用户选择 8 个支持比例之一（manifest 中每组的 `image_ratio`，或全局 `image_ratio`）。
2. **付费确认**：执行前向用户确认这是一次付费批次（可能消耗多张额度）。
3. 构造 manifest：`{ groups: [{ id, prompt, candidates, image_ratio, reference_images?, original_image? }], image_resolution?, image_provider?, concurrency?, deadline_seconds?, completion_grace_seconds? }`；组 id 唯一、prompt 非空、candidates ≥ 1。`reference_images` 为该组所有候选的参考图路径（顺序有语义，相对 manifest 所在目录解析）；`original_image` 为联系表槽 0 的素材/风格参考（多参考时务必显式指定，防止素材参考误占槽 0）。`image_resolution` 为批次级可选 `1K`/`2K`/`4K`（缺省按线路默认：Gemini 2K、GPT 4K、Dreamina 1K）；`image_provider` 为批次级用户明确点名线路（所有候选只走该线路、失败不回退，缺省用默认串行回退顺序）；`completion_grace_seconds` 为完成宽限期（>0 且 ≤120，缺省 120，可缩短不可延长）。可用 `manifest_path` 传入 JSON 文件。
4. 调用 `batch_image` 的 `start`：调度器后台执行（最多 10 路并发、真实提交间隔 ≥ 1 秒）。分派截止默认 ceil(总数÷并发)×60 秒×1.5（可用 `deadline_seconds` 覆盖）：**截止后不再启动新任务**，未启动任务永久 `abandoned`；已在运行的任务最多再等 `completion_grace_seconds`，宽限期内落地成功照常收集，超时仍未完成的运行中任务终止并标记 `failed`。总最大运行时长 = 截止 + 宽限期。返回稳定 `job_key`。
5. 用 `batch_image` 的 `status` 轮询进度；不要自行并发调用 `generate_image` 代替调度器（会绕过去重、间隔与截止）。
6. 结束后用 `contact_sheet` 生成编号联系表（固定槽位，人工选图）；**不做自动视觉质量判断或尺寸淘汰**。
7. 截止/宽限后未完成的任务绝不查询、重试或静默重提；同一 manifest 的 job key 稳定，重复提交会被拒绝。
