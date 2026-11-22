# 运营与操作手册

> 从 `AGENTS.md` 拆出（2026-11-24）。画布 CLI 操作、画板批量制片流程、账号切换。
> 这些是「按步骤做」的手册，不是开发约定。

## 即梦画布 CLI（`dreamina-canvas`）—— 生成线路的唯一执行层

> **旧 `dreamina` CLI 自 2026-11 起停止维护**：仓库已**彻底**迁移到画布 CLI —— 旧二进制、旧登录流程（`login --headless`）与**积分余额查询**全部移除。画布 CLI 的 `auth account` 只返回 `userId` / `isVip` / `vipLevel`，不返回余额。

- **一个对话窗口默认只使用同一个画布项目（2026-10-14 用户明确）**：本会话第一次需要画布时确定唯一 canvas project 并一直用它——所有卡片、素材登记、生成、下载与画布链接都落在同一个项目；**新素材/新卡片/新提示词/新批次都不是新建项目的理由**，用户没有明确要求时**不得**调用 `dreamina-canvas canvas create`；既没有当前项目、也没有用户确认过的项目时，用 `canvas ls` 列出已有项目让用户挑一个（仍然不新建）；只有用户显式说"新建项目/新画布"才建（先确认名称与用途，建成后 `--use` 设为当前）；会话恢复或换窗口时先用 `canvas ls` 或持久化 projectId 认下已有项目再继续；原项目不可用（无权限/已删/异常）才另建，且先报告原因。注意这是**即梦画布项目**，与 Skill 线 `project_pipeline` 的治理项目无关。
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

### 3.5 素材节点与卡片维护纪律（2026-10-27 固化，建发短剧实战）

> **素材节点是易失资源**：实战中 5 张角色卡、8 张场景卡、3 个音色节点被反复删除/重建，导致
> **18 张视频卡的上游连线全部变成死链**（`upstreamNodeIds` 指向已不存在的 nodeId，prompt 里
> `{{node:xxx}}` 悬空），卡片看起来正常、跑起来缺素材。以下五条是默认流程，不是可选项。

1. **改卡一律 `node edit video --node-id <id>`，禁止 delete + create**。edit 保留 nodeId、上游连线与
   卡片身份；delete+create 会换新 nodeId、丢连线，并在画布上堆垃圾节点。
2. **每次改卡前先校验 refs**：`node show` 取 `upstreamNodeIds`，与 `node find` 的存活集合逐个比对；
   有死链**先补素材节点、再改卡**（顺序不能反）。改完再复查一遍。
3. **死链修复靠 prompt 语义反推**：`{{node:X}}为妈妈/为爸爸/为男孩/为…音色/为三个购物袋…` 都能直接认回素材；
   只有 `为场景，只取其材质…` 无法区分具体场景——所以**建卡时要自己留一张
   「素材名 ↔ 文档图片N ↔ nodeId」的映射表**，别指望事后猜。
4. **素材名与文档 `图片N` 是两套编号**：文档按每段「图片1=妈妈…」的顺序，画布按节点名。重建时按映射表替换，
   不靠正则猜；同一段改完必须复核「参考块里的 `{{node:}}` 数量 = 该段素材数」。
5. **画布上的素材卡必须建全**：角色卡、场景卡、道具卡、音色卡四类都要有节点并用 `--ref node:<id>` 连上；
   **只上传资源不建节点 = 等于没有素材**（`resource upload` 只登记，不上画布）。素材多时优先合并同类
   （如三个购物袋合成一张「袋子合集」），节点越少越稳。

