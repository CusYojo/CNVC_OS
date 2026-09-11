import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  ADMIN_PERMANENT_DELETION_RISK_TEXT,
  permanentDeletionExecuteSchema,
} from '../src/contracts/adminPermanentDeletionContract.js'

test('permanent deletion requires the exact fixed risk statement', () => {
  const base = {
    resourceType: 'lead',
    resourceId: randomUUID(),
    previewToken: randomUUID(),
    resourceName: '星语智能',
  }
  assert.equal(permanentDeletionExecuteSchema.safeParse({
    ...base,
    riskText: `${ADMIN_PERMANENT_DELETION_RISK_TEXT} `,
  }).success, false)
  assert.equal(permanentDeletionExecuteSchema.safeParse({
    ...base,
    riskText: ADMIN_PERMANENT_DELETION_RISK_TEXT,
  }).success, true)
})
