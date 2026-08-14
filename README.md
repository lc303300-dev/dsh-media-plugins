# dsh-media-plugins

DSH 媒体能力组合包（bundle），一次安装带来三个媒体工具和一个完成通知：

| 功能 | 说明 | 底层 | 凭证 |
|---|---|---|---|
| `describe_image` | 看图（识别/描述本地图片） | 火山方舟 Doubao（`doubao-seed-2-0-mini`） | `VOLCANO_ENGINE_API_KEY` |
| `generate_image` | 生图（文生图 / 图生图） | Comfly Gemini（`gemini-3.1-flash-image-preview`） | `COMFLY_API_KEY` + VPN 代理 |
| `generate_video` | 生视频（文生视频 / 图生视频） | 即梦 Dreamina 本地 CLI（`dreamina.exe`） | OAuth 登录态 |
| 完成通知 | 答案生成完成时弹 Windows 托盘气泡（含答案摘要） | `notify-toast.ps1`（`NotifyIcon`） | 无（仅 Windows，免配置） |

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
dsh plugin --profile <name> add ./dsh-media-plugins-0.1.0.tgz   # tarball
```

安装后 `dsh --profile <name> --dump-config` 应看到 `dsh-media-plugins` 层。

## 前置准备（三个功能各自的依赖）

### 1. 火山方舟（看图）

在 `$DSH_HOME/settings.yaml` 配置视觉 provider（`llm-pi-ai` 已由 dsh 内置，只需补这一节）：

```yaml
llm-pi-ai:
  providers:
    volcengine:
      displayName: Volcengine
      apiKeyEnv: VOLCANO_ENGINE_API_KEY
      api: openai-completions
      baseURL: https://ark.cn-beijing.volces.com/api/v3
      models:
        - id: doubao-seed-2-0-mini-260428
          name: Doubao Seed 2.0 Mini
          contextWindow: 256000
          maxTokens: 8192
          input: [text, image]
```

Key 写入 `$DSH_HOME/.credentials.yaml`：

```yaml
VOLCANO_ENGINE_API_KEY: <火山方舟 Key>
COMFLY_API_KEY: <Comfly Key>
```

### 2. Comfly（生图）

- 需要 `COMFLY_API_KEY`（见上）。
- 需要 **VPN 代理**：`cordis.patch.yml` 里默认 `proxyUrl: 'http://127.0.0.1:7897'`，按本机代理端口改。

### 3. 即梦 Dreamina（生视频）

- `dreamina.exe` 由 `setup.ps1` 从官方地址下载到本包 `bin/`（不随仓库分发）。
- **OAuth 登录**：首次使用需在浏览器授权。`setup.ps1` 会引导，或手动执行：

```sh
.\bin\dreamina.exe login
```

登录态存于 `~\.dreamina_cli\credential.json`（官方固定位置，跨机器需重新登录）。

## 一键引导

新机器上跑 `setup.ps1`，它会按提示完成：写 Key、配火山 provider、下载 dreamina.exe、引导登录。完成通知无需任何配置，随 bundle 自动启用。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

## 使用

```text
describe_image(file_path="D:\图.png", prompt="识别报错")
generate_image(prompt="一只戴红围巾的橘猫", size="1:1", output="outputs/cat.png")
generate_video(prompt="夜晚的未来城市，镜头缓慢推进", duration=8, ratio="16:9")
```

给 `generate_image` / `generate_video` 传 `output` 参数，返回路径会变成可点击的「打开文件」。

## 安全

- Key 走 DSH credentials 系统（`.credentials.yaml` / 环境变量），**不进入本仓库**。
- `bin/dreamina.exe` 与登录态**不进入 Git**（见 `.gitignore`）。
- 火山/Comfly 仅在真正调用时请求外部服务；生视频走本地 CLI。
