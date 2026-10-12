import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACCOUNT_NAME_RE,
  accountDir,
  accountsRoot,
  clearDefaultAccount,
  ensureActiveAccount,
  isReusedLoginOutput,
  listAccounts,
  parseDeviceAuthOutput,
  parseUserCredit,
  readAccountMeta,
  readAccountToken,
  readActiveKeychain,
  readDefaultAccount,
  renameAccount,
  saveAccount,
  tokenFingerprint,
  writeDefaultAccount,
} from '../src/shared/dreamina-account.ts'
import { PRIMARY_VALUE_NAME } from '../src/shared/dreamina-keychain.ts'

/** Real `dreamina user_credit` output. */
const USER_CREDIT = `{
  "total_credit": 12531,
  "user_id": 854784705060587,
  "user_name": "",
  "vip_level": "maestro"
}
`

/** Real `dreamina login --headless` output. */
const DEVICE_AUTH = `请使用浏览器完成 OAuth Device Flow 登录。
verification_uri: https://jimeng.jianying.com/ai-tool/cli-auth?verification_uri=https%3A%2F%2Fjimeng
user_code: 1db286381183168da017481452406068
device_code: 6c09ace3f1f8d38a31b8575ed137d355
poll_interval: 1s
expires_at: 2026-10-06T01:03:30+08:00
`

const BLOB_A = `AQAAANCMnd8BFdERjHoAwE/Cl+sBAAA${'A'.repeat(40)}`
const BLOB_B = `AQAAANCMnd8BFdERjHoAwE/Cl+sBAAA${'B'.repeat(40)}`

const isWin = process.platform === 'win32'
/** Registry-backed paths are Windows-only by design. */
const winTest = isWin ? test : test.skip

/** In-memory stand-in for `reg.exe`, exposing the same CLI surface we rely on. */
function fakeRegistry(initial = {}) {
  const store = new Map(Object.entries(initial))
  const calls = []
  const runner = async (args) => {
    calls.push(args)
    const op = args[0]
    if (op === 'query') {
      if (store.size === 0) {
        const error = new Error('reg query failed')
        error.stderr = '错误: 系统找不到指定的注册表项或文件。'
        throw error
      }
      const lines = ['HKEY_CURRENT_USER\\Software\\BytedAuthClient\\keychain\\dreamina']
      for (const [name, value] of store) lines.push(`    ${name}    REG_SZ    ${value}`)
      return { stdout: `${lines.join('\r\n')}\r\n` }
    }
    if (op === 'add') {
      store.set(args[args.indexOf('/v') + 1], args[args.indexOf('/d') + 1])
      return { stdout: '操作成功完成。' }
    }
    if (op === 'delete') {
      store.delete(args[args.indexOf('/v') + 1])
      return { stdout: '操作成功完成。' }
    }
    throw new Error(`unexpected reg call: ${args.join(' ')}`)
  }
  return { runner, store, calls }
}

test('parseUserCredit reads the real output', () => {
  assert.deepEqual(parseUserCredit(USER_CREDIT), {
    userId: '854784705060587',
    userName: '',
    vipLevel: 'maestro',
    credit: 12531,
  })
})

test('parseUserCredit keeps 15+ digit ids exact and tolerates noise', () => {
  // 9007199254740993 is not representable as a double: textual extraction matters.
  const parsed = parseUserCredit('noise before {"total_credit": 1, "user_id": 9007199254740993}')
  assert.equal(parsed.userId, '9007199254740993')
  assert.equal(parseUserCredit('未检测到有效登录态'), undefined)
})

