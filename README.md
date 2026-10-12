# dsh-media-plugins

DSH Studio 媒体与业务能力组合包（bundle），一次安装带来 16 个工具、11 个技能与一个完成通知
（**当前火山方舟通道已屏蔽，实际注册 15 个工具**，见 `describe_image` 一行），
覆盖 Codex_Wsstudio 指南（P0–P4 + 受约束修订系统 + Codex_IS 受治理图片业务 Skill 层）在 DSH 平台上的重建：

| 功能 | 说明 | 底层 | 凭证 |
|---|---|---|---|
| `generate_image` | 统一媒体路由器生图/改图：`image_ratio` 必填 8 个标准比例（也接受 `1920x1080` 这类像素尺寸并自动换算成最接近的比例）、`image_resolution`（1K/2K/4K；单档位线路只钳制不报错：Gemini **2K-only**（1K/4K→2K）、GPT Image 2 固定输出 2048 长边（属 2K，1K/2K/4K 请求都按该档执行）、Dreamina 1K）、`image_provider` 显式线路直达不回退；默认线路 `comfly-gpt-image-2-4k`（Comfly `gpt-image-2-4k`：只传 `aspect_ratio` 比例、**绝不传 `size`**（size 请求会被网关改写成无配额渠道并 503）、不传 `resolution`/`response_format`、**实测输出 2048 长边**（16:9 → 2048x1152，模型名里的 4k 只是渠道后缀）、图片读 `data[0].url` 下载），次选线路 `comfly-gemini-flash-preview`（Comfly `gemini-3.1-flash-image-preview-2k`，**2K-only**：只出 2K、1K/4K 请求钳制为 2K，提交 `resolution=2k` + `response_format=url` 并读 `data[0].url`），**单线路执行**：每条候选只选链中第一条就绪线路（comfly-gpt-image-2-4k；缺凭证或熔断则顺延到 comfly-gemini-flash-preview、dreamina-image），**失败即停、绝不换线路重放已付费的尝试**，单张总预算 90s（提交 + 下载 + 下载重试共用同一时间盒），失败分类 + needs_review 禁重试 + 每线路连续 3 次失败熔断 60s，EXIF 归一化 + 最长边 1920px（无 alpha 时上传副本转 JPEG q88），跨进程容量锁（默认 **10**，全部图片任务共享单一池 `image`；视频侧独立池按 `videoCapacity`（默认 10）限制并发提交） | Comfly / Dreamina CLI | `COMFLY_API_KEY` + VPN 代理 |
| `generate_video` | 生视频（即梦画布 CLI）：默认 `seedance_2.5` / 480p / 16:9 / 5 秒；公开模式只有 `t2v` / `first_last_frame` / `m2v`（**没有 i2v**：无参考→`t2v`；单图锁首帧、或两张有序图片→`first_last_frame`；单图但显式指定比例、或含视频/音频/多图参考→`m2v`）；多产物**分节点**（每节点 `--count 1`）；付费链路固定 `resource upload → node create（保存）→ node quote → node confirm --credit-ceiling → node run --submit-id → operation wait → resource download`，报价不等于授权、同一 submit-id 绝不重放、等待超时记 needs_review 而不重提；`video_execution_mode`：production（提交+等待+下载）、production_submit_only（仅提交）、test_submit_only（最低成本模型 + 720p，仅提交） | 即梦画布 CLI（`dreamina-canvas`） | OAuth 设备授权（`auth login`） |
| `describe_image` | **当前已屏蔽**（`cordis.patch.yml` 未注册 `Ws_tool-vision`，`setup.ps1` 默认也不引导其 Key/provider；恢复见下文「前置准备 1」）。原本用途：兜底看图——仅当当前主模型无法读图时用 Doubao 返回中文描述；主模型可读图时请直接用核心 `read_image` | 火山方舟 Doubao（`doubao-seed-2-0-mini`） | `VOLCANO_ENGINE_API_KEY` |
| `skill_registry` | 业务 Skill 治理（Codex_CS）：ingest/search/get/publish/deprecate/list，contract 校验、name@version 去重、内容哈希防漂移、FTS5 trigram 中文检索 | node:sqlite + FTS5（零原生依赖） | 无 |
| `skill_curator` | 业务 Skill 录入治理（Codex_CS codex-cs-skill-curator）：scaffold / validate（validator 1.2.0）/ add_count_rules / planned_counts / migrate / publish（intake-receipt） | 内置模板 `refs/skill-template/` | 无 |
| `project_pipeline` | 项目状态机（Codex_CS，**Skill 线专属**）：`create` 有 `skill_mode` 硬门（用户未显式要求启用 Skill 模式即拒绝创建）、显式状态流转、素材槽 min/max 校验、素材/提示词 sha256 锁定、`build_payload` 提交前哈希复核防未确认版本 | 原子 JSON 状态（私有运行目录） | 无 |
| `prompt_batch` | 批次创作工作台（导演线的多素材批次能力，原 `dt_batch`）：init_batch / prepare_previews（≤1024px）/ set_visuals / set_prompts（裸标签绑定门 + **每段一次性检索凭证门**）/ finalize_review（审阅 HTML：每张参考图带复选框 + **复制勾选名称/路径**）/ run_batch（提交计划） | sharp | 无 |
| `prompt_revision` | 提示词修订系统（Codex_DT）：classify 确定性分类（explicit_local/ambiguous_creative/structural_rewrite）+ 规范哈希修订契约；search_corpus 内置 seedance-forge 全量语料（2477 条，≤10 上限、保留 provenance、语料模型版本绝不用于选模型）；validate_result 校验（locked_context_sha256 回显、explicit_local 禁语料）；**search_corpus 每次发放一张一次性检索凭证 `search_id`**（账本 `<private>/corpus-ledger.json`），`authoring_gate` 校验并消费它——因此 N 段创作必须 N 次检索，自报命中数不再被接受 | 内置语料 `refs/forge-index.jsonl` | 无 |
| `batch_image` | 确定性批量生图调度器：manifest 校验（支持组级 `reference_images`/`original_image` 槽 0、组级 `grid` 多宫格声明如 `"3x3"`）、稳定 job key、SQLite 状态、≤10 并发、≥1s 间隔、分派截止（默认 ceil(总数÷并发)×90s，可配 `deadline_seconds`）、完成宽限期（`completion_grace_seconds` 默认/上限 120s，可缩短不可延长）：截止后未启动任务永久 abandoned（`batch_deadline_not_submitted`）、运行中任务宽限期内落地照常收集、超时标记 failed（`batch_completion_grace_timeout`）；编号联系表（HTML，**每张图可勾选 + 一键复制名称/路径**；落地图若是九宫格/四宫格等**单图多小图会被自动拆分并逐格列出**，页面只展示拆出来的小图、不再重复展示拆前的整图，无缝拼版按 `grid` 声明等比切割，面板落在 `<outputDir>/<jobKey>/_panels/`）；重复提交被 job key 幂等拒绝 | node:sqlite + 统一路由器 | 同 generate_image |
| `video_to_gif` | 视频转 GIF：FFmpeg 双遍 palettegen/paletteuse，宽度/FPS/颜色/抖动分档降级，默认 ≤10MB；可选 strict/quality 模式、denoise、anti-moire、palette stats/diff 模式、bayer_scale、gifsicle lossy 优化、max_duration_sec 截断、input_dir 批量 + CSV 转换报告 | FFmpeg（`FFMPEG_PATH` / PATH / 常见安装路径）+ 可选 gifsicle | 无 |
| `image_preview` | EXIF 归一化 ≤1024px 预览 + 尺寸报告（视觉检查/审阅页用，不读原始大图） | sharp | 无 |
| `split_grid_sheet` | 3×3 九宫格拆格（**先识别分辨率 + 双检测器 + 仲裁**）：**流程第一步读取文件本身确认真实分辨率**（绝不假定 3840×2160 画布），其后格线定位与切割全部按该真实尺寸计算——同批图分辨率不一致（实测 3840×2160 与 5504×3072 混排）也能正确拆；`expected_size` 可传预期分辨率，不符会告警。方案1 形态学线检测（纯白格线最快最准）→ 方案2 **亮度曲线峰值检测**（取最接近 1/3、2/3 的**窄峰**，以峰宽而非绝对亮度拒绝把大片亮内容（天空/水面/白墙）误判为格线，可处理浅灰格线、行高列宽不均匀）→ 两结果按「谁更接近标准三等分」仲裁，皆失败或**偏离 >20% 判定不可靠**时回退方案3 等比分割。检测成功时按格线带**外侧**切割，格线像素零残留。**支持批量分组**：`groups=[{group, images}]` 把每组所有图的面板**平铺**写入 `<output_dir>/<group>/`，组内不再嵌套子目录；批量结果含每张图的 `source_resolution` 与整体 `resolution_summary`。可选 normalize_ratio 规范比例；单张输出 r1c1..r3c3 + 自包含审阅页（**只列拆分后的面板**、每张可勾选并一键复制名称/路径，拆前的源图只在标题行标路径、不重复展示） | sharp | 无 |
| `image_skill_curator` | 图片业务 Skill 录入治理（Codex_IS image-skill-curator）：scaffold（image-skill-template 骨架）/ audit（validator 2.0.0 intake-report：契约/路由/收据 schema、反泛化与反污染扫描、来源哈希）/ approve（approved_by=user）/ validate / publish（staging 原子发布 + 注册表重建，禁覆盖）/ upgrade（备份+回滚原子升级）/ seed_library（同步插件自带正式图片 Skill 库） | 内置模板 `refs/image-skill-template/` + 正式库 `refs/image-skill-library/` | 无 |
| `image_skill_pipeline` | 图片业务 Skill 项目管线（Codex_IS project-pipeline）：create 校验已发布包收据/包哈希 + 比例/场景数/候选数契约门禁，按 references 逐场景建素材槽；add_material 只收 allowed_slot_ids 声明槽并校验每场景参考图上限；lock_materials sha256 快照锁定（变化作废提示词）；set_prompt/confirm_prompt 哈希绑定确认；多场景或多候选须 confirm_paid_batch 付费批次确认；start_generation --dry-run 生成执行清单（单候选 generate_image / 多候选 batch-image-generation） | 原子 JSON 状态（私有运行目录 `<private>/image-projects/`） | 无 |
| `media_status` | 媒体/业务工具就绪检查：status（ready/degraded/unavailable）+ verify（部署验证：凭证存在性只报变量名、dreamina 二进制/登录/credit/**激活账号 + user_id + 管线默认账号 + 是否不一致**、ffmpeg、私有目录可写、语料、注册库） | 只读探针 | 无 |
| `dreamina_account` | 即梦 CLI 账号切换。CLI **同一时刻只持有一个登录态**，真实位置是注册表 `HKCU\Software\BytedAuthClient\keychain\dreamina` 的 DPAPI 值（值名 base64 = `byted_cli_user_token`）——`~/.dreamina_cli/credential.json` 是 CLI **从不读取**的遗留文件（删掉/改坏它 CLI 照常工作）。命令：`current`（当前激活 + 管线默认）、`list`（账号库）、`save`（把当前登录态存为命名账号）、`use`（切换；有活动即梦任务时拒绝，除非 `force=true`）、`default`（**设置管线默认账号并立即切换**）、`rename`（给账号改名，默认指针跟随）、`login`（引导 OAuth Device Flow：先把现有登录态自动备份入库再清空，输出 `verification_uri`/`user_code`/`device_code`，用目标浏览器授权）、`login-check`（轮询完成授权并自动入库）、`forget`（从库中删账号，不动当前登录态）。账号名大小写不敏感（显示保留写法，如 `ISUN`/`wsstudio`）。只输出 user_id/额度/指纹，绝不输出登录态内容 | Windows 注册表 keychain + `<private>/dreamina-accounts/` | 无 |
| 完成通知 | 答案生成完成时弹 Windows 托盘气泡 | `notify-toast.ps1` | 无（仅 Windows） |

所有任务状态、锁、日志、注册库、项目/批次状态写入 **私有运行目录**
`<workspace>/.dsh-media-private/`（对应 `.codex-image-private`），凭证走 DSH credentials
系统，均不进入仓库或聊天。

### 即梦账号切换（`dreamina_account`）

即梦 CLI 的登录态**不在** `%USERPROFILE%\.dreamina_cli\credential.json`（那是遗留文件），
而在注册表 `HKCU\Software\BytedAuthClient\keychain\dreamina` 的一个 DPAPI 值里，因此
**同一时刻只可能有一个账号在线**。切换账号 = 用另一个账号的 blob 覆盖该值；账号库落在
`<private>/dreamina-accounts/<name>/{token.txt,account.json}`（原样保存 DPAPI blob，只有
当前 Windows 用户 + 本机能复用）。

把管线固定到某个账号（例如你在 Chrome 里登录的那个）：

```text
dreamina_account command=save   name=wsstudio               # 先把当前（默认浏览器）账号入库备份
dreamina_account command=login  name=ISUN                   # 输出 verification_uri / user_code / device_code
   → 在 Chrome 打开 verification_uri（该浏览器已登录目标即梦账号），确认 user_code 完成授权
dreamina_account command=login-check name=ISUN device_code=<上一步的 device_code>
dreamina_account command=default name=ISUN                  # 设为管线默认，并立即切换
```

**账号命名**：字母（大小写皆可）/数字/`. _ -`，≤32 字符。显示名保留你写的写法（`ISUN` 就是 `ISUN`），
但目录与 `default.json` 指针统一按小写归一，因此大小写不敏感（`ISUN` = `isun`），改名只改写法
（`rename name=isun new_name=ISUN`）不会搬动目录。改名用
`dreamina_account command=rename name=<旧名> new_name=<新名>`，管线默认指针会自动跟随。

此后 `generate_video` / `generate_image` / `batch_image` 在**每次 CLI 调用前**都会确保默认账号
是激活态（幂等：指纹一致时只做一次 `reg query`，不写注册表）；想回到旧账号执行
`dreamina_account command=use name=wsstudio` 即可，无需再次授权。若有正在运行的
即梦任务，切换会被拒绝（避免进行中的任务用错账号轮询），确需强制时传 `force=true`。

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

### 1. 火山方舟（看图）—— **当前已屏蔽，跳过即可**

`describe_image`（`Ws_tool-vision`）已从 `cordis.patch.yml` 注销，`setup.ps1` 默认也不再引导它的 Key 与
provider；部署时**无需**申请或填写火山方舟 Key。

恢复（三步）：`.\setup.ps1 -EnableVolcano`（或手工在 `$DSH_HOME/settings.yaml` 配
`llm-pi-ai.providers.volcengine`，Key 写入 `$DSH_HOME/.credentials.yaml`）→ 取消
`cordis.patch.yml` 里 `Ws_tool-vision` 两行注释 → 重启 dsh。

官方入口：获取/管理 Key → <https://console.volcengine.com/ark>；充值 → <https://console.volcengine.com/finance/>

### 2. Comfly（生图线路）

- `COMFLY_API_KEY`（必填，两条 Comfly 线路共用）
- 需要 **VPN 代理**：`cordis.patch.yml` 里默认 `proxyUrl: 'http://127.0.0.1:7897'`，按本机代理端口改。
- 官方入口：充值 → <https://pay.comfly.chat/pay/>；获取/管理 Key → <https://comfly.chat>

### 3. 即梦画布 CLI（生视频 / 即梦图片兜底线路）

- 安装（官方安装器，装到 `~/bin/dreamina-canvas.exe` 并附带 Agent Skill `~/.agents/skills/dreamina-canvas-cli`）：
  `irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex`
- **OAuth 设备授权登录**：`dreamina-canvas auth login`；自检 `auth status` / `auth account`。
- 登录态在 `HKCU\Software\BytedAuthClient\keychain\dreamina_canvas_oauth_v2_<hash>`（DPAPI 值），与旧 CLI 的 `...\keychain\dreamina` **互不覆盖**。
- 旧的 `dreamina.exe` 自 2026-11 停止维护：本包**不再分发**、也**不再提供余额查询**。账户身份与会员等级取 `auth account`（`userId` / `isVip` / `vipLevel`，**不返回积分余额**）。
- 即梦创作平台（会员/积分充值）：<https://jimeng.jianying.com>

### 4. FFmpeg（video_to_gif）

`FFMPEG_PATH` 环境变量 > PATH > 常见安装路径（oopz / Topaz / Virtual Desktop Streamer）。

## 一键引导

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

会完成：写 Comfly Key（火山方舟 Key 因通道屏蔽已跳过；需要时加 `-EnableVolcano`）→ 检测/安装即梦画布 CLI（`dreamina-canvas`）→
引导 `auth login` → 安装 11 个 Studio 技能到 `$DSH_HOME\skills\<技能名>`（DSH 技能发现根，两级结构，重启后生效）→ ffmpeg 检查。

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

- **单张（`generate_image`，技能 `default-image-generation`）**：`image_ratio` 必填（8 个标准比例，或 `1920x1080` 这类像素写法，自动换算）；**单线路策略**——只选第一条就绪线路（默认 `comfly-gpt-image-2-4k` 输出 2048 长边；缺凭证或熔断时顺延到 `comfly-gemini-flash-preview` 2K-only、`dreamina-image` 1K），选定后**失败即停，绝不换线路、绝不重放已付费的尝试**；`image_provider` 点名则只用该线路。预算：单张总预算 90s（`IMAGE_SECONDS_PER_CANDIDATE`），提交 + 下载 + 下载重试共用这一个时间盒；`needs_review` 禁重试。失败的候选由用户决定是否重新排队。
- **批量（`batch_image`，技能 `batch-image-generation`）**：manifest（组 × 候选，可选组级 `grid` 如 `"3x3"` 声明多宫格拼版）→ 稳定 job key（同一 manifest 重复提交被拒）→ SQLite 状态 → 分派并发默认 10（`concurrency` 1..10）、真实提交间隔 ≥1s → 分派截止 `ceil(总数÷并发)×90s + 并发s`（可 `deadline_seconds` 覆盖）：截止后**未启动**任务永久 `abandoned`（`batch_deadline_not_submitted`，不查询不重试）→ 已在跑的再等 `completion_grace_seconds`（默认/上限 120s），到点**硬停**（中止在跑任务，最多再给 5 秒善后），超时记 `failed`（`batch_completion_grace_timeout`）→ **不读图、不做任何内容检查**，直接收集已落地的成功图并自动写审阅页（`contact-<jobKey>.html`）；审阅页**每张图可勾选 + 一键复制名称/路径**，识别出的九宫格/四宫格等拼版会**拆成独立面板逐格列出**（面板落 `<outputDir>/<jobKey>/_panels/`；页面上只出现这些小图，拆前的整图不重复展示），无缝拼版按 `grid` 声明等比切割；缺失槽位**永不自动补跑**，由用户看审阅页决定重跑哪些（换新组 id 才会重排）。
- **并发容量（单一图片池）**：图片侧只有一个跨进程共享的容量池（`IMAGE_CAPACITY_KEY = 'image'`，默认 **10**）：`generate_image` 单张、`batch_image` 批量、所有线路、同一 workspace 下的所有 dsh 进程都从这 10 个槽位取用——**任何时刻最多只有 10 张图在同时生成**。批量分派并发默认也是 10（`concurrency` 1..10），与池子对齐；调小 `concurrency` 只是让分派更保守，池子仍可能被其他会话的单张任务占用。**视频侧容量完全独立**（`seedance-cli` 上限 6，来自上游 CLI 自己的 `max_concurrency`），图片与视频互不占额度。
- **受治理业务 Skill 线（`image-skill-router` + `image_skill_pipeline`）**：仅在用户使用受治理图片 Skill 时走；总任务量 = 场景数 × 候选数，=1 交 `generate_image`，>1 需 `confirm_paid_batch` 后交 `batch_image`。
- **洗图 / 去绘画感 / 高清化（技能 `image-repaint-cleanup`）**：把插画、概念图、效果图或 AI 绘画按**原构图与设计**重渲染为 UE5 风格写实 CG，去掉绘画笔触、涂抹感、碎裂纹理。触发词：洗图、洗一下、去掉绘画感、去 AI 味、插画转写实、写实化、高清化、修复绘画感。固定参数：`comfly-gemini-flash-preview`（2K）、每组 1 候选、多张走 `batch_image`（并发 10）、成品 `<原名>-UE5.jpg`、原图只读不覆盖；`image_ratio` 按原图长宽比**就近**取标准比例并在交付中说明。**前置看图门（不可跳过）**：提交前必须 `image_preview` + `read_image` 逐张看图（`describe_image` 已 disabled，靠自身视觉），登记"有没有人物/角色/身体部位（脸、手、臂、腿、脚、背影、群像、雕像、拟人动物、玩偶机甲）"；**发现即必挂 `M8` 人物/角色与身体部位修复**（按景别/风格选变体：完整版 / 风格化条款 / 远景精简句 / 局部特写），修复多指并指、肢体融合、五官崩坏、塑料皮肤，并锁死人物身份、数量、位置、朝向与遮挡，禁止补全画外肢体与新增人物。防"全局黄染"与"逆光剪影压黑主体"用提示词模块（`M3`/`M4`）；**自然产物与透明材质专项**：看图发现水 / 植被 / 树叶 / 云 / 地形大气 → 挂 `M6-水` / `M6-植被` / `M6-树叶` / `M6-云朵` / `M6-地形与大气`（逐项点名波纹与倒影、叶簇体积与叶片半透、云体受光背光，防糊成涂抹色块）；发现玻璃 / 幕墙 / 窗 / 瓶罐 / 镜面 → 挂 `M10`（反射与折射、厚度断面、反射内容必须来自场景，防洗成不透明板或塑料片）；**可选风格统一**：用户提供一张风格参考图时挂 `M9`（图 2 = 风格参考，只给影调/色温/色彩关系/光比/后期质感，不给内容；强度三档默认「中」，人物画面 ≤ 中档；批量时**所有组共用同一张风格图 + 同一段风格描述**以保证跨图一致）。完整主模板、模块、看图判定表与实测坑位见技能内 `references/repaint-template.md`。

**40 张怎么走**（例：5 组 × 8 候选，`image_ratio` 16:9，`image_resolution` 4K）：

```text
batch_image(command="start", manifest={groups:[…5 组…], image_resolution:"4K"})
→ total 40 · concurrency 10（默认）· estimate ceil(40/10)×90 + 10 = 370s · dispatch deadline 370s · grace 120s · max runtime 490s
→ 提交节流 ≥1s：前 10 张在约 9s 内按 1s 间隔起跑，之后每完成一张补一张；全程同时在跑的图片不超过 10
→ 370s 起不再发起新任务：未启动的永久 abandoned，在跑的再等 ≤120s，超时 failed
batch_image(command="status", job_key=…)        # 轮询 landed/abandoned
batch_image(command="contact_sheet", job_key=…) # 生成编号联系表 → 用户人工选图
```

`deadline` 只由一个数字决定：**每股 90 秒**（`IMAGE_SECONDS_PER_CANDIDATE`，与单张的超时预算同一个值），`deadline = ceil(候选数 ÷ 并发) × 90s + 并发s`（末项是 ≥1 秒真实提交间隔的小余量）——40 张即 `ceil(40/10)×90 + 10 = 370s`。要放宽就显式给 `deadline_seconds`；`concurrency` 只管分派节奏，真正的并发上限始终是那个共享的 10。

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
| `scripts/deploy.ps1` | new-machine-deploy / bootstrap-new-machine | 一键部署：前置检查 → 结构校验 → pnpm install+build → setup.ps1 引导 → verify-deployment |
| `scripts/verify-deployment.ps1` | verify-deployment.ps1 | 部署验证：包结构/构建产物/技能/语料/dreamina/ffmpeg/DSH 宿主侧 |
| `scripts/start-task.ps1` | scripts/maintenance/start-task.ps1 | 任务开始前检查：结构校验 + git 状态 + 安全 fast-forward 更新（仅干净工作树） |
| `scripts/configure-keys.ps1` | configure-api-key.ps1 | 隐藏式写 API Key 到 `$DSH_HOME/.credentials.yaml`，值不回显 |
运行时就绪详情用 `media_status` 工具的 `status` / `verify` 命令。

## 完成通知

无需配置，随 bundle 自动启用（仅 Windows）。
