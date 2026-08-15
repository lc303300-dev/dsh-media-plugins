# dsh-media-plugins

DSH Studio 媒体与业务能力组合包（bundle），一次安装带来 10 个工具、6 个技能与一个完成通知，
覆盖 Codex_Wsstudio 指南（P0–P4 + DT 修订系统）在 DSH 平台上的重建：

| 功能 | 说明 | 底层 | 凭证 |
|---|---|---|---|
| `generate_image` | 统一媒体路由器生图/改图：`image_ratio` 必填 8 值，6 级适配器严格串行回退（comfly×3 → apimart → google gemini → dreamina-image），单适配器 120s / 整任务 300s，失败分类 + needs_review 禁重试，EXIF 归一化 + 最长边 1920px，跨进程容量锁（默认 6，dreamina 图/视频共享 `seedance-cli`） | Comfly / APIMart / Google Gemini / Dreamina CLI | `COMFLY_API_KEY`、`APIMART_API_KEY`、`GEMINI_API_KEY` + VPN 代理 |
| `generate_video` | 生视频：默认 seedance2.5 / 480p；text2video / multimodal2video；`video_execution_mode`：production（提交+轮询+下载）、production_submit_only（仅提交）、test_submit_only（强制非 VIP 2.0/720p，仅返回 submit_id，到即梦后台查看） | 即梦 Dreamina 本地 CLI（`dreamina.exe`） | OAuth 登录态 |
| `describe_image` | 看图（识别/描述本地图片） | 火山方舟 Doubao（`doubao-seed-2-0-mini`） | `VOLCANO_ENGINE_API_KEY` |
| `skill_registry` | 业务 Skill 治理（Codex_CS）：ingest/search/get/publish/deprecate/list，contract 校验、name@version 去重、内容哈希防漂移、FTS5 trigram 中文检索 | node:sqlite + FTS5（零原生依赖） | 无 |
| `project_pipeline` | 项目状态机（Codex_CS）：显式状态流转、素材槽 min/max 校验、素材/提示词 sha256 锁定、`build_payload` 提交前哈希复核防未确认版本 | 原子 JSON 状态（私有运行目录） | 无 |
| `dt_batch` | DT 批次工作台：init_batch / prepare_previews（≤1024px）/ set_prompts / finalize_review（审阅 HTML） | sharp | 无 |
| `prompt_revision` | 提示词修订系统（Codex_DT）：classify 确定性分类（explicit_local/ambiguous_creative/structural_rewrite）+ 规范哈希修订契约；search_corpus 内置 seedance-forge 全量语料（2477 条，≤3 上限、保留 provenance、语料模型版本绝不用于选模型）；validate_result 校验（locked_context_sha256 回显、explicit_local 禁语料） | 内置语料 `refs/forge-index.jsonl` | 无 |
| `batch_image` | 确定性批量生图调度器：manifest 校验、稳定 job key、SQLite 状态、≤10 并发、≥1s 间隔、硬截止（默认 ceil(总数÷并发)×60s×1.5）、截止后永久 abandoned、编号联系表；重复提交被 job key 幂等拒绝 | node:sqlite + 统一路由器 | 同 generate_image |
| `video_to_gif` | 视频转 GIF：FFmpeg 双遍 palettegen/paletteuse，宽度/FPS/抖动分档降级，默认 ≤10MB | FFmpeg（`FFMPEG_PATH` / PATH / 常见安装路径） | 无 |
| `image_preview` | EXIF 归一化 ≤1024px 预览 + 尺寸报告（视觉检查/审阅页用，不读原始大图） | sharp | 无 |
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

### 2. Comfly / APIMart / Gemini（生图回退链）

- `COMFLY_API_KEY`（必填，回退链 1–3 级共用）
- `APIMART_API_KEY`（可选，第 4 级）
- `GEMINI_API_KEY`（可选，第 5 级）
- 需要 **VPN 代理**：`cordis.patch.yml` 里默认 `proxyUrl: 'http://127.0.0.1:7897'`，按本机代理端口改。

### 3. 即梦 Dreamina（生视频）

- `dreamina.exe` 由 `setup.ps1` 下载到本包 `bin/`（不随仓库分发）。
- **OAuth 登录**：`.\bin\dreamina.exe login`，登录态存于 `~\.dreamina_cli\credential.json`。

### 4. FFmpeg（video_to_gif）

`FFMPEG_PATH` 环境变量 > PATH > 常见安装路径（oopz / Topaz / Virtual Desktop Streamer）。

## 一键引导

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

会完成：写 Key（含 APIMART/GEMINI）→ 配火山 provider → 下载 dreamina.exe → 引导登录 →
安装 6 个 Studio 技能到 `$DSH_HOME\skills\dsh-media-studio`（DSH 技能发现根，重启后生效）→ ffmpeg 检查。

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

## 安全契约（与指南一致）

- Key / Cookie / 登录会话不进入 Git、日志与 Agent 回复；只记录脱敏 prompt（字符数 + sha256）。
- 付费安全：默认人工确认；`needs_review` 绝不自动重试；`test_submit_only` 不轮询；批量需明确付费确认。
- 输入安全：大图 EXIF 归一化与等比缩放（≤1920px）、不覆盖原图、素材顺序稳定、音频时长与文件存在性校验。
- 状态可靠性：任务 id 幂等、状态原子写、跨进程锁、取消标记、提交前后持久化。
- 并发控制：按 capacity key 限流；`seedance-cli` 图/视频共享容量。

## 开发与测试

```sh
pnpm build   # tsdown：src/*.ts → 包根 *.js（profile 用 link: 安装，改完重启 dsh 生效）
pnpm test    # node --test（23 个离线单测，覆盖路由/失败分类/状态机/注册库/批量/锁）
```

## 完成通知

无需配置，随 bundle 自动启用（仅 Windows）。
