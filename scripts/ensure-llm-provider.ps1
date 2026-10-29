<#
.SYNOPSIS
  确保每个 DSH profile 的 llm-pi-ai 配置里都有 creative_writer 需要的 Comfly provider。

.DESCRIPTION
  creative_writer 默认 provider=comfly / gemini-4-argon-thinking-high，但 dsh-base 把
  llm-pi-ai 以“零路由”挂载：profile 的 cordis.patch.yml 不提供 provider 时，调用会报
  `no adapter registered for provider "comfly"`（DSH 的 Web Models 页写入的也是同一处）。

  本脚本幂等地把 comfly provider 合并进每个 profile 的 cordis.patch.yml：
    - 已有 comfly            -> 跳过（不重复写）；
    - 已有 llm-pi-ai 条目    -> 只在它的 providers 下追加 comfly，保留 volcengine 等其它 provider；
    - 没有 llm-pi-ai 条目    -> 追加一条完整条目（patch 为 [] 时替换 []）。
  同时检查 $DSH_HOME\.credentials.yaml 里是否有 COMFLY_API_KEY 这个凭据名，缺失只提示，
  不写、不读、不输出任何密钥值。

  兼容 Windows PowerShell 5.1；重复执行安全。

.PARAMETER DshHome
  DSH home；默认 $env:DSH_HOME，其次 ~\.dsh。

.PARAMETER Profiles
  只处理指定 profile 名；缺省处理 profiles 目录下的全部 profile。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ensure-llm-provider.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ensure-llm-provider.ps1 -Profiles desktop
