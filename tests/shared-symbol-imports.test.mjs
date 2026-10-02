import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

/**
 * Symbols owned by src/shared/failure.ts. Any module that uses one of them must
 * import it (or define it itself).
 */
const SHARED_SYMBOLS = ['MediaError', 'mediaErrors']

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

/**
 * Regression guard.
 *
 * `src/shared/media-client.ts` used `MediaError` inside its catch clauses without
 * importing it. tsdown/esbuild does not type-check, so the bundle shipped a bare
 * reference: every slow request that reached those catch clauses died with
 * `MediaError is not defined` (a ReferenceError), which masked the real failure
 * class and made a slow provider look like a broken pipeline.
 */
test('a shared failure symbol is imported wherever it is used', () => {
  const offenders = []

  for (const file of walk(SRC)) {
    // Comments may legitimately name the symbol (e.g. "throws MediaError"); strip them first.
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    for (const symbol of SHARED_SYMBOLS) {
      if (!new RegExp(`\\b${symbol}\\b`).test(source)) continue
      const definesIt = new RegExp(`(?:class|const|let|var|function)\\s+${symbol}\\b`).test(source)
      if (definesIt) continue
      const importsIt = new RegExp(`import[^;]*\\b${symbol}\\b[^;]*from\\s*['"][^'"]+['"]`).test(source)
      if (!importsIt) offenders.push(`${file.slice(ROOT.length + 1)} uses ${symbol} without importing it`)
    }
  }

  assert.deepEqual(offenders, [], `missing imports:\n${offenders.join('\n')}`)
})

/**
 * The per-candidate time basis (90 s) is only a default: when the upstream image
 * route runs slow, both image plugins must carry an explicit, wider budget, or the
 * router abandons (and bills) work the provider is still generating.
 */
test('image plugins pin an explicit per-request timeout budget', () => {
  const yml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

  for (const id of ['Ws_tool-image-gen', 'Ws_tool-batch-image']) {
    const at = yml.indexOf(id)
    assert.notEqual(at, -1, `${id} is not registered in cordis.patch.yml`)
    const block = yml.slice(at, yml.indexOf('\n\n', at) === -1 ? undefined : yml.indexOf('\n\n', at))
    assert.match(block, /providerTimeoutMs:\s*\d+/, `${id} must declare providerTimeoutMs`)
    assert.match(block, /taskTimeoutMs:\s*\d+/, `${id} must declare taskTimeoutMs`)
  }
})
