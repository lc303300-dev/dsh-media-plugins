# dsh-media-plugins

DSH Studio 媒体与业务能力组合包（bundle），一次安装带来 15 个工具、9 个技能与一个完成通知，
覆盖 Codex_Wsstudio 指南（P0–P4 + DT 修订系统 + Codex_IS 受治理图片业务 Skill 层）在 DSH 平台上的重建：

| 功能 | 说明 | 底层 | 凭证 |
|---|---|---|---|
| `generate_image` | 统一媒体路由器生图/改图：`image_ratio` 必填 8 值、`image_resolution`（1K/2K/4K，Gemini 默认 2K / GPT 4K / Dreamina 1K）、`image_provider` 显式线路直达不回退；3 级适配器严格串行回退（comfly-gemini-flash-preview → comfly-gpt-image-2 → dreamina-image），单适配器 120s / 整任务 300s，失败分类 + needs_review 禁重试 + 每适配器连续 3 次失败熔断 60s，EXIF 归一化 + 最长边 1920px，跨进程容量锁（默认 6，dreamina 图/视频共享 `seedance-cli`） | Comfly / Dreamina CLI | `COMFLY_API_KEY` + VPN 代理 |
| `generate_video` | 生视频：默认 seedance2.5 / 480p；text2video / multimodal2video；`video_execution_mode`：production（提交+轮询+下载）、production_submit_only（仅提交）、test_submit_only（强制非 VIP 2.0/720p，仅返回 submit_id，到即梦后台查看） | 即梦 Dreamina 本地 CLI（`dreamina.exe`） | OAuth 登录态 |
| `describe_image` | 看图（识别/描述本地图片） | 火山方舟 Doubao（`doubao-seed-2-0-mini`） | `VOLCANO_ENGINE_API_KEY` |
| `skill_registry` | 业务 Skill 治理（Codex_CS）：ingest/search/get/publish/deprecate/list，contract 校验、name@version 去重、内容哈希防漂移、FTS5 trigram 中文检索 | node:sqlite + FTS5（零原生依赖） | 无 |
| `skill_curator` | 业务 Skill 录入治理（Codex_CS codex-cs-skill-curator）：scaffold / validate（validator 1.2.0）/ add_count_rules / planned_counts / migrate / publish（intake-receipt） | 内置模板 `refs/skill-template/` | 无 |
| `project_pipeline` | 项目状态机（Codex_CS）：显式状态流转、素材槽 min/max 校验、素材/提示词 sha256 锁定、`build_payload` 提交前哈希复核防未确认版本 | 原子 JSON 状态（私有运行目录） | 无 |
| `dt_batch` | DT 批次工作台：init_batch / prepare_previews（≤1024px）/ set_prompts / finalize_review（审阅 HTML） | sharp | 无 |
| `prompt_revision` | 提示词修订系统（Codex_DT）：classify 确定性分类（explicit_local/ambiguous_creative/structural_rewrite）+ 规范哈希修订契约；search_corpus 内置 seedance-forge 全量语料（2477 条，≤3 上限、保留 provenance、语料模型版本绝不用于选模型）；validate_result 校验（locked_context_sha256 回显、explicit_local 禁语料） | 内置语料 `refs/forge-index.jsonl` | 无 |
| `batch_image` | 确定性批量生图调度器：manifest 校验（支持组级 `reference_images`/`original_image` 槽 0）、稳定 job key、SQLite 状态、≤10 并发、≥1s 间隔、分派截止（默认 ceil(总数÷并发)×60s×1.5，可配 `deadline_seconds`）、完成宽限期（`completion_grace_seconds` 默认/上限 120s，可缩短不可延长）：截止后未启动任务永久 abandoned（`batch_deadline_not_submitted`）、运行中任务宽限期内落地照常收集、超时标记 failed（`batch_completion_grace_timeout`）；编号联系表（HTML，槽 0 原图）；重复提交被 job key 幂等拒绝 | node:sqlite + 统一路由器 | 同 generate_image |
| `video_to_gif` | 视频转 GIF：FFmpeg 双遍 palettegen/paletteuse，宽度/FPS/颜色/抖动分档降级，默认 ≤10MB；可选 strict/quality 模式、denoise、anti-moire、palette stats/diff 模式、bayer_scale、gifsicle lossy 优化、max_duration_sec 截断、input_dir 批量 + CSV 转换报告 | FFmpeg（`FFMPEG_PATH` / PATH / 常见安装路径）+ 可选 gifsicle | 无 |
| `image_preview` | EXIF 归一化 ≤1024px 预览 + 尺寸报告（视觉检查/审阅页用，不读原始大图） | sharp | 无 |
| `split_grid_sheet` | 3×3 九宫格拼图拆格：方案1 形态学线检测 → 失败自动方案2 等比分割；可选 normalize_ratio 规范比例；输出 r1c1..r3c3 面板 + 自包含审阅页 | sharp | 无 |
| `image_skill_curator` | 图片业务 Skill 录入治理（Codex_IS image-skill-curator）：scaffold（image-skill-template 骨架）/ audit（validator 2.0.0 intake-report：契约/路由/收据 schema、反泛化与反污染扫描、来源哈希）/ approve（approved_by=user）/ validate / publish（staging 原子发布 + 注册表重建，禁覆盖）/ upgrade（备份+回滚原子升级）/ seed_library（同步插件自带正式图片 Skill 库） | 内置模板 `refs/image-skill-template/` + 正式库 `refs/image-skill-library/` | 无 |
| `image_skill_pipeline` | 图片业务 Skill 项目管线（Codex_IS project-pipeline）：create 校验已发布包收据/包哈希 + 比例/场景数/候选数契约门禁，按 references 逐场景建素材槽；add_material 只收 allowed_slot_ids 声明槽并校验每场景参考图上限；lock_materials sha256 快照锁定（变化作废提示词）；set_prompt/confirm_prompt 哈希绑定确认；多场景或多候选须 confirm_paid_batch 付费批次确认；start_generation --dry-run 生成执行清单（单候选 generate_image / 多候选 batch-image-generation） | 原子 JSON 状态（私有运行目录 `<private>/image-projects/`） | 无 |
| `media_status` | 媒体/业务工具就绪检查：status（ready/degraded/unavailable）+ verify（部署验证：凭证存在性只报变量名、dreamina 二进制/登录/credit、ffmpeg、私有目录可写、语料、注册库） | 只读探针 | 无 |
| 完成通知 | 答案生成完成时弹 Windows 托盘气泡 | `notify-toast.ps1` | 无（仅 Windows） |

