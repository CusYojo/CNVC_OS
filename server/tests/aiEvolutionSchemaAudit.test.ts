import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyAiEvolutionSchema, type EvolutionSchemaShape } from '../src/scripts/aiEvolutionSchemaAudit.js'

const expected: EvolutionSchemaShape = {
  ai_evolution_runs: { id: 'varchar', budget: 'json', lease_token: 'int' },
}

test('evolution schema audit distinguishes compatible, repairable and blocked remnants', () => {
  assert.equal(classifyAiEvolutionSchema(expected, {
    ai_evolution_runs: { id: 'varchar', budget: 'json', lease_token: 'int' },
  }).status, 'compatible')
  assert.deepEqual(classifyAiEvolutionSchema(expected, {}).missingTables, ['ai_evolution_runs'])
  assert.equal(classifyAiEvolutionSchema(expected, {
    ai_evolution_runs: { id: 'varchar', budget: 'json' },
  }).status, 'repairable')
  assert.equal(classifyAiEvolutionSchema(expected, {
    ai_evolution_runs: { id: 'varchar', budget: 'text', lease_token: 'int' },
  }).status, 'blocked')
})

