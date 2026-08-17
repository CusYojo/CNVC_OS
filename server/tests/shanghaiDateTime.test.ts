import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatShanghaiDateKey,
  formatShanghaiDateTimeInput,
  parseShanghaiDate,
  parseShanghaiDateTime,
} from '../src/utils/shanghaiTime.js'
import {
  formatShanghaiDateTime,
  shanghaiDateKey,
  shanghaiDateTimeInputValue,
} from '../../src/lib/dateTime.js'

const UTC_INSTANT = new Date('2026-08-09T16:30:45.678Z')

test('UTC instant is rendered as the same Shanghai business date on server and client', () => {
  assert.equal(formatShanghaiDateKey(UTC_INSTANT), '2026-08-10')
  assert.equal(formatShanghaiDateTimeInput(UTC_INSTANT), '2026-08-10 00:30')
  assert.equal(shanghaiDateKey(UTC_INSTANT), '2026-08-10')
  assert.equal(shanghaiDateTimeInputValue(UTC_INSTANT), '2026-08-10 00:30')
  assert.match(formatShanghaiDateTime(UTC_INSTANT), /2026\/08\/10 00:30/)
})

test('Shanghai form values are converted to an unambiguous UTC instant', () => {
  assert.equal(parseShanghaiDateTime('2026-08-10 00:30').toISOString(), '2026-08-09T16:30:00.000Z')
  assert.equal(parseShanghaiDateTime('2026-08-10T00:30').toISOString(), '2026-08-09T16:30:00.000Z')
  assert.equal(parseShanghaiDate('2026-08-10').toISOString(), '2026-08-09T16:00:00.000Z')
})

test('invalid Shanghai calendar dates fail closed', () => {
  assert.throws(() => parseShanghaiDate('2026-02-30'), /日期格式无效/)
  assert.throws(() => parseShanghaiDateTime('2026-02-30 10:00'), /日期时间格式无效/)
  assert.throws(() => parseShanghaiDateTime('2026-08-10 24:01'), /日期时间格式无效/)
})

test('explicit Shanghai formatting does not depend on the process timezone', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'America/Los_Angeles'
    assert.equal(formatShanghaiDateKey(UTC_INSTANT), '2026-08-10')
    assert.equal(shanghaiDateKey(UTC_INSTANT), '2026-08-10')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