所有任务状态、锁、日志、注册库、项目/批次状态写入 **私有运行目录**
`<workspace>/.dsh-media-private/`（对应 `.codex-image-private`），凭证走 DSH credentials
系统，均不进入仓库或聊天。

## 安装

### 从 GitHub（源码）

```sh
dsh plugin --profile <name> add github:lc303300-dev/dsh-media-plugins
```

首次会因 pnpm 需要授权构建而失败，`dsh` 会提示把包名加进该 profile 的
`pnpm-workspace.yaml` 的 `allowBuilds`，之后重新 `add`。

### 从 npm / tarball（预构建，免授权）

```sh
dsh plugin --profile <name> add dsh-media-plugins       # npm
dsh plugin --profile <name> add ./dsh-media-plugins-0.2.0.tgz   # tarball
```

安装后 `dsh --profile <name> --dump-config` 应看到 `dsh-media-plugins` 层及其全部工具。

## 前置准备

### 1. 火山方舟（看图）

`$DSH_HOME/settings.yaml` 配置 `llm-pi-ai.providers.volcengine`（见 `setup.ps1` 或旧版 README）。
Key 写入 `$DSH_HOME/.credentials.yaml`。

官方入口：获取/管理 Key → <https://console.volcengine.com/ark>；充值 → <https://console.volcengine.com/finance/>

