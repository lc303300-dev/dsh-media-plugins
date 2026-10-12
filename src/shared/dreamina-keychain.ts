/**
 * Dreamina CLI login-state bridge (Windows registry keychain).
 *
 * Where the login state actually lives
 * ------------------------------------
 * The 即梦/Dreamina CLI does NOT authenticate from
 * `%USERPROFILE%\.dreamina_cli\credential.json`. That file is a stale leftover:
 * deleting it, emptying it or replacing it with garbage leaves `user_credit`
 * working, and the CLI never rewrites it. Probed 2026-10 on the local install:
 *
 *   - `dreamina login --headless` with a valid session prints
 *     "已复用当前本地 OAuth 登录态。" and writes nothing;
 *   - renaming the registry value below makes every command answer
 *     "未检测到有效登录态，请先执行 dreamina login";
 *   - corrupting that value makes commands fail with
 *     `authsdk: store unavailable: ... registry value corrupt: base64 decode failed`;
 *   - redirecting USERPROFILE/APPDATA/LOCALAPPDATA elsewhere changes nothing,
 *     because the store is the registry, not a file under the home directory.
 *
 * The real store is a ByteDance auth-SDK keychain entry in the registry:
 *
 *   HKCU\Software\BytedAuthClient\keychain\dreamina
 *     value name: Ynl0ZWRfY2xpX3VzZXJfdG9rZW4  (base64 of "byted_cli_user_token")
 *     value     : REG_SZ = base64(DPAPI blob)  (CryptProtectData, user-bound)
 *
 * Consequence for account switching: the CLI keeps exactly ONE login at a time,
 * so switching accounts means replacing that single registry value with another
 * captured DPAPI blob. The blob itself is DPAPI-encrypted to the current Windows
 * user, so a saved account can only be replayed by the same Windows user on the
 * same machine — which is exactly the supported scenario.
 *
 * @module dsh-media-plugins/shared/dreamina-keychain
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Registry root shared by BOTH CLIs. The old `dreamina` binary and the new
 * `dreamina-canvas` binary are separate products that keep separate keychain
 * entries side by side (probed 2026-10-12, after logging the canvas CLI in):
 *
 *   ...\keychain\dreamina                                          (old CLI)
 *   ...\keychain\dreamina_canvas_oauth_v2_<64 hex>                 (canvas CLI)
 *
 * Both entries use the SAME value name (base64 "byted_cli_user_token") and the
 * same REG_SZ shape, and they do not overwrite each other — logging into the
 * canvas CLI left the old CLI's credit lookup working. The canvas suffix is an
 * auth-SDK constant (it is not derived from the profile name, the region or the
 * local instance id — all tested), so it must be DISCOVERED, never hard-coded.
 */
export const KEYCHAIN_ROOT = 'HKCU\\Software\\BytedAuthClient\\keychain'

/** Subkey used by the legacy `dreamina` binary. */
export const LEGACY_KEYCHAIN_SUBKEY = 'dreamina'

/** Registry key holding the auth-SDK keychain for the legacy Dreamina CLI. */
export const KEYCHAIN_REG_PATH = `${KEYCHAIN_ROOT}\\${LEGACY_KEYCHAIN_SUBKEY}`

/** Full registry path of one keychain subkey. */
export function keychainRegPath(subKey: string): string {
  const clean = String(subKey ?? '').trim().replace(/^\\+/, '')
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(clean)) throw new Error(`非法的 keychain 子键名: ${clean.slice(0, 64)}`)
  return `${KEYCHAIN_ROOT}\\${clean}`
}

/**
 * Value name the CLI looks up. It is base64("byted_cli_user_token"); we keep the
 * encoded spelling because that is literally what the store contains, and only
 * ever use it as an opaque key.
 */
export const PRIMARY_VALUE_NAME = 'Ynl0ZWRfY2xpX3VzZXJfdG9rZW4'

/** One registry value of the keychain key. */
export interface KeychainValue {
  valueName: string
  /** Registry type as reported by `reg query` (we only ever use REG_SZ). */
  type: string
  value: string
}

/** Injected registry runner (tests pass a fake; production shells out to reg.exe). */
export type RegRunner = (args: string[]) => Promise<{ stdout: string; stderr?: string }>

/** True on the only platform this store exists on. */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * Default runner: `reg.exe` with a generous buffer (the blob is ~2.5 KB of
 * base64, and `reg query` prints it on one line).
 */
