import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function source(path: string) {
  return await readFile(new URL(`../../src/${path}`, import.meta.url), 'utf8')
}

test('project center retires the broad lead-pool tab but keeps discovery and review', async () => {
  const page = await source('pages/ProjectCenterPage.tsx')
  assert.doesNotMatch(page, /SourcingPage|id: 'leads'/)
  assert.match(page, /ProjectDiscoveryPage/)
  assert.match(page, /LeadReviewPanel/)
  assert.match(page, /view=discover|view: 'discover'/)
})

test('shared lead detail remains reachable and defaults back to discovery', async () => {
  const [app, detail, project, agent] = await Promise.all([
    source('App.tsx'), source('pages/LeadDetailPage.tsx'),
    source('pages/ProjectDetailPage.tsx'), source('lib/saiAgent.ts'),
  ])
  assert.match(app, /path="\/sourcing\/:id" element=\{<LeadDetailPage \/>\}/)
  assert.match(detail, /state\?\.from \|\| '\/projects\?view=discover'/)
  assert.match(project, /navigate\('\/projects\?view=discover'\)/)
  assert.doesNotMatch(agent, /params\.get\('view'\) === 'leads'/)
})