`node show` 返回结构不稳定（有时 `data.nodes[0].node`、有时 `nodes[0]` 本身），空节点会返回
prompt 0 字 / refs 0 —— 解析代码必须两种都兼容，读到空内容时按"该卡已损坏"处理，不要静默继续。

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
  - `...\keychain\dreamina_canvas_oauth_v2_<64 hex>` —— 即梦画布 CLI 1.1.x；**2026-11-14 升到 1.3.0 后用 `oauth_v3_<64 hex>`**，旧 v2 子键**残留不删**（CLI 只读写自己那版）。后缀是 auth-SDK 常量（**不是** profile/region/instance-id 的派生值，均已实测排除），因此必须**按前缀发现**（`listKeychainSubkeys`）并**按版本号取最高**（`pickCanvasSubKey`），绝不硬编码、也不取枚举顺序第一个 —— 否则 `dreamina_account current` 会把旧 blob 当活跃登录态，切账号还会写进旧子键（1.3.0 读不到，表现为「切换成功但账号没变」）。两者**互不覆盖**：登录画布 CLI 后旧 CLI 的 `user_credit` 照常工作。
  - `~/.dreamina_cli/credential.json` 是**遗留文件**：删掉/清空/改成垃圾后 `dreamina user_credit` 照常工作，CLI 也从不重写它；改坏注册表值才会得到 `authsdk: store unavailable: ... registry value corrupt`；重定向 `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 无效（不是家目录文件）。凭据也不在 Windows 凭据管理器里。
- **单账号时只能有一个活跃登录，但要同时切两边**：切换 = 用另一个账号的 blob 覆盖注册表值。账号库在 `<private>/dreamina-accounts/<name>/{token.txt, canvas-token.txt, account.json}` + `default.json`；`token.txt` 存旧 CLI 的 DPAPI blob 原文，`canvas-token.txt` 存画布 CLI 的（都不落明文凭证），只能被**同一 Windows 用户 + 同一台机器**复用。`ensureActiveAccount` 与 `switchCanvasLogin` 保证切换时两个子键一起换 —— 只切旧子键会让 `generate_video` 用错账号。
- **账号命名**：`ACCOUNT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/`（大小写皆可，如 `wsstudio`、`ISUN`）。`meta.name` 保留用户写法，`accountDir()` 与 `default.json` 指针统一按**小写归一** —— Windows 目录大小写不敏感，不归一会出现 `ISUN`/`isun` 两个指向同一目录的"不同账号"。`readDefaultAccount` 反查 meta 后返回显示名，因此指针写小写也不影响展示，并让"只认小写"的旧版本代码仍能解析它。
- **工具**：`dreamina_account`（`current` / `list` / `save` / `use` / `default` / `rename` / `login` / `login-check` / `forget`）。`login` 会先把现有登录态自动备份入库再清空，返回 `verification_uri` / `user_code` / `device_code`（用户在目标浏览器授权），`login-check` 轮询成功后自动入库；失败/放弃时自动恢复原登录态。`rename` 同步搬目录、改 `meta.name`、跟随默认指针；`login-check` 以 `login checklogin` 是否通过为唯一成功判据 —— 设备流程进行中 keychain 里会存在中间态值，**不得**据此报"已检测到新登录态"。
- **升级画布 CLI 会重置登录态（2026-11-14 实测 1.1.1 → 1.3.0，`oauth_v2` → `oauth_v3`）**：旧 blob 不迁移，升级后 `auth status` 直接 `loggedIn:false`，必须重新 `dreamina_account login` + `login-check`（设备授权）。**登录后必须再 `dreamina_account save` 复核**：`login-check` 曾把**旧 v2 blob** 写进 `wsstudio` 的 `canvas-token.txt` / `canvasSubKey`（它取到了枚举顺序第一个子键），靠重新 save 才纠正成 v3 的 blob 与子键。`auth status` / `version` 的 envelope `schemaVersion` 由 `"1"` 变 `"2"`（插件只校验 `ok`，不受影响）。升级判定源 `CANVAS_CLI_SOURCE` 已同步到打包号 `1_0_0_60`（→ CLI 1.3.0 / commit `c6a5530a`）。
- **管线默认账号**：`dreamina_account default name=<n>`（或工具的 `dreaminaAccount` 配置）→ `generate_video` / `generate_image` / `batch_image` 在**每次 CLI 调用前**调 `ensureActiveAccount`：指纹一致时只做一次 `reg query`（零写入），不一致才加租约切换（`locks/providers/...` 之外的 `dreamina-account` 单槽锁）。
- **切换纪律**：有活动即梦任务（`locks/providers/seedance-cli|image` 内未过期 `.lock`）时 `use`/`default` 会拒绝切换（除非 `force=true`），否则进行中的任务会用错账号轮询/提交。
- **浏览器即账号锚点（2026-10-17 实战踩坑）**：**同一台机器上不同浏览器登录的是不同即梦账号**，而画布是否"看得见"取决于 CLI 登录态与浏览器账号是否一致。实测：**Chrome = `ISUN`**（user_id `960342070926412`），默认浏览器对应的是另一个账号。所以：
  1. 打开即梦画布 / 授权页**必须显式用 Chrome 可执行文件**：`Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "<url>"`；`Start-Process "<url>"`（不带 exe）会落到默认浏览器 → 等于打开错账号的页面。
  2. **建画布 / 上传素材 / 建节点前，先 `dreamina_account current` 核对**目标浏览器账号；不一致就先 `use`（同账号库内可切）或 `login`（账号库缺失时走设备授权）。只切旧 CLI 子键或只切画布子键都会导致校验失败（`切换校验失败：期望 user_id=…，实际 user_id=…`），此时应 `auth logout` 后重新 `dreamina_account login`，不要反复 `use`。
  3. 账号库里某账号若**只有 `token.txt` 没有 `canvas-token.txt`**（且 `account.json` 无 `canvasSubKey`），说明当年只备份了旧 CLI，**画布侧不可切**，必须重新 OAuth 授权补全。
  4. 画布 `webUrl` 交付给用户时也用 Chrome 打开 —— 否则用户在自己的（另一账号的）浏览器里看不到刚建的画布。
- **实现与回归**：`src/shared/dreamina-keychain.ts`（注册表桥 + `reg query` 输出解析）、`src/shared/dreamina-account.ts`（账号库 / ensure / 指纹）、`src/tool-dreamina-account.ts`；测试 `tests/dreamina-keychain.test.mjs`、`tests/dreamina-account.test.mjs`。
