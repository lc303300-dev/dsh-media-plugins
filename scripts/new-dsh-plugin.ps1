# new-dsh-plugin.ps1 - scaffold a standard DSH bundle (composite package)
#
# The generated skeleton strictly follows the official docs:
#   - docs/user/develop/basic/publish.md   bundle structure & manifest
#   - docs/user/develop/basic/tool.md      tool plugin shape
#   - docs/user/develop/basic/config.md    Config (Schema) shape
#
# Usage:
#   .\new-dsh-plugin.ps1 -Name dsh-my-plugin -Tool my_tool
#   .\new-dsh-plugin.ps1 -Name dsh-foo -Tool bar -Out D:\work
param(
    [Parameter(Mandatory = $true)]
    [string]$Name,          # package (bundle) name, e.g. dsh-hello-plugin
    [string]$Tool = "",     # tool name; defaults to Name without the dsh- prefix
    [string]$Out = "."      # output root directory
)

$ErrorActionPreference = "Stop"

# Write UTF-8 WITHOUT BOM (Windows PowerShell's Set-Content -Encoding UTF8 adds a BOM,
# which breaks package.json and YAML for pnpm/dsh).
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Text([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

if ($Tool -eq "") {
    $Tool = $Name -replace '^dsh-', ''
    $Tool = $Tool -replace '-', '_'
}

$PluginName = $Name
$RowId = $Tool

$dir = Join-Path $Out $Name
if (Test-Path $dir) {
    throw "directory already exists: $dir"
}
New-Item -ItemType Directory -Force -Path "$dir\src" | Out-Null

# ---------- package.json (publish.md: bundle manifest) ----------
$packageJson = @"
{
  "name": "$Name",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "scripts": {
    "prepare": "tsdown",
    "build": "tsdown"
  },
  "devDependencies": {
    "tsdown": "^0.22.0",
    "typescript": "^5.0.0"
  },
  "license": "MIT"
}
"@
Write-Text (Join-Path $dir "package.json") $packageJson

# ---------- src/index.ts (tool.md + config.md) ----------
$indexTs = @"
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = '$PluginName'
export const inject = ['tools']

// No hardcoded tunables: any value a deployment may change goes here,
// overridden via cordis.patch.yml config; defaults live in the schema.
export interface Config {
  // greeting: string
}

export const Config: Schema<Config> = Schema.object({
  // greeting: Schema.string().default('Hello'),
})

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: '$Tool',
    description: 'TODO: one-line description of what the tool does.',
    parameters: {
      // name: { type: 'string', required: true, description: 'param description' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      // TODO: implement, returning the canonical value declared by output.schema
      throw new Error('not implemented')
    },
  }))
}
"@
Write-Text (Join-Path $dir "src\index.ts") $indexTs

# ---------- cordis.patch.yml (publish.md: reference by package name) ----------
$patch = @"
- insert:
    - id: $RowId
      name: $Name
"@
Write-Text (Join-Path $dir "cordis.patch.yml") $patch

# ---------- tsdown.config.ts (publish.md GitHub distribution: self-contained) ----------
$tsdown = @"
import { defineConfig } from 'tsdown'

// Self-contained build: transpile src/ directly, no project references, no type-check.
// @deepseek-ai/* are host-provided, node:* are built-ins; neither is bundled.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: '.',
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//, /^node:/] },
})
"@
Write-Text (Join-Path $dir "tsdown.config.ts") $tsdown

# ---------- .npmrc ----------
$npmrc = @"
# @deepseek-ai/* are host-provided peer dependencies; never auto-install them from npm.
auto-install-peers=false
"@
Write-Text (Join-Path $dir ".npmrc") $npmrc

# ---------- .gitignore ----------
$gitignore = @"
node_modules/
*.tgz
# build output is produced by the prepare script
index.js
# local credentials
.env
"@
Write-Text (Join-Path $dir ".gitignore") $gitignore

# ---------- README.md ----------
$readme = @'
# __NAME__

TODO: one-line description of what this plugin does.

## Install

```sh
# GitHub source (first add may require allowBuilds in the profile's pnpm-workspace.yaml)
dsh plugin --profile <name> add github:you/__NAME__
# or npm / tarball (prebuilt, no build permission needed)
dsh plugin --profile <name> add __NAME__
```

## Config

Pass `config` on the `__ROWID__` row in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: __ROWID__
      name: __NAME__
      config:
        # override defaults here
```

## Develop

```sh
pnpm install
pnpm build   # tsdown transpiles src/ -> index.js
```
'@
$readme = $readme.Replace('__NAME__', $Name).Replace('__ROWID__', $RowId)
Write-Text (Join-Path $dir "README.md") $readme

Write-Host ""
Write-Host "Generated standard bundle skeleton: $dir" -ForegroundColor Green
Write-Host "  package.json       (dsh.bundle + prepare)"
Write-Host "  cordis.patch.yml   (insert row)"
Write-Host "  src/index.ts       (tool plugin)"
Write-Host "  tsdown.config.ts   (self-contained build)"
Write-Host "  .npmrc / .gitignore / README.md"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  cd $dir"
Write-Host "  pnpm install && pnpm build"
Write-Host "  then implement the TODOs in src/index.ts and install with: dsh plugin add"
