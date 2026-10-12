# AGENTS.md

DSH Studio 媒体能力包。一次安装提供 16 个工具、11 个技能与一个完成通知，是 Codex_Wsstudio
能力指南在 DSH 平台上的重建。本文件给在此仓库工作的 Agent 一个最小但足够的上下文。

> **火山方舟通道已屏蔽**：`cordis.patch.yml` 里 `Ws_tool-vision`（`describe_image`）的注册被注释，
> 实际注册 15 个工具；`setup.ps1` 默认也不再引导 `VOLCANO_ENGINE_API_KEY` 与
> `llm-pi-ai.providers.volcengine`。恢复：`.\setup.ps1 -EnableVolcano` + 取消该两行注释 + 重启 dsh。
> `src/tool-vision.ts` 实现保留，`media_status` 里该项显示 `disabled`。

## 视频/图片创作线路

- **导演线（默认，唯一）**：`skills/video-prompt-orchestrator` 编排器 —— 单条走非破坏性提示词门，多素材走批次模式（`prompt_batch` 工具 = 原 `dt_batch`，提供批次/1024px 预览/审阅页）。批次模式下**每段必须先 `prompt_revision search_corpus` 取得一次性检索凭证并经 `authoring_gate(segment=该段 material)` 消费**（账本 `corpus-ledger.json`）；`set_prompts` 拒写没有自己凭证的段。默认**不得**触发业务 Skill 线。
- **Skill 线（仅用户显式要求"启用 Skill 模式"时）**：`skills/video-skill-router` → `project_pipeline`（`create` 有 `skill_mode=true` 硬门）+ `skill_registry`。进入时必须告知用户已进入 Skill 模式。
- **图片侧对称**：`image-skill-router` / `image_skill_pipeline` / `image-skill-curator`（治理层 `skill_curator` / `image_skill_curator` 只在用户上传资料入库时走，不受上面收紧影响）。

## 即梦画布 CLI（`dreamina-canvas`）—— 生成线路的唯一执行层

> **旧 `dreamina` CLI 自 2026-11 起停止维护**，仓库已于 2026-10-12 完成迁移。旧二进制只剩「积分余额查询」一个用途（画布 CLI 的 `auth account` 不返回余额）。

- **二进制**：`dreamina-canvas`（官方安装器装到 `~/bin/dreamina-canvas.exe` + Skill `~/.agents/skills/dreamina-canvas-cli`）。解析顺序：配置 `dreaminaPath`/`dreaminaCanvasPath` → 包内 `bin/` → `~/bin/` → PATH（`resolveCanvasBinary`）。
- **产品模型完全不同**：画布(project) + 节点(node) + 报价确认 + 可恢复操作。**保存 ≠ 生成**；付费链路固定六段，任何一步不可跳过：`resource upload` → `node create ...（保存）` → `node quote` → `node confirm --credit-ceiling`（取 `creditConfirmationToken`）→ `node run --submit-id` → `operation wait` → `resource download`。
- **视频公开模式只有** `t2v` / `first_last_frame` / `m2v`，**没有 `i2v`**：无媒体=`t2v`；单图（锁首帧比例）或两张有序图片=`first_last_frame`；单图但**显式指定比例**、或有视频/音频/多图混合参考=`m2v`。`first_last_frame` 合并后引用数必须 1 或 2。
- **多产物分节点**：每个产物一个节点（`--count 1`），不再用单节点多输出承载多候选。
- **同一任务绝不换新 `submit-id` 重放**（付费不可回滚）；`operation wait` 退出码 20（本地等待超时）**不是失败**，服务端任务仍在跑 → 记 `needs_review` 并保留身份。
- **引用形态**：`--ref res:<小写规范 UUID>`（上传登记或冻结某份产物）或 `--ref node:<nodeId>`（跟随节点最新产物并保留连线）。大写/`urn:uuid:`/去连字符的 Resource ID 会被 CLI 本地拒绝。
- **账号**：画布 CLI 的登录态在**另一个 keychain 子键**（见下节），与旧 CLI 互不覆盖；`--profile` 只隔离登录态名，业务记录目录可用 `DREAMINA_CANVAS_STATE_DIR` 重定向。
- **实现与回归**：`src/shared/dreamina-canvas.ts`（envelope/退出码分类、模式选择、命令构造、画布复用、二进制解析）、`src/shared/video-canvas-pipeline.ts`（六段链路 + 有界并发 + 下载）、`src/tool-video-gen.ts`、`src/shared/adapters.ts` 的 `dreamina-image` 适配器；测试 `tests/dreamina-canvas.test.mjs`（真机零成本验证脚本曾覆盖 t2v/m2v/first_last_frame/i2i 四种 `--dry-run` 形态）。

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
