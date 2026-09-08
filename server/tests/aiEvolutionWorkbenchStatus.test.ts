import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyEvolutionWorkbenchStatus } from '../../src/components/ai-evolution/AiEvolutionPanel.js'

const proposal = (kind: 'experience' | 'skill' | 'code', status: string) => ({ status, spec: { kind } })
test('workbench categories use run and candidate evidence instead of proposal approval alone', () => {
  assert.equal(classifyEvolutionWorkbenchStatus(proposal('code', 'ready')), 'pending')
  assert.equal(classifyEvolutionWorkbenchStatus(proposal('code', 'approved'), { runStatus: 'executing' }), 'running')
  assert.equal(classifyEvolutionWorkbenchStatus(proposal('code', 'approved'), { candidateStatus: 'active' }), 'active')
  assert.equal(classifyEvolutionWorkbenchStatus(proposal('skill', 'approved'), { candidateStatus: 'rolled_back' }), 'history')
  assert.equal(classifyEvolutionWorkbenchStatus(proposal('code', 'approved'), { runStatus: 'failed' }), 'history')
  assert.equal(classifyEvolutionWorkbenchStatus(proposal('experience', 'approved')), 'active')
})
