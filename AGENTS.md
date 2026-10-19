# AGENTS.md

DSH Studio 媒体能力包。一次安装提供 17 个工具、11 个技能与一个完成通知，是 Codex_Wsstudio
能力指南在 DSH 平台上的重建。本文件给在此仓库工作的 Agent 一个最小但足够的上下文。

> **火山方舟通道已屏蔽**：`cordis.patch.yml` 里 `Ws_tool-vision`（`describe_image`）的注册被注释，
> 实际注册 16 个工具；`setup.ps1` 默认也不再引导 `VOLCANO_ENGINE_API_KEY` 与
> `llm-pi-ai.providers.volcengine`。恢复：`.\setup.ps1 -EnableVolcano` + 取消该两行注释 + 重启 dsh。
> `src/tool-vision.ts` 实现保留，`media_status` 里该项显示 `disabled`。

## 插件整体不加载：dsh 版本兼容门（2026-10-18 根因修复）

> **症状**：dsh 重启后 `creative_writer` / `dreamina_canvas` / `media_status` / `generate_video` 等**全部**工具消失，
> GUI 与主进程都没有报错。**根因不在 patch、不在 dist、不在符号链接**。
>
> **机制**：`@deepseek-ai/dsh-app-boot` 启动时对组合后的**每一行**插件行跑 compatibility preflight
> （`evaluatePluginCompatibility` → `prepareProfileEntries`）。manifest 若声明 `engines.dsh` 则只看它；否则检查
> `peerDependencies` 里每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 是否满足**当前 dsh 运行时版本**。不满足时该行
> `disabled = true`（group 行整组禁用），只往 stderr 写 `dsh: disabling profile plugin <row>: ...`，**进程不报错**。
> 本仓库 `peerDependencies` 锁过 `0.2.0-rc.2`，桌面版 dsh 升到 `0.2.1-rc.2`（2026-10-17 安装）后，19 个 insert 行全部被
> 静默禁用 —— 整个 bundle 一个工具都注册不出来。
>
> **为什么"曾经能用"**：升级后旧进程仍在跑（旧会话日志直到 10-18 01:45），重启才让新 dsh 生效；10-18 18:08 加
> `Ws_tool-creative` 只是同期巧合，与本故障无关。
>
> **修复（已固化）**：`package.json` 增加 `"engines": { "dsh": ">=0.2.0-rc.2 <0.3.0" }`。`engines.dsh` 存在时优先且
> 忽略 peer 检查；`0.2.0-rc.2` 与 `0.2.1-rc.2` 的实际用到的导出（`defineTool` / `createSystemMessage` /
> `createUserMessage` / `credentialRef`）已逐一验证存在。
>
> **离线验证（无需重启）**：
> `$env:ELECTRON_RUN_AS_NODE=1; & "D:\AI\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals <script.mjs>`，
> 脚本内 `import { evaluatePluginCompatibility, getDshRuntimeVersion } from 'file:///D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'`，
> 用它读 `package.json`。返回 `undefined` = 兼容；返回对象（带 `requirements`）= 该行会被禁用。
>
> **部署注意（第二条坑，2026-10-18 踩到）**：profile 的 `node_modules/dsh-media-plugins` 必须是**指向本仓库的链接**
> （pnpm 的 symlink，或 `mklink /J` junction）。曾用 robocopy 把插件复制成真实目录 —— 这会把 pnpm 的 symlink 拓扑压平
> （`.pnpm` 里的依赖链接变成真实目录），运行时 `sharp` / `@deepseek-ai/schemastery` 找不到自己的间接依赖
> （`Cannot find package 'detect-libc'` / `'@deepseek-ai/cosmokit'`）。链接模式下改 `package.json` / `cordis.patch.yml`
> 无需同步；若必须复制，请整体保留 `.pnpm` 的 symlink 结构，或在 profile 里重跑 pnpm install 重建链接。
>
> **升级 dsh 后**：超出 `engines.dsh` 上界（如 0.3.x）会被禁用 —— 这是刻意设计，需重新验证 API。应急授权：在 profile 的
> `compatibility.json` 写 `{ "dsh-media-plugins@0.3.2": ["<dsh 版本>"] }`（exact 版本；**缺文件 = 不授权**），或
> `dsh plugin allow-version --accept-risk`。

## 创意写作（`creative_writer`，comfly / gemini-4-argon）

