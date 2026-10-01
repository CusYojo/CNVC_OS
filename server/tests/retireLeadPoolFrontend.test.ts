import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function source(path: string) {
  return await readFile(new URL(`../../src/${path}`, import.meta.url), 'utf8')
}

test('project center keeps review as an icon and redirects discovery to its workspace', async () => {
  const [page, app] = await Promise.all([source('pages/ProjectCenterPage.tsx'), source('App.tsx')])
  assert.doesNotMatch(page, /SourcingPage|id: 'leads'/)
  assert.match(page, /LeadReviewPanel/)
  assert.match(page, /aria-label="打开待复核"/)
  assert.match(page, /legacyView === 'discover'/)
  assert.match(app, /path="\/discovery" element=\{<ProjectDiscoveryPage \/>\}/)
})

test('shared lead detail remains reachable and defaults back to discovery', async () => {
  const [app, detail, project, agent] = await Promise.all([
    source('App.tsx'), source('pages/LeadDetailPage.tsx'),
    source('pages/ProjectDetailPage.tsx'), source('lib/saiAgent.ts'),
  ])
  assert.match(app, /path="\/sourcing\/:id" element=\{<LeadDetailPage \/>\}/)
  assert.match(detail, /state\?\.from \|\| '\/discovery'/)
  assert.match(project, /navigate\('\/discovery'\)/)
  assert.doesNotMatch(agent, /params\.get\('view'\) === 'leads'/)
})