#>
[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string[]]$Profiles = @()
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
}
$profilesRoot = Join-Path $DshHome 'profiles'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Ok([string]$text) { Write-Host "  OK   $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "  warn $text" -ForegroundColor Yellow }

# comfly 模型清单（与 Comfly /v1/models 实测一致，creative_writer 的思考档位映射依赖它们）。
$models = @(
    @{ id = 'gemini-4-argon'; name = 'Gemini 4 Argon' },
    @{ id = 'gemini-4-argon-thinking-low'; name = 'Gemini 4 Argon Thinking Low' },
    @{ id = 'gemini-4-argon-thinking-medium'; name = 'Gemini 4 Argon Thinking Medium' },
    @{ id = 'gemini-4-argon-thinking-high'; name = 'Gemini 4 Argon Thinking High' }
)

# 生成 comfly provider 块；$indent 是 `comfly:` 这一行的缩进（字符串）。
function New-ProviderBlock([string]$indent) {
    $out = New-Object System.Collections.Generic.List[string]
    $out.Add("${indent}comfly:")
    $out.Add("${indent}  displayName: Comfly")
    $out.Add("${indent}  apiKeyEnv: COMFLY_API_KEY")
    $out.Add("${indent}  api: openai-completions")
    $out.Add("${indent}  baseURL: https://ai.comfly.org/v1")
    $out.Add("${indent}  models:")
    foreach ($m in $models) {
        $out.Add("${indent}    - id: $($m.id)")
        $out.Add("${indent}      name: $($m.name)")
        $out.Add("${indent}      contextWindow: 1048576")
        $out.Add("${indent}      maxTokens: 32768")
        $out.Add("${indent}      input:")
        $out.Add("${indent}        - text")
        $out.Add("${indent}        - image")
    }
    return $out.ToArray()
}

# 处理单个 cordis.patch.yml；返回 added / already / created / missing。
function Add-ComflyProvider([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 'missing' }
    $text = [System.IO.File]::ReadAllText($Path, $utf8)
    $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $endsWithNewline = $text.EndsWith("`n")
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($l in ($text -split "`r?`n")) { $lines.Add($l) }

    # 0. 清掉历史遗留的空列表行 `[]`（与其它条目并存时是非法 YAML）。
    $normalized = $false
    $hasTopEntry = $false
    foreach ($l in $lines) { if ($l -match '^-(\s|$)') { $hasTopEntry = $true; break } }
    if ($hasTopEntry) {
        for ($i = $lines.Count - 1; $i -ge 0; $i--) {
            if ($lines[$i].Trim() -eq '[]') { $lines.RemoveAt($i); $normalized = $true }
        }
    }

    # 1. 定位顶层 `- id: llm-pi-ai` 条目。
    $idIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^- id:\s*llm-pi-ai\s*$') { $idIdx = $i; break }
    }

    if ($idIdx -lt 0) {
        # 没有条目：清掉遗留的 `[]`，再追加完整条目。
        for ($i = $lines.Count - 1; $i -ge 0; $i--) {
            if ($lines[$i].Trim() -eq '[]') { $lines.RemoveAt($i); $normalized = $true }
        }
        $entry = New-Object System.Collections.Generic.List[string]
        $entry.Add('- id: llm-pi-ai')
        $entry.Add('  name: "@deepseek-ai/dsh-llm-pi-ai"')
        $entry.Add('  config:')
        $entry.Add('    providers:')
        foreach ($l in (New-ProviderBlock '      ')) { $entry.Add($l) }
        while ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim().Length -eq 0) {
            $lines.RemoveAt($lines.Count - 1)
        }
        if ($lines.Count -gt 0) { $lines.Add('') }
        foreach ($l in $entry) { $lines.Add($l) }
        $backup = "$Path.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $Path -Destination $backup -Force
        [System.IO.File]::WriteAllText($Path, (($lines -join $nl) + $nl), $utf8)
        return 'created'
    }

    # 2. 条目结束位置：下一条顶格 `- `。
    $endIdx = $lines.Count
    for ($i = $idIdx + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^-(\s|$)') { $endIdx = $i; break }
    }

    # 3. 已有 comfly 就跳过；若刚清理过遗留的 `[]`，仍需写回修复。
    for ($i = $idIdx; $i -lt $endIdx; $i++) {
        if ($lines[$i] -match '^\s+comfly:\s*$') {
            if ($normalized) {
                $backup = "$Path.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
                Copy-Item -LiteralPath $Path -Destination $backup -Force
                $out = ($lines -join $nl)
                if ($endsWithNewline -or -not $out.EndsWith($nl)) { $out += $nl }
                [System.IO.File]::WriteAllText($Path, $out, $utf8)
                return 'added'
            }
            return 'already'
        }
    }

    # 4. 找 providers: 行，并在其后插入。
    $provIdx = -1
    $provIndent = 0
    for ($i = $idIdx; $i -lt $endIdx; $i++) {
        if ($lines[$i] -match '^(\s+)providers:\s*$') {
            $provIdx = $i
            $provIndent = $matches[1].Length
            break
        }
    }

    # 4. 找 providers: 行，并在其后插入。
    $provIdx = -1
    $provIndent = 0
    $inlineProviders = $false
    $inlineConfig = $false
    for ($i = $idIdx; $i -lt $endIdx; $i++) {
        if ($lines[$i] -match '^(\s+)providers:\s*$') {
            if ($provIdx -lt 0) {
                $provIdx = $i
                $provIndent = $matches[1].Length
            }
        } elseif ($lines[$i] -match '^\s+providers:\s*\S') {
            $inlineProviders = $true
        } elseif ($lines[$i] -match '^\s*config:\s*\S') {
            $inlineConfig = $true
        }
    }
    if ($inlineProviders -or ($provIdx -lt 0 -and $inlineConfig)) {
        # 内联写法（flow style）不动，交给人工/Models 页处理，绝不猜着改坏。
        return 'unknown'
    }

    if ($provIdx -ge 0) {
        # 子项缩进优先沿用现有 provider 键（如 volcengine 的 6 空格）。
        $childIndent = $provIndent + 2
        for ($i = $provIdx + 1; $i -lt $endIdx; $i++) {
            if ($lines[$i].Trim().Length -eq 0) { continue }
            if ($lines[$i] -match '^(\s+)\S') { $childIndent = $matches[1].Length }
            break
        }
        $block = New-ProviderBlock (' ' * $childIndent)
        $lines.InsertRange($provIdx + 1, [string[]]$block)
    } else {
        # 没有 providers: 就在 config: 下补一个（或按条目默认缩进）。
        $configIdx = -1
        $configIndent = 2
        for ($i = $idIdx; $i -lt $endIdx; $i++) {
            if ($lines[$i] -match '^(\s*)config:\s*$') {
                $configIdx = $i
                $configIndent = $matches[1].Length
                break
            }
        }
        $block = New-Object System.Collections.Generic.List[string]
        if ($configIdx -ge 0) {
            $block.Add((' ' * ($configIndent + 2)) + 'providers:')
            foreach ($l in (New-ProviderBlock (' ' * ($configIndent + 4)))) { $block.Add($l) }
            $lines.InsertRange($configIdx + 1, $block.ToArray())
        } else {
            # 罕见的无 config 形态：在 name 行后补 config + providers。
            $insertAt = $idIdx + 1
            for ($i = $idIdx + 1; $i -lt $endIdx; $i++) {
                if ($lines[$i] -match '^\s+name:') { $insertAt = $i + 1 }
            }
            $block.Add('  config:')
            $block.Add('    providers:')
            foreach ($l in (New-ProviderBlock '      ')) { $block.Add($l) }
            $lines.InsertRange($insertAt, $block.ToArray())
        }
    }

    # 5. 备份后写回（UTF-8 无 BOM），保持原有换行风格。
    $backup = "$Path.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $Path -Destination $backup -Force
    $out = ($lines -join $nl)
    if ($endsWithNewline -or -not $out.EndsWith($nl)) { $out += $nl }
    [System.IO.File]::WriteAllText($Path, $out, $utf8)

    # 6. 写后自检：comfly 与四个模型都在文件里。
    $check = [System.IO.File]::ReadAllText($Path, $utf8)
    foreach ($m in $models) {
        if (-not $check.Contains($m.id)) { throw "写入后自检失败：$Path 缺少模型 $($m.id)" }
    }
    return 'added'
}