### 2. Comfly（生图回退链）

- `COMFLY_API_KEY`（必填，回退链 1–2 级共用）
- 需要 **VPN 代理**：`cordis.patch.yml` 里默认 `proxyUrl: 'http://127.0.0.1:7897'`，按本机代理端口改。
- 官方入口：充值 → <https://pay.comfly.chat/pay/>；获取/管理 Key → <https://comfly.chat>

### 3. 即梦 Dreamina（生视频）

- `dreamina.exe` 由 `setup.ps1` 下载到本包 `bin/`（不随仓库分发）。
- **OAuth 登录**：`.\bin\dreamina.exe login`，登录态存于 `~\.dreamina_cli\credential.json`。
- 即梦创作平台（会员/积分充值）：<https://jimeng.jianying.com>

### 4. FFmpeg（video_to_gif）

`FFMPEG_PATH` 环境变量 > PATH > 常见安装路径（oopz / Topaz / Virtual Desktop Streamer）。

## 一键引导

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

会完成：写 Key（COMFLY / VOLCANO）→ 配火山 provider → 下载 dreamina.exe → 引导登录 →
安装 9 个 Studio 技能到 `$DSH_HOME\skills\<技能名>`（DSH 技能发现根，两级结构，重启后生效）→ ffmpeg 检查。

## 使用

```text
generate_image(prompt="一只戴红围巾的橘猫", image_ratio="1:1", output="outputs/cat.png")
generate_video(prompt="夜晚的未来城市，镜头缓慢推进", duration=8, ratio="16:9")
generate_video(prompt="根据参考视频运镜，配合音乐节奏将静态图转为动态视频",
               images=["D:\\素材\\主图.png"], videos=["D:\\素材\\运镜参考.mp4"],
               audios=["D:\\素材\\音乐.mp3"], duration=8, model_version="2.5")
skill_registry(command="ingest", package_dir="D:\\skills\\城市夜景短片")
project_pipeline(command="create", skill_name="城市夜景短片", ratio="16:9", duration=8)
dt_batch(command="init_batch", materials=["D:\\素材\\a.png", "D:\\素材\\b.png"], duration=8)
batch_image(command="start", manifest={groups:[{id:"g1",prompt:"橘猫",candidates:4,image_ratio:"1:1"}]})
video_to_gif(video="D:\\out\\clip.mp4")
```

## Codex_IS：受治理图片业务 Skill 层

内置正式图片业务 Skill 库（`refs/image-skill-library/`），首包 `scene-storyboard-grid`（场景一致性九宫格分镜，双槽 scene-base + identity-design、3×3 单张输出、事实账本选镜）。用 `image_skill_curator` 的 `seed_library` 同步进私有库并注册，之后走 `image-skill-router` 技能流程：

```text
image_skill_curator(command="seed_library")
skill_registry(command="search", query="九宫格分镜")
image_skill_pipeline(command="create", skill_id="scene-storyboard-grid",
                     display_name="场景一致性九宫格分镜", ratio="16:9",
                     candidate_count=1, scene_count=1, skill_confirmed=true)
image_skill_pipeline(command="add_material", project_id=..., slot="scene-base", path="D:\\素材\\底图.png")
image_skill_pipeline(command="lock_materials", project_id=..., use_source=true)
image_skill_pipeline(command="set_prompt", project_id=..., text="<业务 Skill 产出的提示词 V1>")
image_skill_pipeline(command="confirm_prompt", project_id=...)
image_skill_pipeline(command="start_generation", project_id=..., dry_run=true)
```

- 单场景单候选 → 统一 `generate_image`；多场景或多候选 → 先 `confirm_paid_batch` 付费批次确认再交 `batch_image`。
- 入库新图片业务 Skill：`image_skill_curator` `scaffold` → 补全删除 `CURATOR-REQUIRED` → `audit`（sources 必填）→ `approve`（approved_by=user）→ `publish`（approved=true）；已发布包修订走 `upgrade`。
- 项目状态在 `<workspace>/.dsh-media-private/image-projects/`，正式图片 Skill 库在 `<workspace>/.dsh-media-private/image-skill-library/`。
- 新技能：`image-skill-router`（路由工作流）与 `image-skill-curator`（入库治理）随 `skills/` 一并安装到 `$DSH_HOME\skills\<技能名>`。

