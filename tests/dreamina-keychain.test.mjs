import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRIMARY_VALUE_NAME,
  parseRegQueryOutput,
  pickPrimaryValue,
  readKeychainValues,
  writeKeychainValue,
  KEYCHAIN_REG_PATH,
} from '../src/shared/dreamina-keychain.ts'

/**
 * Real `reg query` shape captured from the machine (Chinese locale, CRLF):
 *
 *     HKEY_CURRENT_USER\Software\BytedAuthClient\keychain\dreamina
 *         Ynl0ZWRfY2xpX3VzZXJfdG9rZW4    REG_SZ    AQAAANCMnd8BFdERjHoAwE/Cl+sB...
 */
const REAL_OUTPUT =
  '\r\nHKEY_CURRENT_USER\\Software\\BytedAuthClient\\keychain\\dreamina\r\n' +
  `    ${PRIMARY_VALUE_NAME}    REG_SZ    AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAAPlDZQ2312USw1e6br1Oh0g\r\n\r\n`

test('parseRegQueryOutput parses the real reg.exe output shape', () => {
  const values = parseRegQueryOutput(REAL_OUTPUT)
  assert.deepEqual(values, [
    {
      valueName: PRIMARY_VALUE_NAME,
      type: 'REG_SZ',
      value: 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAAPlDZQ2312USw1e6br1Oh0g',
    },
  ])
})

test('parseRegQueryOutput ignores the key line and tolerates default / empty values', () => {
  const stdout = [
    'HKEY_CURRENT_USER\\Software\\BytedAuthClient\\keychain\\dreamina',
    '    (Default)    REG_SZ    ',
    '    Counter    REG_DWORD    0x1',
    '    Named    REG_SZ    abc123',
    '',
  ].join('\n')
  const values = parseRegQueryOutput(stdout)
  assert.equal(values.length, 3)
  assert.deepEqual(values[0], { valueName: '(Default)', type: 'REG_SZ', value: '' })
  assert.deepEqual(values[1], { valueName: 'Counter', type: 'REG_DWORD', value: '0x1' })
  assert.deepEqual(values[2], { valueName: 'Named', type: 'REG_SZ', value: 'abc123' })
})

test('parseRegQueryOutput returns nothing for empty or unrelated output', () => {
  assert.deepEqual(parseRegQueryOutput(''), [])
  assert.deepEqual(parseRegQueryOutput('错误: 系统找不到指定的注册表项或文件。'), [])
})

test('pickPrimaryValue prefers the known CLI value name among REG_SZ entries', () => {
  const values = [
    { valueName: 'Counter', type: 'REG_DWORD', value: '0x1' },
    { valueName: 'OtherToken', type: 'REG_SZ', value: 'zzz' },
    { valueName: PRIMARY_VALUE_NAME, type: 'REG_SZ', value: 'blob' },
  ]
  assert.equal(pickPrimaryValue(values)?.value, 'blob')
  // A renamed store entry still round-trips instead of looking like "logged out".
  assert.equal(pickPrimaryValue([{ valueName: 'RenamedToken', type: 'REG_SZ', value: 'blob2' }])?.value, 'blob2')
  assert.equal(pickPrimaryValue([]), undefined)
  assert.equal(pickPrimaryValue([{ valueName: PRIMARY_VALUE_NAME, type: 'REG_SZ', value: '' }]), undefined)
})

test('readKeychainValues treats a missing key as "never logged in"', async () => {
  const runner = async () => {
    const error = new Error('reg failed')
    error.stderr = '错误: 系统找不到指定的注册表项或文件。'
    throw error
  }
  if (process.platform !== 'win32') return
  assert.deepEqual(await readKeychainValues(runner), [])
})

test('readKeychainValues surfaces unrelated registry failures', async () => {
  const runner = async () => {
    const error = new Error('reg failed')
    error.stderr = '错误: 拒绝访问。'
    throw error
  }
  if (process.platform !== 'win32') return
  await assert.rejects(() => readKeychainValues(runner), /读取 Dreamina 登录态/)
})

test('writeKeychainValue shells out to reg add and refuses junk values', async () => {
  const calls = []
  const runner = async (args) => {
    calls.push(args)
    return { stdout: '操作成功完成。' }
  }
  if (process.platform !== 'win32') return
  const blob = 'A'.repeat(64)
  await writeKeychainValue(PRIMARY_VALUE_NAME, blob, runner)
  assert.deepEqual(calls[0], ['add', KEYCHAIN_REG_PATH, '/v', PRIMARY_VALUE_NAME, '/t', 'REG_SZ', '/d', blob, '/f'])

  // A non-base64 / too-short value must never reach the registry: writing it
  // would corrupt the CLI login state (the CLI rejects a corrupt record).
  await assert.rejects(() => writeKeychainValue(PRIMARY_VALUE_NAME, 'not a blob!', runner), /非法|base64/)
  await assert.rejects(() => writeKeychainValue('bad name', blob, runner), /非法/)
  assert.equal(calls.length, 1)
})
