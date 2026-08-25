---
name: dt-prompt-authoring
description: DT 批次创作流程：初始化隔离批次、生成 1024px 预览、逐素材检索语料并通过创作门、编写可执行中文视频提示词、生成审阅页供用户逐项确认后才提交视频。
whenToUse: 用户提供多张素材图片（或要求按素材逐条创作）要生成视频，或要求"先看提示词再确认"时。
---

# DT 批次创作（提示词编译器 + 审阅工作台）

> 本流程的提示词创作**必须先检索语料、通过 `prompt_revision authoring_gate` 创作门**，不得凭印象直接写（对应 Bug 总汇 BUG-02）。写作门槛与 `dt-video-prompt` 编排器一致。**创作过程必须强制透明输出**：每开始一个步骤先输出 `▶ 步骤`，检索语料完成后**逐条列出该段命中的语料**（编号/标题/得分/可迁移结构），语料模型版本只作 provenance、绝不选模型。

1. **创建隔离批次**：文本优先用 `dt_batch` 的 `init_batch`（传 duration、ratio、model、user_requirements、materials 路径列表，顺序即素材编号）。新对话多附件场景先只导入和初始化，首轮不生成。每段可多图：额外参考图用 `set_visuals` 的 `items[].images` 绑定（顺序即 `--image` 顺序）。

2. **准备预览**：`prepare_previews` 把素材转成最长边 1024px 预览并记录映射；**不要直接检查原始大图**。

3. **▶ 逐段检索语料并逐条列出命中（不可跳过）**：写任何一段之前，先对该段用 `prompt_revision search_corpus` 检索（≤10 条，只提取可迁移的镜头结构/导演方法，**不复制案例**），随后用 `prompt_revision authoring_gate` 传 `current_prompt`（该段草稿）、`media={images:该段参考图数, videos, audios}`、`corpus_hits=实际命中数`。**只有 `authoring_gate` 返回 `ok=true`（complete，或 incomplete 但已查语料）才可继续写该段**；返回错误时先补检索语料。检索后**逐条向用户列出该段命中的语料**（编号/标题/得分/可迁移结构）；语料的模型/版本只作 provenance，**绝不据此选生成模型**。每段开始前先输出 `▶ 步骤` 声明当前进行到的环节。

4. **▶ 编写提示词（逐素材）**：逐素材编写可执行中文视频提示词。**先加载 `video-director-prompt` 技能**（调用 `skill` 工具），按其 `references` 路由使用导演知识：`directing-methods.md`（可视化表达/场面调度/表演/光色/物理/声音）每次必读、`prompt-structure.md`（提示词区块/剪辑/素材语义/交付格式）、`community-techniques.md`（特殊视角/高速动作/复杂转场/极端 FOV/社区实战技巧）、`structure-guide.md`（seedance-forge 结构指南），并对照其"交付前检查清单"（首帧非空、情绪转可见表演、运镜与主体动作分开、连续性锚点、英文术语留释义等）。**用中文裸标签（图片1、视频1、音频1…）严格绑定传入顺序，禁用 `@图片1` 等 chip 形式与 `参考图片N` 前缀**；用户未指定音频时追加 `不生成音乐，仅生成音效。`。用 `set_prompts` 写入（[{material, prompt}]）——`set_prompts` 会按 material 合并、自动把 `@图片N`/`参考图片N` 规范为裸标签，并对缺少 `图片N` 绑定的段拒绝写入。

5. **生成审阅页**：`finalize_review` 生成 `review/index.html`（逐段列出全部参考图 + 中文提示词，图片路径为 `../previews/`），把路径交给用户逐项确认；用户确认素材绑定后才允许提交。

6. **提交**：确认后调用统一 `generate_video`（统一管线：多图默认 multimodal2video、seedance2.5；不同素材用 `tasks` 数组一次提交，每段 `tasks[].images` 绑定该段全部参考图；同一素材多份用 `video_count`；每个任务隔离下载、按 submit_id 精确轮询）。正式 production 提交前把已确认的模型/分辨率/时长作为 `video_confirmation_model` / `video_confirmation_resolution` / `video_confirmation_duration` 传入且须与最终值一致；不同时长按时长分组提交（`duration` 在调用级共享）。**不直接调用任何供应商 CLI**。

7. **修订（受约束）**：用户要求修改时用 `prompt_revision` 的 `classify`（传 current_prompt / user_feedback / locked_context：contract_rules、material_order、ratio、duration_seconds）获得确定性分类与受约束修订请求：
   - `explicit_local`：只改用户指出的内容，**禁止** `search_corpus`；
   - `ambiguous_creative` / `structural_rewrite`：可 `search_corpus`（最多 10 条），只提取可迁移结构（portable_pattern），不复制案例；
   - 不改变已确认硬约束（契约规则、素材顺序、比例、时长）；语料模型版本绝不用于选模型。
   - 修订结果必须通过 `validate_result`（回显同一 locked_context_sha256、preserved_unspecified_content=true），然后交用户再次确认；DT 修订步骤不提交视频。

8. 导演知识/语料结构参考见 `refs/director-corpus.md`；语料来源与约束见 `refs/forge-NOTICE.md`。