- **写提示词 / 剧本分镜 / 文章 / 文案 / 故事这类创意文本，交给 `creative_writer` 一次成稿**，主 Agent 不自己逐字写；返回文本即可直接交付（最多做少量编辑）。
- 与 `describe_image` **同一模式**：工具内部经 `ctx.llm.stream` 直调 `llm-pi-ai` 注册的 provider，不碰文件系统、不反问。默认 `comfly` + **`gemini-4-argon-thinking-high`**（`baseURL: https://ai.comfly.org/v1`，`apiKeyEnv: COMFLY_API_KEY`）。**实测可直连**：网页站点的 451 地区限制不影响 API 端点，无需代理。
- 参数：`brief`（必填）、`kind`（`prompt`/`script`/`article`/`copy`/`story`/`other`）、`context`、`length`（`short`/`medium`/`long`）、`thinking`（`base`/`low`/`medium`/`high`；**不传则跟随配置 = thinking-high**）。
- **thinking 档位很慢**：high 实测 **77 秒 / 817 字**（completion 4862 tokens，约 40% 是思考），长剧本 1–3 分钟；思考 token 先于正文消耗 —— `maxTokens` 必须给足（现为 **32768**），否则长文会被截断成空回复。要快速草稿就显式传 `thinking=base`（4–12 秒）。
- 系统提示词强制**只给成品正文**：无开场白、无创作思路/结构拆解、无 Markdown 装饰标题。换模型只改 `cordis.patch.yml` 里 `Ws_tool-creative.config`，不动代码。
- **创作门（2026-10-18 固化，硬门）**：插件层**拦不住模型直接吐出的自由文本**，所以门放在第一个下游消费点。`creative_writer` 每次成功调用都会在私有运行目录写 `creative-ledger.json`（`id/kind/model/brief_sha256/output_sha256/chars/at`）并返回 `credential_id`；`prompt_batch set_prompts` 默认要求该工作区（`resolvePrivateRoot`）**最近 24 小时**内存在 `kind ∈ {prompt, script, story, copy}` 的记录，否则**整次拒绝**。确实要手写提示词时传 `allow_manual_prompts: true` 显式豁免（测试与人工场景就是这么放行的）。想收紧到「每段一次调用」可把查询改成按 segment 绑定 —— 当前是批次级一票，兼顾成本（thinking-high 单次约 77 秒）。实现见 `src/shared/creative-ledger.ts`。
- 实现 `src/tool-creative.ts` + `src/shared/creative-ledger.ts`；改提示词后跑 `pnpm build` + `pnpm test`，并**重启 dsh**（插件在启动时加载）。回归测试：`tests/creative-ledger.test.mjs`、`tests/corpus-credential-gate.test.mjs`、`tests/order-binding-gate.test.mjs`。

## 视频/图片创作线路

- **导演线（默认，唯一）**：`skills/video-prompt-orchestrator` 编排器 —— 单条走非破坏性提示词门，多素材走批次模式（`prompt_batch` 工具 = 原 `dt_batch`，提供批次/1024px 预览/审阅页）。批次模式下**每段必须先 `prompt_revision search_corpus` 取得一次性检索凭证并经 `authoring_gate(segment=该段 material)` 消费**（账本 `corpus-ledger.json`）；`set_prompts` 拒写没有自己凭证的段。默认**不得**触发业务 Skill 线。
- **Skill 线（仅用户显式要求"启用 Skill 模式"时）**：`skills/video-skill-router` → `project_pipeline`（`create` 有 `skill_mode=true` 硬门）+ `skill_registry`。进入时必须告知用户已进入 Skill 模式。
- **图片侧对称**：`image-skill-router` / `image_skill_pipeline` / `image-skill-curator`（治理层 `skill_curator` / `image_skill_curator` 只在用户上传资料入库时走，不受上面收紧影响）。
- **短剧 / 剧情 TVC（全链路）**：`skills/drama-tvc-prompt` —— **社区项目「山音超级导演大师」（剧本→九列分镜表，@山音，MIT）+ 用户实战归纳的即梦短剧 10 区块规范（分镜→提示词）** 两段式技能，覆盖「文字脚本 → 九列分镜表 → 即梦提示词 → 画板生成」全链路。社区方法论原文见 `references/shanyin-director-method.md`（五步工作流 / 六维定调 / 九列规范 / 551 镜时长基准 / 70-30 法则 / 动作-反应 12 变体）；本仓库实战补充（三幕重排 / 转场 / 连续性台词清单）单独标注在 `references/practice-notes.md`，**非社区内容**。**标准生产流程（2026-10-18 固化，必读）**见 `references/production-pipeline.md`：Agent 用山音九列搭骨架 → 12 项逻辑自检 → Gemini4 重写（**整套只调一次成功**；**档位分情况**：剧本 / 执行脚本 / 导演定调用 `gemini-4-argon-thinking-high`，**即梦提示词 / 文案 / 文章用基础档 `gemini-4-argon`**（快 10–20 倍）；**超时按输出字数动态计算**：thinking-high `clamp(70 + W×0.012, 120, 300)`、基础档 `clamp(40 + W×0.006, 60, 150)`，实测 817字/77s、2097字/101s、11513字/188s；→ 失败降基础档 → 再失败 **Agent 自己润色**，不报错不重试）→ Agent 验收并规范化输出（md + docx）。这是**线性流水线**，不是「骨架 / LLM 二选一」。单条提示词仍用 `video-director-prompt`。
- **提示词模板唯一真源**：`skills/video-director-prompt/references/jimeng-standard-template.md`（即梦提示词模板集，据 **13 份官方范例**归纳：连续多镜头 6 / 单一镜头 4 / 一镜到底 1 / 视频驱动 1）。**5 个模板按情况选**——T1 `镜头N` 编号式（有分镜、逐镜推进）、T2 时间轴式（有分镜且要卡点：`0-1.5秒:` 或 `[00.0-03.0秒|场景名]` + `[素材说明]/[整体设定]/[时间轴]/[稳定性限制]`，每段音效单独成行）、T3 单一镜头内部时间轴（一镜内有连续变化）、T4 单镜头连续（一镜到底式）、T5 视频驱动（首句 `严格参考:<视频>的运镜/动作` + 用"变为/分配给"做素材映射）。**同一层只用一种分段手段。** 共用配件：素材说明（**逐份声明角色**：首帧/场景/三视图/正脸五官/道具/配角/变形对象/多角色/参考视频）、光影三层 `光影: <光源层>，<光行为层>，<色调层>`、音效行、禁止项、画质与稳定性限制。**时间码 / 秒数区间 / 方括号区块头 / `CUT_02 硬切至…` 都是合法写法**（2026-10 按用户指示**撤回**了此前的"时间码淘汰"改动）；**只有管道符拼接标题被代码层拒绝**（`0.0-4.0 秒｜第一段｜图片2`，`validatePromptContent`）。`@Image1`/`参考图片1` 与 fps/码率/模型名尾巴同样禁用。官方范例的 `图片N` 是**素材库内文件名编号**（可跳号、可带 `(2)`、跨范例复用同一素材，如 `图片32`），提交前必须按 **图片 → 视频 → 音频 的传入顺序**重编号，同一素材全片同号；`set_prompts` 拒绝超出该段素材数的编号，也拒写没有 `图片N` 绑定的段。回归测试：`tests/order-binding-gate.test.mjs`、`tests/project-core.test.mjs`。

