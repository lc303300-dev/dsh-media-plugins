/**
 * Dreamina (即梦) multi-account store and switching.
 *
 * The CLI can hold only ONE login at a time (a single registry keychain value,
 * see `dreamina-keychain.ts`), so "account switching" is: capture the current
 * login blob into a named account under the private runtime, and replay it later.
 * The blob is DPAPI-encrypted for the current Windows user, so a captured
 * account is reusable by this user on this machine and nowhere else.
 *
 * Layout under `<private>/dreamina-accounts/`:
 *
 *   <name>/token.txt      base64(DPAPI blob) exactly as the registry holds it
 *   <name>/account.json   identity + provenance + blob fingerprint
 *   default.json          the account the pipeline must ensure before CLI calls
 *
 * Nothing here is a plaintext credential: the stored material is the same
 * DPAPI-protected blob the CLI itself keeps in the registry.
 *
 * @module dsh-media-plugins/shared/dreamina-account
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PRIMARY_VALUE_NAME,
  isWindows,
  listKeychainSubkeys,
  readKeychainValues,
  readKeychainValuesAt,
  pickPrimaryValue,
  writeKeychainValue,
  writeKeychainValueAt,
  type KeychainValue,
  type RegRunner,
} from './dreamina-keychain.ts'
import { acquireSlot, atomicWriteJson, atomicWriteText, ensureDir, newTaskId, readJsonSafe } from './private-runtime.ts'

/**
 * 画布 CLI（dreamina-canvas）的 keychain 子键前缀。
 *
 * 两个 CLI 各持一份独立登录态（实测互不覆盖），所以「切账号」必须同时切换
 * 两个子键：只切旧子键会让 `generate_video`（走画布 CLI）用错账号。
 */
export const CANVAS_KEYCHAIN_PREFIX = 'dreamina_canvas'

/** 捕获到的一份画布 CLI 登录态。 */
export interface CanvasKeychainCapture {
  subKey?: string
  valueName?: string
  value?: string
  fingerprint?: string
}

/**
 * 读取当前激活的画布 CLI 登录态。
 *
 * 子键名带一个 auth-SDK 常量后缀（与 profile/region/instance-id 都无关），
 * 所以这里按前缀发现，而不是硬编码。没有画布登录态时返回空对象。
 */
export async function readActiveCanvasKeychain(runner?: RegRunner): Promise<CanvasKeychainCapture> {
  const subkeys = (await listKeychainSubkeys(runner)).filter((k) => k.startsWith(CANVAS_KEYCHAIN_PREFIX))
  if (subkeys.length === 0) return {}
  const subKey = subkeys[0]
  const values = await readKeychainValuesAt(subKey, runner)
  const primary =
    values.find((v) => v.valueName === PRIMARY_VALUE_NAME && v.value.length > 0) ??
    values.find((v) => v.type === 'REG_SZ' && v.value.length > 0)
  if (!primary) return { subKey }
  return { subKey, valueName: primary.valueName, value: primary.value, fingerprint: tokenFingerprint(primary.value) }
}

/**
 * Account names: letters (either case), digits and `. _ -`, starting with a
 * letter or digit. Display names keep the user's capitalisation (`ISUN` stays
 * `ISUN`); the on-disk directory is lower-cased so the store stays unambiguous
 * on case-insensitive Windows filesystems (and identical on any other).
 */
export const ACCOUNT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

/** Identity reported by `dreamina user_credit`. */
export interface DreaminaIdentity {
  userId: string | null
  userName: string
  vipLevel: string
  credit: number | null
}

/** One captured account. */
export interface DreaminaAccountMeta {
  name: string
  userId: string | null
  userName: string
  vipLevel: string
  credit: number | null
  savedAt: string
  /** Set when the account was renamed after capture. */
  renamedAt?: string
  /** Registry value name this blob must be written back to. */
  valueName: string
  /** sha256(blob) prefix — lets us prove which account is live without decrypting. */
  fingerprint: string
  /** 画布 CLI 的 keychain 子键（该账号登录画布 CLI 时捕获；未捕获则为空）。 */
  canvasSubKey?: string
  /** 画布 CLI 的值名（实测与旧 CLI 同名）。 */
  canvasValueName?: string
  /** sha256(画布 blob) 前缀，用于判断画布侧是否是同一账号。 */
  canvasFingerprint?: string
  platform: string
  source: 'current' | 'login'
}

