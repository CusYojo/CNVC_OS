import assert from 'node:assert/strict'
import test from 'node:test'
import { officeLeaveDays, officeLeaveType } from '../src/contracts/fdeOfficeContract.js'

test('请假类型不把余额展示文字存入业务值', () => {
  assert.equal(officeLeaveType('年假'), '年假')
  assert.equal(officeLeaveType('年假（剩余 10 天）'), '年假')
  assert.equal(officeLeaveType('年假（剩余 6.5 天）'), '年假')
})

test('请假自然时长按 24 小时换算天数', () => {
  assert.equal(officeLeaveDays('96'), 4)
  assert.equal(officeLeaveDays(undefined), 0)
})
