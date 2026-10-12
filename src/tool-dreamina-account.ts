/**
 * `dreamina_account` — Dreamina (即梦) CLI account switching.
 *
 * The CLI keeps exactly one login at a time, stored as a DPAPI blob in
 * `HKCU\Software\BytedAuthClient\keychain\dreamina` (see shared/dreamina-keychain.ts;
 * `~/.dreamina_cli/credential.json` is a stale leftover the CLI never reads).
 * This tool captures that blob into named accounts under the private runtime and
 * replays it, so the pipeline can be pinned to one account and switched without
 * re-running an OAuth login. Switching itself is a registry write; the pipeline's
 * other tools call `ensureActiveAccount` before every CLI invocation.
 *
 * @module @deepseek-ai/dsh-tool-dreamina-account
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { readdir, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { packageRootOf } from './shared/pkg-root.ts'
import { appendSafeLog, resolvePrivateRoot } from './shared/private-runtime.ts'
import { deleteKeychainValue, PRIMARY_VALUE_NAME, writeKeychainValue } from './shared/dreamina-keychain.ts'
import {
  ACCOUNT_NAME_RE,
  accountDir,
  accountsRoot,
  assertAccountSwitchingSupported,
  clearDefaultAccount,
  describeIdentity,
  listAccounts,
  readAccountCanvasToken,
  readAccountMeta,
  readAccountToken,
  readActiveCanvasKeychain,
  readActiveKeychain,
  readDefaultAccount,
  renameAccount,
  saveAccount,
  switchCanvasLogin,
  tokenFingerprint,
  writeDefaultAccount,
  type DreaminaIdentity,
} from './shared/dreamina-account.ts'
import { createCanvasCli, resolveCanvasBinary } from './shared/dreamina-canvas.ts'

const execFileAsync = promisify(execFile)

const PACKAGE_ROOT = packageRootOf(import.meta.url)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'Ws_tool-dreamina-account'
export const inject = ['tools']

export interface Config {
  privateDir?: string
  /** 旧 CLI（`dreamina`）路径；只用于兼容读取身份与旧登录态。 */
  dreaminaPath?: string
  /** 画布 CLI（`dreamina-canvas`）路径；留空 = 自动解析（包内 bin → ~/bin → PATH）。 */
  dreaminaCanvasPath?: string
  /** Stale lease threshold (ms) used to decide whether a Dreamina task is in flight. */
  leaseStaleMs?: number
}

export const Config: z<Config> = z.object({
  privateDir: z.string().default(''),
  dreaminaPath: z.string().default(''),
  dreaminaCanvasPath: z.string().default(''),
  leaseStaleMs: z.number().default(30 * 60 * 1000),
})

type ResolvedConfig = Required<Config>

/**
 * 画布 CLI 的账号身份（`auth account` → userId / isVip / vipLevel）。
 *
 * 画布 CLI **不返回积分余额**（官方口径：账户信息里暂无 credit），所以
 * `credit` 一律为 null —— 旧 CLI 已退役，仓库不再提供任何余额查询。
 */
async function fetchCanvasIdentity(binary: string): Promise<DreaminaIdentity | undefined> {
  try {
    const cli = createCanvasCli({ binary })
    const result = await cli.run(['auth', 'account'], { timeoutMs: 30_000 })
    if (result.classification.outcome !== 'ok') return undefined
    const data: any = result.envelope?.data ?? {}
    const userId = data.userId === undefined || data.userId === null ? null : String(data.userId)
    if (!userId) return undefined
    const vip = String(data.vipLevel ?? '')
    return { userId, userName: String(data.userName ?? ''), vipLevel: vip || (data.isVip === true ? 'vip' : ''), credit: null }
  } catch {
    return undefined
  }
}

/** Active Dreamina leases that would break if the login were swapped mid-flight. */
async function activeDreaminaLeases(privateRoot: string, staleMs: number): Promise<string[]> {
  const out: string[] = []
  for (const capacity of ['seedance-cli', 'image']) {
    const dir = join(privateRoot, 'locks', 'providers', capacity)
    let files: string[] = []
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.lock')) continue
      try {
        const info = await stat(join(dir, file))
        if (Date.now() - info.mtimeMs <= staleMs) out.push(`${capacity}/${file}`)
      } catch {
        /* raced away */
      }
    }
  }
  return out
}

