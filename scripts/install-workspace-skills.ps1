# install-workspace-skills.ps1 —— 把仓库 skills/ 安装到某个技能根
#
# 为什么需要：DSH 的 @deepseek-ai/dsh-skill-filesystem 按 rank 扫描技能根——
#   rank 100  <projectRoot>/.dsh/skills      （项目级，优先级最高）
#   rank 200  <projectRoot>/.agents/skills
#   rank 400  $DSH_HOME/skills               （用户级，setup.ps1 / release.ps1 装这里）
#   rank 500  ~/.agents/skills
# 默认目标是项目级 `.dsh/skills`：技能随工作目录走、同名覆盖用户级旧版，适合给一个
# 具体项目钉住技能版本；`-SkillsRoot` 可直接指向任意技能根（如用户级
# `$DSH_HOME\skills`），用来把本机用户级技能对齐到仓库版本。
#
# projectRoot 是「最近的含 .git 的祖先目录」，没有 .git 时取工作目录本身。
# 脚本会自动定位并提示；若工作目录在 git 仓库子目录里，请把 -Workspace 指向 git 根。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-workspace-skills.ps1
#   [-Workspace <工作目录>] [-SkillsRoot <技能根>] [-Skills a,b] [-PruneNested] [-Mirror] [-DryRun]
#
# 默认：Workspace = 当前目录；安装仓库 skills/ 下全部技能；只覆盖不删除。
# -PruneNested 会删掉 <技能>/<技能>/ 这层历史残留副本（旧安装脚本留下的），-DryRun 只打印。
# -Mirror 会删除目标端「源里没有」的技能目录（有确认提示，-DryRun 只打印）。
[CmdletBinding()]
param(
    [string]$Workspace = (Get-Location).Path,
    [string]$SkillsRoot,
    [string[]]$Skills,
    [switch]$PruneNested,
    [switch]$Mirror,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$srcRoot = Join-Path $root 'skills'

function Step([string]$Name) { Write-Host "`n== $Name ==" -ForegroundColor Cyan }
function Info([string]$Msg) { Write-Host "  $Msg" -ForegroundColor Green }
function Warn([string]$Msg) { Write-Host "  $Msg" -ForegroundColor Yellow }

function Find-ProjectRoot([string]$Path) {
    $p = (Resolve-Path $Path).Path
    while ($true) {
        if (Test-Path (Join-Path $p '.git')) { return $p }
        $parent = Split-Path $p -Parent
        if (-not $parent -or $parent -eq $p) { return (Resolve-Path $Path).Path }
        $p = $parent
    }
}

# 0. 前置
Step '前置检查'
if (-not (Test-Path $srcRoot)) { throw "仓库 skills/ 不存在: $srcRoot" }
if (-not (Test-Path $Workspace)) { throw "工作目录不存在: $Workspace" }
$Workspace = (Resolve-Path $Workspace).Path
if ($SkillsRoot) {
    $dstRoot = $SkillsRoot
    Info "源  : $srcRoot"
    Info "目标: 指定技能根 $dstRoot"
} else {
    $dstRoot = Join-Path $Workspace '.dsh\skills'
    $projectRoot = Find-ProjectRoot $Workspace
    Info "源  : $srcRoot"
    Info "目标: $dstRoot"
    if ($projectRoot -ne $Workspace) {
        Warn "该工作目录位于 git 仓库内，DSH 的 projectRoot 会是 $projectRoot"
        Warn "技能根应放在 $projectRoot\.dsh\skills；否则不会被扫描（用 -Workspace $projectRoot 重跑）"
    }
}
if (-not $DryRun -and -not (Test-Path $dstRoot)) { New-Item -ItemType Directory -Force -Path $dstRoot | Out-Null }

# 1. 选技能
Step '选择技能'
$available = @(Get-ChildItem $srcRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') })
if ($Skills) {
    # -File 传参时 "a,b" 是单个字符串，这里按逗号/分号再拆，两种调用方式都成立
    $wanted = @($Skills | ForEach-Object { $_ -split '[,;]' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $unknown = @($wanted | Where-Object { $available.Name -notcontains $_ })
    if ($unknown.Count -gt 0) { throw "未知技能: $($unknown -join ', ')（可用: $($available.Name -join ', ')）" }
    $selected = @($available | Where-Object { $wanted -contains $_.Name })
} else {
    $selected = $available
}
if ($selected.Count -eq 0) { throw '没有可安装的技能' }
Info ("$($selected.Count) 个: " + (($selected | Select-Object -ExpandProperty Name) -join ', '))

# 2. 安装（哈希比较，复制目录内容而不是目录本身，避免 <skill>/<skill>/ 嵌套）
Step '安装技能'
$changed = 0
$same = 0
foreach ($dir in $selected) {
    $dstDir = Join-Path $dstRoot $dir.Name
    $dirty = -not (Test-Path $dstDir)
    if (-not $dirty) {
        foreach ($file in Get-ChildItem $dir.FullName -Recurse -File) {
            $rel = $file.FullName.Substring($dir.FullName.Length).TrimStart('\', '/')
            $dst = Join-Path $dstDir $rel
            if (-not (Test-Path $dst)) { $dirty = $true; break }
            if ((Get-FileHash $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $dst -Algorithm SHA256).Hash) { $dirty = $true; break }
        }
    }
    if (-not $dirty) { $same++; continue }
    if ($DryRun) { Info "[dry] 安装 $($dir.Name)/"; $changed++; continue }
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
    Get-ChildItem -LiteralPath $dir.FullName -Force | Copy-Item -Destination $dstDir -Recurse -Force
    Info "安装 $($dir.Name)/"
    $changed++
}

# 3. PruneNested（可选：删掉 <技能>/<技能>/ 这层历史残留副本）
$pruned = 0
if ($PruneNested -and (Test-Path $dstRoot)) {
    Step '清理同名嵌套残留 (-PruneNested)'
    foreach ($d in Get-ChildItem $dstRoot -Directory) {
        $inner = Join-Path $d.FullName $d.Name
        if (-not (Test-Path (Join-Path $inner 'SKILL.md'))) { continue }
        if ($DryRun) { Warn "[dry] 删除 $($d.Name)/$($d.Name)/"; $pruned++; continue }
        Remove-Item $inner -Recurse -Force
        Warn "删除 $($d.Name)/$($d.Name)/"
        $pruned++
    }
    if ($pruned -eq 0) { Info '没有嵌套残留' }
}

# 4. Mirror（可选：删掉目标端源里没有的技能目录）
$removed = 0
if ($Mirror -and (Test-Path $dstRoot)) {
    Step '清理目标端多余技能 (-Mirror)'
    $keep = @($available | Select-Object -ExpandProperty Name)
    foreach ($d in Get-ChildItem $dstRoot -Directory) {
        if ($keep -contains $d.Name) { continue }
        if (-not (Test-Path (Join-Path $d.FullName 'SKILL.md'))) { continue }
        if ($DryRun) { Warn "[dry] 删除 $($d.Name)/"; $removed++; continue }
        Remove-Item $d.FullName -Recurse -Force
        Warn "删除 $($d.Name)/"
        $removed++
    }
    if ($removed -eq 0) { Info '没有多余技能' }
}

# 5. 摘要
Step '完成'
if ($DryRun) {
    Info "DRY RUN：将安装 $changed 个、未变 $same 个、嵌套清理 $pruned 个、将删除 $removed 个"
} else {
    Info "安装 $changed 个、未变 $same 个、嵌套清理 $pruned 个、删除 $removed 个"
}
Write-Host "  技能根: $dstRoot（rank 100，同名覆盖 $HOME\.dsh\skills）" -ForegroundColor DarkGray
Write-Host "  DSH 会自动发现并刷新技能目录，无需重启；新开会话即可看到。" -ForegroundColor DarkGray
