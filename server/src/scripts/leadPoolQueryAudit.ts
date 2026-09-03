import assert from 'node:assert/strict'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  SERVER_LEAD_POOL_INDUSTRIES,
  SERVER_LEAD_POOL_STAGES,
} from '../contracts/leadPoolQueryContract.js'
import type { LeadInvestmentProfileSummary } from '../contracts/leadInvestmentProfileContract.js'
import { LEAD_LIST_READ_TRANSACTION, listLeads } from '../services/aiSummaryService.js'
import { BUSINESS_REGIONS } from '../services/leadRegion.js'

type PublicLead = Awaited<ReturnType<typeof listLeads>>['list'][number]
type LeadFilters = Parameters<typeof listLeads>[0]
type InvestmentProfile = LeadInvestmentProfileSummary
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))

async function inBatches<T, R>(items: readonly T[], worker: (item: T) => Promise<R>, size = 4): Promise<R[]> {
  const results: R[] = []
  for (let index = 0; index < items.length; index += size) {
    results.push(...await Promise.all(items.slice(index, index + size).map(worker)))
  }
  return results
}

async function allLeads(filters: LeadFilters = {}): Promise<PublicLead[]> {
  const first = await listLeads({ ...filters, page: 1, pageSize: 100 })
  if (first.totalPages === 1) return first.list
  const pages = Array.from({ length: first.totalPages - 1 }, (_, index) => index + 2)
  const remaining = await inBatches(pages, async (page) => (
    await listLeads({ ...filters, page, pageSize: 100 })
  ).list)
  return [first.list, ...remaining].flat()
}

function idSet(leads: PublicLead[]): Set<string> {
  return new Set(leads.map((lead) => lead.id))
}

function assertSameIds(label: string, expected: Set<string>, actual: Set<string>) {
  const missing = [...expected].filter((id) => !actual.has(id)).length
  const unexpected = [...actual].filter((id) => !expected.has(id)).length
  assert.equal(missing + unexpected, 0,
    `${label}: expected=${expected.size}, actual=${actual.size}, missing=${missing}, unexpected=${unexpected}`)
}

function teamProbe(team: unknown): string | null {
  if (typeof team !== 'string') return null
  const value = team.trim()
  if (!value) return null
  const token = value.split(/[、,，;；|/\n]/).map((item) => item.trim()).find((item) => item.length >= 2)
  return token?.slice(0, 100) ?? null
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN') : ''
}

function investmentProfile(lead: PublicLead): InvestmentProfile | null {
  const value = lead.investmentProfile
  return value && typeof value === 'object' && !Array.isArray(value) ? value as InvestmentProfile : null
}

