# 在桌面创建 DeepSeek Harness 快捷方式（指向已构建的壳 exe 或其启动包装器）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\shell\Install-DesktopShortcut.ps1 [-ExePath <path>] [-Root <harnessRoot>]
# -Root: DSH harness 源码检出根目录。提供且有效时，会在 exe 旁生成 launch-shell.cmd
#        （固定 DEEPSEEK_HARNESS_ROOT 后以 dev 模式启动服务器），快捷方式指向该包装器，
#        无需 dsh 在 PATH 上、也无需等 Explorer 刷新环境变量即可使用。
[CmdletBinding()]
param(
    [string]$ExePath,
    [string]$Root
)
$ErrorActionPreference = "Stop"

if (-not $ExePath) {
    $ExePath = Join-Path $PSScriptRoot "DeepSeekHarnessShell\bin\Release\net8.0-windows\DeepSeekHarnessShell.exe"
}
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    throw "Shell executable not found (build it first): $ExePath"
}

$exeDir = Split-Path -Parent $ExePath
$target = $ExePath

if ($Root -and (Test-Path -LiteralPath (Join-Path $Root "apps\cli\src\bin.ts") -PathType Leaf)) {
    $launcher = Join-Path $exeDir "launch-shell.cmd"
    $launcherBody = @"
@echo off
rem DeepSeek Harness shell launcher: pins DEEPSEEK_HARNESS_ROOT so the shell
rem can start the server in dev mode regardless of the current Explorer session.
set "DEEPSEEK_HARNESS_ROOT=$Root"
start "" "%~dp0DeepSeekHarnessShell.exe"
"@
    Set-Content -LiteralPath $launcher -Value $launcherBody -Encoding ASCII
    $target = $launcher
    Write-Host "  Launcher written: $launcher" -ForegroundColor Green
} else {
    Write-Host "  -Root 未提供或无效，快捷方式将直接指向 exe（打包模式，需 dsh 在 PATH 上）" -ForegroundColor DarkGray
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "DeepSeek Harness.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $exeDir
$shortcut.Description = "DeepSeek Harness Web GUI"
$iconPath = Join-Path $exeDir "Assets\DeepSeekHarness.ico"
if (Test-Path -LiteralPath $iconPath) { $shortcut.IconLocation = $iconPath }
$shortcut.Save()

Write-Host "  Desktop shortcut created: $shortcutPath -> $target" -ForegroundColor Green
