import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('startup read-only schema check requires every evolution table only when the feature is enabled', async () => {
  const source = await readFile('server/src/db/migrate.ts', 'utf8')
  for (const table of [
    'ai_evolution_proposals', 'ai_evolution_runs', 'ai_evolution_events', 'ai_evolution_audits',
    'ai_evolution_model_calls', 'ai_evolution_candidates', 'ai_evolution_evaluations', 'ai_evolution_approvals',
    'ai_experiences', 'ai_experience_versions', 'ai_evolution_applications', 'ai_evolution_skill_versions',
    'ai_evolution_skill_bindings', 'ai_evolution_skill_binding_changes', 'ai_evolution_skill_applications',
    'ai_evolution_release_jobs', 'ai_evolution_feedback',
  ]) assert.match(source, new RegExp(`'${table}'`))
  assert.match(source, /process\.env\.AI_EVOLUTION_ENABLED === 'true'[\s\S]*AI_EVOLUTION_RUNTIME_TABLES/)
  assert.match(source, /requiredTables\.map\(mysqlTableName\)/)
})
