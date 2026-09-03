import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { projectListPath } from '../../src/services/projectListApi.js'

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('project list route exposes server-side scope and business filters', async () => {
  const source = await read('server/src/routes/projects.ts')
  assert.match(source, /scope:\s*z\.enum\(\['mine', 'all'\]\)/)
  assert.match(source, /industry:\s*z\.string\(\)\.optional\(\)/)
  assert.match(source, /risk:\s*z\.enum\(\['低', '中', '高'\]\)\.optional\(\)/)
})

test('project list service returns classification counts from database query', async () => {
  const source = await read('server/src/services/projectService.ts')
  assert.match(source, /groupBy\(projects\.classification\)/)
  assert.match(source, /counts:\s*classificationCounts/)
})

test('project center does not count or paginate the first 100 cached projects', async () => {
  const [center, list] = await Promise.all([
    read('src/pages/ProjectCenterPage.tsx'),
    read('src/pages/ProjectsPage.tsx'),
  ])
  assert.doesNotMatch(center, /projects\.filter\([\s\S]*?\.length/)
  assert.doesNotMatch(list, /filtered\.slice\(/)
  assert.match(list, /fetchProjectList\(/)
  assert.match(center, /classificationCounts/)
})

test('project list client sends every server-side pagination and filter parameter', () => {
  const path = projectListPath({
    page: 2, pageSize: 6, scope: 'mine', classification: 'normal', lifecycle: 'active',
    keyword: '新能源', stage: '尽调', industry: '新能源', owner: '陈斌', risk: '中',
  })
  const params = new URLSearchParams(path.split('?')[1])
  assert.deepEqual(Object.fromEntries(params), {
    page: '2', pageSize: '6', scope: 'mine', classification: 'normal', lifecycle: 'active',
    keyword: '新能源', stage: '尽调', industry: '新能源', owner: '陈斌', risk: '中',
  })
})
