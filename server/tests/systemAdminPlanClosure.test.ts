import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

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
