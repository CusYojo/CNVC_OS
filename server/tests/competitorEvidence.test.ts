import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyCompetitorEvidence, type CompetitorEvidenceRow } from '../../cybernaut-assistant/src/lib/competitor-evidence.js'
import { filterEvidenceBackedCompetitors } from '../src/services/competitorEvidence.js'

const directCompetitor: CompetitorEvidenceRow = {
  name: '精密视觉科技',
  is_self: false,
  tech: '工业视觉检测',
  product: '面向锂电产线的缺陷检测系统',
  funding: '',
  differentiation: '均服务锂电产线质量检测',
  matchType: 'direct',
  sameTargetUser: true,
  sameUseCase: true,
  sameDeliverable: true,
  comparisonBasis: '面向相同锂电客户交付同类在线缺陷检测系统',
  evidence: '精密视觉科技向锂电池厂商提供在线缺陷检测系统，与本项目争夺同类产线订单。',
  sourceRef: '项目访谈纪要.md',
  sourceUrl: '/knowledge/project-interview',
  confidence: 0.92,
}

test('accepts only a project-level competitor backed by exact input evidence', () => {
  const corpus = `信息来源：项目访谈纪要.md｜/knowledge/project-interview\n${directCompetitor.evidence}`
  const result = verifyCompetitorEvidence([directCompetitor], corpus, 'project')

  assert.equal(result.length, 1)
  assert.equal(result[0].verificationStatus, 'evidence-backed')
})

test('rejects a same-industry company without direct competition evidence', () => {
  const sameIndustry = {
    ...directCompetitor,
    name: '通用机器人集团',
    comparisonBasis: '都属于人工智能和机器人行业',
    evidence: '精密视觉科技向锂电池厂商提供在线缺陷检测系统。',
  }
  const result = verifyCompetitorEvidence(
    [sameIndustry],
    `信息来源：项目访谈纪要.md｜/knowledge/project-interview\n${sameIndustry.evidence}`,
    'project',
  )

  assert.deepEqual(result, [])
})

test('rejects legacy competitors without an evidence-backed marker from public output', () => {
  const result = filterEvidenceBackedCompetitors([
    { name: '泛行业公司', is_self: false, sourceUrl: 'https://example.com' },
    { ...directCompetitor, verificationStatus: 'evidence-backed' },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0].name, '精密视觉科技')
})
