import assert from 'node:assert/strict'
import test from 'node:test'
import { ADMIN_PERMANENT_DELETION_RISK_TEXT } from '../src/contracts/adminPermanentDeletionContract.js'
import { assertPermanentDeletionConfirmation, permanentDeletionImpactHash } from '../src/services/adminPermanentDeletionService.js'

test('permanent deletion confirmation requires exact name and exact risk text', () => {
  assert.doesNotThrow(() => assertPermanentDeletionConfirmation({
    currentName: '星语智能', resourceName: '星语智能', riskText: ADMIN_PERMANENT_DELETION_RISK_TEXT,
  }))
  assert.throws(() => assertPermanentDeletionConfirmation({
    currentName: '星语智能', resourceName: '星语智能 ', riskText: ADMIN_PERMANENT_DELETION_RISK_TEXT,
  }), { code: 'PERMANENT_DELETE_NAME_MISMATCH' })
  assert.throws(() => assertPermanentDeletionConfirmation({
    currentName: '星语智能', resourceName: '星语智能', riskText: `${ADMIN_PERMANENT_DELETION_RISK_TEXT} `,
  }), { code: 'PERMANENT_DELETE_RISK_TEXT_MISMATCH' })
})

test('impact hash is stable and changes with the deletion surface', () => {
  const left = permanentDeletionImpactHash({ relatedRecords: 3, files: 1, sharedFiles: 0 })
  const same = permanentDeletionImpactHash({ sharedFiles: 0, files: 1, relatedRecords: 3 })
  const changed = permanentDeletionImpactHash({ relatedRecords: 4, files: 1, sharedFiles: 0 })
  assert.equal(left, same)
  assert.notEqual(left, changed)
})
