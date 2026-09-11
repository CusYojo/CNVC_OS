import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('permanent deletion migration persists one-time previews and minimal audit state', async () => {
  const [migration, journal, schema, routes] = await Promise.all([
    readFile(new URL('../drizzle/0113_add_admin_permanent_deletions.sql', import.meta.url), 'utf8'),
    readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/db/schema.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/systemAdministration.ts', import.meta.url), 'utf8'),
  ])
  assert.match(migration, /CREATE TABLE `sbl_admin_permanent_deletions`/)
  assert.match(migration, /UNIQUE KEY `uq_admin_permanent_deletion_token`/)
  assert.match(migration, /risk_confirmation_version/)
  assert.doesNotMatch(migration, /risk_text|article_body|business_content/)
  assert.match(journal, /"tag": "0113_add_admin_permanent_deletions"/)
  assert.match(schema, /export const adminPermanentDeletions/)
  const guard = routes.indexOf('systemAdministrationRouter.use(requireSystemAdmin)')
  const endpoint = routes.indexOf("systemAdministrationRouter.get('/permanent-deletions/search'")
  assert.ok(guard >= 0 && endpoint > guard)
})