/** Material printed by `dreamina login --headless`. */
export interface DeviceAuthMaterial {
  verificationUri: string
  userCode: string
  deviceCode: string
  pollInterval: string
  expiresAt: string
}

/** sha256 of the stored blob, first 16 hex chars (audit fingerprint, not a secret). */
export function tokenFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Parse `user_credit` output. `user_id` is pulled out textually so a 15-digit id
 * keeps its exact digits (no float round-trip).
 */
export function parseUserCredit(stdout: string): DreaminaIdentity | undefined {
  const text = String(stdout ?? '')
  const start = text.indexOf('{')
  if (start < 0) return undefined
  const jsonText = text.slice(start)
  let parsed: any
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const idMatch = jsonText.match(/"user_id"\s*:\s*"?(\d+)"?/)
  const userId = idMatch?.[1] ?? (parsed.user_id !== undefined && parsed.user_id !== null ? String(parsed.user_id) : null)
  const creditValue = Number(parsed.total_credit)
  return {
    userId: userId && userId.length > 0 ? userId : null,
    userName: String(parsed.user_name ?? ''),
    vipLevel: String(parsed.vip_level ?? ''),
    credit: Number.isFinite(creditValue) ? creditValue : null,
  }
}

/** True when `login --headless` reused an already-valid local session. */
export function isReusedLoginOutput(stdout: string): boolean {
  return /已复用|reuse/i.test(String(stdout ?? ''))
}

/**
 * Parse the `login --headless` authorization material:
 *
 *     请使用浏览器完成 OAuth Device Flow 登录。
 *     verification_uri: https://jimeng.jianying.com/ai-tool/cli-auth?...
 *     user_code: 1db286381183168da017481452406068
 *     device_code: 6c09ace3f1f8d38a31b8575ed137d355
 *     poll_interval: 1s
 *     expires_at: 2026-10-06T01:03:30+08:00
 */
export function parseDeviceAuthOutput(stdout: string): DeviceAuthMaterial | undefined {
  const text = String(stdout ?? '')
  const field = (name: string): string => text.match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'mi'))?.[1] ?? ''
  const material: DeviceAuthMaterial = {
    verificationUri: field('verification_uri'),
    userCode: field('user_code'),
    deviceCode: field('device_code'),
    pollInterval: field('poll_interval'),
    expiresAt: field('expires_at'),
  }
  if (!material.deviceCode && !material.userCode && !material.verificationUri) return undefined
  return material
}

/** `<private>/dreamina-accounts` */
export function accountsRoot(privateRoot: string): string {
  return join(privateRoot, 'dreamina-accounts')
}

/** Directory holding one account (lower-cased; see ACCOUNT_NAME_RE). */
export function accountDir(privateRoot: string, name: string): string {
  if (!ACCOUNT_NAME_RE.test(name)) throw new Error(`非法账号名 "${name}"（只允许字母、数字与 . _ -，≤32 字符）`)
  return join(accountsRoot(privateRoot), name.toLowerCase())
}

/** `<private>/dreamina-accounts/default.json` */
export function defaultAccountPath(privateRoot: string): string {
  return join(accountsRoot(privateRoot), 'default.json')
}

/** Read one account's metadata (undefined when the account does not exist). */
export async function readAccountMeta(privateRoot: string, name: string): Promise<DreaminaAccountMeta | undefined> {
  const meta = await readJsonSafe(join(accountDir(privateRoot, name), 'account.json'))
  if (!meta || typeof meta !== 'object' || typeof meta.name !== 'string') return undefined
  return meta as DreaminaAccountMeta
}

/** Read one account's stored blob. */
export async function readAccountToken(privateRoot: string, name: string): Promise<string | undefined> {
  return readAccountFile(privateRoot, name, 'token.txt')
}

/** Read one account's stored canvas-CLI blob (undefined when it was never captured). */
export async function readAccountCanvasToken(privateRoot: string, name: string): Promise<string | undefined> {
  return readAccountFile(privateRoot, name, 'canvas-token.txt')
}

