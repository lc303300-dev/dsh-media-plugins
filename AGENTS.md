# AGENTS.md

DSH Studio 媒体能力包。一次安装提供 15 个工具、9 个技能与一个完成通知，是 Codex_Wsstudio
能力指南在 DSH 平台上的重建。本文件给在此仓库工作的 Agent 一个最小但足够的上下文。

## 布局

- `src/tool-*.ts` — 工具入口（每个工具一个文件，对应 cordis.patch.yml 里的一行）。
- `src/shared/*.ts` — 纯领域逻辑（无 DSH/供应商依赖），由各工具共享，tsdown 会抽成共享 chunk。
- `src/index.ts` — 包入口，按名 re-export 所有工具，构建产物 `dist/index.js`（满足 `main`）。
- `refs/` — 数据资产：skill 模板、seedance-forge 语料（`forge-index.jsonl`）、正式图片 Skill 库。
- `skills/` — 随包安装到 `$DSH_HOME\skills\<技能名>` 的 Studio 技能 Markdown。
- `scripts/` — 部署/校验/发布/任务开始检查等 PowerShell 脚本。
- `shell/` — WebView2 桌面壳（仅 Windows，`.NET 8 SDK`）；构建产物不提交。
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
