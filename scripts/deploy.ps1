# dsh-media-plugins 一键部署（对应 Codex new-machine-deploy/bootstrap-new-machine）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 [-SkipBuild] [-SkipSetup] [-SkipVerify]
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipSetup,
    [switch]$SkipVerify
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "== dsh-media-plugins deploy ==" -ForegroundColor Cyan

# 1. 前置命令检查
foreach ($command in @("git", "node", "pnpm", "powershell.exe")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command is missing: $command"
    }
}
Write-Host "[1/5] 前置命令就绪（git / node / pnpm）" -ForegroundColor Green

# 2. 仓库结构检查
foreach ($path in @(
    (Join-Path $root "package.json"),
    (Join-Path $root "tsdown.config.ts"),
    (Join-Path $root "src\shared\adapters.ts"),
    (Join-Path $root "skills\default-image-generation\SKILL.md")
)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file missing: $path"
    }
}
Write-Host "[2/5] 仓库结构完整" -ForegroundColor Green

# 3. 依赖 + 构建
if (-not $SkipBuild) {
    Write-Host "[3/5] pnpm install + build（tsdown 生成包根 *.js）..." -ForegroundColor Yellow
    Push-Location $root
    try {
        & pnpm install 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
        & pnpm build 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
    } finally {
        Pop-Location
    }
    Write-Host "  构建完成" -ForegroundColor Green
} else {
    Write-Host "[3/5] 跳过构建（-SkipBuild）" -ForegroundColor DarkGray
}

# 4. 单机引导（下载 dreamina、写 key、配火山 provider、登录、装技能）
if (-not $SkipSetup) {
    Write-Host "[4/5] 运行 setup.ps1 引导（按提示操作）..." -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "setup.ps1")
    if ($LASTEXITCODE -ne 0) { throw "setup.ps1 failed" }
} else {
    Write-Host "[4/5] 跳过引导（-SkipSetup）" -ForegroundColor DarkGray
}

# 5. 部署验证
if (-not $SkipVerify) {
    Write-Host "[5/5] 部署验证..." -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\verify-deployment.ps1")
    if ($LASTEXITCODE -ne 0) { throw "verify-deployment failed" }
} else {
    Write-Host "[5/5] 跳过验证（-SkipVerify）" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "== 部署完成。重启 dsh（web profile）后新工具契约生效 ==" -ForegroundColor Cyan
