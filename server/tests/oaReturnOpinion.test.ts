import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { oaActionSchema } from '../src/contracts/oaWorkflowActionContract.js'
import { officeAction } from '../src/contracts/fdeOfficeContract.js'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('returning a project approval requires a meaningful opinion', () => {
  assert.equal(oaActionSchema.safeParse({ action: 'return', comment: '补充', expectedVersion: 1 }).success, false)
  assert.equal(oaActionSchema.safeParse({ action: 'return', comment: '请补充财务依据', expectedVersion: 1 }).success, true)
  assert.equal(oaActionSchema.safeParse({ action: 'approve', comment: '同意', expectedVersion: 1 }).success, true)
  assert.equal(officeAction.safeParse({ clientRequestId: crypto.randomUUID(), action: 'return', reason: '补充', expectedVersion: 1 }).success, false)
})

test('project approval presents a dedicated return dialog and hides timeline sync diagnostics', () => {
  const workflow = read('src/pages/WorkflowPage.tsx')
  const tasks = read('src/components/FdeTaskPanel.tsx')
  assert.match(workflow, /title="退回申请"/)
  assert.match(workflow, /退回意见至少填写 5 个字/)
  assert.match(workflow, /void act\('return', returnComment\)/)
  assert.doesNotMatch(workflow, /useState\('资料核验范围清楚，同意进入下一节点。'\)/)
  assert.doesNotMatch(tasks, /流程行动待联动/)
  assert.doesNotMatch(tasks, /请补齐日期或负责人/)
})
