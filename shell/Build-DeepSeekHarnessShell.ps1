# 构建 DeepSeek Harness WebView2 桌面壳（需要 .NET 8 SDK）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\shell\Build-DeepSeekHarnessShell.ps1 [-NoShortcut] [-Root <harnessRoot>]
# -Root: 透传给 Install-DesktopShortcut.ps1，用于生成 dev 模式启动包装器。
[CmdletBinding()]
param(
    [switch]$NoShortcut,
    [string]$Root
)
$ErrorActionPreference = "Stop"

$project = Join-Path $PSScriptRoot "DeepSeekHarnessShell\DeepSeekHarnessShell.csproj"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw ".NET SDK (dotnet) is not installed or not in PATH. Install the .NET 8 SDK from https://dotnet.microsoft.com/download and retry."
}

Write-Host "== Building DeepSeek Harness shell ==" -ForegroundColor Cyan

# 若壳正在运行，先关闭旧实例（构建需覆盖 exe，单实例互斥保证不会重复启动）
$running = Get-Process -Name "DeepSeekHarnessShell" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "  检测到壳正在运行（PID $($running.Id -join ', ')），先关闭以更新..." -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Seconds 1
}

& dotnet build $project -c Release -v minimal --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed" }

$exe = Join-Path $PSScriptRoot "DeepSeekHarnessShell\bin\Release\net8.0-windows\DeepSeekHarnessShell.exe"
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Build output missing: $exe"
}
Write-Host "  Built: $exe" -ForegroundColor Green

if (-not $NoShortcut) {
    $installArgs = @()
    if ($Root) { $installArgs += @("-Root", $Root) }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Install-DesktopShortcut.ps1") @installArgs
    if ($LASTEXITCODE -ne 0) { throw "Install-DesktopShortcut.ps1 failed" }
}
