import test from 'node:test'
import assert from 'node:assert/strict'
import { responsibilityScanLimit, responsibilityScannerEnabled, responsibilityScannerErrorCode } from '../src/contracts/fdeResponsibilityScannerContract.js'

test('responsibility scanner requires explicit enablement and bounded batches', () => {
  for (const value of [undefined, '', 'false', '1', 'TRUE']) assert.equal(responsibilityScannerEnabled(value), false)
  assert.equal(responsibilityScannerEnabled('true'), true)
  for (const value of [0, -1, 101, 1.5, Infinity, '25']) assert.equal(responsibilityScanLimit.safeParse(value).success, false)
  assert.equal(responsibilityScanLimit.parse(100), 100)
})
test('scanner health and checkpoints never expose raw errors, SQL or credentials', () => {
  assert.equal(responsibilityScannerErrorCode({ code: 'RESP_POLICY_INTEGRITY' }), 'RESP_POLICY_INTEGRITY')
  for (const error of [null, new Error('private SQL'), { code: 'SELECT password FROM users' }, { code: 'X'.repeat(65) }, { code: 500 }]) assert.equal(responsibilityScannerErrorCode(error), 'RESP_SCAN_FAILED')
})
