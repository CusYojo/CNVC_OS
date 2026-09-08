import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('release jobs migration is durable, leased and registered after its dependencies', async () => {
  const migration = await readFile(new URL('../drizzle/0107_add_ai_evolution_release_jobs.sql', import.meta.url), 'utf8')
  assert.match(migration, /CREATE TABLE `sbl_ai_evolution_release_jobs`/)
  assert.match(migration, /UNIQUE KEY `uq_evo_release_job_request` \(`actor_user_id`, `idempotency_key`\)/)
  assert.match(migration, /UNIQUE KEY `uq_evo_release_job_approval` \(`approval_id`\)/)
  assert.match(migration, /KEY `idx_evo_release_job_lease` \(`status`, `lease_expires_at`\)/)
  assert.match(migration, /FOREIGN KEY \(`candidate_id`\) REFERENCES `sbl_ai_evolution_candidates`/)
  assert.match(migration, /FOREIGN KEY \(`approval_id`\) REFERENCES `sbl_ai_evolution_approvals`/)
  assert.match(migration, /`receipt` json NULL/)
  assert.match(migration, /`lease_token` int NOT NULL DEFAULT 0/)

  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  assert.deepEqual(journal.entries.at(-1), { idx: 107, version: '5', when: 1792828143000,
    tag: '0107_add_ai_evolution_release_jobs', breakpoints: true })
})
