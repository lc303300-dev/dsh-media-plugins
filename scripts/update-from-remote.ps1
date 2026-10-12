<#
.SYNOPSIS
  从远端把 dsh-media-plugins 更新到最新（含「即梦画布 CLI（dreamina-canvas）替换旧 dreamina CLI」这次迁移），
  并完成依赖安装、构建、测试、画布 CLI 就绪检查与登录引导。

.DESCRIPTION
  在一台**其它电脑**上执行本脚本即可完成整次替换，无需手工 clone / 改配置：

    1. 检查 git / node / pnpm；
    2. 目标目录不存在则 git clone，存在则 git pull --ff-only（有未提交改动会停下来提示，绝不覆盖）；
    3. pnpm install + pnpm build +（默认）pnpm test；
    4. 确保即梦画布 CLI（dreamina-canvas）已安装 —— 缺失时调用官方安装器；
    5. 清理旧时代的 bin\dreamina.exe（旧 CLI 自 2026-11 停维，本包不再分发它）；
    6. 检查画布 CLI 登录态，未登录时引导 auth login；
    7. 打印验证结果与后续动作（重启 dsh、重新 save 账号）。

  典型用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\update-from-remote.ps1
    pwsh -File .\scripts\update-from-remote.ps1                      # 有 pwsh 时同样可用

  全新电脑（连仓库都没有）：
    irm https://raw.githubusercontent.com/lc303300-dev/dsh-media-plugins/main/scripts/update-from-remote.ps1 | iex

.NOTES
  - 不触碰任何凭证：不读、不写、不上传 token / keychain。
  - 幂等：重复执行安全；-SkipInstall / -SkipTests / -SkipCanvasCli / -SkipLogin 可按需跳过。
  - 兼容 Windows PowerShell 5.1：原生命令写到 stderr 的普通进度不会误判为失败。
  - 本包在 DSH 里是 link: 安装，所以 build 完成后**重启 dsh** 即生效。
#>
[CmdletBinding()]
param(
    [string]$RepoUrl = 'https://github.com/lc303300-dev/dsh-media-plugins.git',
    [string]$Branch = 'main',
    [string]$RepoDir = '',
    [switch]$SkipInstall,
    [switch]$SkipTests,
    [switch]$SkipCanvasCli,
    [switch]$SkipLogin
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ([string]::IsNullOrWhiteSpace($RepoDir)) { $RepoDir = Join-Path $HOME 'dsh-media-plugins' }
$RepoDir = [System.IO.Path]::GetFullPath($RepoDir)

function Step([string]$Text) { Write-Host ""; Write-Host "== $Text ==" -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "  OK   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  warn $Text" -ForegroundColor Yellow }

# 原生命令辅助：Windows PowerShell 5.1 下，git 等程序写到 stderr 的普通进度在
# $ErrorActionPreference='Stop' 时会变成终止错误；调用期间临时放宽，只看退出码。
function Run([string]$Exe, [string[]]$Argv, [string]$What) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @Argv 2>&1 | ForEach-Object { Write-Host "    $_" } }
    finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$What 失败（$Exe $($Argv -join ' ') 退出码 $LASTEXITCODE）" }
}
function Capture([string]$Exe, [string[]]$Argv) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return (& $Exe @Argv 2>&1 | Out-String) }
    finally { $ErrorActionPreference = $previous }
}

Write-Host "== dsh-media-plugins 远端更新 ==" -ForegroundColor Cyan
Write-Host "  repo   : $RepoUrl"
Write-Host "  branch : $Branch"
Write-Host "  target : $RepoDir"

# ---------------------------------------------------------------- 1. 前置检查
Step '1/7 前置检查'
foreach ($tool in @('git', 'node')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "缺少 $tool，请先安装（node 建议 >= 20）" }
    Ok "$tool -> $($cmd.Source)"
}
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Warn '未找到 pnpm，尝试用 corepack 启用…'
    $null = Capture 'corepack' @('enable', 'pnpm')
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) { throw '缺少 pnpm。请执行：npm i -g pnpm（或 corepack enable pnpm）' }
}
Ok "pnpm -> $($pnpm.Source)"
Ok "node -> $(node --version)"

# ---------------------------------------------------------------- 2. 拉取代码
Step '2/7 拉取最新代码'
if (-not (Test-Path (Join-Path $RepoDir '.git'))) {
    if (Test-Path $RepoDir) { throw "$RepoDir 已存在但不是 git 仓库，请手工处理后再跑本脚本" }
    Write-Host "  克隆到 $RepoDir …"
    Run 'git' @('clone', '--branch', $Branch, $RepoUrl, $RepoDir) 'git clone'
} else {
    Push-Location $RepoDir
    try {
        $dirty = @(git status --porcelain)
        if ($dirty.Count -gt 0) {
            Warn '工作区有未提交改动：为避免覆盖，脚本不执行 pull。'
            $dirty | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" }
            throw "请在 $RepoDir 里先提交或 stash（git stash），然后重跑本脚本。"
        }
        Run 'git' @('fetch', 'origin', $Branch) 'git fetch'
        Run 'git' @('checkout', $Branch) 'git checkout'
        Run 'git' @('pull', '--ff-only', 'origin', $Branch) 'git pull --ff-only'
    } finally { Pop-Location }
}
Push-Location $RepoDir
try { Ok "HEAD = $(git log --oneline -1)" } finally { Pop-Location }

