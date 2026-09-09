import assert from 'node:assert/strict'
import test from 'node:test'
import { complianceRenderContractError } from '../src/services/complianceRenderContract.js'
import { safeAiTaskFailureMessage, safeAiTaskFailureStage } from '../src/services/aiTaskErrorService.js'

test('missing contract identifies wiring error without exposing content', () => {
  const payload = { title: 'PRIVATE_COMPANY', sections: [{ text: 'PRIVATE_FACT' }] }
  const before = JSON.stringify(payload)
  const error = complianceRenderContractError(payload)!
  assert.equal(error.code, 'COMPLIANCE_RENDER_CONTRACT_MISMATCH')
  assert.deepEqual(error.missingFields, ['public_verification', 'delivery_readiness', 'target_company.legal_name'])
  assert.equal(JSON.stringify(payload), before)
  assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE/)
  assert.equal(safeAiTaskFailureStage(error), '合规渲染契约不匹配')
  assert.match(safeAiTaskFailureMessage(error), /修复.*重试/)
})

test('preflight handles malformed fields but does not certify evidence or authorization', () => {
  assert.equal(complianceRenderContractError(null)?.missingFields.length, 3)
  assert.equal(complianceRenderContractError({ public_verification: [], delivery_readiness: false })?.missingFields.length, 3)
  // Only presence is checked here; empty records must still fail native validation.
  assert.equal(complianceRenderContractError({
    public_verification: {}, delivery_readiness: {}, target_company: { legal_name: 'Synthetic' },
  }), null)
})