## 安全契约（与指南一致）

- Key / Cookie / 登录会话不进入 Git、日志与 Agent 回复；只记录脱敏 prompt（字符数 + sha256）。
- 付费安全：默认人工确认；`needs_review` 绝不自动重试；`test_submit_only` 不轮询；批量需明确付费确认。
- 输入安全：大图 EXIF 归一化与等比缩放（≤1920px）、不覆盖原图、素材顺序稳定、音频时长与文件存在性校验。
- 状态可靠性：任务 id 幂等、状态原子写、跨进程锁、取消标记、提交前后持久化。
- 并发控制：按 capacity key 限流；`seedance-cli` 图/视频共享容量。

## 开发与测试

```sh
pnpm build   # tsdown：src/*.ts → 包根 *.js（profile 用 link: 安装，改完重启 dsh 生效）
pnpm test    # node --test（103 个离线单测，覆盖路由/失败分类/熔断/状态机/注册库/批量/锁/GIF/修订/图片 Skill 治理与项目管线）
```

## 部署与运维脚本（`scripts/`）

| 脚本 | 对应 Codex | 用途 |
|---|---|---|
| `scripts/deploy.ps1` | new-machine-deploy / bootstrap-new-machine | 一键部署：前置检查 → 结构校验 → pnpm install+build → setup.ps1 引导 → verify-deployment → 桌面壳 + 快捷方式（.NET 8 SDK 可用时） |
| `scripts/verify-deployment.ps1` | verify-deployment.ps1 | 部署验证：包结构/构建产物/技能/语料/dreamina/ffmpeg/DSH 宿主侧 |
| `scripts/start-task.ps1` | scripts/maintenance/start-task.ps1 | 任务开始前检查：结构校验 + git 状态 + 安全 fast-forward 更新（仅干净工作树） |
| `scripts/configure-keys.ps1` | configure-api-key.ps1 | 隐藏式写 API Key 到 `$DSH_HOME/.credentials.yaml`，值不回显 |
| `shell/Build-DeepSeekHarnessShell.ps1` | — | 构建 WebView2 桌面壳（需要 .NET 8 SDK） |
| `shell/Install-DesktopShortcut.ps1` | — | 在桌面创建 DeepSeek Harness 快捷方式 |

运行时就绪详情用 `media_status` 工具的 `status` / `verify` 命令。

## 桌面壳（DeepSeekHarnessShell，仅 Windows）

`shell/` 内含一个 WebView2 桌面壳：启动 `dsh web`（或就近的源码检出）并包成独立窗口 + 托盘，
外链在系统默认浏览器打开。源码随仓库分发，构建产物不提交。

- 前置：**.NET 8 SDK**（`dotnet` 在 PATH）；运行时依赖 WebView2（Win10/11 自带）。
- 构建 + 建快捷方式：`powershell -NoProfile -ExecutionPolicy Bypass -File .\shell\Build-DeepSeekHarnessShell.ps1`
- 仅建快捷方式：`powershell -NoProfile -ExecutionPolicy Bypass -File .\shell\Install-DesktopShortcut.ps1`
- 部署入口 `scripts/deploy.ps1` 检测到 `dotnet` 时会自动构建并创建桌面快捷方式，否则跳过并提示。
- 壳会优先探测附近的 DSH 源码检出（或 `DEEPSEEK_HARNESS_ROOT`）；都没有时走 `dsh` CLI。
  可用环境变量 `DSH_WEB_COMMAND` 覆盖启动命令（默认 `dsh`）。

## 完成通知

无需配置，随 bundle 自动启用（仅 Windows）。
