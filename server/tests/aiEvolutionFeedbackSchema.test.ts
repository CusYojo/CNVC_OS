import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('feedback migration binds one authorized subject and is registered last', async () => {
  const migration = await readFile(new URL('../drizzle/0109_add_ai_evolution_feedback.sql', import.meta.url), 'utf8')
  assert.match(migration, /CREATE TABLE `sbl_ai_evolution_feedback`/)
  assert.match(migration, /CHECK \(\(`candidate_id` IS NULL\) <> \(`application_id` IS NULL\)\)/)
  assert.match(migration, /UNIQUE KEY `uq_evo_feedback_request` \(`owner_user_id`, `idempotency_key`\)/)
  assert.match(migration, /FOREIGN KEY \(`candidate_id`\) REFERENCES `sbl_ai_evolution_candidates`/)
  assert.match(migration, /FOREIGN KEY \(`application_id`\) REFERENCES `sbl_ai_evolution_applications`/)
  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'))
  assert.deepEqual(journal.entries.find((item: { tag: string }) => item.tag === '0109_add_ai_evolution_feedback'),
    { idx: 109, version: '5', when: 1793087343000,
    tag: '0109_add_ai_evolution_feedback', breakpoints: true })
})
