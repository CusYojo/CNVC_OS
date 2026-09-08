import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('0112 creates the conversation experience memory schema', async () => {
  const sql = await readFile(new URL('../drizzle/0112_add_assistant_experience_memory.sql', import.meta.url), 'utf8')
  const journal = await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')
  const schema = await readFile(new URL('../src/db/schema.ts', import.meta.url), 'utf8')
  for (const name of ['assistant_experience_settings', 'assistant_experience_candidates', 'assistant_experiences', 'assistant_experience_decisions']) {
    assert.ok(sql.includes(`CREATE TABLE \`sbl_${name}\``))
  }
  assert.match(sql, /`auto_summary_enabled` boolean NOT NULL DEFAULT true/)
  assert.match(journal, /"tag": "0112_add_assistant_experience_memory"/)
  assert.match(schema, /assistantExperienceSettings/)
})
