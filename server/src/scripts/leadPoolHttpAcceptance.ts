import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js'
import { metaRouter } from '../routes/meta.js'

type LeadListHttpResponse = {
  list: Array<{
    id: string
    region?: string
    businessTags?: { industry?: string[]; region?: string[] }
    latestUpdates?: Array<Record<string, unknown>>
    investmentProfile?: Record<string, unknown>
    researchProfile?: Record<string, unknown>
    availableData?: Record<string, unknown>
    [key: string]: unknown
  }>
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))

type ErrorHttpResponse = {
  code: string
  message: string
  details: Array<{ path: string; message: string }> | null
}

function teamProbe(team: unknown): string | null {
  if (typeof team !== 'string') return null
  return team.trim().split(/[、,，;；|/\n]/).map((item) => item.trim()).find((item) => item.length >= 2)?.slice(0, 100) ?? null
}

function assertProjectedObject(label: string, value: unknown, allowedKeys: readonly string[]) {
  if (value === null || value === undefined) return
  assert.equal(typeof value, 'object', `${label} 必须是对象或空值`)
  const unexpected = Object.keys(value as Record<string, unknown>).filter((key) => !allowedKeys.includes(key))
  assert.deepEqual(unexpected, [], `${label} 泄露非列表投影字段`)
}