export async function defaultRegRunner(args: string[]): Promise<{ stdout: string; stderr?: string }> {
  const { stdout, stderr } = await execFileAsync('reg.exe', args, {
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  return { stdout: String(stdout), stderr: String(stderr) }
}

/** Value names are registry-safe identifiers (no spaces, quotes or backslashes). */
const VALUE_NAME_RE = /^[A-Za-z0-9_.()@-]{1,255}$/
/** Registry values we write are base64 blobs; anything else is a bug, not data. */
const VALUE_RE = /^[A-Za-z0-9+/=_-]{16,200000}$/

/**
 * Parse `reg query <key>` output into values.
 *
 * Real shape (Chinese and English locales, CRLF):
 *
 *     HKEY_CURRENT_USER\Software\BytedAuthClient\keychain\dreamina
 *         Ynl0ZWRfY2xpX3VzZXJfdG9rZW4    REG_SZ    AQAAANCMnd8BFdERjHoAwE/Cl+sB...
 *
 * Rows are `name <2+ spaces> REG_TYPE <2+ spaces> value`; the value may be
 * empty, and the default value is spelled `(默认)` / `(Default)`. Exported and
 * tested directly because a locale tweak here would silently look like
 * "no account saved".
 */
export function parseRegQueryOutput(stdout: string): KeychainValue[] {
  const out: KeychainValue[] = []
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (/^HKEY_/i.test(line)) continue
    // name, then 2+ spaces, then REG_*, then 2+ spaces, then the value.
    const match = line.match(/^(.+?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*))?$/) ?? line.match(/^(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/)
    if (!match) continue
    const valueName = match[1].trim()
    const type = match[2].toUpperCase()
    const value = (match[3] ?? '').trim()
    if (valueName.length === 0) continue
    out.push({ valueName, type, value })
  }
  return out
}

/**
 * Read every value of the CLI keychain key. A missing key means "never logged
 * in" and is reported as an empty list, not an error; any other failure is
 * surfaced so a broken registry (permissions, wrong hive) is never mistaken for
 * "logged out".
 */
export async function readKeychainValues(runner: RegRunner = defaultRegRunner): Promise<KeychainValue[]> {
  return readKeychainValuesAt(LEGACY_KEYCHAIN_SUBKEY, runner)
}

/**
 * Read every value of one keychain subkey. A missing key means "never logged in
 * for that CLI" and is reported as an empty list, not an error; any other failure
 * is surfaced so a broken registry (permissions, wrong hive) is never mistaken
 * for "logged out".
 */
export async function readKeychainValuesAt(subKey: string, runner: RegRunner = defaultRegRunner): Promise<KeychainValue[]> {
  if (!isWindows()) throw new Error('Dreamina 账号切换仅支持 Windows（登录态存放在 HKCU 的 BytedAuthClient keychain）')
  const path = keychainRegPath(subKey)
  try {
    const { stdout } = await runner(['query', path])
    return parseRegQueryOutput(stdout)
  } catch (error: any) {
    const message = String(error?.stderr ?? error?.message ?? error)
    if (/找不到|not find|Unable to find|cannot find/i.test(message)) return []
    throw new Error(`读取 Dreamina 登录态（注册表 keychain）失败: ${message.trim().slice(0, 300)}`)
  }
}

/**
 * List every keychain subkey under the shared BytedAuthClient root.
 *
 * `reg query <root>` prints the key itself first and then one full path per
 * subkey, so the subkey name is the suffix after the (case-insensitive) root.
 */
export async function listKeychainSubkeys(runner: RegRunner = defaultRegRunner): Promise<string[]> {
  if (!isWindows()) throw new Error('Dreamina 账号切换仅支持 Windows（登录态存放在 HKCU 的 BytedAuthClient keychain）')
  try {
    const { stdout } = await runner(['query', KEYCHAIN_ROOT])
    return parseRegSubkeys(stdout)
  } catch (error: any) {
    const message = String(error?.stderr ?? error?.message ?? error)
    if (/找不到|not find|Unable to find|cannot find/i.test(message)) return []
    throw new Error(`枚举 BytedAuthClient keychain 子键失败: ${message.trim().slice(0, 300)}`)
  }
}

/** Parse `reg query <root>` output into subkey names (pure; unit-tested). */
export function parseRegSubkeys(stdout: string): string[] {
  const root = KEYCHAIN_ROOT.toLowerCase()
  const out: string[] = []
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!/^HKEY_/i.test(line)) continue
    const normalized = line.replace(/^HKEY_CURRENT_USER/i, 'HKCU').replace(/\\+$/, '')
    const lower = normalized.toLowerCase()
    if (lower === root) continue
    if (lower.startsWith(`${root}\\`)) {
      const name = normalized.slice(KEYCHAIN_ROOT.length + 1)
      if (name.length > 0 && !out.includes(name)) out.push(name)
    }
  }
  return out
}

