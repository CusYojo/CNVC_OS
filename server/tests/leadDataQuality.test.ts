import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deterministicLeadStageReview,
  publicLeadStageDisplay,
} from '../src/services/leadDataQualityService.js'

test('source-labeled unfinanced has a concise public label while preserving evidence status', () => {
  const result = deterministicLeadStageReview({ rawStage: '未融资' })
  assert.equal(result.funding.stageDisplay, '未融资')
  assert.equal(result.funding.evidenceStatus, 'source_labeled')
  assert.equal(result.businessStage.stageDisplay, '待核验')
})

test('standard financing round is kept separate from business stage', () => {
  const result = deterministicLeadStageReview({ rawStage: 'Pre-A' })
  assert.equal(result.funding.stageDisplay, 'Pre-A轮')
  assert.equal(result.businessStage.stageDisplay, '待核验')
})

test('standard financing round normalizes internal plus spacing before deterministic review', () => {
  const result = deterministicLeadStageReview({ rawStage: '天使 ++ 轮' })
  assert.equal(result.funding.stageDisplay, '天使++轮')
  assert.equal(result.funding.evidenceStatus, 'source_labeled')
  assert.equal(result.requiresModel, false)
})

test('historical round is not mislabeled as the current round', () => {
  const result = deterministicLeadStageReview({ rawStage: '历史B轮（2022年），当前阶段待核验' })
  assert.equal(result.funding.stageDisplay, '历史B轮，当前轮次待核验')
})

test('research output does not receive company financing semantics', () => {
  const result = deterministicLeadStageReview({ rawStage: '科研成果', isResearch: true })
  assert.equal(result.funding.stageDisplay, '不适用')
  assert.equal(result.businessStage.stageDisplay, '科研成果')
})

test('public display reads a valid persisted Codex review first', () => {
  const result = publicLeadStageDisplay({
    fallbackStage: '未融资；研发、试点或商业化阶段待核验',
    dataQuality: {
      schemaVersion: 'lead-data-quality-v1',
      method: 'codex-semantic-normalization-v1',
      model: 'gpt-5.6-sol',
      reviewedAt: '2026-08-25T00:00:00.000Z',
      sourceStage: '未融资',
      funding: { stageDisplay: '未融资（来源标注）', evidenceStatus: 'source_labeled' },
      businessStage: { stageDisplay: '待核验', evidenceStatus: 'unverified' },
      reason: '来源仅标注未融资。',
    },
  })
  assert.equal(result.fundingStage, '未融资')
  assert.equal(result.businessStage, '待核验')
})