async function main() {
  assert.deepEqual(LEAD_LIST_READ_TRANSACTION, {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  }, '真实库审计必须通过 MySQL 只读一致快照查询')
  const all = await allLeads()
  const allIds = idSet(all)
  const profiled = all.flatMap((lead) => {
    const profile = investmentProfile(lead)
    return profile ? [{ lead, profile }] : []
  })
  assert.ok(profiled.length > 0, '投资画像筛选审计要求至少一条已生成画像；请先执行受控回补')
  const beyond = await listLeads({ page: 10_000, pageSize: 20 })
  assert.equal(beyond.page, beyond.totalPages, '越界分页未回退至末页')
  assert.ok(beyond.list.length > 0, '非空线索池的末页不得为空')

  const industryResults = await inBatches(SERVER_LEAD_POOL_INDUSTRIES, async (industry) => ({
    industry,
    ids: idSet(await allLeads({ industry })),
  }), 1)
  for (const { industry, ids } of industryResults) {
    const displayed = new Set(all.filter((lead) => lead.businessTags?.industry.includes(industry)).map((lead) => lead.id))
    assertSameIds(`industry:${industry}`, displayed, ids)
  }

  const regionResults = await inBatches(BUSINESS_REGIONS, async (region) => ({
    region,
    ids: idSet(await allLeads({ region })),
  }), 1)
  for (const { region, ids } of regionResults) {
    const displayed = new Set(all.filter((lead) => lead.region === region).map((lead) => lead.id))
    assertSameIds(`region:${region}`, displayed, ids)
  }

  const stageResults = await inBatches(SERVER_LEAD_POOL_STAGES, async (stage) => ({
    stage,
    ids: idSet(await allLeads({ stage })),
  }), 1)
  const stageUnion = new Set(stageResults.flatMap(({ ids }) => [...ids]))
  assert.ok(stageUnion.size > 0, '阶段筛选未命中任何线索')
  assert.ok([...stageUnion].every((id) => allIds.has(id)), '阶段筛选返回了公共池之外的线索')

  const publicLeadIds = [...allIds]
  const [teamRows] = await pool.query<Array<RowDataPacket & { id: string; team: unknown }>>(
    `SELECT id,team FROM ${leadsTable}
     WHERE id IN (${publicLeadIds.map(() => '?').join(',')}) AND team IS NOT NULL AND TRIM(team)<>''
     ORDER BY id LIMIT 100`,
    publicLeadIds,
  )
  const probes = teamRows
    .map((lead) => ({ id: lead.id, keyword: teamProbe(lead.team) }))
    .filter((probe): probe is { id: string; keyword: string } => Boolean(probe.keyword))
    .slice(0, 24)
  assert.equal(probes.length, 24, '直接团队字段不足 24 个可验证样本')
  const keywordResults = await inBatches(probes, async (probe) => ({
    ...probe,
    ids: idSet(await allLeads({ keyword: probe.keyword })),
  }), 1)
  const teamKeywordMisses = keywordResults.filter(({ id, ids }) => !ids.has(id)).length
  assert.equal(teamKeywordMisses, 0, `团队字段关键词漏检 ${teamKeywordMisses}/${probes.length}`)

  const profileFilterChecks: string[] = []
  const verifyProfileFilter = async (
    label: string,
    filters: LeadFilters,
    predicate: (lead: PublicLead) => boolean,
  ) => {
    const expected = idSet(all.filter(predicate))
    const actual = idSet(await allLeads(filters))
    assertSameIds(`investment-profile:${label}`, expected, actual)
    profileFilterChecks.push(label)
  }
  const firstProfile = profiled[0]!.profile
  await verifyProfileFilter('profile-status', { profileStatus: firstProfile.dataStatus.status }, (lead) => (
    investmentProfile(lead)?.dataStatus.status === firstProfile.dataStatus.status
  ))
  await verifyProfileFilter('no-conflict', { hasConflict: false }, (lead) => (
    investmentProfile(lead)?.dataStatus.conflictCount === 0
  ))
  await verifyProfileFilter('no-verified-customer', { hasVerifiedCustomer: false }, (lead) => (
    investmentProfile(lead)?.customers.verifiedCount === 0
  ))

  const level1 = profiled.map(({ profile }) => profile.industry.level1).find(Boolean)
  if (level1) await verifyProfileFilter('industry-level1', { industryLevel1: level1 }, (lead) => (
    investmentProfile(lead)?.industry.level1 === level1
  ))
  const productRoute = profiled.flatMap(({ profile }) => profile.products)
    .map((product) => product.productRoute || product.technologyRoute).find(Boolean)
  if (productRoute) await verifyProfileFilter('product-route', { productRoute }, (lead) => (
    (investmentProfile(lead)?.products ?? []).some((product) => (
      normalizedText(product.productRoute).includes(normalizedText(productRoute))
      || normalizedText(product.technologyRoute).includes(normalizedText(productRoute))
    ))
  ))
  const institution = profiled.flatMap(({ profile }) => profile.institutions)
    .map((item) => item.name).find(Boolean)
  if (institution) await verifyProfileFilter('institution', { institution }, (lead) => (
    (investmentProfile(lead)?.institutions ?? []).some((item) => normalizedText(item.name).includes(normalizedText(institution)))
  ))
  const institutionType = profiled.flatMap(({ profile }) => profile.institutions)
    .map((item) => item.type).find(Boolean)
  if (institutionType) await verifyProfileFilter('institution-type', { institutionType }, (lead) => (
    (investmentProfile(lead)?.institutions ?? []).some((item) => item.type === institutionType)
  ))
  const academicInstitution = profiled.flatMap(({ profile }) => profile.academicLinks)
    .map((item) => item.institution).find(Boolean)
  if (academicInstitution) await verifyProfileFilter('academic-institution', { academicInstitution }, (lead) => (
    (investmentProfile(lead)?.academicLinks ?? []).some((item) => (
      normalizedText(item.institution).includes(normalizedText(academicInstitution))
      || normalizedText(item.departmentLab).includes(normalizedText(academicInstitution))
    ))
  ))
  const latestRound = profiled.map(({ profile }) => profile.financing.latestRound).find(Boolean)
  if (latestRound) await verifyProfileFilter('latest-round', { latestRound }, (lead) => (
    investmentProfile(lead)?.financing.latestRound === latestRound
  ))
  const customerTier = (['A', 'B', 'C'] as const).find((tier) => profiled.some(({ profile }) => (
    tier === 'A' ? profile.customers.tierACount > 0
      : tier === 'B' ? profile.customers.tierBCount > 0
        : profile.customers.tierCCount > 0
  )))
  if (customerTier) await verifyProfileFilter('customer-tier', { customerTier }, (lead) => {
    const customers = investmentProfile(lead)?.customers
    return customerTier === 'A' ? Number(customers?.tierACount) > 0
      : customerTier === 'B' ? Number(customers?.tierBCount) > 0
        : Number(customers?.tierCCount) > 0
  })

  console.log(JSON.stringify({
    ok: true,
    total: all.length,
    pagination: {
      requestedPage: 10_000,
      actualPage: beyond.page,
      totalPages: beyond.totalPages,
      lastPageRows: beyond.list.length,
    },
    industryOptionsChecked: industryResults.length,
    otherIndustryCount: industryResults.find(({ industry }) => industry === '其他')?.ids.size ?? 0,
    regionOptionsChecked: regionResults.length,
    stageOptionsChecked: stageResults.length,
    stageMatchedLeadCount: stageUnion.size,
    teamKeywordSamples: probes.length,
    teamKeywordMisses,
    investmentProfiles: profiled.length,
    investmentProfileFilterChecks: profileFilterChecks,
    readOnlyTransaction: LEAD_LIST_READ_TRANSACTION,
  }, null, 2))
}

await main().finally(async () => pool.end())
