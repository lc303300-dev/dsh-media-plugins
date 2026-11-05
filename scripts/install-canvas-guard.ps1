# install-canvas-guard.ps1
#
# 把 dreamina-canvas 的执行层守卫装上：
#   1. 官方二进制 `dreamina-canvas.exe` → 改名为 `dreamina-canvas.real.exe`
#   2. 同目录写 `dreamina-canvas.cmd`，转发到 scripts/canvas-guard.mjs
#
# 为什么必须改名：Windows 解析命令时 .exe 优先于 .cmd，只要同名 .exe 还在，
# 直调 `dreamina-canvas` 就会命中真二进制、绕过守卫。
#
# 用法：
#   .\scripts\install-canvas-guard.ps1                 # 默认 ~/bin
#   .\scripts\install-canvas-guard.ps1 -CanvasDir "D:\tools"
#   .\scripts\install-canvas-guard.ps1 -Revert         # 卸载（恢复原名）

param(
  [string]$CanvasDir = "$env:USERPROFILE\bin",
  [string]$NodeExe = "",
  [switch]$Revert
)

$ErrorActionPreference = "Stop"
$real = Join-Path $CanvasDir "dreamina-canvas.real.exe"
$orig = Join-Path $CanvasDir "dreamina-canvas.exe"
$cmdPath = Join-Path $CanvasDir "dreamina-canvas.cmd"
$guard = Join-Path $PSScriptRoot "canvas-guard.mjs"

if (-not (Test-Path $guard)) {
  Write-Error "找不到守卫脚本：$guard"
  exit 1
}

if ($Revert) {
  if (Test-Path $cmdPath) { Remove-Item $cmdPath -Force; Write-Host "已删除 $cmdPath" }
  if (Test-Path $real) { Rename-Item $real $orig -Force; Write-Host "已恢复 $real -> $orig" }
  Write-Host "守卫已卸载。"
  exit 0
}

# 1) 真二进制改名（幂等）
if (Test-Path $real) {
  Write-Host "真二进制已存在：$real"
} elseif (Test-Path $orig) {
  Rename-Item $orig $real -Force
  Write-Host "已改名：$orig -> $real"
} else {
  Write-Error "找不到官方 CLI：$orig（先用官方安装器装好 dreamina-canvas）"
  exit 1
}

# 2) 解析 node 可执行文件
if (-not $NodeExe) {
  $candidate = Get-Command node -ErrorAction SilentlyContinue
  if ($candidate) {
    $NodeExe = $candidate.Source
  }
}
if (-not $NodeExe) {
  Write-Error "找不到 node。用 -NodeExe <path> 指定（DSH 桌面版可用 Electron 的 ELECTRON_RUN_AS_NODE 模式，需自行确认）。"
  exit 1
}
Write-Host "node：$NodeExe"

# 3) 写 .cmd 转发器
$content = @"
@echo off
setlocal
"$NodeExe" "$guard" %*
exit /b %ERRORLEVEL%
"@
Set-Content -Path $cmdPath -Value $content -Encoding ASCII
Write-Host "已写入守卫入口：$cmdPath"

# 4) 自检
Write-Host "`n=== 自检（不带票据的 node run 应被拒绝）==="
$test = & $cmdPath node run --project-id 00000000-0000-0000-0000-000000000000 --node-id node_x --format json 2>&1
if ($test -match "launch_gate.guard_required") {
  Write-Host "OK：直调已被守卫拦下。" -ForegroundColor Green
} else {
  Write-Host "警告：自检未命中预期拒绝，请检查 PATHEXT 与同名 .exe 是否已改名。" -ForegroundColor Yellow
  Write-Host ($test | Out-String)
}

Write-Host "`n完成。`n  - 经 dreamina_canvas 工具调用：校验票据后注入 DSH_LAUNCH_TICKET，守卫消费后转发。`n  - 直调 dreamina-canvas：无票据 → 拒绝。`n  - 卸载：.\scripts\install-canvas-guard.ps1 -Revert"
