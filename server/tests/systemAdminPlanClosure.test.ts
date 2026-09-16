import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { presentFdePlanReadiness } from '../../src/lib/fdePlanReadinessPresentation.js'

const workflowSource = () => readFile(new URL('../src/services/fdeWorkflowService.ts', import.meta.url), 'utf8')

test('admin plan editing uses the shared enabled-admin identity', async () => {
  const source = await workflowSource()
  assert.match(source, /isEnabledSystemAdmin/)
  assert.match(source, /if \(await isEnabledSystemAdmin\(tx, userId\)\) return actor/)
  assert.match(source, /canEditDraftPlan/)
})

test('workflow exposes backend-computed plan review readiness', async () => {
  const source = await workflowSource()
  assert.match(source, /planReadiness/)
  assert.match(source, /validForReview/)
  assert.match(source, /inspectPlanReadiness/)
  assert.match(source, /validateFdePlan/)
})

test('plan formulation stays blocked until the backend reports a valid plan', () => {
  assert.deepEqual(
    presentFdePlanReadiness({ stage: '尽调计划制定', loaded: true, validForReview: false, reason: '尚未配置有效倒排计划' }),
    { required: true, blocked: true, label: '尚未配置有效倒排计划', action: 'configure' },
  )
  assert.equal(presentFdePlanReadiness({ stage: '尽调计划制定', loaded: true, validForReview: true, reason: '计划已配置，可提交审核' }).blocked, false)
  assert.equal(presentFdePlanReadiness({ stage: '尽调计划制定', loaded: false, validForReview: false, reason: '' }).blocked, true)
  assert.equal(presentFdePlanReadiness({ stage: '尽调', loaded: true, validForReview: false, reason: '' }).required, false)
})

test('workflow panel renders the plan blocker and direct configuration route', async () => {
  const panel = await readFile(new URL('../../src/components/FdeWorkflowPanel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /presentFdePlanReadiness/)
  assert.match(panel, /planReadiness\.label/)
  assert.match(panel, /\?tab=tasks/)
  assert.doesNotMatch(panel, /const planRequired = \['尽调计划审核'/)
})