## 即梦画布 CLI（`dreamina-canvas`）—— 生成线路的唯一执行层

> **旧 `dreamina` CLI 自 2026-11 起停止维护**：仓库已**彻底**迁移到画布 CLI —— 旧二进制、旧登录流程（`login --headless`）与**积分余额查询**全部移除。画布 CLI 的 `auth account` 只返回 `userId` / `isVip` / `vipLevel`，不返回余额。

- **二进制**：`dreamina-canvas`（官方安装器装到 `~/bin/dreamina-canvas.exe` + Skill `~/.agents/skills/dreamina-canvas-cli`）。解析顺序：配置 `dreaminaPath`/`dreaminaCanvasPath` → 包内 `bin/` → `~/bin/` → PATH（`resolveCanvasBinary`）。
- **产品模型完全不同**：画布(project) + 节点(node) + 报价确认 + 可恢复操作。**保存 ≠ 生成**；付费链路固定六段，任何一步不可跳过：`resource upload` → `node create ...（保存）` → `node quote` → `node confirm --credit-ceiling`（取 `creditConfirmationToken`）→ `node run --submit-id` → `operation wait` → `resource download`。
- **视频公开模式只有** `t2v` / `first_last_frame` / `m2v`，**没有 `i2v`**：无媒体=`t2v`；单图（锁首帧比例）或两张有序图片=`first_last_frame`；单图但**显式指定比例**、或有视频/音频/多图混合参考=`m2v`。`first_last_frame` 合并后引用数必须 1 或 2。
- **多产物分节点**：每个产物一个节点（`--count 1`），不再用单节点多输出承载多候选。
- **同一任务绝不换新 `submit-id` 重放**（付费不可回滚）；`operation wait` 退出码 20（本地等待超时）**不是失败**，服务端任务仍在跑 → 记 `needs_review` 并保留身份。
- **引用形态**：`--ref res:<小写规范 UUID>`（上传登记或冻结某份产物）或 `--ref node:<nodeId>`（跟随节点最新产物并保留连线）。大写/`urn:uuid:`/去连字符的 Resource ID 会被 CLI 本地拒绝。
- **账号**：画布 CLI 的登录态在**另一个 keychain 子键**（见下节），与旧 CLI 互不覆盖；`--profile` 只隔离登录态名，业务记录目录可用 `DREAMINA_CANVAS_STATE_DIR` 重定向。
- **实现与回归**：`src/shared/dreamina-canvas.ts`（envelope/退出码分类、模式选择、命令构造、画布复用、二进制解析）、`src/shared/video-canvas-pipeline.ts`（六段链路 + 有界并发 + 下载）、`src/shared/canvas-browser.ts`（按需打开画布，带冷却去重）、`src/tool-video-gen.ts`、`src/shared/adapters.ts` 的 `dreamina-image` 适配器；测试 `tests/dreamina-canvas.test.mjs`、`tests/canvas-tool.test.mjs`。
- **通用能力入口（官方命令面全覆盖）**：`dreamina_canvas` 工具（`src/tool-canvas.ts`）开放 `catalog`(model list/find)、`voice list`、`canvas`、`node`（含 `text` / `element` / `timeline` / `upscale image`）、`operation`、`resource`、`schema`、`version`。**调用前必须先用 `command=schema` + `action="node create video"` 查当前制品的真实 flag 与枚举，绝不凭记忆猜参数**（官方硬性要求）。内置付费门：`--run` / `node run` / `node upscale` 必须在同一次调用里带 `credit_ceiling` 或 `credit_token`，否则直接拒绝 —— 报价 ≠ 授权。返回结构化字段 `outcome` / `required_action` / `request_id` / `partial_items` / `credit_confirmation`，失败时原样带出 `partialData` 身份供续跑。
- **协议遵循（官方 5 份 reference 已落实）**：退出码 20 恒为 `pending`（本地等待超时 ≠ 失败）；`error.localStorage.submissionPhase === 'after_submit'` 同样归 `pending`（副作用可能已发生 → 只读恢复，**绝不重提**）；`node run` 返回 10 时从 `partialData.items[]` 取回 `nodeId` + `submitId` 并记 `needs_review`（**换新 submitId 等于第二次运行、会再扣一次钱**）；报价不可用（`occupancy_unknown` / `confirmable=false`）**绝不按 0 批准**；下载必须校验 `size > 0` 与真实容器/图片内容（CLI 落地扩展名不可信：实测 `.png` 内容是 jpeg）并记录 `sha256`；`meta.requestId` 全程留痕；`DREAMINA_CANVAS_STATE_DIR` 指向私有运行目录。

