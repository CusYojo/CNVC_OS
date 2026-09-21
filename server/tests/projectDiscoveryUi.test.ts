import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('project center exposes the imported discovery workspace without rewriting the lead pool', async () => {
  const [center, discovery, sourcing] = await Promise.all([
    read('src/pages/ProjectCenterPage.tsx'),
    read('src/pages/ProjectDiscoveryPage.tsx'),
    read('src/pages/SourcingPage.tsx'),
  ])

  assert.match(center, /id: 'discover', label: '新项目发现'/)
  assert.match(center, /view === 'discover' \? <ProjectDiscoveryPage \/>/)
  assert.match(discovery, /<h1>新项目发现<\/h1>/)
  assert.match(discovery, /今天新发现/)
  assert.match(discovery, /近 7 天/)
  assert.doesNotMatch(discovery, /label: '全部'/, '发现页不应将首页候选误标为全量')
  assert.match(discovery, /navigate\(`\/sourcing\/\$\{lead\.id\}`/)
  assert.doesNotMatch(discovery, /convertLead\(/, '发现页应先进入证据详情，不得绕过原转换流程')
  assert.match(sourcing, /<h1>共享线索池<\/h1>/, '原线索池仍需独立保留')
})