async function main() {
  const app = express()
  app.use(express.json())
  app.use('/protected-api', requireAuth, metaRouter)
  app.use((req: AuthedRequest, res, next) => {
    res.locals.requestId = 'lead-pool-http-acceptance'
    req.user = {
      uid: 'lead-pool-http-acceptance',
      email: 'acceptance@example.invalid',
      name: '线索池只读验收',
      role: 'acceptance',
      department: 'acceptance',
    }
    next()
  })
  app.use('/api', metaRouter)
  app.use(errorHandler)

  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  const request = async <T>(query: string): Promise<{ status: number; body: T; bytes: number; durationMs: number }> => {
    const startedAt = performance.now()
    const response = await fetch(`http://127.0.0.1:${port}/api/leads?${query}`)
    const responseText = await response.text()
    return {
      status: response.status,
      body: JSON.parse(responseText) as T,
      bytes: Buffer.byteLength(responseText, 'utf8'),
      durationMs: performance.now() - startedAt,
    }
  }

  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/protected-api/leads`)
    const unauthenticatedBody = await unauthenticated.json() as { code?: string }
    assert.equal(unauthenticated.status, 401)
    assert.equal(unauthenticatedBody.code, 'AUTH_REQUIRED')

    const defaults = await request<LeadListHttpResponse>('')
    assert.equal(defaults.status, 200)
    assert.equal(defaults.body.page, 1)
    assert.equal(defaults.body.pageSize, 20)
    assert.equal(defaults.body.list.length, Math.min(20, defaults.body.total))
    for (const lead of defaults.body.list) {
      assertProjectedObject('lead', lead, [
        'id', 'name', 'companyName', 'region', 'leadType', 'rating', 'businessTags',
        'poolEnteredAt', 'dataUpdatedAt', 'latestUpdates', 'scoring', 'radarProfile', 'investmentProfile', 'researchProfile', 'availableData',
      ])
      for (const internalField of ['detailJson', 'rawPayload', 'summary', 'highlights', 'fundingRounds']) {
        assert.equal(Object.hasOwn(lead, internalField), false, `列表 DTO 泄露内部字段 ${internalField}`)
      }
      assert.ok(Array.isArray(lead.latestUpdates), '列表最新动态必须是数组')
      assert.ok((lead.latestUpdates ?? []).length <= 2, '列表最新动态最多返回两条')
      for (const update of lead.latestUpdates ?? []) {
        assertProjectedObject('latestUpdates item', update, ['occurredAt', 'title'])
        assert.equal(typeof update.title, 'string')
      }
      assert.equal(Object.hasOwn(lead.investmentProfile ?? {}, 'sourceFactIds'), false, '列表投资画像泄露内部事实 ID')
      assert.equal(Object.hasOwn(lead.researchProfile ?? {}, 'sourceFactIds'), false, '列表科研画像泄露内部事实 ID')
      assertProjectedObject('investmentProfile', lead.investmentProfile, [
        'schemaVersion', 'snapshotId', 'industry', 'products', 'institutions',
        'academicLinks', 'financing', 'valuation', 'customers', 'dataStatus',
      ])
      assertProjectedObject('availableData', lead.availableData, [
        'dataStatus', 'verificationStatus', 'displayLabel', 'sourceKinds', 'conflictFields',
        'industryTags', 'products', 'institutions', 'academicLinks', 'financing', 'valuation',
      ])
      assertProjectedObject('researchProfile', lead.researchProfile, [
        'schemaVersion', 'projectionVersion', 'subject', 'direction', 'team', 'progress',
        'valueAndTransfer', 'rights', 'latestDevelopments', 'dataStatus',
      ])
      if (lead.availableData) {
        assert.equal(lead.availableData.dataStatus, 'candidate')
        assert.equal(lead.availableData.verificationStatus, 'unverified')
        assert.ok(Array.isArray(lead.availableData.sourceKinds))
        assert.ok(Array.isArray(lead.availableData.conflictFields))
        assert.match(String(lead.availableData.displayLabel), /待核验$/)
        const candidate = lead.availableData as {
          institutions?: Array<{ name?: string }>
          financing?: { status?: string; latestRound?: string; latestAmount?: string }
          conflictFields?: string[]
        }
        for (const institution of candidate.institutions ?? []) {
          assert.doesNotMatch(String(institution.name ?? ''), /^(?:未透露|待核验|待核实|待确认|未披露)$/)
          assert.doesNotMatch(String(institution.name ?? ''), /(?:行长|董事长|创始人|企业家|先生|女士|个人|自然人)/)
        }
        if (candidate.financing?.status === '未融资') {
          assert.equal(candidate.financing.latestRound, undefined, '未融资候选不得同时展示融资轮次')
          assert.equal(candidate.financing.latestAmount, undefined, '未融资候选不得同时展示融资金额')
        }
        if (candidate.conflictFields?.includes('financing')) {
          assert.equal(candidate.financing?.status, '候选冲突')
        }
      }
      assertProjectedObject('scoring', lead.scoring, ['enrichment'])
      assertProjectedObject('scoring.enrichment', (lead.scoring as { enrichment?: unknown } | undefined)?.enrichment, ['status'])
      assertProjectedObject('radarProfile', lead.radarProfile, ['profile', 'channel'])
      assertProjectedObject('radarProfile.profile', (lead.radarProfile as { profile?: unknown } | undefined)?.profile, ['lab'])
    }
    const research = await request<LeadListHttpResponse>('page=1&pageSize=20&leadType=research')
    assert.equal(research.status, 200)
    assert.ok(research.body.list.length > 0, '正式库没有可验收的科研线索')
    assert.ok(research.body.list.every((lead) => lead.researchProfile), '科研列表必须返回独立科研画像')
    assert.ok(research.body.list.every((lead) => !lead.investmentProfile), '科研列表不得返回企业投资画像')
    assert.ok(research.body.list.every((lead) => !Object.hasOwn(lead.researchProfile ?? {}, 'sourceFactIds')), '科研列表不得泄露事实 ID')
    const performanceSamples = [defaults]
    for (let index = 1; index < 10; index += 1) {
      performanceSamples.push(await request<LeadListHttpResponse>(''))
    }
    const sortedDurations = performanceSamples.map((sample) => sample.durationMs).sort((left, right) => left - right)
    const p95DurationMs = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1] ?? 0

    const beyond = await request<LeadListHttpResponse>('page=10000&pageSize=20')
    assert.equal(beyond.status, 200)
    assert.equal(beyond.body.page, beyond.body.totalPages)
    assert.equal(beyond.body.pageSize, 20)
    assert.ok(beyond.body.list.length > 0)

    const zeroKeyword = encodeURIComponent('lead-pool-zero-result-4f673c13-8cb0-4ba8-b042-a48016c4706b')
    const empty = await request<LeadListHttpResponse>(`page=99&pageSize=20&keyword=${zeroKeyword}`)
    assert.equal(empty.status, 200)
    assert.deepEqual({
      total: empty.body.total,
      page: empty.body.page,
      totalPages: empty.body.totalPages,
      rows: empty.body.list.length,
    }, { total: 0, page: 1, totalPages: 1, rows: 0 })

    const [one, hundred] = await Promise.all([
      request<LeadListHttpResponse>('page=1&pageSize=1'),
      request<LeadListHttpResponse>('page=1&pageSize=100'),
    ])
    assert.equal(one.status, 200)
    assert.equal(one.body.pageSize, 1)
    assert.equal(one.body.list.length, 1)
    assert.equal(hundred.status, 200)
    assert.equal(hundred.body.pageSize, 100)
    assert.equal(hundred.body.list.length, Math.min(100, hundred.body.total))

    const visibleLeadIds = hundred.body.list.map((lead) => lead.id)
    for (let page = 2; page <= hundred.body.totalPages; page += 1) {
      const candidate = await request<LeadListHttpResponse>(`page=${page}&pageSize=100`)
      assert.equal(candidate.status, 200)
      visibleLeadIds.push(...candidate.body.list.map((lead) => lead.id))
    }
    const teamCandidates: Array<RowDataPacket & { id: string; team: unknown }> = []
    for (let index = 0; index < visibleLeadIds.length; index += 500) {
      const batch = visibleLeadIds.slice(index, index + 500)
      const [rows] = await pool.query<Array<RowDataPacket & { id: string; team: unknown }>>(
        `SELECT id,team FROM ${leadsTable}
         WHERE id IN (${batch.map(() => '?').join(',')}) AND team IS NOT NULL AND TRIM(team)<>''
         ORDER BY id LIMIT 24`,
        batch,
      )
      teamCandidates.push(...rows)
      if (teamCandidates.length >= 24) break
    }
    const teamLead = teamCandidates
      .map((lead) => ({ lead, keyword: teamProbe(lead.team) }))
      .find((item) => Boolean(item.keyword))
    assert.ok(teamLead, '真实公共池中没有可用于 HTTP 团队关键词验收的直接团队字段')
    assert.ok(teamLead.keyword)
    const teamKeyword = await request<LeadListHttpResponse>(
      `page=1&pageSize=100&keyword=${encodeURIComponent(teamLead.keyword)}`,
    )
    assert.equal(teamKeyword.status, 200)
    let teamKeywordMatched = teamKeyword.body.list.some((lead) => lead.id === teamLead.lead.id)
    for (let page = 2; !teamKeywordMatched && page <= teamKeyword.body.totalPages; page += 1) {
      const candidate: { status: number; body: LeadListHttpResponse; bytes: number; durationMs: number } = await request<LeadListHttpResponse>(
        `page=${page}&pageSize=100&keyword=${encodeURIComponent(teamLead.keyword)}`,
      )
      assert.equal(candidate.status, 200)
      teamKeywordMatched = candidate.body.list.some((lead: LeadListHttpResponse['list'][number]) => lead.id === teamLead.lead.id)
    }
    assert.ok(teamKeywordMatched, 'HTTP 团队关键词未命中目标线索')

    const [otherIndustry, beijingRegion] = await Promise.all([
      request<LeadListHttpResponse>(`page=1&pageSize=100&industry=${encodeURIComponent('其他')}`),
      request<LeadListHttpResponse>(`page=1&pageSize=100&region=${encodeURIComponent('北京')}`),
    ])
    assert.equal(otherIndustry.status, 200)
    assert.ok(otherIndustry.body.list.every((lead) => lead.businessTags?.industry?.includes('其他')))
    assert.equal(beijingRegion.status, 200)
    assert.ok(beijingRegion.body.list.every((lead) => lead.region === '北京'))

    const otherInBeijing = await request<LeadListHttpResponse>(
      `page=1&pageSize=100&industry=${encodeURIComponent('其他')}&region=${encodeURIComponent('北京')}`,
    )
    assert.equal(otherInBeijing.status, 200)
    assert.ok(otherInBeijing.body.list.every((lead) => (
      lead.region === '北京' && lead.businessTags?.industry?.includes('其他')
    )))

    const institutionTypeProbe = '产业资本'
    const institutionTypeResult = await request<LeadListHttpResponse>(
      `page=1&pageSize=100&institutionType=${encodeURIComponent(institutionTypeProbe)}`,
    )
    assert.equal(institutionTypeResult.status, 200)
    assert.ok(institutionTypeResult.body.list.every((lead) => (
      ((lead.investmentProfile as { institutions?: Array<{ type?: string }> } | undefined)?.institutions ?? [])
        .some((institution) => institution.type === institutionTypeProbe)
    )))

    const invalidCases = [
      ['page=abc', 'page'],
      ['page=1.5', 'page'],
      ['page=0', 'page'],
      ['pageSize=101', 'pageSize'],
      [`industry=${encodeURIComponent('%')}`, 'industry'],
      [`region=${encodeURIComponent('火星')}`, 'region'],
      [`stage=${encodeURIComponent('未知阶段')}`, 'stage'],
      [`channel=${encodeURIComponent('未知渠道')}`, 'channel'],
      ['hasConflict=1', 'hasConflict'],
      ['hasMajorInstitution=yes', 'hasMajorInstitution'],
      [`institutionType=${encodeURIComponent('x'.repeat(65))}`, 'institutionType'],
      ['customerStageMin=L6', 'customerStageMin'],
      ['profileStatus=ready', 'profileStatus'],
      ['fundingDateFrom=2026%2F01%2F01', 'fundingDateFrom'],
      ['valuationMin=-1', 'valuationMin'],
      ['valuationMin=100', 'valuationCurrency'],
      ['valuationMin=100&valuationMax=99', 'valuationMax'],
    ] as const
    for (const [query, path] of invalidCases) {
      const response = await request<ErrorHttpResponse>(query)
      assert.equal(response.status, 400, query)
      assert.equal(response.body.code, 'INVALID_ARGUMENT', query)
      assert.ok(response.body.details?.some((issue) => issue.path === path), query)
    }

    console.log(JSON.stringify({
      ok: true,
      readOnly: true,
      unauthenticated: { status: unauthenticated.status, code: unauthenticatedBody.code },
      defaults: { page: defaults.body.page, pageSize: defaults.body.pageSize, rows: defaults.body.list.length },
      currentSourceDiagnostic: {
        sampleCount: performanceSamples.length,
        responseBytes: {
          minimum: Math.min(...performanceSamples.map((sample) => sample.bytes)),
          maximum: Math.max(...performanceSamples.map((sample) => sample.bytes)),
        },
        latencyMs: {
          minimum: Number(sortedDurations[0]?.toFixed(2) || 0),
          p95: Number(p95DurationMs.toFixed(2)),
          maximum: Number(sortedDurations.at(-1)?.toFixed(2) || 0),
        },
        note: 'diagnostic only; no approved I0 baseline or absolute latency/size budget is available',
      },
      pagination: {
        requestedPage: 10_000,
        actualPage: beyond.body.page,
        totalPages: beyond.body.totalPages,
        lastPageRows: beyond.body.list.length,
      },
      zeroResult: { page: empty.body.page, totalPages: empty.body.totalPages, rows: empty.body.list.length },
      pageSizesChecked: [1, 100],
      teamKeywordMatched: true,
      otherIndustryTotal: otherIndustry.body.total,
      beijingRegionTotal: beijingRegion.body.total,
      combinedFilterRows: otherInBeijing.body.total,
      institutionTypeProbe: { value: institutionTypeProbe, rows: institutionTypeResult.body.total },
      internalFieldsChecked: ['detailJson', 'rawPayload', 'legacy list summaries', 'scoring projection', 'radarProfile projection'],
      invalidArgumentsChecked: invalidCases.length,
    }, null, 2))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

await main().finally(async () => pool.end())