# ---------------------------------------------------------------- 3-5. 依赖 / 构建 / 测试
Push-Location $RepoDir
try {
    Step '3/7 安装依赖'
    if ($SkipInstall) { Warn 'pnpm install 已跳过' } else { Run 'pnpm' @('install') 'pnpm install' }

    Step '4/7 构建'
    Run 'pnpm' @('build') 'pnpm build'
    Ok 'dist/ 已重建'

    Step '5/7 单测'
    if ($SkipTests) { Warn 'pnpm test 已跳过' } else { Run 'pnpm' @('test') 'pnpm test'; Ok '单测通过' }

    # ------------------------------------------------------------ 6. 画布 CLI + 清理旧物
    Step '6/7 即梦画布 CLI 就绪 + 清理旧二进制'
    $canvasExe = $null
    $homeCandidate = Join-Path $HOME 'bin\dreamina-canvas.exe'
    if (Test-Path $homeCandidate) { $canvasExe = $homeCandidate }
    if (-not $canvasExe) {
        $cmd = Get-Command dreamina-canvas.exe -CommandType Application -ErrorAction SilentlyContinue
        if ($cmd) { $canvasExe = $cmd.Source }
    }
    if ($canvasExe) {
        Ok "dreamina-canvas -> $canvasExe"
    } elseif ($SkipCanvasCli) {
        Warn 'dreamina-canvas 缺失，且指定了 -SkipCanvasCli：生成线路将不可用'
    } else {
        Write-Host '  未检测到 dreamina-canvas，运行官方安装器（写 ~/bin 与 ~/.agents/skills，并尝试加入用户 PATH）…'
        irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex
        if (Test-Path $homeCandidate) { $canvasExe = $homeCandidate }
        if (-not $canvasExe) {
            $cmd = Get-Command dreamina-canvas.exe -CommandType Application -ErrorAction SilentlyContinue
            if ($cmd) { $canvasExe = $cmd.Source }
        }
        if ($canvasExe) { Ok "dreamina-canvas -> $canvasExe" } else { Warn '安装后仍未找到 dreamina-canvas：请重开终端让 PATH 生效' }
    }

    $legacy = Join-Path $RepoDir 'bin\dreamina.exe'
    if (Test-Path $legacy) {
        $sizeMB = [Math]::Round((Get-Item $legacy).Length / 1MB, 1)
        Remove-Item -LiteralPath $legacy -Force
        Ok "已删除旧二进制 bin\dreamina.exe（$sizeMB MB，已退役）"
    } else {
        Ok 'bin\dreamina.exe 不存在（符合预期）'
    }
    Write-Host '  提示：若 dreamina_account list 里的账号是迁移前 save 的（没有画布登录态），请重新 save 一次'

    # ------------------------------------------------------------ 7. 登录 + 验证
    Step '7/7 登录检查与验证'
    if ($canvasExe) {
        $loggedIn = $false
        try {
            $statusJson = Capture $canvasExe @('--format', 'json', '--non-interactive', 'auth', 'status')
            $loggedIn = (($statusJson | ConvertFrom-Json).data.loggedIn) -eq $true
        } catch { $loggedIn = $false }

        if ($loggedIn) {
            Ok 'auth status: loggedIn = true'
            try {
                $accountJson = Capture $canvasExe @('--format', 'json', '--non-interactive', 'auth', 'account')
                $account = ($accountJson | ConvertFrom-Json).data
                Ok "auth account: userId=$($account.userId) isVip=$($account.isVip) vipLevel=$($account.vipLevel)"
            } catch { Warn 'auth account 解析失败（可能登录态不完整）' }
        } elseif ($SkipLogin) {
            Warn '未登录，且指定了 -SkipLogin：生成前需手工执行 dreamina-canvas auth login'
        } else {
            Warn '未登录。即将运行 dreamina-canvas auth login，请在浏览器完成授权…'
            Run $canvasExe @('auth', 'login') 'auth login'
        }
        Write-Host ''
        Write-Host '  零成本自检（不提交生成、不消耗积分）：' -ForegroundColor Gray
        Run $canvasExe @('--format', 'json', 'version') 'version'
    }
} finally { Pop-Location }

# ---------------------------------------------------------------- 汇总
Push-Location $RepoDir
try { $head = git log --oneline -1 } finally { Pop-Location }
Write-Host ''
Write-Host '== 完成 ==' -ForegroundColor Cyan
Write-Host "  代码  : $RepoDir（$head）"
Write-Host '  生效  : 本包在 DSH 里是 link: 安装，**重启 dsh** 后新版本即生效。'
Write-Host '  复核  : 重启后调用 media_status（verify），确认 dreamina_canvas_binary / dreamina_canvas_login 均为真。'
Write-Host ''
Write-Host '  本次替换要点：' -ForegroundColor Gray
Write-Host '   - 生成线路已从旧 dreamina CLI 全量迁移到即梦画布 CLI（dreamina-canvas）；' -ForegroundColor Gray
Write-Host '   - 旧 CLI 不再分发、也不再提供积分余额查询；账户身份取 auth account；' -ForegroundColor Gray
Write-Host '   - 付费链路：node quote -> node confirm --credit-ceiling -> node run --submit-id；报价不等于授权；' -ForegroundColor Gray
Write-Host '   - 视频公开模式只有 t2v / first_last_frame / m2v（没有 i2v）。' -ForegroundColor Gray
