import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('0091候选库迁移、Schema和运行时必需表保持一致', () => {
  const journal = JSON.parse(read('../drizzle/meta/_journal.json')) as { entries: Array<{ idx: number; tag: string }> }
  assert.deepEqual(journal.entries.at(-1), {
    idx: 91, version: '5', when: 1791445743000,
    tag: '0091_add_lead_source_candidates', breakpoints: true,
  })
  const migration = read('../drizzle/0091_add_lead_source_candidates.sql')
  assert.match(migration, /CREATE TABLE `sbl_lead_source_candidates`/)
  assert.match(migration, /UNIQUE KEY `uq_lead_source_candidates_source` \(`source_type`,`source_project_id_hash`\)/)
  assert.match(migration, /FOREIGN KEY \(`raw_event_id`\) REFERENCES `sbl_lead_pipeline_raw_events`/)
  assert.match(migration, /FOREIGN KEY \(`admitted_lead_id`\) REFERENCES `sbl_leads`/)
  assert.match(migration, /'registration_ineligible'/)
  assert.match(read('../src/db/schema.ts'), /mysqlTable\('lead_source_candidates'/)
  assert.match(read('../src/db/migrate.ts'), /'lead_source_candidates'/)
})
