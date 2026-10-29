# 隐藏式配置 API Key（对应 Codex configure-api-key.ps1）：把 Key 写入 $DSH_HOME/.credentials.yaml，
# 不回显值。已有条目保留；同名覆盖。用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-keys.ps1 -ComflyKey xxx -VolcanoKey yyy
# 未传的 Key 从同名环境变量读取（COMFLY_API_KEY / VOLCANO_ENGINE_API_KEY）。
[CmdletBinding()]
param(
    [string]$ComflyKey,
    [string]$VolcanoKey
)
$ErrorActionPreference = "Stop"
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$credFile = Join-Path $dshHome ".credentials.yaml"
New-Item -ItemType Directory -Force -Path $dshHome | Out-Null

# 新版 DSH 的凭据库是 { version, refs, records } 结构，由凭据服务维护。
# 本脚本只认识最简单的 YAML KV，整文件重写会把 refs/records 写坏，让已保存的
# 凭据全部失效（2026-10 排查确认）。检测到结构化凭据库就直接拒绝，绝不改写。
if (Test-Path -LiteralPath $credFile) {
    $rawCreds = [System.IO.File]::ReadAllText($credFile, [System.Text.UTF8Encoding]::new($false))
    if ($rawCreds -match '(?m)^refs:\s*$' -or $rawCreds -match '(?m)^records:\s*$') {
        throw @"
检测到新版凭据库（$credFile 含 refs/records 结构）：本脚本会整文件重写并破坏它，已拒绝执行。
请在 DSH 的「设置 -> 模型/凭据」页写入 Key，或把 Key 写到 $dshHome\.env 的一行（COMFLY_API_KEY=...），重启 DSH 后生效。
"@
    }
}

# 读取现有条目（简单 YAML KV）
$entries = @{}
if (Test-Path -LiteralPath $credFile) {
    Get-Content -LiteralPath $credFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z0-9_]+)\s*:\s*(.+)\s*$') {
            $entries[$matches[1]] = $matches[2].Trim()
        }
    }
}

# 参数优先，其次环境变量；空字符串视为清除
function Resolve-Key {
    param([string]$Explicit, [string]$EnvName, [string]$Current)
    if ($PSBoundParameters.ContainsKey('Explicit') -and $Explicit) { return $Explicit }
    if ($PSBoundParameters.ContainsKey('Explicit') -and $Explicit -eq '') { return $null }
    $envValue = [Environment]::GetEnvironmentVariable($EnvName)
    if ($envValue) { return $envValue }
    return $Current
}

$entries["COMFLY_API_KEY"] = Resolve-Key $ComflyKey "COMFLY_API_KEY" $entries["COMFLY_API_KEY"]
$entries["VOLCANO_ENGINE_API_KEY"] = Resolve-Key $VolcanoKey "VOLCANO_ENGINE_API_KEY" $entries["VOLCANO_ENGINE_API_KEY"]

$lines = $entries.GetEnumerator() | Sort-Object Key | ForEach-Object {
    if ($_.Value) { "$($_.Key): $($_.Value)" }
}
$lines | Set-Content -LiteralPath $credFile -Encoding UTF8
Write-Host "凭证已写入 $credFile（值不回显）："
foreach ($k in @("COMFLY_API_KEY", "VOLCANO_ENGINE_API_KEY")) {
    $state = if ($entries[$k]) { "已配置" } else { "未配置" }
    Write-Host "  $k = $state"
}
