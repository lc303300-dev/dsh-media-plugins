---
name: video-prompt-orchestrator
description: 统一视频编排器（Codex_DT codex-dt-video-prompt 的 DSH 重建），即"导演线"，也是默认且唯一的视频创作线。用户要从文本/图片/视频/音频生成或测试视频时使用：仅当用户明确说不修改提示词时才只做语义保真规范化，否则一律用导演知识+语料补全结构与镜头方案；多张素材或用户要求逐素材创作/先看提示词再确认时，在本线走批次模式（1024px 预览 + 审阅页 + 逐段语料门）。默认不触发业务 Skill 线（skill_registry / project_pipeline）——只有用户显式要求启用 Skill 模式时才改走 video-skill-router。
whenToUse: 用户要从文本、图片、视频或音频生成/测试视频，或要求补全、优化、改写视频提示词后再生成时。这是默认视频创作线。
---

# 导演线编排器（按用户意图路由）

> 本技能是 Codex_DT `codex-dt-video-prompt` 在 DSH 的等价物，是**默认且唯一**的视频创作线，接在 `default-video-generation` 之前。
> 原独立的 DT 批次线已并入本线：多素材创作直接在这里走批次模式，不再有第二套入口。
> 下游付费执行一律走 `default-video-generation` / 统一 `generate_video`，不直接调用任何供应商 CLI。

## 一、线路判定（每次先做这一步）

1. **默认走本线**。用户没有明说"启用 Skill 模式"时，一律走本线——**不得检索业务 Skill、不得调用 `skill_registry`、不得调用 `project_pipeline`**，也不要在回复里暗示存在另一条线。
2. **仅当用户显式要求启用 Skill 模式**（如"启用 skill 模式""用业务 Skill""走 skill 线""用 XX 业务包"）时，改走 `video-skill-router`，并**在进入的第一句明确告知用户"已进入 Skill 模式"**。
3. 已经存在 `project_pipeline` 项目时，继续该项目即可；不要因为存在项目就主动开启新的 Skill 线，也不要在用户没要求时新建项目。

## 二、非破坏性提示词门（按用户意图路由）

读任何语料/参考/改写前，先判断用户对这段提示词的态度：

- **只规范化（normalize-only）**：**仅当用户明确说不修改提示词**时（如"保持原样/别改/直接发/就这样用/不要动/不要优化"），才走这条路径，只做"语义保真规范化"，绝不做创意改写。
- **导演+语料补全（默认路径）**：**只要用户没有明确说"不修改提示词"**，一律走导演知识+语料补全——即使提示词看起来已完整、甚至用户已标记为最终，也不再以"提示词是否完整"作为只规范化的依据。**提示词的完整/不完整不再决定是否只规范化，只决定补全的深度。**

### 用户明确不修改提示词 → 语义保真规范化（只改执行层面）

1. **保留真实含义**：主体身份、动作、因果、镜头意图、时序/顺序、构图、风格、情绪、连续性、约束、音频要求、预期结尾，一律不变。
2. **只允许执行导向的修正**：把畸形参考标签（如 `@图片1`、`@Image 1`）规范为当前适配器裸标签（`图片1`）；把参考编号与传入的有序媒体对齐；修复破损的标题/分隔符/列表结构/标点/明确的专业术语错误；删除重复的、无创意意义的平台/工具指令。
3. **不得**增删、强化、弱化、重新解释、总结、翻译或重排创意内容。**不得**追加音频句、负面约束、镜头想法、语料技巧或新的视觉细节。
4. 若某个修正有歧义、可能改变含义，**保留原样并指出**，而不是猜测。
5. 不要用导演/语料作为创意增补来源；只用适配器/编译器规则规范标签与提交语法。
6. 缺省的时长/比例/分辨率/模型/执行模式作为结构化工具参数传入，**不要注入提示词**。
7. 用规范化后的提示词 + 原始有序媒体调用 `default-video-generation`。

## 三、批次模式（多素材，或用户要求先审阅）

**触发条件（满足任一）**：一次给了 ≥2 张素材、要按素材逐条创作；或用户要求"先看提示词再确认""逐条给我确认"。

