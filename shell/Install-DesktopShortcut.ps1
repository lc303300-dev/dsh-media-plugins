# 在桌面创建 DeepSeek Harness 快捷方式（指向已构建的壳 exe）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\shell\Install-DesktopShortcut.ps1 [-ExePath <path>]
[CmdletBinding()]
param([string]$ExePath)
$ErrorActionPreference = "Stop"

if (-not $ExePath) {
    $ExePath = Join-Path $PSScriptRoot "DeepSeekHarnessShell\bin\Release\net8.0-windows\DeepSeekHarnessShell.exe"
}
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    throw "Shell executable not found (build it first): $ExePath"
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "DeepSeek Harness.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $ExePath
$shortcut.WorkingDirectory = Split-Path -Parent $ExePath
$shortcut.Description = "DeepSeek Harness Web GUI"
$iconPath = Join-Path (Split-Path -Parent $ExePath) "Assets\DeepSeekHarness.ico"
if (Test-Path -LiteralPath $iconPath) { $shortcut.IconLocation = $iconPath }
$shortcut.Save()

Write-Host "  Desktop shortcut created: $shortcutPath" -ForegroundColor Green
