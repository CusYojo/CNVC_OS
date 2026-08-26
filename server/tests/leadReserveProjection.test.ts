import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeLeadScoringWithRetainedSources,
  project36KrLeadDetail,
} from '../src/services/leadReserveProjection.js'

test('projects the complete 36Kr detail into source-labeled lead fields', () => {
  const sourceUrl = 'https://pitchhub.36kr.com/project/123'
  const projected = project36KrLeadDetail({
    name: '测试项目',
    intro: '这是一段完整项目简介，不能退化为一句话摘要。',
    oneWord: '一句话摘要',
    corpWebUrl: 'example.com',
    logo: 'https://img.example.com/logo.png',
    companyName: '测试项目有限公司',
    provinceName: '浙江省',
    setupDate: 1_704_067_200_000,
    currentFinancing: { name: '天使轮' },
    industryList: [{ name: '企业服务' }],
    business: {
      name: '测试项目有限公司',
      legalPersonName: '张三',
      regLocation: '杭州市西湖区',
      shareholder: [{ name: '张三', percent: '60%', amomon: '60万元' }],
    },
    teamList: [{ name: '李四', profile: 'CTO', experience: '负责产品研发', faceUrl: 'https://img.example.com/li.jpg' }],
    financingList: [{ roundTxt: '天使轮', amount: '1000万元', date: '2024-01', investorList: [{ name: '测试资本' }] }],
  }, sourceUrl)

  assert.equal(projected.introduction, '这是一段完整项目简介，不能退化为一句话摘要。')
  assert.equal(projected.sourceLabeledProfile.projectIntroduction.value, projected.introduction)
  assert.equal(projected.structuredTeam[0]?.sourceUrl, sourceUrl)
  assert.equal(projected.structuredTeam[0]?.profileUrl, 'https://img.example.com/li.jpg')
  assert.equal(projected.structuredShareholders[0]?.percentage, '60%')
  assert.equal(projected.structuredShareholders[0]?.sourceUrl, sourceUrl)
  assert.equal(projected.fundingRounds[0]?.investors, '测试资本')
  assert.equal(projected.registryEvidence.every((item) => item.sourceUrl === sourceUrl), true)
})

test('scoring merge keeps source-owned facts when the AI snapshot omits or empties them', () => {
  const current = {
    scoreJob: { status: 'running' },
    officialSite: 'https://example.com/',
    sourceLabeledProfile: { projectIntroduction: { value: '来源原文', sourceUrl: 'https://source.example/' } },
    structuredTeam: [{ name: '李四', title: 'CTO', sourceUrl: 'https://source.example/', evidenceStatus: 'source_labeled' }],
    structuredShareholders: [{ name: '张三', percentage: '60%', sourceUrl: 'https://source.example/' }],
    registryEvidence: [{ field: 'companyName', value: '测试项目有限公司', sourceUrl: 'https://source.example/' }],
    dataQualityV1: { schemaVersion: 'lead-data-quality-v1' },
  }
  const merged = mergeLeadScoringWithRetainedSources(current, {
    total: 80,
    structuredTeam: [],
    structuredShareholders: [],
    registryEvidence: [],
    sourceLabeledProfile: {},
  }, { companyName: '测试项目有限公司' }, { preserveDataQuality: true })

  assert.equal((merged.structuredTeam as unknown[]).length, 1)
  assert.equal((merged.structuredShareholders as unknown[]).length, 1)
  assert.equal((merged.registryEvidence as unknown[]).length, 1)
  assert.equal((merged.sourceLabeledProfile as Record<string, any>).projectIntroduction.value, '来源原文')
  assert.equal(merged.officialSite, 'https://example.com/')
  assert.deepEqual(merged.scoreJob, { status: 'running' })
  assert.deepEqual(merged.dataQualityV1, { schemaVersion: 'lead-data-quality-v1' })
})
