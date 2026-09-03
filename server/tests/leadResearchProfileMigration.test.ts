import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('research profile migration has isolated read projection and safe relationships', async () => {
  const sql = await readFile(new URL('../drizzle/0095_add_lead_research_profile_projections.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE `sbl_lead_research_profile_projections`/)
  assert.match(sql, /FOREIGN KEY \(`lead_id`\).*ON DELETE CASCADE/)
  assert.match(sql, /FOREIGN KEY \(`snapshot_id`\).*ON DELETE SET NULL/)
  assert.doesNotMatch(sql, /financing|valuation|customer/i)
})

test('research projection is joined into the list DTO and investment fields stay separate', async () => {
  const source = await readFile(new URL('../src/services/aiSummaryService.ts', import.meta.url), 'utf8')
  assert.match(source, /leadResearchProfileProjections/)
  assert.match(source, /researchProfile:/)
  assert.match(source, /enriched\.leadType === 'research'/)
})
