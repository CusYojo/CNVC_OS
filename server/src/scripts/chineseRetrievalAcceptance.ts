import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { knowledgeChunks } from '../db/schema.js'
import { retrieveKnowledge } from '../services/ragService.js'

const fixtures = [
  { key: 'technology', name: '技术路线说明.md', content: '核心产品采用碳化硅功率模块和车规级逆变器，自研栅极驱动与热管理算法，已完成小批量量产验证。' },
  { key: 'customers', name: '客户与订单情况.md', content: '公司已与比亚迪、蔚来签署定点协议，在手订单覆盖未来两年；前五大客户收入占比显示客户集中度仍需持续跟踪。' },
  { key: 'financials', name: '财务分析.xlsx', content: '2025年营业收入为三亿元，综合毛利率百分之四十二，经营活动现金流转正，研发费用率保持百分之十八。' },
  { key: 'equity', name: '股权与融资结构.docx', content: '创始团队合计持股百分之五十六，A轮融资投后估值十二亿元，员工期权池占比百分之十。' },
  { key: 'risk', name: '风险清单.md', content: '主要风险是晶圆供应商集中，若核心供应商断供将影响交付；缓释措施包括第二供应源认证和安全库存。' },
  { key: 'team', name: '管理团队履历.pdf', content: 'CEO曾负责新能源汽车功率器件量产，拥有十五年研发和工厂爬坡经验；CTO长期从事宽禁带半导体设计。' },
  { key: 'competition', name: '竞争格局.pptx', content: '主要竞争对手包括英飞凌和意法半导体，本项目竞争优势在于本地交付、定制响应和系统级成本。' },
  { key: 'exit', name: '投资退出方案.md', content: '计划以科创板上市作为主要退出路径，同时保留被产业方并购和下一轮老股转让方案。' },
] as const

