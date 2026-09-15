import assert from 'node:assert/strict'
import test from 'node:test'
import { requireOaApprovalNodes } from '../src/contracts/oaApprovalNodeContract.js'

test('OA approval requests require at least one business approval node', () => {
  assert.equal(requireOaApprovalNodes([{ id: 'node-1' }])[0].id, 'node-1')
  let error: (Error & { status?: number; code?: string }) | undefined
  try {
    requireOaApprovalNodes([])
  } catch (caught) {
    error = caught as Error & { status?: number; code?: string }
  }
  assert.ok(error)
  assert.equal(error.status, 409)
  assert.equal(error.code, 'OA_APPROVAL_NODES_REQUIRED')
})
