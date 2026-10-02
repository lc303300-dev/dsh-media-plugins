# AGENTS.md

DSH Studio 媒体能力包。一次安装提供 15 个工具、10 个技能与一个完成通知，是 Codex_Wsstudio
能力指南在 DSH 平台上的重建。本文件给在此仓库工作的 Agent 一个最小但足够的上下文。

> **火山方舟通道已屏蔽**：`cordis.patch.yml` 里 `Ws_tool-vision`（`describe_image`）的注册被注释，
> 实际注册 14 个工具；`setup.ps1` 默认也不再引导 `VOLCANO_ENGINE_API_KEY` 与
> `llm-pi-ai.providers.volcengine`。恢复：`.\setup.ps1 -EnableVolcano` + 取消该两行注释 + 重启 dsh。
> `src/tool-vision.ts` 实现保留，`media_status` 里该项显示 `disabled`。

## 视频/图片创作线路

- **导演线（默认，唯一）**：`skills/video-prompt-orchestrator` 编排器 —— 单条走非破坏性提示词门，多素材走批次模式（`prompt_batch` 工具 = 原 `dt_batch`，提供批次/1024px 预览/审阅页）。批次模式下**每段必须先 `prompt_revision search_corpus` 取得一次性检索凭证并经 `authoring_gate(segment=该段 material)` 消费**（账本 `corpus-ledger.json`）；`set_prompts` 拒写没有自己凭证的段。默认**不得**触发业务 Skill 线。
- **Skill 线（仅用户显式要求"启用 Skill 模式"时）**：`skills/video-skill-router` → `project_pipeline`（`create` 有 `skill_mode=true` 硬门）+ `skill_registry`。进入时必须告知用户已进入 Skill 模式。
- **图片侧对称**：`image-skill-router` / `image_skill_pipeline` / `image-skill-curator`（治理层 `skill_curator` / `image_skill_curator` 只在用户上传资料入库时走，不受上面收紧影响）。

## 批量生图交付约定（工具级，已固化）

> **只要用了 `batch_image`，就一定有审阅页** —— 这是工具的固定行为，不依赖使用者记得手动调用。

- **自动生成**：`batch_image` 任务结算（scheduler 收尾）后自动写审阅页 `<outputDir>/contact-<jobKey>.html`；显式 `contact_sheet` 命令复用同一实现（`writeReviewPage` in `src/tool-batch-image.ts`）。
- **图片必须内嵌**：审阅页用 data URI（`data:image/jpeg;base64,…`）嵌入缩略图，并用自适应 CSS grid 排版。`file://` 或相对路径的 `img src` 会被沙箱查看器拦成坏图 —— 不要退回外部路径引用（回归测试：`tests/batch-review-page.test.mjs`）。
- **一任务一页**：页面只含该次任务的图（含未落地槽位占位），不累积历史批次、**不渲染参考图** —— `original_image` / `reference_images` 即使传入也被忽略（旧的 “slot 0 = 原始／参考图” 行为已移除）。
- **原图另行交付**：审阅页内是缩略图；原始分辨率的成品图按原尺寸交付，不缩小。
- **并发口径（不要改小）**：`batch_image` 不写 `concurrency` 就是**默认 10**（= 共享图片池上限），`deadline = ceil(张数÷并发)×90s + 并发s`。**不要在 manifest 或技能文档里把默认写死成 `concurrency: 1`** —— 实测 75 张：并发 10 约 11 分钟，串行约 36 分钟。`start` 回执会在 manifest 显式钉住低于 10 的并发时给出 ⚠ 提示。
- **失败即停、不自动补跑**：每条候选只走一条线路（选定前只做免费的熔断/凭证检查），失败即终；到点（deadline + 宽限）**硬停**，只收集已落地的成功图写审阅页，缺失槽位由用户决定是否换新组 id 重排。
- **单张超时必须显式钉住（上游慢速期尤其重要）**：`IMAGE_SECONDS_PER_CANDIDATE = 90` 只是**默认**预算，可在 `cordis.patch.yml` 的 `Ws_tool-image-gen` / `Ws_tool-batch-image` 用 `providerTimeoutMs` / `taskTimeoutMs` 覆盖（现为 **300000**，即 300s）。上游渠道高峰期实测单张 **121–195s**：90s 预算会让工具先放弃、上游却继续跑完并计费（`timeout_before_submit` + 后台消费记录），等于空烧。改这两个值时同步调整 manifest 的 `deadline_seconds`（慢速期用 1800）。回归测试：`tests/shared-symbol-imports.test.mjs`。
- **共享符号必须显式导入**：tsdown/esbuild **不做类型检查**，漏 `import` 不会在构建期报错，只会在运行时抛 `X is not defined` 并**掩盖真实失败原因**（曾发生：`media-client.ts` 用了 `MediaError` 却没导入，所有慢请求的失败分类被打成 `MediaError is not defined`）。改 `src/shared/*.ts` 后务必跑 `pnpm test`（含导入一致性回归）。
- 实现落在 `src/shared/batch-core.ts` 的 `buildContactSheetHtml`（async，依赖 `sharp`）。

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
