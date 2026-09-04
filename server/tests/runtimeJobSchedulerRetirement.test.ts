import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('runtime scheduler retires and excludes jobs that no longer have an executor', async () => {
  const source = await readFile(new URL('../src/services/runtimeJobScheduler.ts', import.meta.url), 'utf8')
  assert.match(source, /retireUnknownRuntimeJobs\(definitions\)/)
  assert.match(source, /WHERE enabled=1 AND id NOT IN/)
  assert.match(source, /SELECT id FROM \$\{jobsTable\}[\s\S]*WHERE id IN \(\$\{ids\.map/)
  assert.match(source, /unknown_enabled_count/)
})

test('runtime scheduler health reports an idle overdue queue as unhealthy', async () => {
  const source = await readFile(new URL('../src/services/runtimeJobScheduler.ts', import.meta.url), 'utf8')
  assert.match(source, /overdue_count/)
  assert.match(source, /oldest_overdue_at/)
  assert.match(source, /overdue > 0 && active\.size === 0/)
})