## 画板批量制片流程（标准规范，2026-10-18 固化）

> 一次「多段视频、同一画板、逐段生成」的标准链路。本次建发短剧 8 段实战验证。
> 短剧提示词写法见技能 `drama-tvc-prompt`。

### 1. 开画板前

- `dreamina_account current` **核对浏览器账号**（Chrome = ISUN），不一致先 `dreamina_account default name=<n>`
- 建画布：`canvas create "<名称>"`，拿 `projectId` + `webUrl`
- **用 Chrome 显式打开** webUrl（`Start-Process <chrome.exe> -ArgumentList "<url>"`），不要用默认浏览器

### 2. 素材上传（resource upload）

- `resource upload --project-id <pid> --file <path> --name <名> --type image|audio`
- 音频必须显式 `--type audio`
- 一次调用一个文件；批量时用脚本循环（18 个素材约 1 分钟）
- **上传只登记资源，不上画布**——上画布要建节点

### 3. 素材节点（上画布）

```
node create image|audio --project-id <pid> --resource-id <rid> \
  --import-kind external_generated --x <x> --y <y> --title "<名>"
```

- `--import-kind external_generated` 是**唯一支持坐标摆放**的路径；`local_upload` 会强制自动布局
- 坐标分区（推荐）：音色 y=0（x=0/340/680）、角色 y=460（x 递增 340）、场景 y=980/1420（x=0/600/1200/1800）、视频卡片 x=2500 起（y 递增 400）
- 标题加 `【场景】/【角色】/【音色】` 前缀便于识别

### 4. 视频卡片（node create video）

- `--mode m2v`（全能参考；有图/音频就是 m2v，不是 t2v）
- `--ref node:<素材节点ID>` 建立**连线**（`--ref res:<uuid>` 无连线，只适用于资产库素材）
- prompt 里用 `{{node:<nodeId>}}` 引用素材，**同一素材同一 ID，全片一致**
- 每个产物一个节点：`--count 1`
- **模型规格必须先查 `catalog list --type video`**：`seedance_2.0_vip` 时长上限 **15 秒**（16 秒会被服务端 `FIELD_VALUE_INVALID` 拒绝，且 edit 失败后节点静默保持旧值）

### 5. 付费链路（六段，一步不能跳）

```
node quote --node-id <id>          # 拿 maxCredits + confirmable
node confirm --node-id <id> --credit-ceiling <maxCredits>
node run   --node-id <id> --submit-id <uuid> --credit-token <token>
```

- **必须单节点 confirm → 单节点 run**。批量 confirm 拿到的一个 token 拆开逐个 run 会全部 `exit=2`（本次 8 个全失败，只能逐个重来）
- `credit-ceiling` 不得低于 quote 的 `maxCredits`
- 报价结构：`data.items[].maxCredits` + `data.totalMaxCredits` + `data.confirmable`（**不是** `data.quote`，解析错会误判为"报价为空"）
- 单价参考：Seedance 2.0 VIP ≈ **14 积分/秒**（720P）

