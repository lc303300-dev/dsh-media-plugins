<#
.SYNOPSIS
  从远端把 dsh-media-plugins 更新到最新（含「即梦画布 CLI（dreamina-canvas）替换旧 dreamina CLI」这次迁移），
  并完成依赖安装、构建、测试、画布 CLI 就绪检查与登录引导。

.DESCRIPTION
  在一台**其它电脑**上执行本脚本即可完成整次替换，无需手工 clone / 改配置：

    1. 检查 git / node / pnpm；
    2. 目标目录不存在则 `git clone`，存在则 `git pull --ff-only`（有本地改动会停下来提示，绝不覆盖）；
    3. `pnpm install` + `pnpm build` +（默认）`pnpm test`；
    4. 确保即梦画布 CLI（dreamina-canvas）已安装 —— 缺失时调用官方安装器；
    5. 清理旧时代的 `bin/dreamina.exe`（旧 CLI 自 2026-11 停维，本包不再分发它）；
    6. 检查画布 CLI 登录态，未登录时引导 `auth login`；
    7. 打印验证结果与后续动作（重启 dsh、重新 save 账号）。

  典型用法（已有仓库的电脑）：
    pwsh -File .\scripts\update-from-remote.ps1

  全新电脑（连仓库都没有）：
    irm https://raw.githubusercontent.com/lc303300-dev/dsh-media-plugins/main/scripts/update-from-remote.ps1 | iex

.NOTES
  - 不触碰任何凭证：不读、不写、不上传 token / keychain。
  - 幂等：重复执行安全；`-SkipTests` / `-SkipCanvasCli` / `-SkipLogin` 可按需跳过。
  - 本包在 DSH 里是 link: 安装，所以 build 完成后**重启 dsh** 即生效。
#>
[CmdletBinding()]
param(
    # 远端仓库地址（默认与本仓库 origin 一致）
    [string]$RepoUrl = 'https://github.com/lc303300-dev/dsh-media-plugins.git',
    [string]$Branch = 'main',
    # 仓库落地目录；不存在则 clone 到这里
    [string]$RepoDir = (Join-Path $HOME 'dsh-media-plugins'),
    [switch]$SkipInstall,
    [switch]$SkipTests,
    [switch]$SkipCanvasCli,
    [switch]$SkipLogin
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "== $Text ==" -ForegroundColor Cyan
}
function Write-Ok([string]$Text) { Write-Host "  OK   $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  warn $Text" -ForegroundColor Yellow }

function Invoke-Checked([string]$Exe, [string[]]$Arguments, [string]$What) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$What 失败（$Exe $($Arguments -join ' ') 退出码 $LASTEXITCODE）" }
}

Write-Host "== dsh-media-plugins 远端更新 ==" -ForegroundColor Cyan
Write-Host "  repo   : $RepoUrl"
Write-Host "  branch : $Branch"
Write-Host "  target : $RepoDir"

# ---------------------------------------------------------------- 1. 前置检查
Write-Step '1/7 前置检查'
foreach ($tool in @('git', 'node')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "缺少 $tool，请先安装（node 建议 ≥ 20）" }
    Write-Ok "$tool -> $($cmd.Source)"
}
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Write-Warn2 '未找到 pnpm，尝试用 corepack 启用…'
    & corepack enable pnpm 2>$null
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) { throw '缺少 pnpm。请执行：npm i -g pnpm（或 corepack enable pnpm）' }
}
Write-Ok "pnpm -> $($pnpm.Source)"
Write-Ok "node -> $(node --version)"

# ---------------------------------------------------------------- 2. 拉取代码
Write-Step '2/7 拉取最新代码'
if (-not (Test-Path (Join-Path $RepoDir '.git'))) {
    if (Test-Path $RepoDir) { throw "$RepoDir 已存在但不是 git 仓库，请手工处理后再跑本脚本" }
    Write-Host "  克隆到 $RepoDir …"
    Invoke-Checked git @('clone', '--branch', $Branch, $RepoUrl, $RepoDir) 'git clone'
} else {
    Push-Location $RepoDir
    try {
        $dirty = (git status --porcelain)
        if ($dirty) {
            Write-Warn2 '工作区有未提交改动：为避免覆盖，脚本不执行 pull。'
            Write-Host $dirty
            throw "请在 $RepoDir 里先提交或 stash（git stash），然后重跑本脚本。"
        }
        Invoke-Checked git @('fetch', 'origin', $Branch) 'git fetch'
        Invoke-Checked git @('checkout', $Branch) 'git checkout'
        Invoke-Checked git @('pull', '--ff-only', 'origin', $Branch) 'git pull --ff-only'
    } finally {
        Pop-Location
    }
}
Push-Location $RepoDir
try {
    Write-Ok "HEAD = $(git log --oneline -1)"
} finally {
    Pop-Location
}

