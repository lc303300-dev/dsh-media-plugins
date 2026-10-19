# dsh-media-plugins 安装引导
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 [-EnableVolcano]
#
# 火山方舟通道（describe_image 看图）当前【已屏蔽】：默认不引导 VOLCANO_ENGINE_API_KEY，
# 也不写 settings.yaml 的 llm-pi-ai.providers.volcengine。恢复三步：
#   1) 运行 .\setup.ps1 -EnableVolcano（或手工配置 provider + Key）
#   2) 在 cordis.patch.yml 里取消 Ws_tool-vision 两行注释
#   3) 重启 dsh
[CmdletBinding()]
param(
    [switch]$EnableVolcano
)
$ErrorActionPreference = "Stop"

$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$credFile = Join-Path $DSH_HOME ".credentials.yaml"
$settingsFile = Join-Path $DSH_HOME "settings.yaml"

Write-Host "== dsh-media-plugins setup ==" -ForegroundColor Cyan

# 1. 确保即梦画布 CLI（dreamina-canvas）可用
#    旧 `dreamina` CLI 自 2026-11 起停止维护，仓库已完全迁移到画布 CLI，不再随包分发旧二进制。
Write-Host ""
Write-Host "[1/6] 检查即梦画布 CLI (dreamina-canvas)..." -ForegroundColor Yellow
$canvasCmd = $null
try { $canvasCmd = (Get-Command dreamina-canvas.exe -CommandType Application -ErrorAction Stop).Source } catch {}
if (-not $canvasCmd) {
    $fallback = Join-Path $HOME "bin\dreamina-canvas.exe"
    if (Test-Path $fallback) { $canvasCmd = $fallback }
}
if ($canvasCmd) {
    Write-Host "  已安装: $canvasCmd" -ForegroundColor Green
} else {
    Write-Host "  未检测到 dreamina-canvas，运行官方安装器…" -ForegroundColor Yellow
    irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex
    try { $canvasCmd = (Get-Command dreamina-canvas.exe -CommandType Application -ErrorAction Stop).Source } catch {}
    if (-not $canvasCmd) { $canvasCmd = Join-Path $HOME "bin\dreamina-canvas.exe" }
    Write-Host "  安装后位置: $canvasCmd" -ForegroundColor Green
}

# 2. 引导输入两个 Key，写入 .credentials.yaml
Write-Host ""
Write-Host "[2/6] 配置 API Key（写入 $credFile）" -ForegroundColor Yellow
$creds = @{}
if (Test-Path $credFile) {
    Get-Content $credFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z0-9_]+)\s*:\s*(.+)\s*$') {
            $creds[$matches[1]] = $matches[2].Trim()
        }
    }
}
function Read-Key([string]$name, [string]$prompt, [string]$current) {
    if ($current) {
        $answer = Read-Host "$prompt（已有 $($current.Substring(0,4))…，回车保留，输入 n 清空，输入新值覆盖）"
        if ($answer -eq '') { return $current }
        if ($answer -eq 'n') { return $null }
        return $answer
    } else {
        $answer = Read-Host $prompt
        if ($answer -eq '') { return $null }
        return $answer
    }
}
Write-Host "  官方入口（先去充值 / 获取 Key 再填）：" -ForegroundColor Gray
if ($EnableVolcano) {
    Write-Host "    火山方舟: 获取/管理 https://console.volcengine.com/ark ｜ 充值 https://console.volcengine.com/finance/" -ForegroundColor Gray
    $volcano = Read-Key "VOLCANO_ENGINE_API_KEY" "火山方舟 Key（看图，可留空跳过）" $creds["VOLCANO_ENGINE_API_KEY"]
} else {
    $volcano = $null
    Write-Host "    [已屏蔽] 火山方舟通道（describe_image）：跳过 VOLCANO_ENGINE_API_KEY；恢复用 .\setup.ps1 -EnableVolcano" -ForegroundColor DarkGray
}
Write-Host "    Comfly:   充值 https://pay.comfly.chat/pay/ ｜ 获取/管理 https://comfly.chat" -ForegroundColor Gray
$comfly = Read-Key "COMFLY_API_KEY" "Comfly Key（生图主通道，可留空跳过）" $creds["COMFLY_API_KEY"]
if ($volcano) { $creds["VOLCANO_ENGINE_API_KEY"] = $volcano }
if ($comfly) { $creds["COMFLY_API_KEY"] = $comfly }
# 新版 DSH 的凭据库是 { version, refs, records } 结构；旧脚本那种整文件重写会破坏它。
# 检测到结构就只提示、不改写（Key 请走 DSH 的 设置 -> 模型/凭据 页）。
$structuredCreds = $false
if (Test-Path $credFile) {
    $rawCreds = [System.IO.File]::ReadAllText($credFile, [System.Text.UTF8Encoding]::new($false))
    if ($rawCreds -match '(?m)^refs:\s*$') { $structuredCreds = $true }
}
if ($structuredCreds) {
    Write-Host "  检测到新版凭据库（refs/records 结构）：为免破坏结构，setup 不改写 $credFile。" -ForegroundColor Yellow
    Write-Host "  请在 DSH 的 设置 -> 模型/凭据 页写入 COMFLY_API_KEY（工具会从凭据服务读取）。" -ForegroundColor Yellow
} else {
    $lines = $creds.GetEnumerator() | ForEach-Object { "$($_.Key): $($_.Value)" }
    $lines | Set-Content -LiteralPath $credFile -Encoding UTF8
    Write-Host "  已写入 $credFile" -ForegroundColor Green
}