### 6. 等待与下载

- 轮询：`node find --project-id <pid> --type video --format json`，看 `data.items[].status`
- **`node find` 只返回定位摘要（nodeId/type/title/status/tags），不含 resources** —— 取资源 ID 用 `node show` 或 run 时记录的 `items[0].resources[0].resourceId`
- 下载：`resource download <resourceId> --project-id <pid> --output <path> --yes`
- **落地必须校验**：`size > 0` + 文件头含 `ftyp` + 记录 `sha256`；扩展名不可信
- **实际时长要自己验**：解析 mp4 `mvhd` 的 duration/timescale，别信节点配置

### 7. 踩坑清单

| 坑 | 后果 | 规避 |
|---|---|---|
| 批量 confirm 的 token 拆开 run | 全部 exit=2 | 单节点 confirm + run |
| 解析 `data.quote` | 误判报价为空 | 用 `data.items[].maxCredits` |
| edit 后立刻 run | 服务端仍按旧配置执行（本次 16s 跑成 14s） | edit 后 `node show` 验证 `durationSeconds` 再 run |
| 模型时长上限不查 | edit 被拒、节点静默保持旧值 | 先 `catalog list --type video` |
| `node find` 找资源 ID | 取不到 | 用 `node show` |
| 画布自动打开用默认浏览器 | 打开错账号、提示无权限 | 用 Chrome 显式打开 |
| 提示词混入 Markdown | `**加粗**` 原样进提交文本 | 提交前扫 `**` 并清除 |

## 即梦账号切换（`dreamina_account`，多账号）

