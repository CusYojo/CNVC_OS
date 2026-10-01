import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('prompt library has a separate forward-only MySQL table, migration, and startup guard', () => {
  const schema = readFileSync(new URL('../src/db/schema.ts', import.meta.url), 'utf8')
  const migration = readFileSync(new URL('../drizzle/0131_add_prompt_library_items.sql', import.meta.url), 'utf8')
  const categoryMigration = readFileSync(new URL('../drizzle/0132_add_prompt_library_category.sql', import.meta.url), 'utf8')
  const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ idx: number; tag: string }> }
  const migrate = readFileSync(new URL('../src/db/migrate.ts', import.meta.url), 'utf8')
  assert.match(schema, /export const promptLibraryItems = mysqlTable\('prompt_library_items'/)
  assert.match(migration, /CREATE TABLE `sbl_prompt_library_items`/)
  assert.match(migration, /`owner_user_id`.*NOT NULL/)
  assert.equal(journal.entries.find(entry => entry.tag === '0132_add_prompt_library_category')?.idx, 132)
  assert.match(schema, /category: varchar\('category'.*default\('general'\)/)
  assert.match(categoryMigration, /ALTER TABLE `sbl_prompt_library_items` ADD COLUMN `category` varchar\(32\) NOT NULL DEFAULT 'general'/)
  assert.match(migrate, /'prompt_library_items'/)
  assert.doesNotMatch(migration, /ai_capabilit/)
})

test('prompt library catalog query projects metadata without reading Markdown longtext', () => {
  const source = readFileSync(new URL('../src/repositories/mysql/mysqlPromptLibraryRepository.ts', import.meta.url), 'utf8')
  const catalogQuery = source.split('async listVisible(')[1]?.split('async findById(')[0] ?? ''
  assert.ok(catalogQuery)
  assert.doesNotMatch(catalogQuery, /db\.select\(\)/)
  assert.doesNotMatch(catalogQuery, /promptLibraryItems\.markdown/)
  assert.match(catalogQuery, /category: promptLibraryItems\.category/)
  assert.match(catalogQuery, /category \? eq\(promptLibraryItems\.category, category\)/)
})

test('prompt library writes audit and mutation in the same MySQL transaction', () => {
  const source = readFileSync(new URL('../src/repositories/mysql/mysqlPromptLibraryRepository.ts', import.meta.url), 'utf8')
  for (const method of ['createWithAudit', 'updateWithAudit', 'deleteWithAudit']) {
    const body = source.split(`async ${method}(`)[1]?.split('\n  },')[0] ?? ''
    assert.ok(body, `${method} must exist`)
    assert.match(body, /db\.transaction\(async \(tx\) =>/)
    assert.match(body, /tx\.insert\(auditLogs\)/)
  }
})
