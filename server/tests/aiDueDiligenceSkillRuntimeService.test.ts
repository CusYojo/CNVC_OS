import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { normalizeDueDiligencePackage } from '../src/services/aiDueDiligenceSkillRuntimeService.js'

const execFileAsync = promisify(execFile)
const evidence = {
  project: {
    name: '测试项目', legal_entity: '测试科技有限公司', cutoff_date: '2026-08-07', currency: 'CNY',
  },
  facts: [{
    id: 'F001', source_index: 0, statement: '测试科技有限公司已公开披露公司、团队、产品及客户信息。',
    entity: '测试科技有限公司', period: '2026-08-07', unit: '不适用',
    source: 'https://example.test/company', source_type: 'public_authoritative',
    status: 'public_fact', materiality: 'low', conflicts: [], as_of_date: '2026-08-07',
    intended_use: '尽调字段、正文事实与投资判断',
  }],
}

function field(sourceGrade: string, data: Record<string, unknown>) {
  return {
    status: 'verified',
    sourceGrade,
    evidenceIds: ['F001'],
    data,
  }
}

test('尽调运行时将模型常见键名归一为原生审计器契约', async () => {
  const normalized = normalizeDueDiligencePackage({
    generated: {
      reportMode: 'screening_public',
      diligenceData: {
        fieldMap: {
          'entity.basic_registry': field('official', {
            legal_name: '测试科技有限公司', unified_social_credit_code: '91110000TEST',
            incorporation_date: '2025-01-01', registered_capital: '1000万元',
            legal_representative: '张三', registered_address: '北京市', business_scope: '软件开发',
          }),
          'ownership.public_ownership': field('official', {
            rows: [{ shareholder: '张三', ownership_pct: '100%' }],
          }),
          'team.core_people': field('official', {
            rows: [
              { name: '张三', role: '创始人', resume: '负责产品与经营', employment_status: '全职' },
              { name: '李四', role: '技术负责人', resume: '负责研发', employment_status: '全职' },
            ],
          }),
          'product.product_matrix': field('official', {
            rows: [{
              product: '测试产品', buyer: '企业客户', pricing: '项目制', delivery: '软件交付',
              maturity: '已发布', evidence: '官网产品页',
            }],
          }),
          'business.public_customer_cases': field('official', {
            rows: [
              { customer: '客户甲', date: '2026-01', deliverable: '软件系统', source: '客户公告' },
              { customer: '客户乙', date: '2026-02', deliverable: '软件系统', source: '公司官网' },
            ],
          }),
          'market.competitor_matrix': field('official', {
            rows: [
              { competitor: '公司甲', product: '产品甲', customer: '企业', pricing: '项目制', strength: '渠道', weakness: '交付周期' },
              { competitor: '公司乙', product: '产品乙', customer: '企业', pricing: '订阅制', strength: '标准化', weakness: '定制能力' },
              { competitor: '公司丙', product: '产品丙', customer: '企业', pricing: '项目制', strength: '产品线', weakness: '价格' },
            ],
          }),
          'legal.public_compliance': field('official', {
            rows: [
              { matter: '主体存续', finding: '正常', source: '登记信息' },
              { matter: '行政处罚', finding: '未见公开记录', source: '监管公示' },
              { matter: '司法风险', finding: '未见公开记录', source: '公开裁判记录' },
            ],
          }),
          'decision.recommendation': field('model', {
            action: 'defer', rationale: '继续观察客户转化', conditions: ['补充订单验证'],
            walk_away_triggers: ['核心团队发生重大变化'],
          }),
        },
      },
      report: {
        meta: { report_title: '错误标题', template_profile: 'deta_v5_up_to_ic' },
        blocks: [
          { type: 'heading', level: 1, text: '公司与股权' },
          {
            type: 'table', title: '公司基本情况', semanticRole: 'company-profile',
            dataFieldIds: ['entity.basic_registry'], columns: ['项目', '内容'],
            rows: [['公司名称', '测试科技有限公司']], evidenceIds: ['F001'],
          },
        ],
      },
    },
    project: { name: '测试项目', companyName: '测试科技有限公司' },
    evidence,
    sourceCutoffDate: '2026-08-07',
    desiredMode: 'screening_public',
  })

  const fields = normalized.diligenceData.fields as Array<Record<string, unknown>>
  assert.equal(fields.length, 8)
  assert.equal(fields[0].status, 'supported')
  assert.equal(fields[0].source_grade, 'public_authoritative')
  assert.deepEqual(fields[0].evidence_ids, ['F001'])
  const reportMeta = normalized.report.meta as Record<string, unknown>
  assert.equal(reportMeta.report_title, '尽职调查报告')
  assert.equal(reportMeta.report_type, 'screening')
  assert.equal('template_profile' in reportMeta, false)
  const blocks = normalized.report.blocks as Array<Record<string, unknown>>
  assert.deepEqual(blocks[1].headers, ['项目', '内容'])
  assert.equal(blocks[1].nature, 'fact')
  assert.equal(blocks[1].semantic_role, 'company_key_facts')
  assert.deepEqual(blocks[1].data_field_ids, ['entity.basic_registry'])

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dd-runtime-test-'))
  const dataPath = path.join(temporary, 'diligence-data.json')
  const reportPath = path.join(temporary, 'report.json')
  const evidencePath = path.join(temporary, 'evidence.json')
  await Promise.all([
    writeFile(dataPath, JSON.stringify(normalized.diligenceData)),
    writeFile(reportPath, JSON.stringify(normalized.report)),
    writeFile(evidencePath, JSON.stringify(evidence)),
  ])
  const scripts = path.resolve(
    process.cwd(), 'server', 'workspace', '.agents', 'skills', 'write-investment-dd-report', 'scripts',
  )
  await execFileAsync('python3', [
    path.join(scripts, 'audit_ic_completeness.py'), dataPath,
    '--report', reportPath, '--evidence', evidencePath,
  ])
  await execFileAsync('python3', [
    path.join(scripts, 'audit_report_content.py'), reportPath, '--evidence', evidencePath,
  ])
})
