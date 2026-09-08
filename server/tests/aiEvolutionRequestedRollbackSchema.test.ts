import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('requested rollback migration binds one rollback to its verified source release', async () => {
  const migration = await readFile(new URL('../drizzle/0110_add_ai_evolution_requested_rollback.sql', import.meta.url), 'utf8')
  assert.match(migration, /ADD COLUMN `operation` varchar\(16\) NOT NULL DEFAULT 'release'/)
  assert.match(migration, /FOREIGN KEY \(`source_release_job_id`\) REFERENCES `sbl_ai_evolution_release_jobs`/)
  assert.match(migration, /UNIQUE KEY `uq_evo_release_job_rollback_source` \(`source_release_job_id`\)/)
  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'))
  assert.deepEqual(journal.entries.at(-1), { idx: 110, version: '5', when: 1793173743000,
    tag: '0110_add_ai_evolution_requested_rollback', breakpoints: true })
})
