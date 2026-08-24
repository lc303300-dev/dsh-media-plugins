# Apply the DSH session-cost window (header capsule) to a deepseek-harness checkout.
#
# This is the reusable, syncable way to get the browser-side "人民币消耗" capsule
# (token counts + RMB + hover breakdown + 峰/谷 badge) onto ANY machine. The
# capsule lives in the deepseek-harness SOURCE (token-meter + ui-conversation),
# so it is shipped here as a patch: each machine pulls this repo, runs this
# script with the path to its harness checkout, and the capsule appears after a
# fresh build + restart of `dsh web`.
#
# Usage (from a PowerShell prompt):
#   .\scripts\apply-dsh-cost-window.ps1 -HarnessPath D:\AI\DeepseekHarness
#
# Steps:
#   1. git apply the patch (fails loudly if already applied / wrong harness version)
#   2. rebuild the harness host libs (token-meter) + ui-conversation client bundle
#   3. tell you to restart `dsh web`

param(
  [Parameter(Mandatory = $true)]
  [string]$HarnessPath,

  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$patch = Join-Path $scriptDir '..\patches\dsh-harness-session-cost.patch'

if (-not (Test-Path $patch)) { throw "patch not found: $patch" }
if (-not (Test-Path $HarnessPath)) { throw "harness checkout not found: $HarnessPath" }

Push-Location $HarnessPath
try {
  Write-Host "==> applying patch to $HarnessPath"
  # --check first so a version mismatch or already-applied state fails clearly.
  git apply --check $patch
  git apply $patch
  Write-Host "==> patch applied."

  if (-not $SkipBuild) {
    Write-Host "==> rebuilding harness host libs (token-meter) ..."
    pnpm run build:lib:host
    Write-Host "==> rebuilding ui-conversation client bundle ..."
    pnpm --filter @deepseek-ai/dsh-client-ui-conversation run bundle
  }

  Write-Host ""
  Write-Host "Done. Restart 'dsh web' (--profile web) to see the session-cost window"
  Write-Host "in the conversation header (input / cache-hit / cache-write / output + RMB)."
  Write-Host ""
  Write-Host "NOTE: token-meter also pulls the litellm price table over the 127.0.0.1:7897"
  Write-Host "proxy and refreshes periodically; set DSH_COST_REFRESH_MS / DSH_COST_FX_RMB to tune."
} finally {
  Pop-Location
}
