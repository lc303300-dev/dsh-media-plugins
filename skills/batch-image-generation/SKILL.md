---
name: batch-image-generation
description: 分组批量生图（每组多张候选、多组并发、人工选图）：用 batch_image 工具的确定性调度器，代替子 Agent 生图。需要明确比例与付费批次确认。
whenToUse: 用户要求"每组生成 N 张""10 路并发生图""多组候选图""编号选图板"等批量场景时。
---

# 批量图片候选生成（确定性调度器）

1. **明确比例**：先让用户选择 8 个支持比例之一（manifest 中每组的 `image_ratio`，或全局 `image_ratio`）。
2. **付费确认**：执行前向用户确认这是一次付费批次（可能消耗多张额度）。
3. 构造 manifest：`{ groups: [{ id, prompt, candidates, image_ratio }], concurrency?, deadline_seconds? }`；组 id 唯一、prompt 非空、candidates ≥ 1。可用 `manifest_path` 传入 JSON 文件。
4. 调用 `batch_image` 的 `start`：调度器后台执行（最多 10 路并发、真实提交间隔 ≥ 1 秒、硬截止默认 ceil(总数÷并发)×60 秒×1.5），返回稳定 `job_key`。
5. 用 `batch_image` 的 `status` 轮询进度；不要自行并发调用 `generate_image` 代替调度器（会绕过去重、间隔与截止）。
6. 结束后用 `contact_sheet` 生成编号联系表（固定槽位，人工选图）；**不做自动视觉质量判断或尺寸淘汰**。
7. 截止后未完成的任务被永久标记 abandoned（不查询、不重试）；同一 manifest 的 job key 稳定，重复提交会被拒绝。
