---
name: dt-prompt-authoring
description: DT 批次创作流程：初始化隔离批次、生成 1024px 预览、逐素材编写可执行中文视频提示词、生成审阅页供用户逐项确认后才提交视频。
whenToUse: 用户提供多张素材图片（或要求按素材逐条创作）要生成视频，或要求"先看提示词再确认"时。
---

# DT 批次创作（提示词编译器 + 审阅工作台）

1. **创建隔离批次**：文本优先用 `dt_batch` 的 `init_batch`（传 duration、ratio、model、user_requirements、materials 路径列表，顺序即素材编号）。新对话多附件场景先只导入和初始化，首轮不生成。
2. **准备预览**：`prepare_previews` 把素材转成最长边 1024px 预览并记录映射；**不要直接检查原始大图**。
3. **编写提示词**：逐素材编写可执行中文视频提示词（导演知识负责场面、镜头、表演、光色、声音；语料库仅作结构参考，见 refs/director-corpus.md），用 `set_prompts` 写入（[{material, prompt}]）。
4. **生成审阅页**：`finalize_review` 生成 `review/index.html`（素材预览 + 中文提示词逐项对照），把路径交给用户逐项确认；用户确认素材绑定后才允许提交。
5. **提交**：确认后调用统一 `generate_video`（多图默认 multimodal2video、seedance2.5）；**不直接调用任何供应商 CLI**。
6. 修订策略：明确局部修改跳过语料；模糊/创意/结构修订最多参考 3 条相关示例（语料见 refs/director-corpus.md），且不改变已确认的硬约束。
