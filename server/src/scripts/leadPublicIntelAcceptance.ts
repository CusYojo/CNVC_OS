import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { leads } from '../db/schema.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  commitLeadPublicIntel,
  type PublicIntelResult,
} from '../services/leadPublicIntelService.js'
import {
  leadPipelineRawEventIdentity,
  verifyLeadPipelineRawEvent,
} from '../services/leadPipelineEventService.js'

const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const transitionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_transitions'))
const decisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_evidence'))
const reviewsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_reviews'))
const entityMatchesTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_entity_matches'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const auditLogsTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const knowledgeTable = quoteMysqlIdentifier(mysqlTableName('knowledge_chunks'))
const marker = `public-intel-acceptance-${randomUUID()}`
const company = `公开情报事务验收公司-${marker}`.slice(0, 128)
const rollbackCompany = `公开情报回滚验收公司-${marker}`.slice(0, 128)
const ambiguousCompany = `公开情报歧义验收公司-${marker}`.slice(0, 128)
const mismatchedCompany = `公开情报错误目标验收公司-${marker}`.slice(0, 128)
const eventIds = new Set<string>()
const leadIds = new Set<string>()
const auditTargets = new Set<string>([company, rollbackCompany, ambiguousCompany, mismatchedCompany])
const checks: string[] = []

function fixtureIntel(overrides: Partial<PublicIntelResult> = {}): PublicIntelResult {
  return {
    positioning: '该主体提供企业级数据治理产品，现有描述来自公开检索线索。',
    companyIntroduction: '该公司面向企业客户提供数据治理软件与配套服务，公开信息显示其产品覆盖数据管理和分析场景。',
    registeredCapital: '1000万元人民币',
    legalRepresentative: '张三',
    foundedAt: '2020-01-02',
    creditCode: '91110108MA01ABC123',
    registrationStatus: '存续',
    companyType: '有限责任公司',
    region: '北京市',
    registeredAddress: '北京市海淀区中关村大街1号',
    fundingRounds: [{
      round: 'A轮',
      date: '2025-01-01',
      amount: '1亿元人民币',
      valuation: '未披露',
      investors: '验收投资机构',
      sourceUrl: `https://example.com/${marker}/funding`,
    }],
    shareholders: [{
      name: '张三',
      percentage: '60%',
      type: '自然人',
      sourceUrl: `https://example.com/${marker}/registry`,
    }],
    competitors: [],
    companyNews: [],
    sources: [
      { title: '企业公开资料', url: `https://example.com/${marker}/profile?utm_source=test`, reliability: '中' },
      { title: '重复企业公开资料', url: `https://example.com/${marker}/profile`, reliability: '中' },
    ],
    confidence: 0.75,
    fetchedAt: '2026-08-09T10:00:00+08:00',
    searchEvidence: [{
      query: company,
      title: '企业公开资料',
      snippet: `${company}提供企业级数据治理产品。`,
      url: `https://example.com/${marker}/profile`,
      reliability: '公开搜索结果摘要，需访问原始页面核验',
    }],
    ...overrides,
  }
}

async function count(table: string, where: string, values: unknown[]) {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
    values,
  )
  return Number(rows[0]?.count || 0)
}

async function cleanup() {
  const ids = [...eventIds]
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(`DELETE FROM ${entityMatchesTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${reviewsTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${evidenceTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${transitionsTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${itemsTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${rawTable} WHERE id IN (${placeholders})`, ids)
  }
  const targets = [...auditTargets]
  if (targets.length) {
    await pool.query(`DELETE FROM ${auditLogsTable} WHERE target IN (${targets.map(() => '?').join(',')})`, targets)
  }
  const idsToDelete = [...leadIds]
  if (idsToDelete.length) {
    const placeholders = idsToDelete.map(() => '?').join(',')
    await pool.query(`DELETE FROM ${knowledgeTable} WHERE source_id IN (${placeholders}) OR ref_id IN (${placeholders})`, [...idsToDelete, ...idsToDelete])
    await pool.query(`DELETE FROM ${leadsTable} WHERE id IN (${placeholders})`, idsToDelete)
  }
}