# 3. 配置火山 provider（settings.yaml 追加 llm-pi-ai）
Write-Host ""
Write-Host "[3/6] 配置火山方舟视觉 provider（$settingsFile）" -ForegroundColor Yellow
if (-not $EnableVolcano) {
    Write-Host "  [已屏蔽] 跳过 llm-pi-ai.providers.volcengine 配置；恢复用 .\setup.ps1 -EnableVolcano" -ForegroundColor DarkGray
} else {
$settings = if (Test-Path $settingsFile) { Get-Content $settingsFile -Raw } else { "" }
if ($settings -notmatch 'llm-pi-ai:') {
    $volcanoSection = @"

# 火山方舟视觉 provider（describe_image 看图）
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
"@
    Add-Content -LiteralPath $settingsFile -Value $volcanoSection -Encoding UTF8
    Write-Host "  已追加 llm-pi-ai.providers.volcengine" -ForegroundColor Green
} else {
    Write-Host "  已存在 llm-pi-ai 配置，跳过" -ForegroundColor Green
}
}

# 4. 注册 creative_writer 的 Comfly LLM provider
#    DSH 的 llm-pi-ai 默认「零路由」挂载：profile 的 cordis.patch.yml 不提供 provider 时，
#    creative_writer（Gemini 4 创意写作）会直接报
#    `no adapter registered for provider "comfly"`。这一步幂等地补齐，重复执行安全。
Write-Host ""
Write-Host "[4/6] 注册 Comfly LLM provider（creative_writer / Gemini 4）" -ForegroundColor Yellow
$ensureProvider = Join-Path $PSScriptRoot "scripts\ensure-llm-provider.ps1"
if (Test-Path $ensureProvider) {
    & $ensureProvider
} else {
    Write-Host "  未找到 scripts\ensure-llm-provider.ps1，跳过（creative_writer 将不可用）" -ForegroundColor Yellow
}

# 5. 引导即梦画布 CLI 登录
Write-Host ""
Write-Host "[5/6] 即梦登录（生成线路，OAuth 设备授权）" -ForegroundColor Yellow
Write-Host "  即将运行: $canvasCmd auth login" -ForegroundColor Gray
Write-Host "  终端/浏览器会给出授权入口，请在已登录即梦账号的浏览器里完成授权。" -ForegroundColor Gray
Write-Host "  即梦创作平台（会员/积分充值）：https://jimeng.jianying.com" -ForegroundColor Gray
$doLogin = Read-Host "  现在登录？（y/n，回车=y）"
if ($doLogin -eq '' -or $doLogin -eq 'y') {
    & $canvasCmd auth login
}

# 6. 安装业务技能到 $DSH_HOME/skills（DSH 技能发现根，重启后生效）
Write-Host ""
Write-Host "[6/6] 安装 Studio 技能到 $DSH_HOME\skills" -ForegroundColor Yellow
$skillRoot = Join-Path $DSH_HOME "skills"
$srcSkills = Join-Path $PSScriptRoot "skills"
if (Test-Path $srcSkills) {
    New-Item -ItemType Directory -Force -Path $skillRoot | Out-Null
    Get-ChildItem $srcSkills -Directory | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $skillRoot $_.Name) -Recurse -Force
        Write-Host "  技能: $($_.Name)" -ForegroundColor Green
    }
} else {
    Write-Host "  skills 目录不存在，跳过" -ForegroundColor Yellow
}

# ffmpeg 检查（video_to_gif 需要）
Write-Host ""
$ffmpegFound = $false
try { $null = Get-Command ffmpeg -ErrorAction Stop; $ffmpegFound = $true } catch {}
if (-not $ffmpegFound -and -not (Test-Path "C:\Program Files\oopz\ffmpeg.exe")) {
    Write-Host "  [提示] 未检测到 ffmpeg；video_to_gif 需要它（可安装或用 FFMPEG_PATH 指定路径）。" -ForegroundColor Yellow
} else {
    Write-Host "  ffmpeg 可用：video_to_gif 就绪" -ForegroundColor Green
}

Write-Host ""
Write-Host "== 完成 ==" -ForegroundColor Cyan
Write-Host "  1. 用 dsh plugin add 安装本 bundle（见 README）。"
Write-Host "  2. 生图需 VPN 代理：按需改 cordis.patch.yml 的 proxyUrl。"
Write-Host "  3. 重启 dsh 后即可使用 generate_image / generate_video / skill_registry / project_pipeline / prompt_batch / batch_image / video_to_gif / image_preview / split_grid_sheet 与 Studio 技能。"
Write-Host "     （describe_image / 火山方舟通道当前已屏蔽；恢复：.\setup.ps1 -EnableVolcano + cordis.patch.yml 取消 Ws_tool-vision 注释 + 重启 dsh）" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  官方充值与 API 管理入口：" -ForegroundColor Cyan
if ($EnableVolcano) {
    Write-Host "    火山方舟: 管理 https://console.volcengine.com/ark ｜ 充值 https://console.volcengine.com/finance/" -ForegroundColor Cyan
}
Write-Host "    Comfly:   充值 https://pay.comfly.chat/pay/ ｜ 管理 https://comfly.chat" -ForegroundColor Cyan
Write-Host "    即梦:     https://jimeng.jianying.com（创作平台，登录后会员/积分充值）" -ForegroundColor Cyan
