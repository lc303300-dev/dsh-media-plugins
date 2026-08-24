[CmdletBinding()]
param([string]$RepositoryRoot)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
$source = Join-Path $RepositoryRoot 'src/tool-cost.ts'
$dist = Join-Path $RepositoryRoot 'dist/tool-cost.js'
foreach ($path in @($source, $dist)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing required file: $path" }
}

foreach ($path in @($source, $dist)) {
  $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  if ($text -match '\.optional\(\)') { throw "Incompatible Schemastery optional() remains in $path" }
  if ($text -match 'required\s*:') { throw "Unsupported output-schema required field remains in $path" }
}

Write-Output 'dsh-media-plugins compatibility check passed.'