Write-Host '== 确保 creative_writer 的 Comfly provider ==' -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $profilesRoot -PathType Container)) {
    Write-Warn "找不到 profiles 目录（$profilesRoot）：请先启动一次 DSH 生成 profile，再重跑本脚本。"
    return
}

$targets = @()
if ($Profiles.Count -gt 0) {
    foreach ($name in $Profiles) { $targets += (Join-Path $profilesRoot $name) }
} else {
    $targets = @(Get-ChildItem -LiteralPath $profilesRoot -Directory | ForEach-Object { $_.FullName })
}
if ($targets.Count -eq 0) {
    Write-Warn "profiles 目录为空（$profilesRoot）：请先启动一次 DSH。"
    return
}

$changed = 0
foreach ($dir in $targets) {
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'package.json') -PathType Leaf)) { continue }
    $patch = Join-Path $dir 'cordis.patch.yml'
    $name = Split-Path -Leaf $dir
    if (-not (Test-Path -LiteralPath $patch -PathType Leaf)) {
        # 没有 patch 文件：从空列表建一个，再写入条目。
        [System.IO.File]::WriteAllText($patch, '[]' + [Environment]::NewLine, $utf8)
        Write-Host "  $name : 新建 cordis.patch.yml" -ForegroundColor Gray
    }
    $result = Add-ComflyProvider $patch
    switch ($result) {
        'already' { Write-Ok "$name : comfly provider 已存在（跳过）" }
        'added' { Write-Ok "$name : 已追加 comfly provider"; $changed++ }
        'created' { Write-Ok "$name : 已写入 llm-pi-ai 条目 + comfly provider"; $changed++ }
        'missing' { Write-Warn "$name : cordis.patch.yml 缺失，跳过" }
        'unknown' { Write-Warn "$name : 内联 YAML 写法无法安全合并，请用 DSH 的 Models 页添加 Comfly provider（$patch）" }
        default { Write-Warn "$name : 未识别的结果 $result" }
    }
}

# 凭据名检查（只看名字，不读值）。
$credFile = Join-Path $DshHome '.credentials.yaml'
if (Test-Path -LiteralPath $credFile) {
    $credText = [System.IO.File]::ReadAllText($credFile, $utf8)
    if ($credText -match 'COMFLY_API_KEY') {
        Write-Ok '凭据 COMFLY_API_KEY 已存在'
    } else {
        Write-Warn '凭据 COMFLY_API_KEY 缺失：请在 DSH 的 Models/凭据页填 Comfly Key，或运行 setup.ps1 写入'
    }
} else {
    Write-Warn "找不到 $credFile：Comfly Key 需要另行配置"
}

Write-Host ''
if ($changed -gt 0) {
    Write-Host "  已更新 $changed 个 profile；**重启 DSH** 后 creative_writer / Gemini 4 模型才会出现。" -ForegroundColor Cyan
} else {
    Write-Host '  所有 profile 均已配置；无需重启。' -ForegroundColor Gray
}
