# release.ps1 —— dsh-media-plugins 一键发布流水线：
#   build -> test(0 fail 门) -> 版本 bump -> pack tgz -> 技能同步 ~/.dsh/skills
#   -> git commit + tag -> push origin main --tags
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release.ps1
#   [-Version 0.4.0] [-SkipBuild] [-SkipTest] [-SkipPack] [-SkipSkillSync] [-SkipCommit] [-SkipPush] [-DryRun]
#
# 安全设计: 默认全流程；DryRun 只打印将执行的动作；每步可 -Skip* 跳过。
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$SkipBuild,
    [switch]$SkipTest,
    [switch]$SkipPack,
    [switch]$SkipSkillSync,
    [switch]$SkipCommit,
    [switch]$SkipPush,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dshSkillsRoot = Join-Path $HOME '.dsh\skills'

function Step([string]$Name) { Write-Host "`n== $Name ==" -ForegroundColor Cyan }
function Info([string]$Msg) { Write-Host "  $Msg" -ForegroundColor Green }

# 0. 前置
Step '前置检查'
foreach ($cmd in @('git', 'node', 'pnpm')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "缺少命令: $cmd" }
}
$status = @(git -C $root status --porcelain 2>$null)
if ($status.Count -gt 0) {
    Write-Host "  [警告] 工作树有 $($status.Count) 个未提交改动（发布会一并提交）" -ForegroundColor Yellow
    $status | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" }
} else {
    Info '工作树干净'
}

# 1. build
if (-not $SkipBuild) {
    Step '构建 (pnpm build)'
    if ($DryRun) { Info '  [dry] pnpm build' } else {
        Push-Location $root
        pnpm build 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'build failed' }
        Pop-Location
        Info '构建完成'
    }
}

# 2. test（0 fail 门）
if (-not $SkipTest) {
    Step '测试 (pnpm test，要求 0 fail)'
    if ($DryRun) { Info '  [dry] pnpm test' } else {
        Push-Location $root
        $out = pnpm test 2>&1
        Pop-Location
        $out | Select-Object -Last 12 | Out-Host
        $failLine = $out | Select-String -Pattern '^ℹ fail\s+(\d+)' | Select-Object -Last 1
        $failCount = if ($failLine) { [int]($failLine.Matches[0].Groups[1].Value) } else { 1 }
        if ($failCount -ne 0) { throw "测试失败 $failCount 个，终止发布" }
        $passLine = $out | Select-String -Pattern '^ℹ pass\s+(\d+)' | Select-Object -Last 1
        Info "测试通过: $($passLine.Matches[0].Groups[1].Value) pass / 0 fail"
    }
}

# 3. 版本 bump
Step '版本号'
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$old = $pkg.version
if (-not $Version) {
    $parts = $old -split '\.'
    $parts[2] = [int]$parts[2] + 1
    $Version = ($parts -join '.')
}
if (-not ($Version -match '^\d+\.\d+\.\d+$')) { throw "非法版本号: $Version" }
Info "  $old -> $Version"
if (-not $DryRun) {
    (Get-Content (Join-Path $root 'package.json') -Raw) -replace ('"version":\s*"' + [regex]::Escape($old) + '"'), ('"version": "' + $Version + '"') |
        Set-Content (Join-Path $root 'package.json') -Encoding utf8NoBOM
}

# 4. pack
if (-not $SkipPack) {
    Step '打包 tgz'
    if ($DryRun) { Info "  [dry] npm pack (=> dsh-media-plugins-$Version.tgz)" } else {
        Push-Location $root
        Get-ChildItem "$root\dsh-media-plugins-*.tgz" -ErrorAction SilentlyContinue | Remove-Item -Force
        npm pack 2>&1 | Select-Object -Last 3 | Out-Host
        Pop-Location
        Info "已生成 dsh-media-plugins-$Version.tgz"
    }
}

# 5. 技能同步到 ~/.dsh/skills
if (-not $SkipSkillSync) {
    Step '技能同步 ~/.dsh/skills'
    if (-not (Test-Path $dshSkillsRoot)) {
        Write-Host "  ~/.dsh/skills 不存在，跳过" -ForegroundColor Yellow
    } else {
        $synced = 0
        foreach ($dir in Get-ChildItem (Join-Path $root 'skills') -Directory) {
            $src = Join-Path $dir.FullName 'SKILL.md'
            $dstDir = Join-Path $dshSkillsRoot $dir.Name
            $dst = Join-Path $dstDir 'SKILL.md'
            if (Test-Path $src) {
                $changed = (-not (Test-Path $dst)) -or ((Get-FileHash $src -Algorithm SHA256).Hash -ne (Get-FileHash $dst -Algorithm SHA256).Hash)
                if ($changed) {
                    if ($DryRun) { Info "  [dry] 同步 $($dir.Name)/SKILL.md" }
                    else {
                        New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
                        Copy-Item $src $dst -Force
                        $synced++
                    }
                }
            }
        }
        if (-not $DryRun) { Info "已同步 $synced 个技能" }
    }
}

# 6. commit + tag
if (-not $SkipCommit) {
    Step 'git commit + tag'
    $tag = "v$Version"
    if ($DryRun) { Info "  [dry] git add -A; commit \"release($Version)\"; tag $tag" } else {
        git -C $root add -A
        git -C $root commit -m "release($Version): automated release build" 2>&1 | Select-Object -Last 1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'commit failed' }
        git -C $root tag -d $tag 2>$null | Out-Null
        git -C $root tag $tag
        Info "已提交并打 tag $tag"
    }
}

# 7. push
if (-not $SkipPush) {
    Step 'push origin'
    if ($DryRun) { Info '  [dry] git push origin main --tags' } else {
        git -C $root push origin main --tags 2>&1 | Select-Object -Last 3 | Out-Host
        if ($LASTEXITCODE -ne 0) { Write-Host '  [警告] push 失败（远端有更新时先 pull/rebase 再重试）' -ForegroundColor Yellow }
    }
}

Write-Host "`n== 完成 ==" -ForegroundColor Green
Write-Host "  版本 $Version 已发布（tag v$Version）。" -ForegroundColor Green
Write-Host "  记住：重启 dsh 服务使新构建生效（本脚本不替你重启）。" -ForegroundColor Yellow
