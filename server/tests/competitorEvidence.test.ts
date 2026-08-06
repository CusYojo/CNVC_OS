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

test('accepts a short brand name when the exact name appears in evidence', () => {
  const shortBrand = {
    ...directCompetitor,
    name: '宇树',
    evidence: '宇树面向机器人客户提供具身智能机器人产品，与本项目争夺同类采购订单。',
  }
  const corpus = `信息来源：项目访谈纪要.md｜/knowledge/project-interview\n${shortBrand.evidence}`
  const result = verifyCompetitorEvidence([shortBrand], corpus, 'project')

  assert.equal(result.length, 1)
  assert.equal(result[0].name, '宇树')
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

test('rejects competitors with only industry-level comparison basis', () => {
  const result = filterEvidenceBackedCompetitors([
    { name: '泛行业公司', is_self: false, sourceUrl: 'https://example.com',
      comparisonBasis: '同属AI芯片行业', evidence: '该公司也从事AI芯片相关业务。', sourceRef: '行业报告' },
    { name: '精密视觉科技', ...directCompetitor, verificationStatus: 'evidence-backed' },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0].name, '精密视觉科技')
})

test('rejects historical competitors without evidence text', () => {
  const result = filterEvidenceBackedCompetitors([
    { name: '空壳竞对', is_self: false, tech: 'AI 视觉',
      comparisonBasis: '', evidence: '', sourceRef: '' },
    { ...directCompetitor, verificationStatus: 'evidence-backed' },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0].name, '精密视觉科技')
})

test('keeps historical competitor with substantial comparison basis and evidence', () => {
  const result = filterEvidenceBackedCompetitors([
    { name: '有效历史竞对', is_self: false,
      comparisonBasis: '均服务锂电产线客户，提供在线缺陷检测系统，争夺同类产线订单',
      evidence: '该公司向锂电池厂商提供在线缺陷检测系统。',
      sourceRef: '访谈纪要.md',
      confidence: 0.85 },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0].name, '有效历史竞对')
})
