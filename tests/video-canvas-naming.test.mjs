/**
 * 画布命名约定测试（用户 2026-11-05 定）：
 * - 推荐模板「项目名_文件名」，但只是推荐、不做格式校验（短名/空格/自定义都放行）；
 * - Agent 侧给名后由工具补 `YYYYMMDD-` 日期前缀；
 * - 名字已带日期前缀时原样保留，不重复加日期。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { datedVideoGroup } from '../src/tool-video-gen.ts'

const NOW = new Date(2026, 10, 5, 16, 34, 0) // 2026-11-05 本地时间

test('补日期前缀：推荐模板（项目名_文件名）→ YYYYMMDD-', () => {
  assert.equal(datedVideoGroup('华发珠海湾_双十一MG广告', NOW), '20261105-华发珠海湾_双十一MG广告')
  assert.equal(datedVideoGroup('金茂璞逸云湖_一周年家书', NOW), '20261105-金茂璞逸云湖_一周年家书')
})

test('日期前缀跨月/跨年按本地日期补零', () => {
  assert.equal(datedVideoGroup('x', new Date(2026, 0, 9)), '20260109-x')
  assert.equal(datedVideoGroup('x', new Date(2026, 11, 31)), '20261231-x')
})

test('已带日期不重复加（YYYYMMDD / YYYY-MM-DD / YYYY_MM_DD）', () => {
  for (const name of [
    '20261105-华发珠海湾_双十一MG广告',
    '2026-11-05-华发珠海湾_双十一MG广告',
    '2026_11_05-华发珠海湾_双十一MG广告',
  ]) {
    assert.equal(datedVideoGroup(name, NOW), name)
  }
})

test('模板只是推荐：短名 / 空格 / 纯自定义都放行（不做格式校验）', () => {
  assert.equal(datedVideoGroup('xmt', NOW), '20261105-xmt')
  assert.equal(datedVideoGroup('中环 双十一', NOW), '20261105-中环 双十一')
  assert.equal(datedVideoGroup('随便起的名字', NOW), '20261105-随便起的名字')
  // 首尾空白会被裁剪，名字正文不动
  assert.equal(datedVideoGroup('  华发珠海湾_双十一MG广告  ', NOW), '20261105-华发珠海湾_双十一MG广告')
})

test('长度边界：1-40 字符单行', () => {
  const forty = '名'.repeat(40)
  assert.equal(datedVideoGroup(forty, NOW), `20261105-${forty}`)
  assert.throws(() => datedVideoGroup('名'.repeat(41), NOW), /1-40 characters/)
  assert.throws(() => datedVideoGroup('', NOW), /1-40 characters/)
  assert.throws(() => datedVideoGroup('   ', NOW), /1-40 characters/)
  assert.throws(() => datedVideoGroup('a\nb', NOW), /1-40 characters/)
})
