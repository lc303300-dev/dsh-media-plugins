# dsh-media-plugins

DSH Studio 媒体与业务能力组合包（bundle），一次安装带来 15 个工具、10 个技能与一个完成通知，
覆盖 Codex_Wsstudio 指南（P0–P4 + 受约束修订系统 + Codex_IS 受治理图片业务 Skill 层）在 DSH 平台上的重建：

| 功能 | 说明 | 底层 | 凭证 |
|---|---|---|---|
| `generate_image` | 统一媒体路由器生图/改图：`image_ratio` 必填 8 个标准比例（也接受 `1920x1080` 这类像素尺寸并自动换算成最接近的比例）、`image_resolution`（1K/2K/4K；单档位线路只钳制不报错：Gemini **2K-only**（1K/4K→2K）、GPT 2.5 **4K-only**（1K/2K→4K）、Dreamina 1K）、`image_provider` 显式线路直达不回退；默认线路 `comfly-gpt-image-2.5`（Comfly `gpt-image-2.5-sunburst`，**4K-only**：只传 4K 具体像素 `size`、1K/2K 请求钳制为 4K、不传 `resolution`/`response_format`、图片读 `data[0].b64_json` 解码），次选线路 `comfly-gemini-flash-preview`（Comfly `gemini-3.1-flash-image-preview-2k`，**2K-only**：只出 2K、1K/4K 请求钳制为 2K，提交 `resolution=2k` + `response_format=url` 并读 `data[0].url`），3 级适配器严格串行回退（comfly-gpt-image-2.5 → comfly-gemini-flash-preview → dreamina-image），单张总预算 90s（单次尝试、整任务、每股基准是同一个数字），失败分类 + 只有错误类才换线路 + needs_review 禁重试 + 每适配器连续 3 次失败熔断 60s，EXIF 归一化 + 最长边 1920px，跨进程容量锁（默认 **10**，全部图片任务共享单一池 `image`；视频侧独立 `seedance-cli` 上限 6） | Comfly / Dreamina CLI | `COMFLY_API_KEY` + VPN 代理 |
| `generate_video` | 生视频：默认 seedance2.5 / 480p；text2video / multimodal2video；`video_execution_mode`：production（提交+轮询+下载）、production_submit_only（仅提交）、test_submit_only（强制非 VIP 2.0/720p，仅返回 submit_id，到即梦后台查看） | 即梦 Dreamina 本地 CLI（`dreamina.exe`） | OAuth 登录态 |
| `describe_image` | 兜底看图：仅当当前主模型无法读图时用 Doubao 返回中文描述；主模型可读图时请直接用核心 `read_image`（本工具会拒绝并提示） | 火山方舟 Doubao（`doubao-seed-2-0-mini`） | `VOLCANO_ENGINE_API_KEY` |
| `skill_registry` | 业务 Skill 治理（Codex_CS）：ingest/search/get/publish/deprecate/list，contract 校验、name@version 去重、内容哈希防漂移、FTS5 trigram 中文检索 | node:sqlite + FTS5（零原生依赖） | 无 |
| `skill_curator` | 业务 Skill 录入治理（Codex_CS codex-cs-skill-curator）：scaffold / validate（validator 1.2.0）/ add_count_rules / planned_counts / migrate / publish（intake-receipt） | 内置模板 `refs/skill-template/` | 无 |
| `project_pipeline` | 项目状态机（Codex_CS，**Skill 线专属**）：`create` 有 `skill_mode` 硬门（用户未显式要求启用 Skill 模式即拒绝创建）、显式状态流转、素材槽 min/max 校验、素材/提示词 sha256 锁定、`build_payload` 提交前哈希复核防未确认版本 | 原子 JSON 状态（私有运行目录） | 无 |
| `prompt_batch` | 批次创作工作台（导演线的多素材批次能力，原 `dt_batch`）：init_batch / prepare_previews（≤1024px）/ set_visuals / set_prompts（裸标签绑定门 + **每段一次性检索凭证门**）/ finalize_review（审阅 HTML）/ run_batch（提交计划） | sharp | 无 |
| `prompt_revision` | 提示词修订系统（Codex_DT）：classify 确定性分类（explicit_local/ambiguous_creative/structural_rewrite）+ 规范哈希修订契约；search_corpus 内置 seedance-forge 全量语料（2477 条，≤10 上限、保留 provenance、语料模型版本绝不用于选模型）；validate_result 校验（locked_context_sha256 回显、explicit_local 禁语料）；**search_corpus 每次发放一张一次性检索凭证 `search_id`**（账本 `<private>/corpus-ledger.json`），`authoring_gate` 校验并消费它——因此 N 段创作必须 N 次检索，自报命中数不再被接受 | 内置语料 `refs/forge-index.jsonl` | 无 |
| `batch_image` | 确定性批量生图调度器：manifest 校验（支持组级 `reference_images`/`original_image` 槽 0）、稳定 job key、SQLite 状态、≤10 并发、≥1s 间隔、分派截止（默认 ceil(总数÷并发)×90s，可配 `deadline_seconds`）、完成宽限期（`completion_grace_seconds` 默认/上限 120s，可缩短不可延长）：截止后未启动任务永久 abandoned（`batch_deadline_not_submitted`）、运行中任务宽限期内落地照常收集、超时标记 failed（`batch_completion_grace_timeout`）；编号联系表（HTML，槽 0 原图）；重复提交被 job key 幂等拒绝 | node:sqlite + 统一路由器 | 同 generate_image |
| `video_to_gif` | 视频转 GIF：FFmpeg 双遍 palettegen/paletteuse，宽度/FPS/颜色/抖动分档降级，默认 ≤10MB；可选 strict/quality 模式、denoise、anti-moire、palette stats/diff 模式、bayer_scale、gifsicle lossy 优化、max_duration_sec 截断、input_dir 批量 + CSV 转换报告 | FFmpeg（`FFMPEG_PATH` / PATH / 常见安装路径）+ 可选 gifsicle | 无 |
| `image_preview` | EXIF 归一化 ≤1024px 预览 + 尺寸报告（视觉检查/审阅页用，不读原始大图） | sharp | 无 |
| `split_grid_sheet` | 3×3 九宫格拆格（**双检测器**）：方案1 形态学线检测（阈值+整幅白色行长带，纯白格线最快最准）→ 方案2 **亮度曲线峰值检测**（整行/整列平均亮度取「最接近 1/3、2/3 的显著局部峰」，可处理浅灰/柔和格线、行高列宽不均匀，并以突出度判据拒绝把大面积亮内容误判为格线）→ 两者皆失败才回退方案3 等比分割。检测成功时按格线带**外侧**切割，格线像素零残留（此前的「格线中心 ± 内缩」在行高不均时会切进相邻格）。**支持批量分组**：`groups=[{group, images}]` 把每组所有图的面板**平铺**写入 `<output_dir>/<group>/`，组内不再嵌套子目录。可选 normalize_ratio 规范比例；单张输出 r1c1..r3c3 + 自包含审阅页 | sharp | 无 |
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
prompt_batch(command="init_batch", materials=["D:\\素材\\a.png", "D:\\素材\\b.png"], duration=8)
batch_image(command="start", manifest={groups:[{id:"g1",prompt:"橘猫",candidates:4,image_ratio:"1:1"}]})
video_to_gif(video="D:\\out\\clip.mp4")
```

## 视频创作线路

**默认只有一条创作线**；业务 Skill 线必须由用户显式启用：

- **导演线（默认，`video-prompt-orchestrator`，原 `dt-video-prompt`）**：单条走"非破坏性提示词门"——用户明确说不改提示词时只做语义保真规范化，否则一律用导演知识 + 语料补全；多素材走批次模式：`prompt_batch` 建隔离批次 → 1024px 预览 → 逐段 `prompt_revision search_corpus` + `authoring_gate`（**一次性检索凭证，N 段必须 N 次检索**）→ `set_prompts`（裸标签 `图片N` 绑定 + 每段凭证核对，缺任一即整次拒写）→ `finalize_review` 审阅页 → 用户逐项确认 → 统一 `generate_video` 提交。**默认不检索业务 Skill、不调用 `skill_registry` / `project_pipeline`。**
- **Skill 线（仅显式启用，`video-skill-router`）**：仅当用户明确要求"启用 Skill 模式"时才走；进入时必须告知用户已进入 Skill 模式；`project_pipeline create` 的 `skill_mode` 硬门会拒绝未经显式要求的创建。
- **DT 批次线已取消**：原 `dt_batch` 工具改名为 `prompt_batch`，作为导演线的批次能力；原 `dt-prompt-authoring` 技能已删除，其流程并入 `video-prompt-orchestrator`。遗留 `<private>/dt/` 批次目录会在首次调用时自动迁移到 `<private>/batches/`。

## 图片生成线路

**职责边界**：图片线路只对**数量与速度**负责——生成后不做质量检查：不逐张 `read_image`/`describe_image` 验收、不做审美/一致性/尺寸判断、不自动淘汰或重生成。成功即以返回路径（或联系表）交付，取舍由用户人工判断；只有工具返回失败或 `needs_review` 时才如实上报。

- **单张（`generate_image`，技能 `default-image-generation`）**：`image_ratio` 必填（8 个标准比例，或 `1920x1080` 这类像素写法，自动换算）；默认线路 `comfly-gpt-image-2.5`（4K-only）→ 允许回退的失败才转 `comfly-gemini-flash-preview`（2K-only）→ `dreamina-image`（1K）；`image_provider` 点名则单线路、失败不回退。预算：单张总预算 90s（`IMAGE_SECONDS_PER_CANDIDATE`，单次尝试、整任务与批量的每股基准是同一个数字）；`needs_review` 禁重试。**只有错误类失败（401/403、402/429、5xx）才换下一条线路**——超时类（`timeout_before_submit` / `provider_timeout`）与 `download_failure` 直接判失败，因为请求已经发出、可能已计费，换线路等于对同一张图付两次钱；下载失败改为重试同一个 URL。
- **批量（`batch_image`，技能 `batch-image-generation`）**：manifest（组 × 候选）→ 稳定 job key（同一 manifest 重复提交被拒）→ SQLite 状态 → 分派并发默认 10（`concurrency` 1..10）、真实提交间隔 ≥1s → 分派截止 `ceil(总数÷并发)×90s`（可 `deadline_seconds` 覆盖）：截止后**未启动**任务永久 `abandoned`（`batch_deadline_not_submitted`，不查询不重试）→ 已在跑的再等 `completion_grace_seconds`（默认/上限 120s），超时记 `failed`（`batch_completion_grace_timeout`）→ `contact_sheet` 出固定槽位编号联系表供人工选图。
- **并发容量（单一图片池）**：图片侧只有一个跨进程共享的容量池（`IMAGE_CAPACITY_KEY = 'image'`，默认 **10**）：`generate_image` 单张、`batch_image` 批量、所有线路、同一 workspace 下的所有 dsh 进程都从这 10 个槽位取用——**任何时刻最多只有 10 张图在同时生成**。批量分派并发默认也是 10（`concurrency` 1..10），与池子对齐；调小 `concurrency` 只是让分派更保守，池子仍可能被其他会话的单张任务占用。**视频侧容量完全独立**（`seedance-cli` 上限 6，来自上游 CLI 自己的 `max_concurrency`），图片与视频互不占额度。
- **受治理业务 Skill 线（`image-skill-router` + `image_skill_pipeline`）**：仅在用户使用受治理图片 Skill 时走；总任务量 = 场景数 × 候选数，=1 交 `generate_image`，>1 需 `confirm_paid_batch` 后交 `batch_image`。

**40 张怎么走**（例：5 组 × 8 候选，`image_ratio` 16:9，`image_resolution` 4K）：

```text
batch_image(command="start", manifest={groups:[…5 组…], image_resolution:"4K"})
→ total 40 · concurrency 10（默认）· estimate ceil(40/10)×90 = 360s · dispatch deadline 360s · grace 120s · max runtime 480s
→ 提交节流 ≥1s：前 10 张在约 9s 内按 1s 间隔起跑，之后每完成一张补一张；全程同时在跑的图片不超过 10
→ 360s 起不再发起新任务：未启动的永久 abandoned，在跑的再等 ≤120s，超时 failed
batch_image(command="status", job_key=…)        # 轮询 landed/abandoned
batch_image(command="contact_sheet", job_key=…) # 生成编号联系表 → 用户人工选图
```

`deadline` 只由一个数字决定：**每股 90 秒**（`IMAGE_SECONDS_PER_CANDIDATE`，与单张的超时预算同一个值），`deadline = ceil(候选数 ÷ 并发) × 90s`，**没有额外的余量系数**——40 张即 `ceil(40/10)×90 = 360s`。要放宽就显式给 `deadline_seconds`；`concurrency` 只管分派节奏，真正的并发上限始终是那个共享的 10。

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
- 并发控制：图片侧单一共享容量池（默认 10，跨进程，`generate_image` / `batch_image` / 所有会话共用）；视频侧独立 `seedance-cli` 池（上限 6）。

## 开发与测试

```sh
pnpm build   # tsdown：src/*.ts → dist/*.js（profile 用 link: 安装，改完重启 dsh 生效）
pnpm test    # node --test（182 个离线单测，覆盖路由/失败分类/熔断/状态机/注册库/批量/锁/GIF/修订/Skill 模式硬门/检索凭证账本/状态迁移/图片 Skill 治理与项目管线）
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
