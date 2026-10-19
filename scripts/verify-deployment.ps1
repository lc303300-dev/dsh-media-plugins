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
foreach ($tool in @("tool-image-gen", "tool-video-gen", "tool-batch-image", "tool-prompt-batch", "tool-status", "tool-dreamina-account", "tool-video-to-gif", "tool-skill-registry", "tool-project", "tool-curator", "tool-revision", "tool-image-skill-curator", "tool-image-skill-pipeline")) {
    Require-Path (Join-Path $RepositoryRoot "dist\$tool.js") "built tool bundle $tool"
}
# 共享域 bundle（tsdown 从 dist/ 抽出的共享 chunk；单消费者内联的模块以源码存在性校验）
# 注意：只有被两个及以上入口引用的模块才会抽成独立 chunk（failure 现已被内联，
# 不再产出 dist/failure.js），所以这里只校验真正会产出的 chunk。
foreach ($core in @("adapters", "corpus-core", "curator-core", "dreamina-account", "gif-core", "image-ops", "image-skill-core", "private-runtime", "project-core", "registry-core", "revision-core")) {
    Require-Path (Join-Path $RepositoryRoot "dist\$core.js") "built shared bundle $core"
}
if ($isSourceCheckout) {
    foreach ($coreSource in @("adapters", "batch-core", "corpus-core", "corpus-ledger", "curator-core", "dreamina-account", "dreamina-canvas", "dreamina-keychain", "prompt-batch-core", "failure", "gif-core", "image-ops", "image-skill-core", "media-client", "private-runtime", "project-core", "registry-core", "revision-core", "video-canvas-pipeline", "video-policy")) {
        Require-Path (Join-Path $RepositoryRoot "src\shared\$coreSource.ts") "shared core source $coreSource"
    }
} else {
    Write-Host "  [info] 非源码检出（无 src/），跳过 src/*.ts 与 tsdown.config.ts 校验" -ForegroundColor DarkGray
}
# 技能
foreach ($skill in @("default-image-generation", "default-video-generation", "batch-image-generation", "video-prompt-orchestrator", "video-director-prompt", "video-skill-router", "codex-cs-skill-curator", "video-to-gif", "image-skill-router", "image-skill-curator", "image-repaint-cleanup")) {
    Require-Path (Join-Path $RepositoryRoot "skills\$skill\SKILL.md") "skill $skill"
}
Require-Path (Join-Path $RepositoryRoot "refs\forge-index.jsonl") "seedance-forge corpus"
Require-Path (Join-Path $RepositoryRoot "refs\image-skill-library\scene-storyboard-grid\intake-receipt.json") "image-skill library package"
# 运行时二进制 / 工具
$binDir = Join-Path $RepositoryRoot "bin"
# 生成线路现在依赖即梦画布 CLI（dreamina-canvas）：优先看配置/包内/~bin/PATH。
$canvasCandidates = @(
    (Join-Path $binDir "dreamina-canvas.exe"),
    (Join-Path $HOME "bin\dreamina-canvas.exe")
)
$canvasFound = $null
foreach ($candidate in $canvasCandidates) { if (Test-Path $candidate) { $canvasFound = $candidate; break } }
if (-not $canvasFound) {
    try { $cmd = Get-Command dreamina-canvas -ErrorAction Stop; $canvasFound = $cmd.Source } catch { }
}
if ($canvasFound) { Write-Host "  OK   dreamina-canvas: $canvasFound" }
else { $errors.Add("dreamina-canvas not found (install: irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex)") }
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
# 已安装技能副本：DSH 从 $DSH_HOME\skills 发现技能，仓库 skills/ 改了不同步过去
# 等于没改（2026-10 两次事故：副本比仓库旧、技能整个缺失）。
# 洗图（image-repaint-cleanup）是硬性口径：副本必须存在，且必须带着"强制 Gemini"
# 的两个标记（repaint 硬门 + comfly-gemini-flash-preview），否则技能等于没生效。
# 其余技能的副本漂移只提示不报错——现网存在有意钉住的旧副本。
$installedSkills = Join-Path $dshHome "skills"
$repaintSkillId = "image-repaint-cleanup"
if (Test-Path -LiteralPath $installedSkills -PathType Container) {
    $repaintSkill = Join-Path $installedSkills "$repaintSkillId\SKILL.md"
    if (-not (Test-Path -LiteralPath $repaintSkill -PathType Leaf)) {
        $errors.Add("installed skill copy missing (run setup.ps1 or copy skills\$repaintSkillId): $repaintSkill")
    } else {
        $repaintText = [System.IO.File]::ReadAllText($repaintSkill, [System.Text.UTF8Encoding]::new($false))
        if ($repaintText -notmatch "repaint") {
            $errors.Add("installed $repaintSkillId copy lacks the repaint hard gate (repo skills\$repaintSkillId\SKILL.md is the source of truth)")
        }
        if ($repaintText -notmatch "comfly-gemini-flash-preview") {
            $errors.Add("installed $repaintSkillId copy does not pin comfly-gemini-flash-preview")
        }
    }
    foreach ($skill in @("default-image-generation", "default-video-generation", "batch-image-generation", "video-prompt-orchestrator", "video-director-prompt", "video-skill-router", "codex-cs-skill-curator", "video-to-gif", "image-skill-router", "image-skill-curator")) {
        $repoSkill = Join-Path $RepositoryRoot "skills\$skill\SKILL.md"
        $installedSkill = Join-Path $installedSkills "$skill\SKILL.md"
        if (-not (Test-Path -LiteralPath $installedSkill -PathType Leaf)) {
            Write-Host "  [warn] installed skill copy missing: $installedSkill" -ForegroundColor DarkYellow
        } elseif ((Test-Path -LiteralPath $repoSkill -PathType Leaf) -and ((Get-FileHash -LiteralPath $repoSkill -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $installedSkill -Algorithm SHA256).Hash)) {
            Write-Host "  [warn] installed skill copy differs from the repo: $installedSkill" -ForegroundColor DarkYellow
        }
    }
} else {
    Write-Host "  [info] $installedSkills 不存在，跳过已安装技能副本校验" -ForegroundColor DarkGray
}

