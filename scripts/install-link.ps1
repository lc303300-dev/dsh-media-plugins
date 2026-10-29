# dsh-media-plugins 安全安装（link 方式，profile 零污染）
#
# 为什么不用 `dsh plugin add`：它会把插件连同依赖装进 profile 的 node_modules。
# 本包已把 @deepseek-ai/* 全部打进 dist（不再有宿主运行时依赖），但安装形态仍应
# 保持 link —— profile\node_modules 里一旦出现 @deepseek-ai，DSH 自带的核心插件
# 会解析到旧副本，启动时 agent-loop 缺服务、整个应用起不来（2026-10-27 事故）。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-link.ps1
#   ... -Profile desktop            # 显式指定 profile（默认自动探测）
#   ... -RepoDir D:\dsh-media-plugins -SkipBuild
[CmdletBinding()]
param(
    [string]$RepoUrl = 'https://github.com/lc303300-dev/dsh-media-plugins.git',
    [string]$RepoDir = '',
    [string]$Profile = '',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step([string]$t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok([string]$t) { Write-Host "  OK   $t" -ForegroundColor Green }
function Warn([string]$t) { Write-Host "  warn $t" -ForegroundColor Yellow }

# 原生命令辅助：git / pnpm 会把普通进度写到 stderr，$ErrorActionPreference='Stop'
# 下会被当成终止错误（Windows PowerShell 5.1）。调用期间临时放宽，只看退出码。
function Run([string]$Exe, [string[]]$Argv, [string]$What) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @Argv 2>&1 | ForEach-Object { Write-Host "    $_" } }
    finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { throw "$What 失败（退出码 $LASTEXITCODE）" }
}

$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
if ([string]::IsNullOrWhiteSpace($RepoDir)) { $RepoDir = Join-Path $HOME 'dsh-media-plugins' }
$RepoDir = [System.IO.Path]::GetFullPath($RepoDir)

Step '1/6 前置检查'
foreach ($tool in @('git', 'node', 'pnpm')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "缺少 $tool，请先安装（node >= 20）" }
    Ok "$tool 就绪"
}

Step '2/6 仓库落地'
if (-not (Test-Path (Join-Path $RepoDir '.git'))) {
    if (Test-Path $RepoDir) { throw "$RepoDir 已存在但不是 git 仓库，请手工处理" }
    Run 'git' @('clone', $RepoUrl, $RepoDir) 'git clone'
} else {
    Push-Location $RepoDir
    try {
        $dirty = @(git status --porcelain)
        if ($dirty.Count -gt 0) { Warn '仓库有未提交改动，跳过 pull（不覆盖本地修改）' }
        else { Run 'git' @('pull', '--ff-only') 'git pull' }
    } finally { Pop-Location }
}
Ok "仓库: $RepoDir"

Step '3/6 依赖与构建（依赖留在仓库，不碰 profile）'
Push-Location $RepoDir
try {
    Run 'pnpm' @('install') 'pnpm install'
    if (-not $SkipBuild) {
        Run 'pnpm' @('build') 'pnpm build'
        Ok 'dist/ 已重建（自包含，无需宿主包）'
    } else { Warn '跳过 build（-SkipBuild）' }
} finally { Pop-Location }

Step '4/6 选择 profile'
$profilesRoot = Join-Path $DSH_HOME 'profiles'
$candidates = @()
if (Test-Path $profilesRoot) {
    $candidates = @(Get-ChildItem $profilesRoot -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })
}
if ($candidates.Count -eq 0) { throw "在 $profilesRoot 下没有找到 profile" }
if ([string]::IsNullOrWhiteSpace($Profile)) {
    $Profile = if ($candidates.Name -contains 'desktop') { 'desktop' } else { $candidates[0].Name }
}
$profileDir = Join-Path $profilesRoot $Profile
if (-not (Test-Path $profileDir)) { throw "profile 不存在: $profileDir" }
Ok "profile: $Profile"

Step '5/6 挂载（junction + link:）'
$profileNm = Join-Path $profileDir 'node_modules'
New-Item -ItemType Directory -Force -Path $profileNm | Out-Null
$junction = Join-Path $profileNm 'dsh-media-plugins'

$existing = Get-Item $junction -Force -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.LinkType -eq 'Junction' -and "$($existing.Target)".TrimEnd('\') -ieq $RepoDir.TrimEnd('\')) {
        Ok 'junction 已存在且指向本仓库'
    } else {
        throw "$junction 已存在但不是指向 $RepoDir 的 junction（可能是被 pnpm 装成了真实目录），请先移走"
    }
} else {
    New-Item -ItemType Junction -Path $junction -Target $RepoDir | Out-Null
    Ok "junction: $junction -> $RepoDir"
}

# 改 profile package.json：dependencies 用 link:，bundles 加一行。写回无 BOM UTF-8。
$profilePkgPath = Join-Path $profileDir 'package.json'
$pkg = [System.IO.File]::ReadAllText($profilePkgPath, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$linkSpec = 'link:' + ($RepoDir -replace '\\', '/')
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } }) -Force }
$bundles = @($pkg.dsh.profile.bundles)

$needLink = ($pkg.dependencies.'dsh-media-plugins' -ne $linkSpec)
$needBundle = ($bundles -notcontains 'dsh-media-plugins')
if ($needLink -or $needBundle) {
    $pkg.dependencies | Add-Member -NotePropertyName 'dsh-media-plugins' -NotePropertyValue $linkSpec -Force
    if ($needBundle) { $pkg.dsh.profile.bundles = @($bundles + 'dsh-media-plugins') }
    # 用 node 序列化以保持 2 空格缩进（PowerShell 5.1 的 ConvertTo-Json 会输出 4 空格 + 奇特对齐）。
    # 全部经临时文件传递，避免把 JSON 塞进命令行转义。
    $tmpJson = Join-Path $env:TEMP ("dsh-profile-" + [guid]::NewGuid().ToString('N') + ".json")
    [System.IO.File]::WriteAllText($tmpJson, ($pkg | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
    try {
        $formatted = (& node -e "const fs=require('fs');process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],'utf8')),null,2)+'\n')" $tmpJson) -join "`n"
    } finally { Remove-Item $tmpJson -Force -ErrorAction SilentlyContinue }
    [System.IO.File]::WriteAllText($profilePkgPath, $formatted, [System.Text.UTF8Encoding]::new($false))
    Ok "package.json 已更新（$linkSpec）"
} else {
    Ok 'package.json 已是 link 配置，未改动'
}

Step '6/6 自检'
$pollution = Join-Path $profileNm '@deepseek-ai'
if (Test-Path $pollution) {
    throw "profile 被污染：$pollution 存在。请改名移走（如 @deepseek-ai.bak）后重跑。"
}
Ok 'profile\node_modules\@deepseek-ai 不存在（干净）'
$distEntry = Join-Path $RepoDir 'dist\index.js'
if (-not (Test-Path $distEntry)) { throw "缺少 $distEntry，请先 pnpm build" }
Ok 'dist/index.js 存在'

Write-Host ''
Write-Host '== 完成 ==' -ForegroundColor Cyan
Write-Host "  profile : $Profile"
Write-Host "  仓库    : $RepoDir"
Write-Host '  下一步  : 1) 跑 scripts\verify-deployment.ps1；2) 重启 DSH；3) media_status command=verify'
Write-Host '           （即梦登录仍要人工: dreamina-canvas auth login）'
