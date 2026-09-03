import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

test('shared lead runtime uses V8 enrichment without lead scoring', () => {
  const contract = source('server/src/services/leadEnrichmentContract.ts')
  const enrichment = source('server/src/services/leadEnrichmentService.ts')
  const postCommit = source('server/src/services/leadEnrichmentSnapshotPostCommit.ts')
  const serverEntry = source('server/src/index.ts')
  const routes = source('server/src/routes/meta.ts')
  const store = source('src/store/useAppStore.ts')
  const systemPage = source('src/pages/SystemPage.tsx')

  assert.match(contract, /LEAD_ENRICHMENT_SCHEMA_VERSION = 'lead-enrichment-v8-web-hit'/)
  assert.match(serverEntry, /startLeadEnrichmentWorker\(\)/)
  assert.match(serverEntry, /stopLeadEnrichmentWorker\(\)/)
  assert.doesNotMatch(serverEntry, /startLeadScoreJobWorker|stopLeadScoreJobWorker|leadScoreJobHealth|executeLeadScoring/)
  assert.doesNotMatch(enrichment, /enqueueRating|enqueueLeadScoreJob/)
  assert.doesNotMatch(postCommit, /rating_queue|enqueueRating|autoScoreEnqueued/)
  assert.match(routes, /post\('\/leads\/:id\/score', requireSystemAdmin[\s\S]*LEAD_SCORING_RETIRED/)
  assert.match(routes, /post\('\/leads\/:id\/score\/retry', requireSystemAdmin[\s\S]*LEAD_SCORING_RETIRED/)
  assert.match(routes, /get\('\/leads\/:id\/score'[\s\S]*LEAD_SCORING_RETIRED/)
  assert.match(routes, /const leadScoringRetired = \(\) => true/)
  assert.match(routes, /scheduleLeadScoring[\s\S]*if \(leadScoringRetired\(\)\) return false/)
  assert.match(routes, /executeLeadScoring[\s\S]*if \(leadScoringRetired\(\)\) return \{ status: 'discarded' \}/)
  const conversionRoute = routes.slice(routes.indexOf("metaRouter.post('/leads/:id/convert'"), routes.indexOf('// 简化的项目摘要查询'))
  assert.doesNotMatch(conversionRoute, /scheduleLeadScoring|enqueueLeadScoreJob/)
  assert.doesNotMatch(store, /startScoring|scoringLeadIds|\/leads\/\$\{leadId\}\/score/)
  assert.doesNotMatch(systemPage, /V3评分恢复|rating-recovery|ratingRestoreTarget/)
})

test('dedicated project scoring remains available', () => {
  const serverEntry = source('server/src/index.ts')
  assert.match(serverEntry, /startProjectScoreJobWorker\(executeProjectScoring\)/)
  assert.match(serverEntry, /stopProjectScoreJobWorker\(\)/)
})