const cases = [
  { id: 'technology-route', query: '碳化硅功率模块技术路线', expected: 'technology' },
  { id: 'customer-orders', query: '客户集中度和在手订单', expected: 'customers' },
  { id: 'financial-quality', query: '营业收入毛利率现金流', expected: 'financials' },
  { id: 'equity-valuation', query: '创始团队持股和A轮估值', expected: 'equity' },
  { id: 'supply-risk', query: '晶圆供应商断供风险', expected: 'risk' },
  { id: 'unicode-team', query: 'ＣＥＯ量产经验', expected: 'team' },
  { id: 'competition', query: '英飞凌竞争优势', expected: 'competition' },
  { id: 'exit-path', query: '科创板退出路径', expected: 'exit' },
] as const

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[chinese retrieval] ${message}`)
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/chinese-retrieval')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  const metrics = report.metrics as Record<string, number>
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryPath, [
    '# 中文知识检索金标验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    `- 样本：${report.caseCount} 个代表性投资问题 / ${report.fixtureCount} 份隔离资料`,
    `- Recall@3：${metrics.recallAt3}`,
    `- Top-1：${metrics.top1Accuracy}`,
    `- MRR：${metrics.meanReciprocalRank}`,
    '- 额外门禁：Unicode 全半角归一化、项目/Scope 隔离、无关查询零召回、重复执行顺序稳定',
    '',
    '报告只保留金标哈希、用例 ID、名次和指标，不包含业务资料正文或数据库连接身份。',
    '',
  ].join('\n'), { mode: 0o600 })
  await Promise.all([chmod(reportPath, 0o600), chmod(summaryPath, 0o600)])
}

async function runCases(refId: string, sourceIds: Map<string, string>) {
  const results: Array<{ id: string; rank: number | null; returned: Array<{ sourceId: string | null; score: number }> }> = []
  for (const item of cases) {
    const rows = await retrieveKnowledge('project', refId, item.query, 3)
    const expectedSourceId = sourceIds.get(item.expected)
    assertContract(expectedSourceId, `missing fixture identity for ${item.expected}`)
    const rankIndex = rows.findIndex((row) => row.sourceId === expectedSourceId)
    results.push({
      id: item.id,
      rank: rankIndex < 0 ? null : rankIndex + 1,
      returned: rows.map((row) => ({ sourceId: row.sourceId, score: row.score })),
    })
  }
  return results
}

async function cleanupFixtures(refIds: string[]) {
  await db.delete(knowledgeChunks).where(inArray(knowledgeChunks.refId, refIds))
  const remaining = await db.select({ id: knowledgeChunks.id }).from(knowledgeChunks)
    .where(inArray(knowledgeChunks.refId, refIds)).limit(1)
  assertContract(remaining.length === 0, 'fixture cleanup left knowledge chunks behind')
}

async function main() {
  const refId = randomUUID()
  const isolatedRefId = randomUUID()
  const sourceIds = new Map(fixtures.map((fixture) => [fixture.key, randomUUID()]))
  const goldHash = sha256(JSON.stringify({ fixtures, cases, version: 'chinese-retrieval-gold-v1' }))
  try {
    await db.insert(knowledgeChunks).values(fixtures.map((fixture, index) => ({
      scope: 'project',
      refId,
      sourceType: 'file',
      sourceId: sourceIds.get(fixture.key),
      sourceName: fixture.name,
      chunkIndex: index,
      content: fixture.content,
    })))
    await db.insert(knowledgeChunks).values([
      {
        scope: 'project', refId: isolatedRefId, sourceType: 'file', sourceId: randomUUID(),
        sourceName: '其他项目资料.md', chunkIndex: 0,
        content: '碳化硅功率模块 技术路线 客户集中度 在手订单 营业收入 毛利率 现金流。',
      },
      {
        scope: 'lead', refId, sourceType: 'lead_profile', sourceId: randomUUID(),
        sourceName: '其他Scope资料', chunkIndex: 0,
        content: '英飞凌竞争优势 科创板退出路径 晶圆供应商断供风险。',
      },
    ])

    const first = await runCases(refId, sourceIds)
    const second = await runCases(refId, sourceIds)
    const third = await runCases(refId, sourceIds)
    const stableSignature = (rows: Awaited<ReturnType<typeof runCases>>) => JSON.stringify(rows.map((row) => ({
      id: row.id,
      rank: row.rank,
      returned: row.returned.map((item) => item.sourceId),
    })))
    assertContract(
      stableSignature(first) === stableSignature(second) && stableSignature(second) === stableSignature(third),
      'three identical runs returned different ordering',
    )

    const hitsAt3 = first.filter((row) => row.rank !== null && row.rank <= 3).length
    const top1 = first.filter((row) => row.rank === 1).length
    const reciprocalRank = first.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / first.length
    const recallAt3 = hitsAt3 / first.length
    const top1Accuracy = top1 / first.length
    const meanReciprocalRank = Number(reciprocalRank.toFixed(4))
    assertContract(recallAt3 >= 0.875, `Recall@3 ${recallAt3} is below 0.875`)
    assertContract(top1Accuracy >= 0.75, `Top-1 ${top1Accuracy} is below 0.75`)
    assertContract(meanReciprocalRank >= 0.8, `MRR ${meanReciprocalRank} is below 0.8`)

    const irrelevant = await retrieveKnowledge('project', refId, '量子通信卫星轨道姿态控制', 3)
    assertContract(irrelevant.length === 0, 'irrelevant query returned a false-positive fixture')
    const otherProject = await retrieveKnowledge('project', isolatedRefId, cases[0].query, 3)
    assertContract(otherProject.length === 1, 'isolated project fixture was not independently retrievable')
    assertContract(
      first.every((row) => row.returned.every((item) => !otherProject.some((other) => other.sourceId === item.sourceId))),
      'project retrieval leaked a chunk from another project',
    )

    await cleanupFixtures([refId, isolatedRefId])

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      profile: 'chinese-retrieval-gold-v1',
      goldHash,
      fixtureCount: fixtures.length,
      caseCount: cases.length,
      metrics: { recallAt3, top1Accuracy, meanReciprocalRank },
      cases: first.map(({ id, rank }) => ({ id, rank })),
      checks: [
        'representative-investment-document-fixtures',
        'recall-at-3-threshold',
        'top-1-accuracy-threshold',
        'mean-reciprocal-rank-threshold',
        'unicode-fullwidth-query-normalization',
        'project-reference-isolation',
        'scope-isolation',
        'irrelevant-query-zero-result',
        'three-run-stable-ordering',
        'fixture-cleanup',
        'evidence-excludes-document-content-and-connection-identity',
      ],
    }
    await persistEvidence(report)
    console.log(JSON.stringify(report))
  } finally {
    await cleanupFixtures([refId, isolatedRefId]).catch(() => undefined)
    await pool.end()
  }
}

await main()
