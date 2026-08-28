import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { knowledgeDefinition, knowledgeSave, knowledgeQuery, knowledgeRatingCommand, safeKnowledgeLink } from '../src/contracts/fdeKnowledgeContract.js'

const value = () => ({ kind: '方法论', title: '核对证据', summary: '人工确认后的知识摘要', link: '', audience: 'selected', readerIds: [], editorIds: [], fileId: null, fileVersion: null })
test('knowledge links accept only explicit HTTP(S) without credentials; no implicit fetch', () => {
  for (const link of ['javascript:alert(1)', 'data:text/html,test', '//example.com', 'file:///tmp/test', 'https://user:pass@example.com']) assert.equal(safeKnowledgeLink(link), null)
  assert.equal(safeKnowledgeLink('https://example.com/a'), 'https://example.com/a')
  assert.equal(safeKnowledgeLink(''), '')
})
test('knowledge definitions require explicit scope, stable identities and paired versions', () => {
  const member = randomUUID()
  assert.deepEqual(knowledgeDefinition.parse({ ...value(), readerIds: [member, member] }).readerIds, [member])
  for (const patch of [{ audience: undefined }, { fileId: randomUUID() }, { fileVersion: 1 }, { editorIds: ['姓名'] }, { authorId: randomUUID() }, { summary: ' ' }]) assert.equal(knowledgeDefinition.safeParse({ ...value(), ...patch }).success, false)
})
test('knowledge saves reject injected lifecycle and stale-format versions; bounded search and scores', () => {
  const payload = { clientRequestId: randomUUID(), expectedVersion: 0, definition: value() }
  assert.ok(knowledgeSave.safeParse(payload).success)
  assert.equal(knowledgeSave.safeParse({ ...payload, status: 'published' }).success, false)
  assert.equal(knowledgeSave.safeParse({ ...payload, expectedVersion: '1' }).success, false)
  assert.equal(knowledgeQuery.safeParse({ pageSize: 500 }).success, false)
  for (const score of [2, 3, 4, 5, null]) assert.ok(knowledgeRatingCommand.safeParse({ clientRequestId: randomUUID(), expectedVersion: 1, score }).success)
  for (const score of [1, 6, 3.5, '5']) assert.equal(knowledgeRatingCommand.safeParse({ clientRequestId: randomUUID(), expectedVersion: 1, score }).success, false)
})
