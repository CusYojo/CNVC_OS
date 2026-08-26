import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function source(relativeUrl: string) {
  return await readFile(new URL(relativeUrl, import.meta.url), 'utf8')
}

test('public lead deletion is admin-only, audited, and implemented as a hidden status', async () => {
  const [service, routes] = await Promise.all([
    source('../src/services/aiSummaryService.ts'),
    source('../src/routes/meta.ts'),
  ])

  assert.match(service, /poolStatus:\s*'已删除'/)
  assert.match(service, /leads\.poolStatus\}\s*=\s*'已删除'/)
  assert.match(service, /action:\s*'删除公共线索'/)
  assert.match(service, /delete\(leadScoreJobs\)/)
  assert.match(routes, /metaRouter\.delete\('\/leads\/:id', requireSystemAdmin/)
})

test('the dedicated lead detail page exposes a two-step deletion flow to administrators', async () => {
  const page = await source('../../src/pages/LeadDetailPage.tsx')

  assert.match(page, /currentUser\?\.role === '系统管理员'/)
  assert.match(page, />\s*删除线索\s*</)
  assert.match(page, /title="删除共享线索"/)
  assert.match(page, /apiDelete<[^\n]+>\(\`\/leads\/\$\{lead\.id\}\`\)/)
  assert.match(page, /历史导入记录、审计记录及已转化的专属项目会继续保留/)
})
