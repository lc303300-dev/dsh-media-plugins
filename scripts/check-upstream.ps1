# check-upstream.ps1 —— 一键检查 Codex_Wsstudio 上游更新，并按模块映射提示
# 哪些 DSH 文件可能需要对齐。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-upstream.ps1
#   [-CodexRepo D:\AI\Deepseek\codex-wsstudio-latest] [-NoFetch] [-NoCheckpoint]
#
# 行为:
#   1) fetch 参考仓库 origin（-NoFetch 跳过；网络失败只警告不中断）
#   2) 列出 自上次检查点(或首次=最近10个提交) 以来的新提交
#   3) 按"上游包 -> DSH 文件"映射表提示每个提交可能影响的 DSH 模块
#   4) 更新检查点文件 <CodexRepo>/.git/upstream-last-check（-NoCheckpoint 跳过）
[CmdletBinding()]
param(
    [string]$CodexRepo = 'D:\AI\Deepseek\codex-wsstudio-latest',
    [switch]$NoFetch,
    [switch]$NoCheckpoint
)
$ErrorActionPreference = 'Stop'

$CodexRepo = [System.IO.Path]::GetFullPath($CodexRepo)
if (-not (Test-Path (Join-Path $CodexRepo '.git'))) {
    throw "参考仓库不存在或不是 git 仓库: $CodexRepo"
}
$CheckpointFile = Join-Path $CodexRepo '.git\upstream-last-check'
$PluginsRoot = Split-Path -Parent $PSScriptRoot

Write-Host "== Codex_Wsstudio 上游更新检查 ==" -ForegroundColor Cyan

# 1. fetch
if (-not $NoFetch) {
    Write-Host "[1/4] fetch origin..." -ForegroundColor Yellow
    & git -C $CodexRepo fetch origin --prune 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [警告] fetch 失败（网络问题？）。用本地已有的 origin/main 继续（可能不是最新）。" -ForegroundColor Yellow
    } else {
        Write-Host "  fetch 完成" -ForegroundColor Green
    }
}

# 2. 检查点
$since = if (Test-Path $CheckpointFile) { (Get-Content $CheckpointFile -Raw).Trim() } else { '' }
if ($since) {
    $rev = "${since}^{commit}"
    & git -C $CodexRepo cat-file -e $rev 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [警告] 检查点提交不存在（仓库被重置过？），退回最近 10 个提交。" -ForegroundColor Yellow
        $since = ''
    }
}
$checkpointLabel = if ($since) { $since.Substring(0, [Math]::Min(8, $since.Length)) } else { '(无，首次)' }
Write-Host "[2/4] 检查点: $checkpointLabel"

$commits = if ($since) {
    @(git -C $CodexRepo log --oneline --no-decorate "$since..origin/main" 2>$null)
} else {
    @(git -C $CodexRepo log --oneline --no-decorate -10 origin/main 2>$null)
}
if ($commits.Count -eq 0) {
    Write-Host "  没有新提交。" -ForegroundColor Green
    exit 0
}

# 3. 模块映射
$map = @(
    @{ Pkg = 'packages/Codex_Flow/';       Dsh = 'flow-format.ts / registry-core.ts / tool-skill-registry.ts / tool-curator.ts / refs/codex-flow-*-template/ / image-skill-core.ts' },
    @{ Pkg = 'packages/Codex_image/CLI/Media-Router/'; Dsh = 'adapters.ts / media-client.ts / video-policy.ts / tool-image-gen.ts / tool-video-gen.ts / tool-batch-image.ts' },
    @{ Pkg = 'packages/Codex_image/comfly-api/';       Dsh = 'adapters.ts / media-client.ts（Comfly 线路）' },
    @{ Pkg = 'packages/Codex_image/seedance-cli/';     Dsh = 'video-policy.ts / tool-video-gen.ts（Seedance 策略）' },
    @{ Pkg = 'packages/Codex_Batch_Image/';            Dsh = 'batch-core.ts / tool-batch-image.ts' },
    @{ Pkg = 'packages/Codex_DT/';                     Dsh = 'dt-core.ts / revision-core.ts / corpus-core.ts / tool-dt.ts / tool-revision.ts' },
    @{ Pkg = 'packages/Codex_IS/';                     Dsh = 'image-skill-core.ts / image-project-core.ts / tool-image-skill-*.ts' },
    @{ Pkg = 'packages/Codex_CS/';                     Dsh = '（已迁移 Codex_Flow，一般无需对齐；参考 video-skill-package-standard.md）' },
    @{ Pkg = 'packages/Codex_Gif/';                    Dsh = 'gif-core.ts / tool-video-to-gif.ts' }
)

Write-Host "[3/4] 新提交与影响提示:" -ForegroundColor Yellow
foreach ($line in $commits) {
    $hash = ($line -split '\s')[0]
    $subject = ($line -replace '^\S+\s*', '')
    Write-Host "`n  $($hash.Substring(0, [Math]::Min(8, $hash.Length)))  $subject" -ForegroundColor White
    $files = @(git -C $CodexRepo diff-tree --no-commit-id --name-only -r $hash 2>$null)
    $hits = @()
    foreach ($m in $map) {
        foreach ($f in $files) {
            if ($f -like ($m.Pkg + '*')) { $hits += $m; break }
        }
    }
    if ($hits.Count -eq 0) {
        Write-Host "    影响: （文档/脚本/配置，仅参考）"
    } else {
        foreach ($h in $hits) {
            Write-Host "    影响 $($h.Pkg): $($h.Dsh)" -ForegroundColor Green
        }
    }
}

# 4. 检查点推进
if (-not $NoCheckpoint) {
    $tip = (git -C $CodexRepo rev-parse origin/main 2>$null)
    if ($tip) {
        Set-Content -Path $CheckpointFile -Value $tip -Encoding ascii
        Write-Host "`n[4/4] 检查点已更新为 $($tip.Substring(0, 8))" -ForegroundColor Green
    }
}
Write-Host "`n下一步: 按提示改动 DSH 对应文件后，跑 scripts\release.ps1 发布。" -ForegroundColor Cyan
exit 0
