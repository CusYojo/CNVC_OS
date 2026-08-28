import assert from 'node:assert/strict'
import test from 'node:test'
import { dataKnowledgeCapabilities, dataKnowledgeSelection } from '../src/contracts/fdeDataKnowledgeContract.js'

const coordinator = { company: true, archives: false, upload: false, input: false, meetings: false, uploadProjectIds: [] }
test('data knowledge: reject implicit grants, invalid capability payloads and unknown links', () => {
  assert.equal(dataKnowledgeCapabilities.safeParse({ ...coordinator, archives: 'true' }).success, false)
  assert.equal(dataKnowledgeCapabilities.safeParse({ ...coordinator, secret: 'hidden' }).success, false)
  assert.equal(dataKnowledgeSelection(coordinator, 'archives', null).allowed, false)
  assert.equal(dataKnowledgeSelection(coordinator, 'unknown', null).allowed, false)
  assert.equal(dataKnowledgeSelection(coordinator, null, null).view, 'company')
})
test('data knowledge: eligible empty archive can read but cannot use upload/input links', () => {
  const empty = { ...coordinator, archives: true, meetings: true }
  assert.equal(dataKnowledgeSelection(empty, 'archives', null).allowed, true)
  assert.equal(dataKnowledgeSelection(empty, 'archives', 'upload').allowed, false)
  assert.equal(dataKnowledgeSelection(empty, 'archives', 'input').allowed, false)
  assert.equal(dataKnowledgeSelection(empty, 'archives', 'meetings').allowed, true)
  assert.equal(dataKnowledgeSelection(empty, 'archives', 'unknown').allowed, false)
})
test('data knowledge: legacy archive-only identity is not forced into company knowledge', () => {
  const legacy = { ...coordinator, company: false, archives: true, meetings: true, upload: true, input: true }
  assert.deepEqual(dataKnowledgeSelection(legacy, null, null), { view: 'archives', tool: null, allowed: true })
  assert.equal(dataKnowledgeSelection(legacy, 'company', null).allowed, false)
  assert.equal(dataKnowledgeSelection(legacy, 'archives', 'upload').allowed, true)
})
