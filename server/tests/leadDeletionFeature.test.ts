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

test('Sourcing detail exposes a two-step lead deletion flow to administrators', async () => {
  const page = await source('../../src/pages/SourcingPage.tsx')

  assert.match(page, /canDeleteLead/)
  assert.match(page, />\s*删除线索\s*</)
  assert.match(page, /title="确认删除线索"/)
  assert.match(page, /apiDelete\(\`\/leads\/\$\{lead\.id\}\`\)/)
  assert.match(page, /原始审计证据及已转成的专属项目仍会保留/)
})