# ---------------------------------------------------------------- 3. 依赖 + 构建
Push-Location $RepoDir
try {
    if (-not $SkipInstall) {
        Write-Step '3/7 安装依赖（pnpm install）'
        Invoke-Checked pnpm @('install') 'pnpm install'
    } else {
        Write-Step '3/7 安装依赖（已跳过）'
    }

    Write-Step '4/7 构建（pnpm build）'
    Invoke-Checked pnpm @('build') 'pnpm build'
    Write-Ok 'dist/ 已重建'

    if (-not $SkipTests) {
        Write-Step '5/7 单测（pnpm test）'
        Invoke-Checked pnpm @('test') 'pnpm test'
        Write-Ok '单测通过'
    } else {
        Write-Step '5/7 单测（已跳过）'
    }

    # ------------------------------------------------------------ 6. 画布 CLI + 清理旧物
    Write-Step '6/7 即梦画布 CLI 就绪 + 清理旧二进制'
    $canvasExe = $null
    try { $canvasExe = (Get-Command dreamina-canvas.exe -CommandType Application -ErrorAction Stop).Source } catch {}
    if (-not $canvasExe) {
        $fallback = Join-Path $HOME 'bin\dreamina-canvas.exe'
        if (Test-Path $fallback) { $canvasExe = $fallback }
    }
    if ($canvasExe) {
        Write-Ok "dreamina-canvas -> $canvasExe"
    } elseif ($SkipCanvasCli) {
        Write-Warn2 'dreamina-canvas 缺失，且指定了 -SkipCanvasCli：生成线路将不可用'
    } else {
        Write-Host '  未检测到 dreamina-canvas，运行官方安装器（会写 ~/bin 与 ~/.agents/skills，并尝试加入用户 PATH）…'
        irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex
        try { $canvasExe = (Get-Command dreamina-canvas.exe -CommandType Application -ErrorAction Stop).Source } catch {}
        if (-not $canvasExe) {
            $fallback = Join-Path $HOME 'bin\dreamina-canvas.exe'
            if (Test-Path $fallback) { $canvasExe = $fallback }
        }
        if ($canvasExe) { Write-Ok "dreamina-canvas -> $canvasExe" }
        else { Write-Warn2 '安装后仍未找到 dreamina-canvas：请重开终端让 PATH 生效' }
    }

    # 旧 CLI 二进制：本包不再分发，历史 clone 里可能还留着
    $legacy = Join-Path $RepoDir 'bin\dreamina.exe'
    if (Test-Path $legacy) {
        $sizeMB = [Math]::Round((Get-Item $legacy).Length / 1MB, 1)
        Remove-Item -LiteralPath $legacy -Force
        Write-Ok "已删除旧二进制 bin\dreamina.exe（$sizeMB MB，已退役）"
    } else {
        Write-Ok 'bin\dreamina.exe 不存在（符合预期）'
    }

    # 账号库迁移提醒：旧版捕获的账号没有画布侧登录态
    $privateHint = '若 dreamina_account list 里的账号是迁移前 save 的（没有画布登录态），请重新 save 一次'
    Write-Host "  提示：$privateHint"

    # ------------------------------------------------------------ 7. 登录 + 验证
    Write-Step '7/7 登录检查与验证'
    if ($canvasExe) {
        $statusJson = & $canvasExe --format json --non-interactive auth status 2>&1 | Out-String
        $loggedIn = $false
        try { $loggedIn = ($statusJson | ConvertFrom-Json).data.loggedIn -eq $true } catch {}
        if ($loggedIn) {
            Write-Ok 'auth status: loggedIn = true'
            $accountJson = & $canvasExe --format json --non-interactive auth account 2>&1 | Out-String
            try {
                $account = ($accountJson | ConvertFrom-Json).data
                Write-Ok "auth account: userId=$($account.userId) isVip=$($account.isVip) vipLevel=$($account.vipLevel)"
            } catch { Write-Warn2 'auth account 解析失败（可能未登录或权限不足）' }
        } elseif ($SkipLogin) {
            Write-Warn2 '未登录，且指定了 -SkipLogin：生成前需要手工执行 dreamina-canvas auth login'
        } else {
            Write-Warn2 '未登录。即将运行 dreamina-canvas auth login，请在浏览器完成授权…'
            & $canvasExe auth login
            if ($LASTEXITCODE -ne 0) { Write-Warn2 '登录未完成：可稍后手工执行 dreamina-canvas auth login' }
        }
        Write-Host ''
        Write-Host '  零成本自检（不提交生成、不消耗积分）：' -ForegroundColor Gray
        & $canvasExe --format json version
    }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------- 汇总
Push-Location $RepoDir
try { $head = git log --oneline -1 } finally { Pop-Location }
Write-Host ''
Write-Host '== 完成 ==' -ForegroundColor Cyan
Write-Host "  代码  : $RepoDir（$head）"
Write-Host '  生效  : 本包在 DSH 里是 link: 安装，**重启 dsh** 后新版本即生效。'
Write-Host '  复核  : 重启后可调用 media_status（verify）确认 dreamina_canvas_binary / dreamina_canvas_login 均为真。'
Write-Host ''
Write-Host '  本次替换的要点：' -ForegroundColor Gray
Write-Host '   - 生成线路已从旧 dreamina CLI 全量迁移到即梦画布 CLI（dreamina-canvas）；' -ForegroundColor Gray
Write-Host '   - 旧 CLI 不再分发、也不再提供积分余额查询；账户身份取 auth account；' -ForegroundColor Gray
Write-Host '   - 付费链路：node quote → node confirm --credit-ceiling → node run --submit-id；报价不等于授权；' -ForegroundColor Gray
Write-Host '   - 视频公开模式只有 t2v / first_last_frame / m2v（没有 i2v）。' -ForegroundColor Gray