/** Read one file from an account directory (trimmed, undefined when missing/empty). */
async function readAccountFile(privateRoot: string, name: string, file: string): Promise<string | undefined> {
  const meta = await readAccountMeta(privateRoot, name)
  if (!meta) return undefined
  try {
    const value = (await readFile(join(accountDir(privateRoot, name), file), 'utf8')).trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** List captured accounts, newest first. */
export async function listAccounts(privateRoot: string): Promise<DreaminaAccountMeta[]> {
  const root = accountsRoot(privateRoot)
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const metas: DreaminaAccountMeta[] = []
  for (const name of names) {
    if (!ACCOUNT_NAME_RE.test(name)) continue
    const meta = await readAccountMeta(privateRoot, name)
    if (meta) metas.push(meta)
  }
  return metas.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
}

/** Persist one captured login (blob + metadata). */
export async function saveAccount(
  privateRoot: string,
  input: {
    name: string
    valueName: string
    value: string
    identity: DreaminaIdentity
    source: 'current' | 'login'
    /**
     * 同一次捕获到的画布 CLI 登录态。两个 CLI 各自独立登录，所以要一起存，
     * 切换时才能把两边都切过去（否则 generate_video 会用错账号）。
     */
    canvas?: CanvasKeychainCapture
  },
): Promise<DreaminaAccountMeta> {
  const dir = await ensureDir(accountDir(privateRoot, input.name))
  const meta: DreaminaAccountMeta = {
    name: input.name,
    userId: input.identity.userId,
    userName: input.identity.userName,
    vipLevel: input.identity.vipLevel,
    credit: input.identity.credit,
    savedAt: new Date().toISOString(),
    valueName: input.valueName || PRIMARY_VALUE_NAME,
    fingerprint: tokenFingerprint(input.value),
    platform: process.platform,
    source: input.source,
  }
  if (input.canvas?.subKey && input.canvas.value) {
    meta.canvasSubKey = input.canvas.subKey
    meta.canvasValueName = input.canvas.valueName || PRIMARY_VALUE_NAME
    meta.canvasFingerprint = input.canvas.fingerprint ?? tokenFingerprint(input.canvas.value)
  }
  await atomicWriteText(join(dir, 'token.txt'), input.value)
  if (input.canvas?.value && input.canvas.value.length > 0) {
    await atomicWriteText(join(dir, 'canvas-token.txt'), input.canvas.value)
  }
  await atomicWriteJson(join(dir, 'account.json'), meta)
  return meta
}

/**
 * The account the pipeline keeps active (configured > default.json).
 *
 * The pointer is stored lower-cased (see writeDefaultAccount) but reported as
 * the account's display name, so `ISUN` reads back as `ISUN` while any version
 * of this code — including one with a stricter name rule — can still resolve it.
 */
export async function readDefaultAccount(privateRoot: string): Promise<string | undefined> {
  const doc = await readJsonSafe(defaultAccountPath(privateRoot))
  const raw = doc?.name
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  if (!ACCOUNT_NAME_RE.test(raw)) return undefined
  const meta = await readAccountMeta(privateRoot, raw)
  return meta?.name ?? raw
}

/**
 * Rename a captured account: directory, metadata and the pipeline default
 * pointer move together. Renaming only the capitalisation (`isun` -> `ISUN`) is
 * a metadata update, since the directory is lower-cased either way.
 */
export async function renameAccount(privateRoot: string, from: string, to: string): Promise<DreaminaAccountMeta> {
  if (!ACCOUNT_NAME_RE.test(from)) throw new Error(`非法账号名 "${from}"`)
  if (!ACCOUNT_NAME_RE.test(to)) throw new Error(`非法账号名 "${to}"（只允许字母、数字与 . _ -，≤32 字符）`)
  const meta = await readAccountMeta(privateRoot, from)
  if (!meta) throw new Error(`账号 "${from}" 不存在`)

  const same = from.toLowerCase() === to.toLowerCase()
  if (!same) {
    const clash = await readAccountMeta(privateRoot, to)
    if (clash) throw new Error(`账号 "${to}" 已存在（user_id=${clash.userId ?? '?'}），请换一个名字或先 forget 它`)
    await rename(accountDir(privateRoot, from), accountDir(privateRoot, to))
  }

  const next: DreaminaAccountMeta = { ...meta, name: to, renamedAt: new Date().toISOString() }
  await atomicWriteJson(join(accountDir(privateRoot, to), 'account.json'), next)

  const defaultName = await readDefaultAccount(privateRoot)
  if (defaultName && defaultName.toLowerCase() === from.toLowerCase()) {
    await writeDefaultAccount(privateRoot, to)
  }
  return next
}

/**
 * Record the pipeline default account. The pointer is written lower-cased: the
 * account directory is lower-cased anyway, and a lower-case pointer keeps
 * working even for a reader whose name rule only accepts lower case.
 */
export async function writeDefaultAccount(privateRoot: string, name: string): Promise<void> {
  if (!ACCOUNT_NAME_RE.test(name)) throw new Error(`非法账号名 "${name}"`)
  const meta = await readAccountMeta(privateRoot, name)
  if (!meta) throw new Error(`账号 "${name}" 不存在，请先 save 或 login`)
  await atomicWriteJson(defaultAccountPath(privateRoot), { name: meta.name.toLowerCase(), updatedAt: new Date().toISOString() })
}

/** Remove the pipeline default account. */
export async function clearDefaultAccount(privateRoot: string): Promise<void> {
  await atomicWriteJson(defaultAccountPath(privateRoot), { name: null, updatedAt: new Date().toISOString() })
}

/** What the registry currently holds. */
export interface ActiveKeychain {
  valueName?: string
  fingerprint?: string
  value?: string
  values: KeychainValue[]
}

/** Inspect the live keychain login (no mutation). */
export async function readActiveKeychain(runner?: RegRunner): Promise<ActiveKeychain> {
  const values = await readKeychainValues(runner)
  const primary = pickPrimaryValue(values)
  if (!primary) return { values }
  return { valueName: primary.valueName, value: primary.value, fingerprint: tokenFingerprint(primary.value), values }
}

/** Ensure the registry login equals the requested account (idempotent). */
export interface EnsureAccountOutcome {
  changed: boolean
  account?: string
  userId?: string | null
  reason: 'no-default-account' | 'already-active' | 'switched'
  /** 本次切换是否同时把画布 CLI 的登录态切过去（旧库账号可能没有画布 blob）。 */
  canvasSwitched?: boolean
}

export interface EnsureAccountOptions {
  privateRoot: string
  /** Explicit config override; falls back to `<private>/dreamina-accounts/default.json`. */
  configuredAccount?: string
  runner?: RegRunner
  /** Optional audit hook (e.g. appendSafeLog). */
  onSwitch?: (info: { account: string; from?: string; to: string }) => Promise<void> | void
}

/**
 * Make the configured/default account the live one.
 *
 * This is deliberately cheap on the happy path: one `reg query` when the live
 * fingerprint already matches, a single write when it does not. It is a no-op
 * when no account is configured, so a pipeline that never opts in behaves
 * exactly as before. A cross-process lease serializes concurrent switches.
 */
export async function ensureActiveAccount(options: EnsureAccountOptions): Promise<EnsureAccountOutcome> {
  const configured = String(options.configuredAccount ?? '').trim()
  const target = configured.length > 0 ? configured : await readDefaultAccount(options.privateRoot)
  if (!target) return { changed: false, reason: 'no-default-account' }
  if (!ACCOUNT_NAME_RE.test(target)) throw new Error(`配置的 Dreamina 账号名不合法: "${target}"`)

  const meta = await readAccountMeta(options.privateRoot, target)
  if (!meta) {
    throw new Error(
      `管线默认 Dreamina 账号 "${target}" 不在账号库中（${accountsRoot(options.privateRoot)}）。` +
        '请用 dreamina_account save/login 重新保存，或清除默认账号。',
    )
  }

  const active = await readActiveKeychain(options.runner)
  const activeCanvas = await readActiveCanvasKeychain(options.runner)
  if (sameAccount(meta, active, activeCanvas)) {
    return { changed: false, account: target, userId: meta.userId, reason: 'already-active' }
  }

  const token = await readAccountToken(options.privateRoot, target)
  if (!token) throw new Error(`账号 "${target}" 的登录态文件缺失或为空，无法切换`)

  const release = await acquireSlot(join(options.privateRoot, 'locks'), 'dreamina-account', 1, {
    taskId: `switch-${newTaskId().slice(0, 8)}`,
    timeoutMs: 20000,
    staleMs: 60000,
  })
  try {
    // Re-check under the lease: another process may have switched already.
    const again = await readActiveKeychain(options.runner)
    const againCanvas = await readActiveCanvasKeychain(options.runner)
    if (sameAccount(meta, again, againCanvas)) {
      return { changed: false, account: target, userId: meta.userId, reason: 'already-active' }
    }
    await writeKeychainValue(meta.valueName || PRIMARY_VALUE_NAME, token, options.runner)
    // 画布 CLI 是另一份独立登录态：不同步切过去，generate_video 就会用错账号。
    let canvasSwitched = false
    if (meta.canvasFingerprint !== undefined) {
      const canvasToken = await readAccountCanvasToken(options.privateRoot, target)
      const canvasSubKey = meta.canvasSubKey ?? againCanvas.subKey
      if (canvasToken && canvasSubKey) {
        await writeKeychainValueAt(canvasSubKey, meta.canvasValueName || PRIMARY_VALUE_NAME, canvasToken, options.runner)
        canvasSwitched = true
      }
    }
    await options.onSwitch?.({ account: target, from: again.fingerprint, to: meta.fingerprint })
    return { changed: true, account: target, userId: meta.userId, reason: 'switched', canvasSwitched }
  } finally {
    await release()
  }
}

/**
 * 把一个账号的画布 CLI 登录态切成活的。
 *
 * 与旧子键的写入配对使用：工具层先写旧子键，再调用本函数写画布子键。账号若
 * 在捕获时画布 CLI 尚未登录（`canvasFingerprint` 为空），这里静默跳过，
 * 行为与迁移前完全一致。
 */
export async function switchCanvasLogin(privateRoot: string, meta: DreaminaAccountMeta, runner?: RegRunner): Promise<boolean> {
  if (meta.canvasFingerprint === undefined) return false
  const token = await readAccountCanvasToken(privateRoot, meta.name)
  if (!token) return false
  const live = await readActiveCanvasKeychain(runner)
  const subKey = meta.canvasSubKey ?? live.subKey
  if (!subKey) return false
  await writeKeychainValueAt(subKey, meta.canvasValueName || PRIMARY_VALUE_NAME, token, runner)
  return true
}

/**
 * 账号是否已经是「两边都活」的状态。
 *
 * 旧库里的账号可能没有画布侧 blob（迁移前捕获的），此时只校验旧子键，
 * 保持向后兼容；一旦记录了 `canvasFingerprint`，就必须两边都匹配。
 */
function sameAccount(meta: DreaminaAccountMeta, oldState: ActiveKeychain, canvasState: CanvasKeychainCapture): boolean {
  if (oldState.fingerprint !== meta.fingerprint) return false
  if (meta.canvasFingerprint === undefined) return true
  return canvasState.fingerprint === meta.canvasFingerprint
}

/**
 * Gate used by the pipeline before CLI calls.
 *
 * It deliberately does NOT memoize: every call re-reads the live registry value
 * (one cheap `reg query`) so a long production poll loop notices an account
 * switched by another session and restores the configured account instead of
 * querying someone else's task with the wrong login.
 */
export function createAccountGate(privateRoot: string, configuredAccount?: string, onSwitch?: EnsureAccountOptions['onSwitch']) {
  return {
    ensure: () => ensureActiveAccount({ privateRoot, configuredAccount, onSwitch }),
  }
}

/** Human-readable one-liner for logs/diagnostics. */
export function describeIdentity(identity: DreaminaIdentity | undefined): string {
  if (!identity) return 'unknown'
  const id = identity.userId ?? 'unknown'
  const vip = identity.vipLevel ? ` / ${identity.vipLevel}` : ''
  const credit = identity.credit === null ? '' : ` / credit ${identity.credit}`
  return `user_id=${id}${vip}${credit}`
}

/** Guard used by the tool layer before touching the store. */
export function assertAccountSwitchingSupported(): void {
  if (!isWindows()) {
    throw new Error('Dreamina 账号切换目前只实现了 Windows（登录态是 HKCU\\Software\\BytedAuthClient\\keychain 下的 DPAPI 值）')
  }
}
