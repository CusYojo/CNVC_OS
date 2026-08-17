import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateDumpTargetEvolution } from '../src/scripts/postgresDumpReconciliationPolicy.js'

const exact = {
  sourceMissingInTarget: 0,
  targetOnlyRows: 0,
  changedSourceRows: 0,
  changedColumns: [],
}

test('accepts an exact dump and target baseline', () => {
  assert.equal(evaluateDumpTargetEvolution('projects', exact, {
    sourceOrphanNormalizationReady: false,
  }).approved, true)
})

test('rejects a source row missing from the target', () => {
  assert.equal(evaluateDumpTargetEvolution('projects', {
    ...exact, sourceMissingInTarget: 1,
  }, { sourceOrphanNormalizationReady: true }).approved, false)
})

test('allows only explicitly approved target-only rows and changed columns', () => {
  assert.equal(evaluateDumpTargetEvolution('audit_logs', {
    ...exact, targetOnlyRows: 2,
  }, { sourceOrphanNormalizationReady: true }).approved, true)
  assert.equal(evaluateDumpTargetEvolution('projects', {
    ...exact, targetOnlyRows: 1,
  }, { sourceOrphanNormalizationReady: true }).approved, false)
  assert.equal(evaluateDumpTargetEvolution('users', {
    ...exact, changedSourceRows: 1, changedColumns: ['password_hash'],
  }, { sourceOrphanNormalizationReady: true }).approved, true)
  assert.equal(evaluateDumpTargetEvolution('users', {
    ...exact, changedSourceRows: 1, changedColumns: ['name'],
  }, { sourceOrphanNormalizationReady: true }).approved, false)
})

test('requires the durable orphan normalization ledger for AI conversation changes', () => {
  const difference = {
    ...exact, changedSourceRows: 4, changedColumns: ['conversation_id'],
  }
  assert.equal(evaluateDumpTargetEvolution('ai_tasks', difference, {
    sourceOrphanNormalizationReady: false,
  }).approved, false)
  assert.equal(evaluateDumpTargetEvolution('ai_tasks', difference, {
    sourceOrphanNormalizationReady: true,
  }).approved, true)
})

test('requires the durable legacy scope ledger for chat conversation changes', () => {
  const difference = {
    ...exact, changedSourceRows: 1, changedColumns: ['scope'],
  }
  assert.equal(evaluateDumpTargetEvolution('chat_conversations', difference, {
    sourceOrphanNormalizationReady: true,
    legacyConversationScopeNormalizationReady: false,
  }).approved, false)
  assert.equal(evaluateDumpTargetEvolution('chat_conversations', difference, {
    sourceOrphanNormalizationReady: true,
    legacyConversationScopeNormalizationReady: true,
  }).approved, true)
  assert.equal(evaluateDumpTargetEvolution('chat_conversations', {
    ...difference, changedColumns: ['title'],
  }, {
    sourceOrphanNormalizationReady: true,
    legacyConversationScopeNormalizationReady: true,
  }).approved, false)
})

test('requires the durable missing-file ledger for AI artifact quarantine changes', () => {
  const difference = {
    ...exact, changedSourceRows: 7, changedColumns: ['conversation_id', 'quality_status', 'archived'],
  }
  assert.equal(evaluateDumpTargetEvolution('ai_artifacts', difference, {
    sourceOrphanNormalizationReady: true,
    missingFileAssetQuarantineReady: false,
  }).approved, false)
  assert.equal(evaluateDumpTargetEvolution('ai_artifacts', difference, {
    sourceOrphanNormalizationReady: false,
    missingFileAssetQuarantineReady: true,
  }).approved, false)
  assert.equal(evaluateDumpTargetEvolution('ai_artifacts', difference, {
    sourceOrphanNormalizationReady: true,
    missingFileAssetQuarantineReady: true,
  }).approved, true)
})

test('requires the durable legacy-scoring ledger for lead and project scoring changes', () => {
  const difference = {
    ...exact, changedSourceRows: 3, changedColumns: ['scoring'],
  }
  for (const table of ['leads', 'projects']) {
    assert.equal(evaluateDumpTargetEvolution(table, difference, {
      sourceOrphanNormalizationReady: true,
      legacyScoringReady: false,
    }).approved, false)
    assert.equal(evaluateDumpTargetEvolution(table, difference, {
      sourceOrphanNormalizationReady: true,
      legacyScoringReady: true,
    }).approved, true)
  }
})
