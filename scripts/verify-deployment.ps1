# dsh-media-plugins 部署验证（对应 Codex verify-deployment.ps1；运行时详情另见 media_status verify）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-deployment.ps1 [-RepositoryRoot <path>]
[CmdletBinding()]
param(
    [string]$RepositoryRoot
)
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$RepositoryRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)
$errors = [System.Collections.Generic.List[string]]::new()

function Require-Path {
    param([string]$Path, [string]$Description, [ValidateSet("Leaf", "Container")][string]$Type = "Leaf")
    if (-not (Test-Path -LiteralPath $Path -PathType $Type)) { $errors.Add("Missing $Description`: $Path") }
}

# 包结构
$isSourceCheckout = Test-Path -LiteralPath (Join-Path $RepositoryRoot "src") -PathType Container
Require-Path (Join-Path $RepositoryRoot "package.json") "package manifest"
Require-Path (Join-Path $RepositoryRoot "dist\index.js") "bundle entry"
if ($isSourceCheckout) {
    Require-Path (Join-Path $RepositoryRoot "tsdown.config.ts") "build config"
}
foreach ($tool in @("tool-image-gen", "tool-video-gen", "tool-batch-image", "tool-dt", "tool-status", "tool-video-to-gif", "tool-skill-registry", "tool-project", "tool-curator", "tool-revision", "tool-image-skill-curator", "tool-image-skill-pipeline")) {
    Require-Path (Join-Path $RepositoryRoot "dist\$tool.js") "built tool bundle $tool"
}
# 共享域 bundle（tsdown 从 dist/ 抽出的共享 chunk；单消费者内联的模块以源码存在性校验）
foreach ($core in @("adapters", "corpus-core", "curator-core", "failure", "gif-core", "image-ops", "image-skill-core", "private-runtime", "project-core", "registry-core", "revision-core")) {
    Require-Path (Join-Path $RepositoryRoot "dist\$core.js") "built shared bundle $core"
}
if ($isSourceCheckout) {
    foreach ($coreSource in @("adapters", "batch-core", "corpus-core", "curator-core", "dt-core", "failure", "gif-core", "image-ops", "image-skill-core", "media-client", "private-runtime", "project-core", "registry-core", "revision-core", "video-policy")) {
        Require-Path (Join-Path $RepositoryRoot "src\shared\$coreSource.ts") "shared core source $coreSource"
    }
} else {
    Write-Host "  [info] 非源码检出（无 src/），跳过 src/*.ts 与 tsdown.config.ts 校验" -ForegroundColor DarkGray
}
# 技能
foreach ($skill in @("default-image-generation", "default-video-generation", "batch-image-generation", "dt-prompt-authoring", "video-skill-router", "codex-cs-skill-curator", "video-to-gif", "image-skill-router", "image-skill-curator")) {
    Require-Path (Join-Path $RepositoryRoot "skills\$skill\SKILL.md") "skill $skill"
}
Require-Path (Join-Path $RepositoryRoot "refs\forge-index.jsonl") "seedance-forge corpus"
Require-Path (Join-Path $RepositoryRoot "refs\image-skill-library\scene-storyboard-grid\intake-receipt.json") "image-skill library package"
# 运行时二进制 / 工具
$binDir = Join-Path $RepositoryRoot "bin"
Require-Path (Join-Path $binDir "dreamina.exe") "Dreamina CLI binary" "Leaf"
$ffmpegFound = $false
try { $null = Get-Command ffmpeg -ErrorAction Stop; $ffmpegFound = $true } catch {
    if (Test-Path "C:\Program Files\oopz\ffmpeg.exe") { $ffmpegFound = $true }
}
if (-not $ffmpegFound) { $errors.Add("ffmpeg not found (set FFMPEG_PATH or install)") }

# DSH 宿主侧
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
Require-Path (Join-Path $dshHome ".credentials.yaml") "DSH credentials file"
$profileWeb = Join-Path $dshHome "profiles\web\package.json"
if (-not (Test-Path $profileWeb)) { $errors.Add("web profile not found (run: dsh plugin --profile web add ...): $profileWeb") }

if ($errors.Count -gt 0) {
    Write-Host "Deployment verification FAILED:" -ForegroundColor Red
    foreach ($e in $errors) { Write-Host "  - $e" -ForegroundColor Red }
    exit 1
}
Write-Host "Deployment verification OK" -ForegroundColor Green
exit 0