# creative_writer 的 Comfly LLM provider：dsh-base 的 llm-pi-ai 默认「零路由」挂载，
# profile 的 cordis.patch.yml 不写 provider 时，creative_writer 会直接报
# `no adapter registered for provider "comfly"`。缺了就提示修复脚本，不阻断其它校验。
$profilesRoot = Join-Path $dshHome "profiles"
if (Test-Path -LiteralPath $profilesRoot -PathType Container) {
    $missingProvider = @()
    foreach ($profileDir in (Get-ChildItem -LiteralPath $profilesRoot -Directory -ErrorAction SilentlyContinue)) {
        if (-not (Test-Path -LiteralPath (Join-Path $profileDir.FullName "package.json") -PathType Leaf)) { continue }
        $profilePatch = Join-Path $profileDir.FullName "cordis.patch.yml"
        if (-not (Test-Path -LiteralPath $profilePatch -PathType Leaf)) { $missingProvider += $profileDir.Name; continue }
        $patchText = [System.IO.File]::ReadAllText($profilePatch, [System.Text.UTF8Encoding]::new($false))
        if ($patchText -notmatch '(?m)^\s+comfly:\s*$') { $missingProvider += $profileDir.Name }
    }
    if ($missingProvider.Count -gt 0) {
        Write-Host "  [warn] llm-pi-ai 缺少 comfly provider（creative_writer 不可用）: $($missingProvider -join ', ')" -ForegroundColor DarkYellow
        Write-Host "         修复: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ensure-llm-provider.ps1" -ForegroundColor DarkYellow
    } else {
        Write-Host "  OK   llm-pi-ai comfly provider（creative_writer / Gemini 4）" -ForegroundColor Gray
    }
}

if ($errors.Count -gt 0) {
    Write-Host "Deployment verification FAILED:" -ForegroundColor Red
    foreach ($e in $errors) { Write-Host "  - $e" -ForegroundColor Red }
    exit 1
}
Write-Host "Deployment verification OK" -ForegroundColor Green
exit 0
