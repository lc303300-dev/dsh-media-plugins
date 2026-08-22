/**
 * Package-root resolution helper.
 *
 * The build emits the compiled chunks into `dist/`, while dev/test runs use
 * `src/` / `src/shared/`. Asset paths (`refs/`, `skills/`, `bin/`, `scripts/`)
 * must be resolved from the *package root*, not from the module's own
 * directory. This helper walks up from a module's URL to the directory that
 * owns `package.json`, so the same code works whether it runs from `dist/`,
 * `src/` or `src/shared/`.
 *
 * @module dsh-media-plugins/shared/pkg-root
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve the package root directory, given a module's `import.meta.url`. */
export function packageRootOf(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl))
  // Walk up until we find the directory owning package.json (the package root),
  // regardless of whether we run from dist/, src/ or src/shared/.
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(fileURLToPath(moduleUrl))
}
