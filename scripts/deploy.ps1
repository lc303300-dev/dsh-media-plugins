# dsh-media-plugins 一键部署（对应 Codex new-machine-deploy/bootstrap-new-machine）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 [-SkipBuild] [-SkipSetup] [-SkipVerify] [-SkipShell]
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipSetup,
    [switch]$SkipVerify,
    [switch]$SkipShell
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "== dsh-media-plugins deploy ==" -ForegroundColor Cyan

# 1. 前置命令检查
foreach ($command in @("git", "node", "pnpm", "powershell.exe")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command is missing: $command"
    }
}
Write-Host "[1/6] 前置命令就绪（git / node / pnpm）" -ForegroundColor Green

# 2. 仓库结构检查
foreach ($path in @(
    (Join-Path $root "package.json"),
    (Join-Path $root "tsdown.config.ts"),
    (Join-Path $root "src\shared\adapters.ts"),
    (Join-Path $root "skills\default-image-generation\SKILL.md")
)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file missing: $path"
    }
}
Write-Host "[2/6] 仓库结构完整" -ForegroundColor Green

# 3. 依赖 + 构建
if (-not $SkipBuild) {
    Write-Host "[3/6] pnpm install + build（tsdown 生成 dist/*.js）..." -ForegroundColor Yellow
    Push-Location $root
    try {
        & pnpm install 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
        & pnpm build 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
    } finally {
        Pop-Location
    }
    Write-Host "  构建完成" -ForegroundColor Green
} else {
    Write-Host "[3/6] 跳过构建（-SkipBuild）" -ForegroundColor DarkGray
}

# 4. 单机引导（下载 dreamina、写 key、配火山 provider、登录、装技能）
if (-not $SkipSetup) {
    Write-Host "[4/6] 运行 setup.ps1 引导（按提示操作）..." -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "setup.ps1")
    if ($LASTEXITCODE -ne 0) { throw "setup.ps1 failed" }
} else {
    Write-Host "[4/6] 跳过引导（-SkipSetup）" -ForegroundColor DarkGray
}

# 5. 部署验证
if (-not $SkipVerify) {
    Write-Host "[5/6] 部署验证..." -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\verify-deployment.ps1")
    if ($LASTEXITCODE -ne 0) { throw "verify-deployment failed" }
} else {
    Write-Host "[5/6] 跳过验证（-SkipVerify）" -ForegroundColor DarkGray
}

# 6. WebView2 桌面壳 + 桌面快捷方式（需要 .NET 8 SDK；缺失时自动尝试 winget 安装）
if (-not $SkipShell) {
    Write-Host "[6/6] 桌面壳（DeepSeekHarnessShell）+ 桌面快捷方式..." -ForegroundColor Yellow

    # 6a. 定位/安装 .NET SDK（PATH 或常见安装路径；都没有则 winget 自动装）
    $dotnet = $null
    if (Get-Command dotnet -ErrorAction SilentlyContinue) { $dotnet = (Get-Command dotnet).Source }
    elseif (Test-Path "C:\Program Files\dotnet\dotnet.exe") { $dotnet = "C:\Program Files\dotnet\dotnet.exe" }
    if (-not $dotnet) {
        Write-Host "  未检测到 .NET SDK，尝试 winget 自动安装 Microsoft.DotNet.SDK.8 ..." -ForegroundColor Yellow
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            & winget install --id Microsoft.DotNet.SDK.8 -e --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1 | Out-Host
            if (Test-Path "C:\Program Files\dotnet\dotnet.exe") {
                $dotnet = "C:\Program Files\dotnet\dotnet.exe"
                $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
                if ($userPath -notmatch [regex]::Escape("C:\Program Files\dotnet")) {
                    [Environment]::SetEnvironmentVariable("Path", "$userPath;C:\Program Files\dotnet", "User")
                    Write-Host "  已将 dotnet 加入用户 PATH" -ForegroundColor Green
                }
            }
        }
    }
    if (-not $dotnet) {
        Write-Host "  [提示] .NET 8 SDK 不可用且自动安装失败；跳过桌面壳。安装 .NET 8 SDK 后重跑本脚本（或手动执行 shell\Build-DeepSeekHarnessShell.ps1）。" -ForegroundColor Yellow
    } else {
        $env:Path = "$(Split-Path -Parent $dotnet);$env:Path"

        # 6b. 发现就近的 DSH harness 源码检出（供壳 dev 模式启动；找不到则快捷方式走打包模式）
        $harnessRoot = if ($env:DEEPSEEK_HARNESS_ROOT) { $env:DEEPSEEK_HARNESS_ROOT } else { "" }
        if (-not $harnessRoot) {
            foreach ($candidate in @(
                (Join-Path (Split-Path -Parent $root) "deepseek-harness-master"),
                (Join-Path (Split-Path -Parent $root) "deepseek-harness")
            )) {
                if (Test-Path (Join-Path $candidate "apps\cli\src\bin.ts") -PathType Leaf) { $harnessRoot = $candidate; break }
            }
        }
        if ($harnessRoot -and (Test-Path (Join-Path $harnessRoot "apps\cli\src\bin.ts") -PathType Leaf)) {
            Write-Host "  使用 harness 源码检出: $harnessRoot" -ForegroundColor Green
            [Environment]::SetEnvironmentVariable("DEEPSEEK_HARNESS_ROOT", $harnessRoot, "User")
            Write-Host "  已写入用户环境变量 DEEPSEEK_HARNESS_ROOT" -ForegroundColor Green
        } else {
            Write-Host "  未发现 DEEPSEEK_HARNESS_ROOT；快捷方式将使用打包模式（需要 dsh 在 PATH 上）" -ForegroundColor DarkGray
        }

        # 6c. 构建壳 + 创建快捷方式（-Root 使快捷方式指向 dev 模式启动包装器）
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "shell\Build-DeepSeekHarnessShell.ps1") -Root $harnessRoot
        if ($LASTEXITCODE -ne 0) { throw "Build-DeepSeekHarnessShell.ps1 failed" }
    }
} else {
    Write-Host "[6/6] 跳过桌面壳（-SkipShell）" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "== 部署完成。重启 dsh（web profile）后新工具契约生效 ==" -ForegroundColor Cyan
