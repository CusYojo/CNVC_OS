import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

test('selected desktop stage starts its outgoing rail at the card edge', async () => {
  const css = await source('../../src/pages/ProjectDetailPage.css')
  assert.match(css, /fde-detail-stage\[aria-pressed="true"\] \.fde-detail-stage-rail::after \{ left: 100%; \}/)
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*fde-detail-stage\[aria-pressed="true"\] \.fde-detail-stage-rail::after \{ left: 50%; \}/)
})

test('diligence plan approval exposes and presents the reviewed task arrangement', async () => {
  const [service, page, types] = await Promise.all([
    source('../src/services/oaWorkflowService.ts'),
    source('../../src/pages/WorkflowPage.tsx'),
    source('../../src/types/index.ts'),
  ])
  assert.match(service, /planReview/)
  assert.match(service, /projectPlanActions/)
  assert.match(service, /participants:/)
  assert.match(types, /planReview\?:/)
  assert.match(page, /selected\.type === '尽调计划审核'/)
  assert.match(page, />尽调任务安排</)
  assert.match(page, />负责人：/)
  assert.match(page, />参与：/)
  assert.match(page, />截止时间</)
})
