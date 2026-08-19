import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldOpenLeadAgentCircuit } from '../src/services/leadAgentRuntimeGuardService.js'

test('consecutive failures only open the circuit after same-profile work settles', () => {
  assert.equal(shouldOpenLeadAgentCircuit(1, ['failed', 'failed'], 2), false)
  assert.equal(shouldOpenLeadAgentCircuit(0, ['failed', 'failed'], 2), true)
  assert.equal(shouldOpenLeadAgentCircuit(0, ['succeeded', 'failed'], 2), false)
  assert.equal(shouldOpenLeadAgentCircuit(0, ['failed'], 2), false)
})
