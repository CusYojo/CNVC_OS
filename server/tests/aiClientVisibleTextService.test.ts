import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeClientVisibleEvidenceWording } from '../src/services/aiClientVisibleTextService.js'

test('客户可见正文不展示内部证据状态标签', () => {
  assert.equal(
    sanitizeClientVisibleEvidenceWording('【待核验】本轮估值待核验。'),
    '本轮估值尚需进一步确认。',
  )
  assert.equal(
    sanitizeClientVisibleEvidenceWording('待核验事项：需要待核验客户合同。'),
    '尚需进一步确认客户合同。',
  )
  assert.equal(
    sanitizeClientVisibleEvidenceWording('【资料记载】公司已完成产品交付。'),
    '公司已完成产品交付。',
  )
})
