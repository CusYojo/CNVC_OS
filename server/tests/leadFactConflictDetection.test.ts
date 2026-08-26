import assert from 'node:assert/strict'
import test from 'node:test'
import { detectLeadCandidateFactConflicts } from '../src/services/leadFactConflictDetectionService.js'

test('different values for one fact key become a host conflict and are not persisted as an array', () => {
  const result = detectLeadCandidateFactConflicts([
    { factKey: 'financing.amount', value: '1亿元', sourceUrls: ['https://a.example'] },
    { factKey: 'financing.amount', value: '2亿元', sourceUrls: ['https://b.example'] },
    { factKey: 'financing.round', value: 'A轮', sourceUrls: ['https://a.example'] },
  ])
  assert.deepEqual(result.facts.map((fact) => fact.factKey), ['financing.round'])
  assert.equal(result.conflicts.length, 1)
  assert.deepEqual(result.conflicts[0]?.values, ['1亿元', '2亿元'])
  assert.deepEqual(result.conflicts[0]?.sourceUrls, ['https://a.example', 'https://b.example'])
})

test('semantically identical object values remain non-conflicting', () => {
  const result = detectLeadCandidateFactConflicts([
    { factKey: 'profile.company', value: { name: '甲', status: '存续' }, sourceUrls: ['https://a.example'] },
    { factKey: 'profile.company', value: { status: '存续', name: '甲' }, sourceUrls: ['https://b.example'] },
  ])
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.facts.length, 2)
})

test('different repeatable instances coexist and only the same instance conflicts', () => {
  const result = detectLeadCandidateFactConflicts([
    { factKey: 'financing.amount', instanceKey: '2024 A轮', value: '1亿元', sourceUrls: ['https://a.example'] },
    { factKey: 'financing.amount', instanceKey: '2025 B轮', value: '2亿元', sourceUrls: ['https://b.example'] },
    { factKey: 'financing.amount', instanceKey: ' 2025  B轮 ', value: '3亿元', sourceUrls: ['https://c.example'] },
  ])
  assert.deepEqual(result.facts.map((fact) => fact.value), ['1亿元'])
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0]?.instanceKey, '2025 b轮')
  assert.deepEqual(result.conflicts[0]?.values, ['2亿元', '3亿元'])
})
