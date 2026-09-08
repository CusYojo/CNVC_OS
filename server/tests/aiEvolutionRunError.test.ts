import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evolutionRunError } from '../src/runtime/evolution/evolutionRunError.js'

test('run errors distinguish actionable causes without forwarding private error text', () => {
  const codes = ['EVOLUTION_SOURCE_FORBIDDEN', 'EVOLUTION_PATCH_BASELINE', 'EVOLUTION_BUDGET_EXCEEDED',
    'EVOLUTION_ENVIRONMENT_UNAVAILABLE', 'EVOLUTION_REPAIR_BUDGET_EXHAUSTED', 'EVOLUTION_NEEDS_INPUT']
  const results = codes.map(code => evolutionRunError({ code, message: 'private-provider-token' }))
  assert.equal(new Set(results.map(result => result.message)).size, codes.length)
  results.forEach((result, index) => {
    assert.equal(result.code, codes[index])
    assert.equal(JSON.stringify(result).includes('private-provider-token'), false)
  })
  for (const error of [null, 'private-provider-token', { code: 'private-provider-token' }, { code: 'EVOLUTION_' + 'A'.repeat(1000) }]) {
    assert.equal(evolutionRunError(error).code, 'EVOLUTION_EXECUTION_FAILED')
  }
})
