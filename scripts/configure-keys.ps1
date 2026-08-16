# 隐藏式配置 API Key（对应 Codex configure-api-key.ps1）：把 Key 写入 $DSH_HOME/.credentials.yaml，
# 不回显值。已有条目保留；同名覆盖。用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-keys.ps1 -ComflyKey xxx -GeminiKey yyy
# 未传的 Key 从同名环境变量读取（COMFLY_API_KEY / APIMART_API_KEY / GEMINI_API_KEY / VOLCANO_ENGINE_API_KEY）。
[CmdletBinding()]
param(
    [string]$ComflyKey,
    [string]$ApimartKey,
    [string]$GeminiKey,
    [string]$VolcanoKey
)
$ErrorActionPreference = "Stop"
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$credFile = Join-Path $dshHome ".credentials.yaml"
New-Item -ItemType Directory -Force -Path $dshHome | Out-Null

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
$entries["APIMART_API_KEY"] = Resolve-Key $ApimartKey "APIMART_API_KEY" $entries["APIMART_API_KEY"]
$entries["GEMINI_API_KEY"] = Resolve-Key $GeminiKey "GEMINI_API_KEY" $entries["GEMINI_API_KEY"]
$entries["VOLCANO_ENGINE_API_KEY"] = Resolve-Key $VolcanoKey "VOLCANO_ENGINE_API_KEY" $entries["VOLCANO_ENGINE_API_KEY"]

$lines = $entries.GetEnumerator() | Sort-Object Key | ForEach-Object {
    if ($_.Value) { "$($_.Key): $($_.Value)" }
}
$lines | Set-Content -LiteralPath $credFile -Encoding UTF8
Write-Host "凭证已写入 $credFile（值不回显）："
foreach ($k in @("COMFLY_API_KEY", "APIMART_API_KEY", "GEMINI_API_KEY", "VOLCANO_ENGINE_API_KEY")) {
    $state = if ($entries[$k]) { "已配置" } else { "未配置" }
    Write-Host "  $k = $state"
}