/** Read one named value; undefined when the key or the value is absent. */
export async function readKeychainValue(valueName: string = PRIMARY_VALUE_NAME, runner: RegRunner = defaultRegRunner): Promise<string | undefined> {
  const values = await readKeychainValues(runner)
  return values.find((v) => v.valueName === valueName)?.value
}

/** Read one named value from a specific keychain subkey (canvas CLI included). */
export async function readKeychainValueAt(subKey: string, valueName: string = PRIMARY_VALUE_NAME, runner: RegRunner = defaultRegRunner): Promise<string | undefined> {
  const values = await readKeychainValuesAt(subKey, runner)
  return values.find((v) => v.valueName === valueName)?.value
}

/** Write (create or overwrite) one keychain value as REG_SZ. */
export async function writeKeychainValue(valueName: string, value: string, runner: RegRunner = defaultRegRunner): Promise<void> {
  if (!isWindows()) throw new Error('Dreamina 账号切换仅支持 Windows（登录态存放在 HKCU 的 BytedAuthClient keychain）')
  if (!VALUE_NAME_RE.test(valueName)) throw new Error(`非法的 keychain 值名: ${valueName.slice(0, 64)}`)
  if (!VALUE_RE.test(value)) throw new Error('登录态 blob 不是合法的 base64 内容，拒绝写入注册表（避免损坏登录态）')
  await runner(['add', KEYCHAIN_REG_PATH, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f'])
}

/**
 * Write (create or overwrite) one value of a specific keychain subkey.
 *
 * Account switching for the canvas CLI replays a captured blob into the canvas
 * subkey, so the target key must be parameterised — the old CLI's key must never
 * be touched by a canvas-side switch (they hold independent logins).
 */
export async function writeKeychainValueAt(subKey: string, valueName: string, value: string, runner: RegRunner = defaultRegRunner): Promise<void> {
  if (!isWindows()) throw new Error('Dreamina 账号切换仅支持 Windows（登录态存放在 HKCU 的 BytedAuthClient keychain）')
  if (!VALUE_NAME_RE.test(valueName)) throw new Error(`非法的 keychain 值名: ${valueName.slice(0, 64)}`)
  if (!VALUE_RE.test(value)) throw new Error('登录态 blob 不是合法的 base64 内容，拒绝写入注册表（避免损坏登录态）')
  await runner(['add', keychainRegPath(subKey), '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f'])
}

/** Delete one keychain value (used to park/clear the current login). */
export async function deleteKeychainValue(valueName: string, runner: RegRunner = defaultRegRunner): Promise<void> {
  if (!isWindows()) throw new Error('Dreamina 账号切换仅支持 Windows（登录态存放在 HKCU 的 BytedAuthClient keychain）')
  if (!VALUE_NAME_RE.test(valueName)) throw new Error(`非法的 keychain 值名: ${valueName.slice(0, 64)}`)
  try {
    await runner(['delete', KEYCHAIN_REG_PATH, '/v', valueName, '/f'])
  } catch (error: any) {
    const message = String(error?.stderr ?? error?.message ?? error)
    if (/找不到|not find|Unable to find/i.test(message)) return
    throw new Error(`删除 Dreamina keychain 值失败: ${message.trim().slice(0, 300)}`)
  }
}

/** Delete one value of a specific keychain subkey (canvas CLI included). */
export async function deleteKeychainValueAt(subKey: string, valueName: string = PRIMARY_VALUE_NAME, runner: RegRunner = defaultRegRunner): Promise<void> {
  if (!isWindows()) throw new Error('Dreamina 账号切换仅支持 Windows（登录态存放在 HKCU 的 BytedAuthClient keychain）')
  if (!VALUE_NAME_RE.test(valueName)) throw new Error(`非法的 keychain 值名: ${valueName.slice(0, 64)}`)
  try {
    await runner(['delete', keychainRegPath(subKey), '/v', valueName, '/f'])
  } catch (error: any) {
    const message = String(error?.stderr ?? error?.message ?? error)
    if (/找不到|not find|Unable to find/i.test(message)) return
    throw new Error(`删除 Dreamina keychain 值失败: ${message.trim().slice(0, 300)}`)
  }
}

/**
 * Resolve the value name the CLI is currently using: the known constant when
 * present, otherwise the first REG_SZ-looking entry, so a renamed store entry
 * still round-trips instead of being reported as "not logged in".
 */
export function pickPrimaryValue(values: KeychainValue[]): KeychainValue | undefined {
  const strings = values.filter((v) => v.type === 'REG_SZ' && v.value.length > 0)
  const named = strings.find((v) => v.valueName === PRIMARY_VALUE_NAME)
  if (named) return named
  return strings[0]
}
