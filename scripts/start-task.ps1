# dsh-media-plugins 任务开始前检查（对应 Codex scripts/maintenance/start-task.ps1）：
# git 状态 + 结构校验 + 可选安全更新（仅干净工作树 + 未分叉时 fast-forward pull）。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-task.ps1 [-RepositoryRoot <path>] [-CheckOnly] [-SkipUpdate]
[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    [switch]$CheckOnly,
    [switch]$SkipUpdate
)
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$RepositoryRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is not installed or is not available in PATH."
}

# 结构校验
foreach ($path in @((Join-Path $RepositoryRoot "package.json"), (Join-Path $RepositoryRoot "src\shared\adapters.ts"))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Project structure validation failed. Missing: $path"
    }
}
Write-Host "[1/3] 结构校验通过" -ForegroundColor Green

# git 状态
$status = (& git -C $RepositoryRoot status --porcelain 2>$null)
if ($LASTEXITCODE -ne 0) {
    Write-Host "[2/3] 警告：$RepositoryRoot 不是 git 仓库（跳过更新检查）" -ForegroundColor Yellow
    if ($CheckOnly) { exit 2 }
    exit 0
}
if ($status) {
    Write-Host "[2/3] 警告：工作树有未提交改动，不会自动更新。" -ForegroundColor Yellow
    $status | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" }
    if ($CheckOnly) { exit 2 }
    exit 0
}
Write-Host "[2/3] 工作树干净" -ForegroundColor Green

# 可选安全更新：仅当本地未分叉（behind 或同步）且可 fast-forward
if (-not $SkipUpdate -and -not $CheckOnly) {
    Write-Host "[3/3] 检查远端更新..." -ForegroundColor Yellow
    & git -C $RepositoryRoot fetch origin 2>$null
    $ahead = (& git -C $RepositoryRoot rev-list --count HEAD..origin/main 2>$null).Trim()
    $behind = (& git -C $RepositoryRoot rev-list --count origin/main..HEAD 2>$null).Trim()
    if ([int]$behind -gt 0) {
        Write-Host "  本地领先 origin/main $behind 个提交，跳过更新（请手动处理）。" -ForegroundColor Yellow
    } elseif ([int]$ahead -gt 0) {
        Write-Host "  远端领先 $ahead 个提交，执行 fast-forward pull..." -ForegroundColor Green
        & git -C $RepositoryRoot pull --ff-only origin main
        if ($LASTEXITCODE -ne 0) { throw "fast-forward pull failed" }
        Write-Host "  已更新到 origin/main（提示：如工具契约有变，请重启 dsh 使新会话生效）" -ForegroundColor Green
    } else {
        Write-Host "  已是最新。" -ForegroundColor Green
    }
}
exit 0
