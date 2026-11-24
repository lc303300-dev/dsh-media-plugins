# AGENTS.md

DSH Studio 媒体能力包。一次安装提供 18 个工具、12 个技能与一个完成通知，是 Codex_Wsstudio
能力指南在 DSH 平台上的重建。本文件给在此仓库工作的 Agent 一个最小但足够的上下文。

> **火山方舟通道已屏蔽**：`cordis.patch.yml` 里 `Ws_tool-vision`（`describe_image`）的注册被注释，
> 实际注册 16 个工具；`setup.ps1` 默认也不再引导 `VOLCANO_ENGINE_API_KEY` 与
> `llm-pi-ai.providers.volcengine`。恢复：`.\setup.ps1 -EnableVolcano` + 取消该两行注释 + 重启 dsh。
> `src/tool-vision.ts` 实现保留，`media_status` 里该项显示 `disabled`。

## 文档索引（先读这里）

| 想了解 | 去看 |
|---|---|
| 产出应该长什么样、什么不许做（业务口径） | [`docs/business-rules.md`](docs/business-rules.md) |
| 为什么这么实现（兼容门 / 依赖打包 / 模块边界） | [`docs/architecture.md`](docs/architecture.md) |
| 各工具的参数语义与硬门（creative_writer / batch_image / 视频提交 / 画布） | [`docs/tool-contracts.md`](docs/tool-contracts.md) |
| 画布操作、画板制片流程、账号切换、踩坑 | [`docs/operations.md`](docs/operations.md) |
| 能力怎么用（按任务） | `skills/*/SKILL.md` |

**本文件只保留「在这个仓库里怎么工作」：结构、构建、调整约定。** 功能细节一律不在本文件展开——
写在这里等于让它和代码漂移（2026-11-24 曾实际发生：AGENTS.md 写 4–10 秒 / 2–4 镜 / 测试通道，
代码已是 4–15 秒 / 2–5 镜 / 无测试通道）。

## 创作线路（路由）

- **视频**：默认走导演线 `skills/video-prompt-orchestrator`；仅用户显式要求「启用 Skill 模式」才走
  `skills/video-skill-router` + `project_pipeline` + `skill_registry`（`create` 有 `skill_mode=true` 硬门）。
- **短剧 / 剧情 TVC**：入口 `skills/drama-mode`（解耦能力集），规则库 `skills/drama-tvc-prompt`。
- **图片**：`skills/default-image-generation`（单张）/ `skills/batch-image-generation`（批量）；
  治理层 `image-skill-curator` / `image_skill_pipeline` 只在用户上传资料入库时走。
- 各线路的参数级细节见 `docs/tool-contracts.md`。

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

## 业务口径（用户设定，长期有效）

工具怎么用写在技能里；**产出应该长什么样、什么不许做**统一放在 [`docs/business-rules.md`](docs/business-rules.md) ——它是业务口径的唯一真源，已脱敏（公开仓库不含客户名/项目名/本机路径）。

改口径的规矩：

- 新增一条用户设定，先改 `docs/business-rules.md` 并注明日期与用户原话；只有当它需要配套操作步骤时才同时写进技能，避免两处重复打架。
- 与技能正文冲突时，以 `docs/business-rules.md` 和标了「硬规则 / 硬门」的那条为准；与代码硬门冲突时以代码为准。
- 现有覆盖情况（2026-11-24 核对）：默认档位、m2v 默认、布光分工、分组规则、审阅页勾选已在技能里；**景别克制、扩图拉条、审阅页复制实现、场景卡三规则、画布命名与布局、角色卡 provider 分线、启动门两个坑**原先只在会话指令里，现已收进该文档，其中景别克制与审阅页复制要求已同时补进技能。
- **技能是按需加载的，不等于常驻生效**：真正每轮必守的（付费门、票据门、默认档位）必须落在代码硬门里，不要只写文档。
- 角色卡 provider 分线不在本文档也不在本文件，在 `skills/drama-mode` 的**素材层**（短剧生图阶段）；场景卡三规则同处。

## 调整约定

- 新增工具：在 `src/` 加 `tool-<name>.ts`，在 `tsdown.config.ts` 的 `entry` 加一行，
  在 `package.json` 的 `exports` 加 `./<name>` 与 `./Ws_<name>` 两条，并在
  `cordis.patch.yml` 的 `insert` 注册一行 `id` + `name`。
- 共享领域逻辑放 `src/shared/` 并保持 `Pure domain`（无 DSH/供应商依赖），用单测覆盖。
- 付费安全与凭证纪律不可破坏：Key/登录态不进仓库；`needs_review` 不自动重试；批量需明确付费确认。

更多行为细节（各工具契约、安全约定、安装/配置）见 `README.md`。
