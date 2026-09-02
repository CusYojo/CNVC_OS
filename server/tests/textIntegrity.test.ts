import assert from 'node:assert/strict'
import test from 'node:test'
import {
  inspectBusinessText,
  normalizeTextPayload,
  safeVisibleText,
} from '../src/contracts/textIntegrityContract.js'
import { sanitizeTextPayloadForDisplay } from '../src/services/textQualityService.js'

test('correct Chinese text is normalized without changing its meaning', () => {
  const result = normalizeTextPayload({ title: '项目立项', reason: '资料核验完成，可以推进。' })
  assert.equal(result.issue, undefined)
  assert.deepEqual(result.value, { title: '项目立项', reason: '资料核验完成，可以推进。' })
})

test('damaged form text is found recursively before it reaches persistence', () => {
  const result = normalizeTextPayload({ request: { reason: '资料���无法读取' } })
  assert.deepEqual(result.issue, { path: '$.request.reason', reason: 'replacement-character' })
})

test('opaque byte and credential fields are never rewritten', () => {
  const payload = { dataBase64: '77+977+9', apiKey: 'sk-Ã-test', title: '项目资料' }
  const result = normalizeTextPayload(payload)
  assert.equal(result.issue, undefined)
  assert.deepEqual(result.value, payload)
})

test('legacy damaged values are removed from business responses', () => {
  const result = sanitizeTextPayloadForDisplay({ reason: '������', nested: [{ comment: '正常意见' }] })
  assert.equal(result.reason, '')
  assert.equal(result.nested[0].comment, '正常意见')
  assert.equal(safeVisibleText('������'), '')
})

test('typical UTF-8 mojibake and control characters are rejected', () => {
  assert.equal(inspectBusinessText('FranÃ§ais').corrupted, true)
  assert.equal(inspectBusinessText('正常\u0000内容').corrupted, true)
})