async function main() {
  await ensureSchema()
  try {
    const intel = fixtureIntel()
    const concurrent = await Promise.all([
      commitLeadPublicIntel({ company, intel }),
      commitLeadPublicIntel({ company, intel }),
    ])
    concurrent.forEach((result) => {
      eventIds.add(result.eventId)
      leadIds.add(result.lead.id)
    })
    assert.equal(new Set(concurrent.map((result) => result.lead.id)).size, 1)
    assert.equal(concurrent.filter((result) => result.status === 'created').length, 1)
    assert.equal(concurrent.filter((result) => result.replayed).length, 1)
    assert.equal(await count(leadsTable, 'name=?', [company]), 1)
    checks.push('concurrent-identical-public-intel-creates-one-formal-lead')

    const first = concurrent[0]
    assert.equal(await count(rawTable, 'id=?', [first.eventId]), 1)
    assert.equal(await count(itemsTable, "event_id=? AND status='ready' AND lead_id=?", [first.eventId, first.lead.id]), 1)
    assert.equal(await count(transitionsTable, 'event_id=?', [first.eventId]), 2)
    assert.equal(await count(auditLogsTable, 'target=?', [company]), 1)
    checks.push('raw-event-lead-audit-and-ready-link-commit-on-one-host-path')

    const verified = await verifyLeadPipelineRawEvent(first.eventId)
    assert.equal(verified.exists, true)
    assert.equal(verified.valid, true)
    assert.equal((verified.event?.payload as { company?: string }).company, company)
    checks.push('public-intel-raw-evidence-is-immutable-and-hash-verifiable')

    const [stored] = await db.select().from(leads).where(eq(leads.id, first.lead.id)).limit(1)
    const storedSources = Array.isArray(stored.sources) ? stored.sources as Array<{ url?: string }> : []
    assert.equal(storedSources.length, 1)
    const scoring = stored.scoring as Record<string, unknown>
    const registry = scoring.registry as Record<string, unknown>
    assert.equal(registry.registeredCapital, '1000万元人民币')
    assert.equal(registry.creditCode, '91110108MA01ABC123')
    assert.equal(registry.registrationStatus, '存续')
    assert.equal(registry.companyType, '有限责任公司')
    assert.equal(scoring.companyIntroduction, intel.companyIntroduction)
    assert.equal((scoring.fundingRoundsResearched as unknown[]).length, 1)
    checks.push('host-cleaning-deduplicates-sources-and-persists-only-sourced-facts')

    const enrichedIntel = fixtureIntel({
      positioning: '该文本不得覆盖首次已保存的有效摘要。',
      fetchedAt: '2026-08-09T11:00:00+08:00',
      sources: [{ title: '第二个公开来源', url: `https://example.com/${marker}/second`, reliability: '高' }],
    })
    const enriched = await commitLeadPublicIntel({
      company,
      intel: enrichedIntel,
      targetLeadId: first.lead.id,
    })
    eventIds.add(enriched.eventId)
    assert.equal(enriched.status, 'updated')
    assert.equal(enriched.lead.id, first.lead.id)
    assert.equal(enriched.lead.summary, intel.positioning)
    assert.equal((enriched.lead.sources as unknown[]).length, 2)
    assert.equal(await count(auditLogsTable, 'target=?', [company]), 2)
    checks.push('incremental-enrichment-preserves-existing-valid-fields-and-adds-new-source')

    const missingTargetId = randomUUID()
    const rollbackIntel = fixtureIntel({
      positioning: '该事件和写入必须回滚。',
      fetchedAt: '2026-08-09T12:00:00+08:00',
      sources: [{ title: '回滚来源', url: `https://example.com/${marker}/rollback`, reliability: '中' }],
    })
    const rollbackIdentity = leadPipelineRawEventIdentity({
      sourceType: 'public-intel',
      sourceId: `company:${rollbackCompany.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`,
      sourceOccurredAt: rollbackIntel.fetchedAt,
      payload: { company: rollbackCompany, intel: rollbackIntel },
    })
    await assert.rejects(
      commitLeadPublicIntel({
        company: rollbackCompany,
        intel: rollbackIntel,
        targetLeadId: missingTargetId,
      }),
      /公开情报目标线索不存在/,
    )
    assert.equal(await count(rawTable, 'id=?', [rollbackIdentity.id]), 0)
    assert.equal(await count(leadsTable, 'name=?', [rollbackCompany]), 0)
    assert.equal(await count(auditLogsTable, 'target=?', [rollbackCompany]), 0)
    checks.push('invalid-target-rolls-back-raw-event-lead-and-audit-together')

    const mismatchedIntel = fixtureIntel({
      positioning: '主体不一致时不得向任意人工指定线索写入。',
      fetchedAt: '2026-08-09T12:10:00+08:00',
      sources: [{ title: '错误目标来源', url: `https://example.com/${marker}/mismatched`, reliability: '中' }],
    })
    const mismatchedIdentity = leadPipelineRawEventIdentity({
      sourceType: 'public-intel',
      sourceId: `company:${mismatchedCompany.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`,
      sourceOccurredAt: mismatchedIntel.fetchedAt,
      payload: { company: mismatchedCompany, intel: mismatchedIntel },
    })
    await assert.rejects(
      commitLeadPublicIntel({
        company: mismatchedCompany,
        intel: mismatchedIntel,
        targetLeadId: first.lead.id,
      }),
      (error: unknown) => (error as { code?: string }).code === 'PUBLIC_INTEL_TARGET_SUBJECT_MISMATCH',
    )
    assert.equal(await count(rawTable, 'id=?', [mismatchedIdentity.id]), 0)
    assert.equal(await count(leadsTable, 'name=?', [mismatchedCompany]), 0)
    assert.equal(await count(auditLogsTable, 'target=?', [mismatchedCompany]), 0)
    checks.push('explicit-public-intel-target-must-match-the-requested-subject-with-full-rollback')

    const terminalIntel = fixtureIntel({
      positioning: '已转项目线索继续作为证据权威来源接受公开情报补全。',
      fetchedAt: '2026-08-09T12:20:00+08:00',
      sources: [{ title: '终态目标来源', url: `https://example.com/${marker}/terminal`, reliability: '中' }],
    })
    const terminalIdentity = leadPipelineRawEventIdentity({
      sourceType: 'public-intel',
      sourceId: `company:${company.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`,
      sourceOccurredAt: terminalIntel.fetchedAt,
      payload: { company, intel: terminalIntel },
    })
    await db.update(leads).set({ poolStatus: '已转专属项目' }).where(eq(leads.id, first.lead.id))
    try {
      const convertedEnrichment = await commitLeadPublicIntel({
        company, intel: terminalIntel, targetLeadId: first.lead.id,
      })
      eventIds.add(convertedEnrichment.eventId)
      assert.equal(convertedEnrichment.status, 'updated')
      assert.equal(convertedEnrichment.lead.poolStatus, '已转专属项目')
    } finally {
      await db.update(leads).set({ poolStatus: '成功' }).where(eq(leads.id, first.lead.id))
    }
    assert.equal(await count(rawTable, 'id=?', [terminalIdentity.id]), 1)
    assert.equal(await count(auditLogsTable, 'target=?', [company]), 3)
    checks.push('converted-lead-remains-the-evidence-authority-for-safe-public-intel-enrichment')

    const ambiguousRows = await db.insert(leads).values([
      { name: ambiguousCompany, companyName: ambiguousCompany, source: 'public-intel-ambiguity-fixture', poolStatus: '成功' },
      { name: ambiguousCompany, companyName: ambiguousCompany, source: 'public-intel-ambiguity-fixture', poolStatus: '成功' },
    ]).$returningId()
    ambiguousRows.forEach((row) => leadIds.add(row.id))
    const ambiguousIntel = fixtureIntel({
      positioning: '歧义主体不得自动选择任意一条正式线索。',
      fetchedAt: '2026-08-09T13:00:00+08:00',
      sources: [{ title: '歧义来源', url: `https://example.com/${marker}/ambiguous`, reliability: '中' }],
    })
    const ambiguousIdentity = leadPipelineRawEventIdentity({
      sourceType: 'public-intel',
      sourceId: `company:${ambiguousCompany.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`,
      sourceOccurredAt: ambiguousIntel.fetchedAt,
      payload: { company: ambiguousCompany, intel: ambiguousIntel },
    })
    let ambiguityError: unknown = null
    await assert.rejects(
      commitLeadPublicIntel({ company: ambiguousCompany, intel: ambiguousIntel }),
      (error: unknown) => {
        ambiguityError = error
        return (error as Error).message.includes('必须人工指定目标')
      },
    )
    eventIds.add(ambiguousIdentity.id)
    const stagedAmbiguity = ambiguityError as Error & { reviewStaged?: boolean; eventId?: string; reviewId?: string }
    assert.equal(stagedAmbiguity.reviewStaged, true)
    assert.equal(stagedAmbiguity.eventId, ambiguousIdentity.id)
    assert.ok(stagedAmbiguity.reviewId)
    assert.equal(await count(rawTable, 'id=?', [ambiguousIdentity.id]), 1)
    assert.equal(await count(itemsTable, "event_id=? AND status='review' AND lead_id IS NULL", [ambiguousIdentity.id]), 1)
    assert.equal(await count(reviewsTable, "event_id=? AND status='pending'", [ambiguousIdentity.id]), 1)
    assert.equal(await count(entityMatchesTable, "event_id=? AND status='ambiguous'", [ambiguousIdentity.id]), 2)
    assert.equal(await count(leadsTable, 'name=?', [ambiguousCompany]), 2)
    assert.equal(await count(auditLogsTable, 'target=?', [ambiguousCompany]), 0)
    checks.push('ambiguous-existing-entity-rolls-back-formal-write-and-stages-auditable-review')

    console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
  } finally {
    await cleanup()
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => await pool.end())