- **真实登录态位置（2026-10-12 实测，两个 CLI 各有独立子键）**：都在 `HKCU\Software\BytedAuthClient\keychain` 下，值名都是 base64 的 `byted_cli_user_token`（REG_SZ，值为 **DPAPI blob 的 base64**）：
  - `...\keychain\dreamina` —— 旧 CLI；
  - `...\keychain\dreamina_canvas_oauth_v2_<64 hex>` —— 即梦画布 CLI。后缀是 auth-SDK 常量（**不是** profile/region/instance-id 的派生值，均已实测排除），因此必须**按前缀发现**（`listKeychainSubkeys`），绝不硬编码。两者**互不覆盖**：登录画布 CLI 后旧 CLI 的 `user_credit` 照常工作。
  - `~/.dreamina_cli/credential.json` 是**遗留文件**：删掉/清空/改成垃圾后 `dreamina user_credit` 照常工作，CLI 也从不重写它；改坏注册表值才会得到 `authsdk: store unavailable: ... registry value corrupt`；重定向 `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 无效（不是家目录文件）。凭据也不在 Windows 凭据管理器里。
- **单账号时只能有一个活跃登录，但要同时切两边**：切换 = 用另一个账号的 blob 覆盖注册表值。账号库在 `<private>/dreamina-accounts/<name>/{token.txt, canvas-token.txt, account.json}` + `default.json`；`token.txt` 存旧 CLI 的 DPAPI blob 原文，`canvas-token.txt` 存画布 CLI 的（都不落明文凭证），只能被**同一 Windows 用户 + 同一台机器**复用。`ensureActiveAccount` 与 `switchCanvasLogin` 保证切换时两个子键一起换 —— 只切旧子键会让 `generate_video` 用错账号。
- **账号命名**：`ACCOUNT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/`（大小写皆可，如 `wsstudio`、`ISUN`）。`meta.name` 保留用户写法，`accountDir()` 与 `default.json` 指针统一按**小写归一** —— Windows 目录大小写不敏感，不归一会出现 `ISUN`/`isun` 两个指向同一目录的"不同账号"。`readDefaultAccount` 反查 meta 后返回显示名，因此指针写小写也不影响展示，并让"只认小写"的旧版本代码仍能解析它。
- **工具**：`dreamina_account`（`current` / `list` / `save` / `use` / `default` / `rename` / `login` / `login-check` / `forget`）。`login` 会先把现有登录态自动备份入库再清空，返回 `verification_uri` / `user_code` / `device_code`（用户在目标浏览器授权），`login-check` 轮询成功后自动入库；失败/放弃时自动恢复原登录态。`rename` 同步搬目录、改 `meta.name`、跟随默认指针；`login-check` 以 `login checklogin` 是否通过为唯一成功判据 —— 设备流程进行中 keychain 里会存在中间态值，**不得**据此报"已检测到新登录态"。
- **管线默认账号**：`dreamina_account default name=<n>`（或工具的 `dreaminaAccount` 配置）→ `generate_video` / `generate_image` / `batch_image` 在**每次 CLI 调用前**调 `ensureActiveAccount`：指纹一致时只做一次 `reg query`（零写入），不一致才加租约切换（`locks/providers/...` 之外的 `dreamina-account` 单槽锁）。
- **切换纪律**：有活动即梦任务（`locks/providers/seedance-cli|image` 内未过期 `.lock`）时 `use`/`default` 会拒绝切换（除非 `force=true`），否则进行中的任务会用错账号轮询/提交。
- **浏览器即账号锚点（2026-10-17 实战踩坑）**：**同一台机器上不同浏览器登录的是不同即梦账号**，而画布是否"看得见"取决于 CLI 登录态与浏览器账号是否一致。实测：**Chrome = `ISUN`**（user_id `960342070926412`），默认浏览器对应的是另一个账号。所以：
  1. 打开即梦画布 / 授权页**必须显式用 Chrome 可执行文件**：`Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "<url>"`；`Start-Process "<url>"`（不带 exe）会落到默认浏览器 → 等于打开错账号的页面。
  2. **建画布 / 上传素材 / 建节点前，先 `dreamina_account current` 核对**目标浏览器账号；不一致就先 `use`（同账号库内可切）或 `login`（账号库缺失时走设备授权）。只切旧 CLI 子键或只切画布子键都会导致校验失败（`切换校验失败：期望 user_id=…，实际 user_id=…`），此时应 `auth logout` 后重新 `dreamina_account login`，不要反复 `use`。
  3. 账号库里某账号若**只有 `token.txt` 没有 `canvas-token.txt`**（且 `account.json` 无 `canvasSubKey`），说明当年只备份了旧 CLI，**画布侧不可切**，必须重新 OAuth 授权补全。
  4. 画布 `webUrl` 交付给用户时也用 Chrome 打开 —— 否则用户在自己的（另一账号的）浏览器里看不到刚建的画布。
- **实现与回归**：`src/shared/dreamina-keychain.ts`（注册表桥 + `reg query` 输出解析）、`src/shared/dreamina-account.ts`（账号库 / ensure / 指纹）、`src/tool-dreamina-account.ts`；测试 `tests/dreamina-keychain.test.mjs`、`tests/dreamina-account.test.mjs`。

## 批量生图交付约定（工具级，已固化）

> **只要用了 `batch_image`，就一定有审阅页** —— 这是工具的固定行为，不依赖使用者记得手动调用。

- **自动生成**：`batch_image` 任务结算（scheduler 收尾）后自动写审阅页 `<outputDir>/contact-<jobKey>.html`；显式 `contact_sheet` 命令复用同一实现（`writeReviewPage` in `src/tool-batch-image.ts`）。
- **图片必须内嵌**：审阅页用 data URI（`data:image/jpeg;base64,…`）嵌入缩略图，并用自适应 CSS grid 排版。`file://` 或相对路径的 `img src` 会被沙箱查看器拦成坏图 —— 不要退回外部路径引用（回归测试：`tests/batch-review-page.test.mjs`）。
- **一任务一页**：页面只含该次任务的图（含未落地槽位占位），不累积历史批次、**不渲染参考图** —— `original_image` / `reference_images` 即使传入也被忽略（旧的 “slot 0 = 原始／参考图” 行为已移除）。
- **原图另行交付**：审阅页内是缩略图；原始分辨率的成品图按原尺寸交付，不缩小。
- **审阅页必带勾选与复制名称（全管线）**：三张审阅表（`batch_image` 联系表、`split_grid_sheet` 拆格审阅页、`prompt_batch` 参考图审阅页）共用 `src/shared/review-ui.ts` 的勾选组件 —— 每张图一个复选框，粘性工具栏显示"已选 N / 共 M"并提供 **复制勾选名称** / **复制勾选路径** / 全选 / 清空。复制走 `navigator.clipboard` → `execCommand` → 预选中 textarea 三级兜底（`file://` 查看器拦截脚本复制时仍可 Ctrl+C）。改审阅页 HTML 时不得退回"只有文件名、没有勾选"的旧形态。
- **单图多小图必须在审阅页拆开（`src/shared/grid-detect.ts`）**：落地候选若是九宫格（3×3）/ 四宫格（2×2）/ 六宫格（2×3）/ 八宫格（2×4）/ 十六宫格（4×4）等拼版，审阅页把它拆成独立面板文件（`<outputDir>/<jobKey>/_panels/<group>-<slot>-rNcM.png`）并逐张列出。**审阅页只出现拆出来的小图** —— 拆分前的那张九宫格/四宫格整图既不渲染、也不再给勾选项（也不重复 embed，省掉一次 900px 缩略图；整图文件仍留在成品目录 `<jobKey>/<group>/` 里）。`split_grid_sheet` 的拆格审阅页同理，只在标题行打印源图路径，不重复展示源图。检测很保守：内部格线必须是**窄带**（≤ 轴的 3%，亮线或暗缝均可，故天空/阴影不会被误判）、必须**横贯整轴**（≥80% 像素在同侧）、必须落在 1/4、1/3、1/2、2/3、3/4 的 ±4.5% 内，且每个面板都要有内容（非纯色/纯白）；按面板数从多到少取第一个全部满足的布局（所以真 3×3 不会被当 2×2、真 4×4 不会被当 2×2）。**无缝拼版检测不到就绝不猜**；需要拆就在 manifest 组里写 `grid: "3x3"`（也接受 `2×2`/`2*3`/`1:2`），声明与检测不一致时按声明**等比切割**并在页面标注。回归测试：`tests/grid-detect.test.mjs`、`tests/review-ui.test.mjs`、`tests/batch-review-page.test.mjs`、`tests/grid-split.test.mjs`。
- **并发口径（不要改小）**：`batch_image` 不写 `concurrency` 就是**默认 10**（= 共享图片池上限），`deadline = ceil(张数÷并发)×90s + 并发s`。**不要在 manifest 或技能文档里把默认写死成 `concurrency: 1`** —— 实测 75 张：并发 10 约 11 分钟，串行约 36 分钟。`start` 回执会在 manifest 显式钉住低于 10 的并发时给出 ⚠ 提示。
- **失败即停、不自动补跑**：每条候选只走一条线路（选定前只做免费的熔断/凭证检查），失败即终；到点（deadline + 宽限）**硬停**，只收集已落地的成功图写审阅页，缺失槽位由用户决定是否换新组 id 重排。
- **单张超时必须显式钉住（上游慢速期尤其重要）**：`IMAGE_SECONDS_PER_CANDIDATE = 90` 只是**默认**预算，可在 `cordis.patch.yml` 的 `Ws_tool-image-gen` / `Ws_tool-batch-image` 用 `providerTimeoutMs` / `taskTimeoutMs` 覆盖（现为 **300000**，即 300s）。上游渠道高峰期实测单张 **121–195s**：90s 预算会让工具先放弃、上游却继续跑完并计费（`timeout_before_submit` + 后台消费记录），等于空烧。改这两个值时同步调整 manifest 的 `deadline_seconds`（慢速期用 1800）。回归测试：`tests/shared-symbol-imports.test.mjs`。
- **共享符号必须显式导入**：tsdown/esbuild **不做类型检查**，漏 `import` 不会在构建期报错，只会在运行时抛 `X is not defined` 并**掩盖真实失败原因**（曾发生：`media-client.ts` 用了 `MediaError` 却没导入，所有慢请求的失败分类被打成 `MediaError is not defined`）。改 `src/shared/*.ts` 后务必跑 `pnpm test`（含导入一致性回归）。
- **工具返回值必须过 `jsonSafe`（DSH 硬性校验）**：DSH 要求工具返回值是无损 JSON，对象里只要出现 `undefined` 键，整个调用就会失败并报 `value is not lossless JSON`。而 `required_action` / `request_id` / 失败项的 `submit_id` 这类字段在成功路径上天然缺席 —— `dreamina_account` 与 `dreamina_canvas` 都真实踩过。新增或修改工具返回时统一用 `src/shared/json-safe.ts` 包一层（`generate_video` 的三条返回路径已接入）。
- **改含中文的文本文件必须显式 UTF-8（会静默损坏数据）**：Windows PowerShell 5.1 的 `Get-Content -Raw` / `Set-Content` 对**没有 BOM** 的 UTF-8 文件按 ANSI(GBK) 解码与编码，改一次就把中文写成乱码，而且 `-replace` 的锚点也会失配（征兆：本该命中的替换却报告 0 处）。本仓库的 `AGENTS.md`、`skills/**/*.md` 都是无 BOM UTF-8。正确写法是显式编码：`[System.IO.File]::ReadAllText($p, (New-Object System.Text.UTF8Encoding($false)))` 读、`[System.IO.File]::WriteAllText($p, $text, $sameEncoding)` 写；`rg` / `Select-String` 只用于查看。写完必须核对 diff 行数（正常是 1 行改动；出现十几行删除就是写坏了）并读回确认中文正常。
- 实现落在 `src/shared/batch-core.ts` 的 `buildContactSheetHtml`（async，依赖 `sharp`）。

