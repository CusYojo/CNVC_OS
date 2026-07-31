import assert from 'node:assert/strict'
import test from 'node:test'
import { readAcceptedAiSubjectReview } from '../src/services/aiSummaryService.js'

test('uses a verified AI company subject even when legacy rules reject the English name', () => {
  const result = readAcceptedAiSubjectReview({
    aiSubjectReview: {
      decision: 'accept',
      subjectType: 'company',
      subjectName: 'Nexus Data Centers',
      legalName: '',
      evidence: '数据中心开发商Nexus Data Centers正就AI数据中心项目筹集约150亿美元资金。',
      confidence: 0.97,
    },
  })

  assert.deepEqual(result, {
    subjectName: 'Nexus Data Centers',
    companyName: 'Nexus Data Centers',
  })
})

test('does not trust an AI subject without matching source evidence', () => {
  const result = readAcceptedAiSubjectReview({
    aiSubjectReview: {
      decision: 'accept',
      subjectType: 'company',
      subjectName: '虚构公司',
      evidence: '原文只提到了另一家公司。',
      confidence: 0.99,
    },
  })

  assert.equal(result, null)
})
