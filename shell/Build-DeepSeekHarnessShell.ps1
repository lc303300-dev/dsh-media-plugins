# 构建 DeepSeek Harness WebView2 桌面壳（需要 .NET 8 SDK）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\shell\Build-DeepSeekHarnessShell.ps1 [-NoShortcut]
[CmdletBinding()]
param([switch]$NoShortcut)
$ErrorActionPreference = "Stop"

$project = Join-Path $PSScriptRoot "DeepSeekHarnessShell\DeepSeekHarnessShell.csproj"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw ".NET SDK (dotnet) is not installed or not in PATH. Install the .NET 8 SDK from https://dotnet.microsoft.com/download and retry."
}

Write-Host "== Building DeepSeek Harness shell ==" -ForegroundColor Cyan
& dotnet build $project -c Release -v minimal --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed" }

$exe = Join-Path $PSScriptRoot "DeepSeekHarnessShell\bin\Release\net8.0-windows\DeepSeekHarnessShell.exe"
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Build output missing: $exe"
}
Write-Host "  Built: $exe" -ForegroundColor Green

if (-not $NoShortcut) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Install-DesktopShortcut.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Install-DesktopShortcut.ps1 failed" }
}
