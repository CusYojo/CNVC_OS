import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { approveNodeTransition } from '../src/contracts/approvalNodeTransition.js'
import { replanApprovalTodoClosure } from '../src/contracts/fdeProjectReplanApprovalContract.js'

type Todo = { requestId: string; nodeId: string; ownerId: string; done: boolean }
function close(todos: Todo[], closure: ReturnType<typeof replanApprovalTodoClosure>) {
  for (const row of todos) if (row.requestId === 'request' && !row.done && (closure.scope === 'request' || closure.ownerIds.includes(row.ownerId))) row.done = true
}
const cases = [
  { name: '或签 first person completes node', mode: '或签', actorId: 'a', approvedByUserIds: [], completed: true },
  { name: '或签 second person completes node', mode: '或签', actorId: 'b', approvedByUserIds: [], completed: true },
  { name: '会签 partial closes actor only', mode: '会签', actorId: 'a', approvedByUserIds: [], completed: false },
  { name: '会签 final closes entire node', mode: '会签', actorId: 'b', approvedByUserIds: ['a'], completed: true },
]
for (const row of cases) for (const nextPeople of [['c'], ['b', 'c'], ['a', 'b']]) test(`${row.name}; next node ${nextPeople.join('/')}`, () => {
  const transition = approveNodeTransition({ ...row, approverUserIds: ['a', 'b'], override: false })
  assert.equal(transition.completed, row.completed)
  const todos: Todo[] = ['a', 'b'].map(ownerId => ({ requestId: 'request', nodeId: 'old', ownerId, done: row.approvedByUserIds.includes(ownerId) }))
  todos.push({ requestId: 'other-request', nodeId: 'other', ownerId: row.actorId, done: false })
  const closure = replanApprovalTodoClosure({ requestStatus: '审批中', nodeCompleted: transition.completed, actorId: row.actorId, approverUserIds: ['a', 'b'] })
  assert.deepEqual(closure, { scope: 'owners', ownerIds: row.completed ? ['a', 'b'] : [row.actorId] })
  // Mirrors service ordering: finish old notices, then activate/create next.
  close(todos, closure)
  if (transition.completed) for (const ownerId of nextPeople) todos.push({ requestId: 'request', nodeId: 'next', ownerId, done: false })
  const open = todos.filter(t => t.requestId === 'request' && !t.done)
  assert.deepEqual(open.map(t => [t.nodeId, t.ownerId]), row.completed ? nextPeople.map(id => ['next', id]) : [['old', 'b']])
  for (const person of ['a', 'b', 'c']) assert.ok(open.filter(t => t.ownerId === person).length <= 1, 'same person has no leftover old-node todo')
  assert.equal(todos.find(t => t.requestId === 'other-request')!.done, false)
})
for (const status of ['已通过', '已拒绝', '已撤回']) test(`terminal ${status} closes all request notices only`, () => {
  const closure = replanApprovalTodoClosure({ requestStatus: status, nodeCompleted: status === '已通过', actorId: 'applicant', approverUserIds: ['a', 'b'] })
  assert.deepEqual(closure, { scope: 'request' })
  const todos = [{ requestId: 'request', nodeId: 'old', ownerId: 'a', done: false }, { requestId: 'request', nodeId: 'older', ownerId: 'b', done: false }, { requestId: 'other-request', nodeId: 'other', ownerId: 'a', done: false }]
  close(todos, closure); assert.deepEqual(todos.map(t => t.done), [true, true, false])
})
test('single-person 会签 and duplicate configured recipient IDs close one owner scope', () => {
  const transition = approveNodeTransition({ mode: '会签', approverUserIds: ['a'], approvedByUserIds: [], actorId: 'a' })
  assert.equal(transition.completed, true)
  assert.deepEqual(replanApprovalTodoClosure({ requestStatus: '审批中', nodeCompleted: true, actorId: 'a', approverUserIds: ['a', 'a'] }), { scope: 'owners', ownerIds: ['a'] })
})
test('cleanup cannot substitute for a valid current approval node or repeat approval', () => {
  for (const approverUserIds of [[], ['b']]) assert.throws(() => replanApprovalTodoClosure({ requestStatus: '审批中', nodeCompleted: true, actorId: 'a', approverUserIds }), /REPLAN_TODO_NODE_INVALID/)
  assert.throws(() => approveNodeTransition({ mode: '会签', approverUserIds: ['a', 'b'], approvedByUserIds: ['a'], actorId: 'a' }), /OA_ALREADY_APPROVED/)
})
test('service binds cleanup to node completion and closes before notifying the next node', () => {
  const source = readFileSync(new URL('../src/services/fdeProjectReplanService.ts', import.meta.url), 'utf8')
  assert.match(source, /nodeCompleted = transition\.completed/)
  assert.match(source, /replanApprovalTodoClosure\(\{ requestStatus: status, nodeCompleted, actorId: userId, approverUserIds: node\.approverUserIds \}\)/)
  const closure = source.indexOf('const closure = replanApprovalTodoClosure(')
  const closeTodos = source.indexOf("await tx.update(todos).set({ status: '已完成' })", closure)
  const notifyNext = source.indexOf('await notify(tx, request, next)', closure)
  assert.ok(closure >= 0 && closeTodos > closure && notifyNext > closeTodos)
  assert.match(source.slice(closeTodos, notifyNext), /inArray\(todos\.ownerUserId, closure\.ownerIds\)/)
})
