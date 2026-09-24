import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { projectAdvancePath } from '../../src/lib/projectDetailPresentation.js'

const detailPage = () => readFile(new URL('../../src/pages/ProjectDetailPage.tsx', import.meta.url), 'utf8')

test('project advance opens the selected project on the actionable approval board', () => {
  assert.equal(projectAdvancePath('project-1'), '/workflow?view=board&project=project-1')
  assert.equal(projectAdvancePath('project 1', 'approval-2'), '/workflow?view=board&project=project+1&request=approval-2')
})

test('project hero uses the approval route instead of reselecting the already active tab', async () => {
  const source = await detailPage()
  assert.match(source, /onPrimary=\{\(\) => project\.lifecycle === 'active' \? navigate\(projectAdvancePath\(project\.id/)
  assert.doesNotMatch(source, /onPrimary=\{\(\) => project\.lifecycle === 'active' \? setActiveTab\('workflow'\)/)
})

test('an empty effective-stage timeline explains that approval is required', async () => {
  const source = await detailPage()
  assert.match(source, /暂无已生效的阶段变更/)
  assert.match(source, /审批通过后会显示在这里/)
})