/** Park the live login into the account store before it is replaced. */
async function backupLiveLogin(
  privateRoot: string,
  live: { valueName: string; value: string },
  identity: DreaminaIdentity | undefined,
): Promise<string> {
  const existing = await listAccounts(privateRoot)
  const fingerprint = tokenFingerprint(live.value)
  const known = existing.find((a) => a.fingerprint === fingerprint)
  if (known) return known.name
  const base = identity?.userId ? `previous-${identity.userId}` : 'previous-unknown'
  let candidate = base
  let n = 2
  while (existing.some((a) => a.name.toLowerCase() === candidate.toLowerCase())) {
    candidate = `${base}-${n}`
    n += 1
  }
  await saveAccount(privateRoot, {
    name: candidate,
    valueName: live.valueName,
    value: live.value,
    identity: identity ?? { userId: null, userName: '', vipLevel: '', credit: null },
    source: 'current',
  })
  return candidate
}

function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'dreamina_account',
      description:
        '即梦（Dreamina）CLI 账号切换：CLI 同一时刻只持有一个登录态（存放在 HKCU\\Software\\BytedAuthClient\\keychain\\dreamina 的 DPAPI 值；~/.dreamina_cli/credential.json 是 CLI 从不读取的遗留文件）。' +
        '命令：current（当前激活账号与默认账号）、list（账号库）、save（把当前登录态保存为命名账号）、use（切换到命名账号，必要时 force）、default（设置/查看管线默认账号，设置后立即切换）、rename（给账号改名，默认账号指针会跟着走）、' +
        'login（引导 OAuth Device Flow 登录新账号：先把现有登录态备份入库再清空，然后返回 verification_uri/user_code/device_code，请用目标浏览器打开授权）、login-check（轮询完成授权并自动入库）、forget（从库中删除账号，不动当前登录态）。' +
        '账号名区分大小写显示但按大小写不敏感解析（目录统一小写），可用 wsstudio / ISUN 这类可读名字；' +
        '只输出账号 id/额度与指纹，绝不输出登录态内容；切换会写注册表登录态，同一时刻只能有一个账号活跃，有活动即梦任务时会拒绝切换（除非 force）。',
      parameters: {
        command: {
          type: 'string',
          enum: ['current', 'list', 'save', 'use', 'default', 'rename', 'login', 'login-check', 'forget'],
          required: true,
          description: '操作命令。',
        },
        name: {
          type: 'string',
          description: '账号名（字母/数字/. _ -，≤32 字符，显示保留大小写）；save/use/default/rename/login/login-check/forget 需要。',
        },
        new_name: {
          type: 'string',
          description: 'rename 用：新的账号名（字母/数字/. _ -，≤32 字符）。',
        },
        device_code: {
          type: 'string',
          description: 'login-check 用：login 返回的 device_code。',
        },
        poll: {
          type: 'number',
          description: 'login-check 用：轮询秒数（默认 30）。',
        },
        clear_default: {
          type: 'boolean',
          description: 'default 用：清除管线默认账号。',
        },
        force: {
          type: 'boolean',
          description: 'use 用：即使有正在运行的即梦任务也强制切换（默认拒绝）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            command: { type: 'string' },
            message: { type: 'string' },
            accounts: { type: 'array', items: { type: 'object', additionalProperties: true } },
            active: { type: 'object', additionalProperties: true },
            default_account: { type: 'string' },
            material: { type: 'object', additionalProperties: true },
          },
        },
        render(_args: unknown, value: any) {
          const lines: string[] = [value.message ?? JSON.stringify(value)]
          if (Array.isArray(value.accounts) && value.accounts.length > 0) {
            lines.push('', '账号库:')
            for (const a of value.accounts) {
              const tags = [a.is_active ? '当前激活' : '', a.is_default ? '管线默认' : ''].filter(Boolean).join('/')
              lines.push(
                `- ${a.name}: user_id=${a.userId ?? '?'}${a.vipLevel ? ` · ${a.vipLevel}` : ''}${a.credit === null || a.credit === undefined ? '' : ` · credit ${a.credit}`}${tags ? ` [${tags}]` : ''}`,
              )
            }
          }
          if (value.active && typeof value.active === 'object') {
            const a = value.active
            lines.push('', `当前激活登录态: ${a.userId ? `user_id=${a.userId}` : '未登录或未知'}${a.vip_level ? ` · ${a.vip_level}` : ''}${a.credit === null || a.credit === undefined ? '' : ` · credit ${a.credit}`}`)
            lines.push(`- 指纹: ${a.fingerprint ?? 'n/a'} · 匹配账号: ${a.account ?? '（未入库）'}`)
          }
          if (value.material && typeof value.material === 'object' && Object.keys(value.material).length > 0) {
            lines.push('', 'OAuth 设备授权（请在目标浏览器打开 verification_uri，用目标即梦账号登录并确认）:')
            for (const [k, v] of Object.entries<any>(value.material)) {
              if (k === 'backup_account' || v === undefined || v === null || v === '') continue
              lines.push(`- ${k}: ${v}`)
            }
            if (value.material.backup_account) lines.push(`- 切换前的登录态已备份为账号: ${value.material.backup_account}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args: any, exec: any) {
        const command: string = String(args?.command ?? 'current')
        const workspaceRoot: string = exec.agent?.session?.header?.cwd ?? process.cwd()
        const privateRoot = resolvePrivateRoot(workspaceRoot, config.privateDir)
        const dreaminaPath = config.dreaminaPath
        const canvasBinary = await resolveCanvasBinary(config.dreaminaCanvasPath)
        const requestedName: string = String(args?.name ?? '').trim()

        const requireName = (): string => {
          if (!ACCOUNT_NAME_RE.test(requestedName)) {
            throw new Error(`需要合法的账号名（小写字母/数字/. _ -，≤32 字符），收到: "${requestedName}"`)
          }
          return requestedName
        }

        const snapshot = async () => {
          // 账号身份与活登录态一律来自画布 CLI（旧 CLI 已退役）。
          const live = await readActiveCanvasKeychain()
          const identity = live.value ? await fetchCanvasIdentity(canvasBinary) : undefined
          const accounts = await listAccounts(privateRoot)
          const defaultName = await readDefaultAccount(privateRoot)
          const matched = live.fingerprint ? accounts.find((a) => a.canvasFingerprint === live.fingerprint) : undefined
          return { live, identity, accounts, defaultName, matched }
        }

        const logSwitch = async (entry: Record<string, unknown>) => {
          await appendSafeLog(privateRoot, 'dreamina-account', entry)
        }

        if (command === 'current') {
          const { live, identity, defaultName, matched } = await snapshot()
          const active = {
            valueName: live.valueName,
            fingerprint: live.fingerprint,
            account: matched?.name,
            userId: identity?.userId ?? matched?.userId ?? null,
            vip_level: identity?.vipLevel ?? matched?.vipLevel ?? '',
            credit: identity?.credit ?? matched?.credit ?? null,
          }
          const message = live.value
            ? `当前即梦账号: ${describeIdentity(identity)}${matched ? `（账号库: ${matched.name}）` : '（未入库）'}；管线默认账号: ${defaultName ?? '（未设置）'}`
            : `当前未检测到即梦登录态（keychain 无有效值）；管线默认账号: ${defaultName ?? '（未设置）'}`
          return { ok: true, command, message, active, default_account: defaultName ?? '' }
        }

        if (command === 'list') {
          const { live, identity, accounts, defaultName, matched } = await snapshot()
          const rows = accounts.map((a) => ({
            ...a,
            is_active: Boolean(matched && matched.name === a.name),
            is_default: a.name === defaultName,
          }))
          return {
            ok: true,
            command,
            message: `账号库共有 ${rows.length} 个账号（${accountsRoot(privateRoot)}）${defaultName ? `；管线默认 = ${defaultName}` : ''}`,
            accounts: rows,
            active: {
              fingerprint: live.fingerprint,
              account: matched?.name,
              valueName: live.valueName,
              userId: identity?.userId ?? matched?.userId ?? null,
              vip_level: identity?.vipLevel ?? matched?.vipLevel ?? '',
              credit: identity?.credit ?? matched?.credit ?? null,
            },
            default_account: defaultName ?? '',
          }
        }

        if (command === 'save') {
          const target = requireName()
          assertAccountSwitchingSupported()
          const live = await readActiveKeychain()
          const canvasLive = await readActiveCanvasKeychain()
          if ((!live.value || !live.valueName) && !canvasLive.value) {
            throw new Error('当前没有可保存的即梦登录态（请先 dreamina-canvas auth login，或旧的 dreamina login）')
          }
          // 身份一律取画布 CLI（旧 CLI 已退役，不再作为来源或兜底）。
          const identity = await fetchCanvasIdentity(canvasBinary)
          if (!identity?.userId) {
            throw new Error('无法读取当前账号身份（dreamina-canvas auth account 失败），拒绝保存未知登录态')
          }
          const value = live.value ?? canvasLive.value ?? ''
          const valueName = live.valueName ?? canvasLive.valueName ?? PRIMARY_VALUE_NAME
          const meta = await saveAccount(privateRoot, {
            name: target,
            valueName,
            value,
            identity,
            source: 'current',
            canvas: canvasLive.value ? canvasLive : undefined,
          })
          await logSwitch({ action: 'save', account: target, userId: meta.userId, fingerprint: meta.fingerprint, canvasCaptured: meta.canvasFingerprint !== undefined })
          return {
            ok: true,
            command,
            message:
              `已把当前登录态保存为账号 "${target}"（${describeIdentity(identity)}，指纹 ${meta.fingerprint}` +
              `${meta.canvasFingerprint ? `；画布 CLI 登录态已一并保存 ${meta.canvasFingerprint}` : '；未检测到画布 CLI 登录态'}）`,
            active: { userId: meta.userId, vip_level: meta.vipLevel, credit: meta.credit, fingerprint: meta.fingerprint, account: target },
          }
        }

        if (command === 'use') {
          const target = requireName()
          assertAccountSwitchingSupported()
          const meta = await readAccountMeta(privateRoot, target)
          if (!meta) throw new Error(`账号 "${target}" 不存在（用 dreamina_account list 查看已有账号）`)
          const token = await readAccountToken(privateRoot, target)
          if (!token) throw new Error(`账号 "${target}" 的登录态文件缺失或为空`)

          const live = await readActiveKeychain()
          if (live.fingerprint === meta.fingerprint) {
            return {
              ok: true,
              command,
              message: `账号 "${target}"（${describeIdentity({ userId: meta.userId, userName: meta.userName, vipLevel: meta.vipLevel, credit: meta.credit })}）已经是当前激活账号，无需切换`,
              active: { userId: meta.userId, vip_level: meta.vipLevel, credit: meta.credit, fingerprint: meta.fingerprint, account: target },
            }
          }

          const leases = await activeDreaminaLeases(privateRoot, config.leaseStaleMs)
          if (leases.length > 0 && args?.force !== true) {
            throw new Error(
              `检测到正在运行的即梦任务（${leases.join(', ')}）：此时切换账号会让进行中的任务用错账号。` +
                '请等待任务结束；确需强制切换请传 force=true。',
            )
          }

          await writeKeychainValue(meta.valueName || PRIMARY_VALUE_NAME, token)
          // 画布 CLI 是另一份独立登录态：必须同步切过去，否则 generate_video 会用错账号。
          const canvasSwitched = await switchCanvasLogin(privateRoot, meta)
          const identity = await fetchCanvasIdentity(canvasBinary)
          if (!identity?.userId) {
            throw new Error('切换后即梦身份校验失败：登录态可能已失效，请用 dreamina_account use <其他账号> 回退，或重新登录')
          }
          if (meta.userId && identity.userId !== meta.userId) {
            throw new Error(`切换校验失败：期望 user_id=${meta.userId}，实际 user_id=${identity.userId}`)
          }
          await logSwitch({ action: 'use', account: target, userId: identity.userId, fingerprint: meta.fingerprint, canvasSwitched, forced: args?.force === true })
          return {
            ok: true,
            command,
            message: `已切换到账号 "${target}"（${describeIdentity(identity)}）${canvasSwitched ? '；画布 CLI 登录态已同步' : ''}${leases.length > 0 ? `；注意：切换时有正在运行的任务（${leases.join(', ')}），已强制切换` : ''}`,
            active: { userId: identity.userId, vip_level: identity.vipLevel, credit: identity.credit, fingerprint: meta.fingerprint, account: target },
          }
        }

        if (command === 'default') {
          assertAccountSwitchingSupported()
          if (args?.clear_default === true) {
            await clearDefaultAccount(privateRoot)
            return { ok: true, command, message: '已清除管线默认即梦账号：后续管线调用不再改动当前登录态', default_account: '' }
          }
          if (!requestedName) {
            const defaultName = await readDefaultAccount(privateRoot)
            return {
              ok: true,
              command,
              message: defaultName ? `管线默认即梦账号 = "${defaultName}"` : '尚未设置管线默认即梦账号（管线不会自动切换账号）',
              default_account: defaultName ?? '',
            }
          }
          const target = requireName()
          const meta = await readAccountMeta(privateRoot, target)
          if (!meta) throw new Error(`账号 "${target}" 不存在，无法设为默认（先 save 或 login）`)
          await writeDefaultAccount(privateRoot, target)

          // 设为默认的同时立即切换：用户说“让管线默认使用这个账号”时，期望立刻生效。
          const live = await readActiveKeychain()
          let switched = false
          if (live.fingerprint !== meta.fingerprint) {
            const leases = await activeDreaminaLeases(privateRoot, config.leaseStaleMs)
            if (leases.length > 0 && args?.force !== true) {
              return {
                ok: true,
                command,
                message:
                  `已把管线默认账号设为 "${target}"，但当前有正在运行的即梦任务（${leases.join(', ')}），暂不立即切换。` +
                  '任务结束后任意管线调用会自动切到该账号；也可稍后手动 use。',
                default_account: target,
              }
            }
            const token = await readAccountToken(privateRoot, target)
            if (!token) throw new Error(`账号 "${target}" 的登录态文件缺失或为空`)
            await writeKeychainValue(meta.valueName || PRIMARY_VALUE_NAME, token)
            await switchCanvasLogin(privateRoot, meta)
            switched = true
          }
          const identity = switched ? await fetchCanvasIdentity(canvasBinary) : undefined
          if (switched && !identity?.userId) {
            throw new Error(
              `管线默认账号已设为 "${target}"，但切换后 dreamina-canvas auth account 失败：该账号登录态可能已失效。` +
                '请 use 另一个账号回退，或重新 login；撤销默认设置用 default clear_default=true。',
            )
          }
          await logSwitch({ action: 'default', account: target, userId: identity?.userId ?? meta.userId, switched })
          return {
            ok: true,
            command,
            message: switched
              ? `已把管线默认账号设为 "${target}" 并切换到该账号（${describeIdentity(identity)}）；之后每次即梦调用前会确保仍是该账号`
              : `已把管线默认账号设为 "${target}"（当前登录态已一致，无需切换）`,
            default_account: target,
            active: switched
              ? { userId: identity?.userId, vip_level: identity?.vipLevel, credit: identity?.credit, fingerprint: meta.fingerprint, account: target }
              : { userId: meta.userId, vip_level: meta.vipLevel, credit: meta.credit, fingerprint: meta.fingerprint, account: target },
          }
        }

        if (command === 'rename') {
          const target = requireName()
          const newName = String(args?.new_name ?? '').trim()
          if (newName.length === 0) throw new Error('rename 需要 new_name（新的账号名），例如 rename name=chrome new_name=ISUN')
          if (!ACCOUNT_NAME_RE.test(newName)) {
            throw new Error(`新账号名不合法: "${newName}"（只允许字母/数字/. _ -，≤32 字符）`)
          }
          assertAccountSwitchingSupported()
          const before = await readAccountMeta(privateRoot, target)
          if (!before) throw new Error(`账号 "${target}" 不存在（用 dreamina_account list 查看已有账号）`)
          const renamed = await renameAccount(privateRoot, target, newName)
          await logSwitch({ action: 'rename', from: target, to: renamed.name, userId: renamed.userId })
          const list = await listAccounts(privateRoot)
          const defaultName = await readDefaultAccount(privateRoot)
          const followed = Boolean(defaultName && defaultName.toLowerCase() === renamed.name.toLowerCase())
          return {
            ok: true,
            command,
            message:
              `账号 "${target}" 已改名为 "${renamed.name}"（user_id=${renamed.userId ?? '?'}，指纹 ${renamed.fingerprint}）` +
              `${followed ? '；管线默认账号指针已同步跟随' : ''}`,
            accounts: list.map((a) => ({ ...a, is_default: a.name === defaultName })),
            default_account: defaultName ?? '',
            active: { account: renamed.name, userId: renamed.userId, fingerprint: renamed.fingerprint },
          }
        }

        if (command === 'login') {
          const target = requireName()
          assertAccountSwitchingSupported()
          // 画布 CLI 的设备流：不清空现有登录态、也不用 --force，所以授权失败/
          // 放弃时无需回滚（旧实现必须先备份再清空是因为旧 CLI 会覆盖登录态）。
          const cli = createCanvasCli({ binary: canvasBinary })
          const started = await cli.runOrThrow(['auth', 'login'], { timeoutMs: 90_000, label: 'auth login' })
          const challenge: any = started.envelope?.data?.challenge ?? {}
          const deviceCode = String(challenge.deviceCode ?? '')
          const userCode = String(challenge.userCode ?? '')
          const verificationUri = String(challenge.verificationUriComplete ?? challenge.verificationUri ?? '')
          if (!deviceCode || verificationUri.length === 0) {
            throw new Error(`未能从 auth login 回执中解析设备授权信息：${started.raw.slice(0, 300)}`)
          }
          await logSwitch({ action: 'login-start', account: target, deviceCode, expiresAt: String(challenge.expiresAt ?? '') })
          return {
            ok: true,
            command,
            message:
              `已开始 OAuth 设备登录（目标账号名 "${target}"）。请在目标浏览器（已登录你要用的即梦账号的那个）打开 verification_uri，` +
              '完成授权后调用 dreamina_account login-check（同一 name 与 device_code）完成入库。',
            material: {
              verification_uri: verificationUri,
              user_code: userCode,
              device_code: deviceCode,
              poll_interval: `${challenge.pollSeconds ?? 1}s`,
              expires_at: String(challenge.expiresAt ?? ''),
              backup_account: '',
            },
          }
        }

        if (command === 'login-check') {
          const target = requireName()
          assertAccountSwitchingSupported()
          const deviceCode = String(args?.device_code ?? '').trim()
          if (!deviceCode) throw new Error('login-check 需要 device_code（由 login 命令返回）')
          const poll = Number.isFinite(Number(args?.poll)) && Number(args.poll) > 0 ? Math.floor(Number(args.poll)) : 30
          const cli = createCanvasCli({ binary: canvasBinary })
          const waited = await cli.run(['auth', 'wait', '--device-code', deviceCode, '--timeout', `${poll}s`], {
            timeoutMs: (poll + 20) * 1000,
          })
          const state: any = waited.envelope?.data ?? {}
          const loggedIn = waited.classification.outcome === 'ok' && (state.status === 'logged_in' || state.state?.loggedIn === true)
          // `auth wait` 返回 logged_in 是唯一成功判据：设备流进行中 keychain 里会存在
          // 中间态值，绝不能据此报「已检测到新登录态」。
          if (!loggedIn) {
            throw new Error(
              `授权尚未完成（auth wait 未返回 logged_in）：${waited.classification.message}。` +
                '请在浏览器打开 verification_uri 完成授权，然后用同一 device_code 重试 login-check；若设备码已过期，请重新执行 login。',
            )
          }
          const identity = await fetchCanvasIdentity(canvasBinary)
          if (!identity?.userId) {
            throw new Error('授权已完成，但 auth account 读取失败：请用同一 name 重试 login-check')
          }
          const canvasLive = await readActiveCanvasKeychain()
          if (!canvasLive.value || !canvasLive.subKey) {
            throw new Error('授权已完成，但本地没有读到画布 CLI 登录态：请重新执行 dreamina_account login')
          }
          const meta = await saveAccount(privateRoot, {
            name: target,
            valueName: canvasLive.valueName ?? PRIMARY_VALUE_NAME,
            value: canvasLive.value,
            identity,
            source: 'login',
            canvas: canvasLive,
          })
          await logSwitch({ action: 'login-complete', account: target, userId: meta.userId, fingerprint: meta.fingerprint })
          return {
            ok: true,
            command,
            message:
              `登录完成并已保存为账号 "${target}"（${describeIdentity(identity)}，指纹 ${meta.fingerprint}）。` +
              `如需让管线默认使用它：dreamina_account default name=${target}`,
            accounts: (await listAccounts(privateRoot)).map((a) => ({ ...a, is_active: a.name === target })),
            active: { userId: identity.userId, vip_level: identity.vipLevel, credit: identity.credit, fingerprint: meta.fingerprint, account: target },
          }
        }

        if (command === 'forget') {
          const target = requireName()
          const meta = await readAccountMeta(privateRoot, target)
          if (!meta) throw new Error(`账号 "${target}" 不存在`)
          const defaultName = await readDefaultAccount(privateRoot)
          await rm(accountDir(privateRoot, target), { recursive: true, force: true })
          if (defaultName === target) await clearDefaultAccount(privateRoot)
          await logSwitch({ action: 'forget', account: target, wasDefault: defaultName === target })
          return {
            ok: true,
            command,
            message: `已从账号库删除 "${target}"${defaultName === target ? '（同时清除了管线默认账号）' : ''}；当前注册表登录态未改动`,
            default_account: defaultName === target ? '' : (defaultName ?? ''),
          }
        }

        throw new Error(`未知命令: ${command}`)
      },
    }),
  )
}

export { apply }