## 视频批量提交约定（工具级，已固化）

> **一次 `generate_video` 调用按管线容量装满，绝不按时长分组** —— 用户 2026-10-06 明确的提交口径。

- **容量**：`videoCapacity`（`Ws_tool-video-gen` 配置项，默认 **10**，常量 `DEFAULT_VIDEO_CAPACITY`）。一次调用用 `tasks[]` 装满容量个任务；画布 CLI 侧每个任务是**独立**的「保存→报价→批准→运行」链，`runCanvasVideoBatch` 内的 `mapWithConcurrency` 用它限制**同时在跑的提交数**，超出的任务排队而不是失败。降并发只需改 `videoCapacity`，无需改代码。
- **逐任务时长**：`tasks[].duration`（4-30 秒）让每个任务保留自己的时长，所以**不同时长的段可以放进同一次调用**。解析顺序：显式 `tasks[].duration` → 该段 prompt 自带的时长提示（`视频时长：N 秒`）→ 调用级 `duration`（`buildSpecs`，`src/tool-video-gen.ts`）。
- **确认门（付费安全，不可绕过）**：单一时长仍用 `video_confirmation_duration=<整数>`（兼容 `5s`/`5秒`）；**多时长批次必须额外传 `video_confirmation_durations="12,15,15"`**（逗号/空格/斜杠分隔皆可，去重排序后与最终集合全等才放行），否则拒绝提交 —— 未确认的逐段时长绝不会进入付费通道（`confirmationGateErrorForDurations`，`src/shared/video-pipeline.ts`）。
- **批次计划**：`prompt_batch run_batch` 已按容量切分，返回 `submission.calls[]`（每次调用 ≤ capacity 个任务），每个 task 带自己的 `duration` 与 `asset_manifest` 标签绑定；`set_visuals` 支持逐段写 `duration`。计划消息会显式提示 “fill each call to capacity — never split by duration”。
- **提交必须零转录（2026-10-06 事故后固化）**：`run_batch` 会把每次调用的 tasks 写成 `<batch>/submission-callN.json`，**提交时必须把该文件路径传给 `generate_video` 的 `tasks_path`**，不要手工把 prompt 重抄进 `tasks[]` —— 曾发生 Agent 重抄导致 3 段（T1/T3/T5a）提交文本与审阅版不一致（错别字、漏句、少 116/15 字），视频已付费生成却与用户确认的提示词不符。`tasks_path` 优先于入参 `tasks`，按字节读取审阅版提示词；确认项（`video_confirmation_model` / `video_confirmation_resolution` / `video_confirmation_duration(s)`）仍须**显式**传入。
- **回归测试**：`tests/video-task-duration.test.mjs`（per-task duration 解析 + 容量默认值）、`tests/video-pipeline.test.mjs`（确认门单值/集合两种语义）。改 `video-policy.ts` / `video-pipeline.ts` / `tool-video-gen.ts` / `tool-prompt-batch.ts` 后必须跑 `pnpm test`。