1. **建隔离批次**：`prompt_batch` 的 `new_batch`（带短描述名）或 `init_batch`，传 duration、ratio、model、user_requirements、materials（路径顺序即素材编号）。对话附件先 `import_images`；新对话多附件场景先只导入并初始化，首轮不生成。
2. **准备预览**：`prepare_previews` 生成最长边 1024px 预览并记录映射；**不要直接检查原始大图**。每段可多图：额外参考图用 `set_visuals` 的 `items[].images` 绑定（顺序即 `--image` 顺序）。
3. **▶ 逐段检索语料并逐条列出命中（不可跳过，代码强制）**：写任何一段之前，先对该段用 `prompt_revision search_corpus` 检索（≤10 条，只提取可迁移的镜头结构/导演方法，**不复制案例**）——该调用返回一张**一次性检索凭证 `search_id`**；随后用 `prompt_revision authoring_gate` 传 `search_id`、`current_prompt`（该段草稿）、`media={images:该段参考图数, videos, audios}`、`segment=该段 material 的绝对路径`。**只有 `authoring_gate` 返回 `ok=true` 才可继续写该段**；凭证在通过时被消费并绑定到该段，**同一张凭证不可复用——N 段就必须 N 次检索**（`set_prompts` 会逐段核对已消费凭证，缺凭证的段直接拒写）。检索后**逐条向用户列出该段命中的语料**（编号/标题/得分/可迁移结构）；语料的模型/版本只作 provenance，**绝不据此选生成模型**。每段开始前先输出 `▶ 步骤`。
4. **▶ 编写提示词（逐素材）**：**先加载 `video-director-prompt` 技能**，按其 `references` 路由使用导演知识：`directing-methods.md`（每次必读）、`prompt-structure.md`、`community-techniques.md`、`structure-guide.md`，并对照其"交付前检查清单"。**用中文裸标签（图片1、视频1、音频1…）严格绑定传入顺序，禁用 `@图片1` 等 chip 形式与 `参考图片N` 前缀**；用户未指定音频时追加 `不生成音乐，仅生成音效。`。用 `set_prompts`（[{material, prompt}]）写入——它按 material 合并、自动规范化标签，并对**缺少 `图片N` 绑定的段、以及没有自己那张已消费检索凭证的段整次拒绝**。
5. **▶ 生成审阅页**：`finalize_review` 生成 `review/index.html`（逐段列出全部参考图 + 中文提示词），把路径交给用户**逐项确认**素材绑定；未经确认不得提交。
6. **▶ 提交**：确认后 `run_batch` 生成提交计划（含 asset_manifest 标签绑定），交给统一 `generate_video`（不同素材用 `tasks` 数组、每段 `tasks[].images` 绑定该段全部参考图；同一素材多份用 `video_count`；不同时长按时长分组提交）。正式 production 提交前把已确认的模型/分辨率/时长作为 `video_confirmation_model` / `video_confirmation_resolution` / `video_confirmation_duration` 传入且须与最终值一致。

## 四、单条模式（素材 ≤1 且用户没要求逐条审阅）

> **强制透明步骤输出**：走本路径时必须向用户显式展示创作过程——每开始一个步骤先输出 `▶ 步骤 N：<名称>`，检索语料的步骤完成后再**逐条列出命中的语料**（编号、标题、得分、可迁移结构；来源模型/版本只作 provenance）。

1. **▶ 步骤 1：读取输入**。先读用户有序媒体、请求的时长/比例/风格/运镜/音频偏好/约束。
2. **▶ 步骤 2：加载导演知识**。**加载 `video-director-prompt` 技能**作为平台无关创作层；按需用其 `directing-methods.md`、`prompt-structure.md`、`community-techniques.md`、`structure-guide.md`。
3. **▶ 步骤 3：检索语料并逐条列出命中（不可跳过，代码强制）**。一律先用 `prompt_revision search_corpus` 检索（≤10 条，只提取可迁移的镜头结构/导演方法，**不复制案例**），取得返回的**一次性凭证 `search_id`**；随后用 `prompt_revision authoring_gate` 传 `search_id`、`current_prompt`、`media={images,videos,audios}`（单条模式可省略 `segment`，凭证按提示词哈希绑定）——**只有当 `authoring_gate` 返回 `ok=true` 才可继续创作**，凭证一经消费即作废，自报命中数不再被接受。拿到结果后**逐条向用户展示命中语料**：`编号（id）`、`标题`、`得分`、`可迁移结构`；`source_model`/版本只作 provenance。
4. **▶ 步骤 4：写提示词**。写一段简洁、可独立执行的中文视频提示词，保留用户的主体/身份/构图/时长/比例/运镜偏好，**用裸标签（图片1、视频1、音频1…）严格绑定传入顺序**。
5. **▶ 步骤 5：应用参考绑定/清理规则**。每个引用分配明确职责（仅身份/仅服饰/仅首帧/仅运镜…），说明什么**不要**从该源转移；删除模型名、分辨率、参考模式、API/上传/工具调用措辞、系统规则套话；正需求只写一次，负面/约束只放一次。
6. **▶ 步骤 6：音频默认**。**用户未指定音频时，追加 `不生成音乐，仅生成音效。`**（仅创作路径；已定稿提示词不得追加）。
7. **▶ 步骤 7：提交**。调用 `default-video-generation` 用优化后的提示词 + 原始有序媒体。

## 五、修订（受约束）

**本线（无项目状态机）的修订**用 `prompt_revision` 直接做：

1. `classify`（传 `current_prompt`、`user_feedback`、`locked_context`）拿到确定性分类与受约束修订请求：
   - `explicit_local`：只改用户指出的内容，**禁止** `search_corpus`；
   - `ambiguous_creative` / `structural_rewrite`：可 `search_corpus`（≤10 条），只提取可迁移结构，不复制案例；
   - 不改变已确认硬约束（素材顺序、比例、时长）；语料模型版本绝不用于选模型。
2. 修订后重新写入：批次模式用 `set_prompts`，单条模式直接交 `default-video-generation`。
3. 结果必须通过 `validate_result`（回显同一 `locked_context_sha256`、`preserved_unspecified_content=true`），然后交用户再次确认。
4. 修订步不提交视频。

**Skill 线（业务 Skill V1 之后）的修订**不要在本科能做：那属于 `video-skill-router` 的项目管线，用 `project_pipeline` 的 `request_revision` → `begin_revision` → `set_prompt`（source=governed_revision）→ 再次 `confirm_prompt`。

## 六、优先级与边界

- 先遵循当前工作区/项目 `AGENTS.md`。
- **默认走本线**；仅在用户显式要求启用 Skill 模式时才交给 `video-skill-router`，并先告知用户已进入 Skill 模式。
- 仅当用户明确说不修改提示词时，才只做语义保真规范化后交给 `default-video-generation`；否则一律走导演+语料补全。
- 本线不建立项目、不做素材/提示词哈希锁定、不做付费批次确认门——这些是 Skill 线的机制，不要在本线冒充。