test('parseDeviceAuthOutput reads the headless device-flow material', () => {
  const material = parseDeviceAuthOutput(DEVICE_AUTH)
  assert.equal(material.deviceCode, '6c09ace3f1f8d38a31b8575ed137d355')
  assert.equal(material.userCode, '1db286381183168da017481452406068')
  assert.match(material.verificationUri, /^https:\/\/jimeng\.jianying\.com\//)
  assert.equal(material.pollInterval, '1s')
  assert.equal(material.expiresAt, '2026-10-06T01:03:30+08:00')
  assert.equal(parseDeviceAuthOutput('已复用当前本地 OAuth 登录态。'), undefined)
  assert.equal(isReusedLoginOutput('已复用当前本地 OAuth 登录态。'), true)
  assert.equal(isReusedLoginOutput(DEVICE_AUTH), false)
})

test('account names are path-safe and predictable', () => {
  for (const ok of ['chrome', 'previous-854784705060587', 'a.b_c-d', 'a1', 'ISUN', 'wsstudio']) assert.ok(ACCOUNT_NAME_RE.test(ok), ok)
  for (const bad of ['has space', '../escape', '', '-lead', 'a'.repeat(33)]) assert.equal(ACCOUNT_NAME_RE.test(bad), false, bad)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acct-'))
  try {
    assert.throws(() => accountDir(dir, '../escape'), /非法账号名/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('display names keep capitalisation but resolve case-insensitively', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acct-'))
  try {
    const identity = { userId: '960342070926412', userName: '', vipLevel: 'maestro', credit: 6948 }
    await saveAccount(dir, { name: 'ISUN', valueName: PRIMARY_VALUE_NAME, value: BLOB_A, identity, source: 'login' })
    // The directory is lower-cased (unambiguous on Windows), the display name is not.
    assert.equal(readFileSync(join(accountsRoot(dir), 'isun', 'token.txt'), 'utf8'), BLOB_A)
    for (const lookup of ['ISUN', 'isun', 'IsUn']) {
      assert.equal((await readAccountMeta(dir, lookup)).name, 'ISUN', lookup)
      assert.equal(await readAccountToken(dir, lookup), BLOB_A, lookup)
    }
    assert.deepEqual((await listAccounts(dir)).map((a) => a.name), ['ISUN'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renameAccount moves directory, metadata and the default pointer together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acct-'))
  try {
    const identity = { userId: '960342070926412', userName: '', vipLevel: 'maestro', credit: 6948 }
    await saveAccount(dir, { name: 'chrome', valueName: PRIMARY_VALUE_NAME, value: BLOB_A, identity, source: 'login' })
    await saveAccount(dir, { name: 'previous-1', valueName: PRIMARY_VALUE_NAME, value: BLOB_B, identity: { ...identity, userId: '1' }, source: 'current' })
    await writeDefaultAccount(dir, 'chrome')

    const renamed = await renameAccount(dir, 'chrome', 'ISUN')
    assert.equal(renamed.name, 'ISUN')
    assert.equal(renamed.fingerprint, tokenFingerprint(BLOB_A))
    // default pointer follows the rename
    assert.equal(await readDefaultAccount(dir), 'ISUN')
    // old name is gone, blob moved intact
    assert.equal(await readAccountMeta(dir, 'chrome'), undefined)
    assert.equal(await readAccountToken(dir, 'ISUN'), BLOB_A)
    assert.deepEqual((await listAccounts(dir)).map((a) => a.name).sort(), ['ISUN', 'previous-1'])

    // renaming onto an existing account is refused
    await assert.rejects(() => renameAccount(dir, 'ISUN', 'previous-1'), /已存在/)
    // renaming only the capitalisation is allowed (no directory move needed)
    const recapitalised = await renameAccount(dir, 'isun', 'Isun')
    assert.equal(recapitalised.name, 'Isun')
    assert.equal(await readDefaultAccount(dir), 'Isun')
    // unknown source account
    await assert.rejects(() => renameAccount(dir, 'ghost', 'other'), /不存在/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('accounts round-trip through the private account store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acct-'))
  try {
    const identity = { userId: '854784705060587', userName: '', vipLevel: 'maestro', credit: 12531 }
    const meta = await saveAccount(dir, { name: 'main', valueName: PRIMARY_VALUE_NAME, value: BLOB_A, identity, source: 'current' })
    assert.equal(meta.fingerprint, tokenFingerprint(BLOB_A))
    assert.equal(meta.userId, '854784705060587')

    // The stored material is the DPAPI blob verbatim, never a decoded secret.
    assert.equal(readFileSync(join(accountsRoot(dir), 'main', 'token.txt'), 'utf8'), BLOB_A)
    assert.equal(await readAccountToken(dir, 'main'), BLOB_A)
    assert.equal((await readAccountMeta(dir, 'main')).vipLevel, 'maestro')

    await saveAccount(dir, { name: 'second', valueName: PRIMARY_VALUE_NAME, value: BLOB_B, identity: { ...identity, userId: '2' }, source: 'login' })
    const names = (await listAccounts(dir)).map((a) => a.name).sort()
    assert.deepEqual(names, ['main', 'second'])

    assert.equal(await readDefaultAccount(dir), undefined)
    await writeDefaultAccount(dir, 'main')
    assert.equal(await readDefaultAccount(dir), 'main')
    await assert.rejects(() => writeDefaultAccount(dir, 'nope'), /不存在/)
    await clearDefaultAccount(dir)
    assert.equal(await readDefaultAccount(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

winTest('ensureActiveAccount is a no-op when no account is configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acct-'))
  try {
    const registry = fakeRegistry({ [PRIMARY_VALUE_NAME]: BLOB_A })
    const outcome = await ensureActiveAccount({ privateRoot: dir, runner: registry.runner })
    assert.deepEqual(outcome, { changed: false, reason: 'no-default-account' })
    // Nothing configured must mean no registry traffic at all.
    assert.equal(registry.calls.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

winTest('ensureActiveAccount leaves an already-active account alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acct-'))
  try {
    await saveAccount(dir, {
      name: 'chrome',
      valueName: PRIMARY_VALUE_NAME,
      value: BLOB_A,
      identity: { userId: '1', userName: '', vipLevel: 'maestro', credit: 10 },
      source: 'current',
    })
    await writeDefaultAccount(dir, 'chrome')
    const registry = fakeRegistry({ [PRIMARY_VALUE_NAME]: BLOB_A })
    const outcome = await ensureActiveAccount({ privateRoot: dir, runner: registry.runner })
    assert.equal(outcome.reason, 'already-active')
    assert.equal(outcome.changed, false)
    assert.ok(!registry.calls.some((c) => c[0] === 'add'), 'must not rewrite an identical login')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

winTest('ensureActiveAccount swaps the live login to the configured account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acct-'))
  try {
    await saveAccount(dir, {
      name: 'chrome',
      valueName: PRIMARY_VALUE_NAME,
      value: BLOB_A,
      identity: { userId: '111', userName: '', vipLevel: 'maestro', credit: 10 },
      source: 'current',
    })
    await saveAccount(dir, {
      name: 'default-edge',
      valueName: PRIMARY_VALUE_NAME,
      value: BLOB_B,
      identity: { userId: '222', userName: '', vipLevel: 'vip', credit: 20 },
      source: 'current',
    })
    await writeDefaultAccount(dir, 'chrome')

    const registry = fakeRegistry({ [PRIMARY_VALUE_NAME]: BLOB_B })
    const switches = []
    const outcome = await ensureActiveAccount({
      privateRoot: dir,
      runner: registry.runner,
      onSwitch: (info) => switches.push(info),
    })
    // 账号库里没有画布侧 blob 时 `canvasSwitched` 为 false（迁移前捕获的旧账号）
    assert.deepEqual(outcome, { changed: true, account: 'chrome', userId: '111', reason: 'switched', canvasSwitched: false })
    assert.equal(registry.store.get(PRIMARY_VALUE_NAME), BLOB_A)
    assert.deepEqual(switches, [{ account: 'chrome', from: tokenFingerprint(BLOB_B), to: tokenFingerprint(BLOB_A) }])

    // Second run: now idempotent.
    const again = await ensureActiveAccount({ privateRoot: dir, runner: registry.runner })
    assert.equal(again.reason, 'already-active')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

winTest('ensureActiveAccount refuses a configured account that is not in the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acct-'))
  try {
    const registry = fakeRegistry({ [PRIMARY_VALUE_NAME]: BLOB_A })
    await assert.rejects(
      () => ensureActiveAccount({ privateRoot: dir, configuredAccount: 'ghost', runner: registry.runner }),
      /不在账号库中/,
    )
    // A broken config must fail before any registry write.
    assert.ok(!registry.calls.some((c) => c[0] === 'add'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

winTest('readActiveKeychain reports the live fingerprint without leaking the blob', async () => {
  const registry = fakeRegistry({ [PRIMARY_VALUE_NAME]: BLOB_A })
  const live = await readActiveKeychain(registry.runner)
  assert.equal(live.valueName, PRIMARY_VALUE_NAME)
  assert.equal(live.fingerprint, tokenFingerprint(BLOB_A))
  assert.equal(live.value, BLOB_A)
  const empty = await readActiveKeychain(fakeRegistry().runner)
  assert.equal(empty.fingerprint, undefined)
})