## 布局

- `src/tool-*.ts` — 工具入口（每个工具一个文件，对应 cordis.patch.yml 里的一行）。
- `src/shared/*.ts` — 纯领域逻辑（无 DSH/供应商依赖），由各工具共享，tsdown 会抽成共享 chunk。
- `src/index.ts` — 包入口，按名 re-export 所有工具，构建产物 `dist/index.js`（满足 `main`）。
- `refs/` — 数据资产：skill 模板、seedance-forge 语料（`forge-index.jsonl`）、正式图片 Skill 库。
- `skills/` — 随包安装到 `$DSH_HOME\skills\<技能名>` 的 Studio 技能 Markdown。
- `scripts/` — 部署/校验/发布/任务开始检查等 PowerShell 脚本。
- `tests/` — `node --test` 离线单测（`.mjs`，直接从 `src/*.ts` 导入）。
- `dist/` — **构建产物，gitignore**。由 `pnpm build`（tsdown）从 `src/` 生成，不进仓库。

## 构建与运行

```sh
pnpm build   # tsdown：src/*.ts -> dist/*.js（profile 用 link: 安装，改完重启 dsh 生效）
pnpm test    # node --test（离线单测）
```

工具通过 npm 子路径加载（`dsh-media-plugins/tool-vision` 等），`package.json` 的 `exports`
已指向 `dist/`。不要在根目录放构建产物——`dist/` 已 gitignore。

## 资产路径

`src/shared/pkg-root.ts` 的 `packageRootOf(import.meta.url)` 从当前模块向上找到拥有
`package.json` 的包根，用于解析 `refs/`、`skills/`、`bin/`、`scripts/`。它在 `dist/`、
`src/`、`src/shared/` 三个位置下都正确，新增需按包根定位资产的代码时请用它。

## 调整约定

- 新增工具：在 `src/` 加 `tool-<name>.ts`，在 `tsdown.config.ts` 的 `entry` 加一行，
  在 `package.json` 的 `exports` 加 `./<name>` 与 `./Ws_<name>` 两条，并在
  `cordis.patch.yml` 的 `insert` 注册一行 `id` + `name`。
- 共享领域逻辑放 `src/shared/` 并保持 `Pure domain`（无 DSH/供应商依赖），用单测覆盖。
- 付费安全与凭证纪律不可破坏：Key/登录态不进仓库；`needs_review` 不自动重试；批量需明确付费确认。

更多行为细节（各工具契约、安全约定、安装/配置）见 `README.md`。
