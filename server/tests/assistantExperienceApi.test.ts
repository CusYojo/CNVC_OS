import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('experience API scopes every operation to authenticated user and validates decisions', async () => {
  const route = await readFile(new URL('../src/routes/assistantExperiences.ts', import.meta.url), 'utf8')
  const index = await readFile(new URL('../src/routes/index.ts', import.meta.url), 'utf8')
  assert.match(index, /apiRouter\.use\('\/assistant-experiences', assistantExperiencesRouter\)/)
  assert.ok((route.match(/req\.user!\.uid/g) || []).length >= 7)
  assert.match(route, /action: z\.enum\(\['adopt', 'reject'\]\)/)
  assert.match(route, /idempotencyKey: uuid/)
  assert.match(route, /version: z\.number\(\)\.int\(\)\.positive\(\)/)
})
