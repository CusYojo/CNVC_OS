import { createHash } from 'node:crypto'
import { and, asc, eq, ne, or } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import type { RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import { db, pool, schema } from '../db/client.js'
import { auditLogs, leads } from '../db/schema.js'
import { resolveLeadBusinessRegion } from './leadRegion.js'
import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'
import {
  recordLeadPipelineRawEvent,
  transitionLeadPipelineItem,
  type LeadPipelineRawEventInput,
} from './leadPipelineEventService.js'
import { openLeadPipelineReview, recordLeadPipelineDecision } from './leadPipelineAuditService.js'
import { recordLeadPipelineEntityMatch } from './leadPipelineEntityMatchService.js'
import { applyLeadFieldPolicy, initialLeadFieldProvenance } from './leadFieldProvenance.js'

export interface PublicIntelFundingRound {
  round: string
  date: string
  amount: string
  valuation: string
  investors: string
  sourceUrl: string
}

export interface PublicIntelShareholder {
  name: string
  percentage: string
  type: string
  sourceUrl: string
}

export interface PublicIntelCompetitor {
  name: string
  is_self?: boolean
  tech: string
  product: string
  funding: string
  differentiation: string
  matchType: 'direct' | 'substitute'
  sameTargetUser: boolean
  sameUseCase: boolean
  sameDeliverable: boolean
  comparisonBasis: string
  evidence: string
  sourceRef: string
  sourceUrl: string
  confidence: number
  verificationStatus: 'evidence-backed'
}

export interface PublicIntelResult {
  positioning: string
  registeredCapital: string
  legalRepresentative: string
  foundedAt: string
  region: string
  registeredAddress: string
  fundingRounds: PublicIntelFundingRound[]
  shareholders: PublicIntelShareholder[]
  competitors: PublicIntelCompetitor[]
  companyNews: Array<{ title: string; summary: string; sourceUrl: string }>
  sources: Array<{ title: string; url: string; reliability: string }>
  confidence: number
  fetchedAt?: string
  searchEvidence?: Array<{
    query?: string
    title?: string
    snippet?: string
    url?: string
    publisher?: string
    publishedAt?: string
    reliability?: string
  }>
}

const PLACEHOLDERS = new Set([
  '',
  '待核验',
  '待核实',
  '未公开',
  '未披露',
  '未披露/待核实',
  '未披露/待验证',
  '未识别/待核实',
  '融资轮次待核实',
  '待工商核验',
  '主体待确认',
  '不适用',
  '无',
  '-',
  'N/A',
  'null',
])

export function meaningfulPublicIntelText(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const text = String(value).trim()
  if (!text || PLACEHOLDERS.has(text)) return ''
  if (/^(?:暂?未|尚未|无法|通常不).*(?:披露|公开|获取|识别|核验|确认|查询)/.test(text)) return ''
  if (/(?:未提及|没有提及|证据不足|无法判断)[。.]?$/.test(text)) return ''
  return text
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

function usefulObject(item: Record<string, unknown>, fields: string[]) {
  return fields.some((field) => meaningfulPublicIntelText(item[field]))
}

function dedupeObjects(
  items: Array<Record<string, unknown>>,
  keyOf: (item: Record<string, unknown>) => string | string[],
) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const rawKeys = keyOf(item)
    const keys = (Array.isArray(rawKeys) ? rawKeys : [rawKeys]).filter(Boolean)
    if (!keys.length || keys.some((key) => seen.has(key))) return false
    for (const key of keys) seen.add(key)
    return true
  })
}

function normalizedSourceIdentity(item: Record<string, unknown>) {
  const title = meaningfulPublicIntelText(item.title)
    .replace(/^(?:36氪|硬氪)?(?:首发|前线)?\s*[|｜丨:：-]\s*/i, '')
    .replace(/[\s“”"'「」『』|｜丨:：,，。！？!?·\-—_]/g, '')
    .toLocaleLowerCase()
  const keys: string[] = []
  if (title && !['公开信息来源', '来源证据', '雷达原文'].includes(title)) keys.push(`title:${title}`)
  const rawUrl = meaningfulPublicIntelText(item.url || item.sourceUrl)
  if (!rawUrl) return keys
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|from$|source$|ref$|refer$|share_|scene$|clicktime$|enterid$)/i.test(key)) {
        url.searchParams.delete(key)
      }
    }
    url.searchParams.sort()
    keys.push(`url:${url.toString().replace(/\/$/, '').toLocaleLowerCase()}`)
  } catch {
    keys.push(`url:${rawUrl.replace(/[?#].*$/, '').replace(/\/$/, '').toLocaleLowerCase()}`)
  }
  return keys
}

function mergeFundingRounds(existing: unknown, incoming: PublicIntelFundingRound[]) {
  const researched = incoming
    .map((item) => ({
      round: meaningfulPublicIntelText(item.round),
      date: meaningfulPublicIntelText(item.date),
      amount: meaningfulPublicIntelText(item.amount),
      valuation: meaningfulPublicIntelText(item.valuation),
      investors: meaningfulPublicIntelText(item.investors),
      sourceUrl: meaningfulPublicIntelText(item.sourceUrl),
    }))
    .filter((item) => usefulObject(item, ['round', 'date', 'amount', 'valuation', 'investors']))
    // 公开情报字段必须有来源；没有 URL 的具体融资数据不写回。
    .filter((item) => Boolean(item.sourceUrl))
  const current = objectArray(existing)
    .filter((item) => usefulObject(item, ['round', 'date', 'amount', 'valuation', 'investors']))
  return dedupeObjects([...researched, ...current], (item) => {
    const url = meaningfulPublicIntelText(item.sourceUrl)
    return url || [
      meaningfulPublicIntelText(item.round),
      meaningfulPublicIntelText(item.date),
      meaningfulPublicIntelText(item.amount),
    ].join('|')
  })
}

function mergeShareholders(existing: unknown, incoming: PublicIntelShareholder[]) {
  const researched = incoming
    .map((item) => ({
      name: meaningfulPublicIntelText(item.name),
      percentage: meaningfulPublicIntelText(item.percentage),
      type: meaningfulPublicIntelText(item.type),
      sourceUrl: meaningfulPublicIntelText(item.sourceUrl),
    }))
    .filter((item) => Boolean(item.name && item.sourceUrl))
  const current = objectArray(existing)
    .filter((item) => Boolean(meaningfulPublicIntelText(item.name)))
  return dedupeObjects([...researched, ...current], (item) => meaningfulPublicIntelText(item.name).toLocaleLowerCase())
}

function mergeCompetitors(existing: unknown, incoming: PublicIntelCompetitor[]) {
  const researched = incoming
    .map((item) => ({
      name: meaningfulPublicIntelText(item.name),
      is_self: false,
      tech: meaningfulPublicIntelText(item.tech),
      product: meaningfulPublicIntelText(item.product),
      funding: meaningfulPublicIntelText(item.funding),
      differentiation: meaningfulPublicIntelText(item.differentiation),
      matchType: item.matchType,
      sameTargetUser: item.sameTargetUser === true,
      sameUseCase: item.sameUseCase === true,
      sameDeliverable: item.sameDeliverable === true,
      comparisonBasis: meaningfulPublicIntelText(item.comparisonBasis),
      evidence: meaningfulPublicIntelText(item.evidence),
      sourceRef: meaningfulPublicIntelText(item.sourceRef),
      sourceUrl: meaningfulPublicIntelText(item.sourceUrl),
      confidence: Number(item.confidence),
      verificationStatus: item.verificationStatus,
    }))
    // 竞对是高风险事实：即使上游已校验，服务端写库前仍执行一次信任边界检查。
    .filter((item) => Boolean(
      item.name
      && item.verificationStatus === 'evidence-backed'
      && ['direct', 'substitute'].includes(item.matchType)
      && item.sameTargetUser
      && item.sameUseCase
      && item.sameDeliverable
      && item.comparisonBasis
      && item.evidence
      && item.sourceRef
      && item.sourceUrl
      && Number.isFinite(item.confidence)
      && item.confidence >= 0.8
    ))
  const current = objectArray(existing)
    .filter((item) => Boolean(meaningfulPublicIntelText(item.name)))
  return dedupeObjects([...researched, ...current], (item) => meaningfulPublicIntelText(item.name).toLocaleLowerCase())
}

function mergeSources(
  existing: unknown,
  intel: PublicIntelResult,
) {
  const accessedAt = formatShanghaiDateKey(new Date())
  const researched = [
    ...(intel.sources ?? []).map((item) => ({
      id: `public-${Buffer.from(item.url || item.title).toString('base64url').slice(0, 20)}`,
      title: meaningfulPublicIntelText(item.title) || '公开信息来源',
      url: meaningfulPublicIntelText(item.url),
      publisher: '公开来源',
      accessedAt,
      category: '第三方数据库',
      reliability: item.reliability === '高' || item.reliability === '中' ? item.reliability : '待核验',
      excerpt: '',
    })),
    ...(intel.companyNews ?? []).map((item) => ({
      id: `news-${Buffer.from(item.sourceUrl || item.title).toString('base64url').slice(0, 20)}`,
      title: meaningfulPublicIntelText(item.title),
      url: meaningfulPublicIntelText(item.sourceUrl),
      publisher: '公开来源',
      accessedAt,
      category: '权威媒体',
      reliability: '中',
      excerpt: meaningfulPublicIntelText(item.summary),
    })),
  ].filter((item) => Boolean(item.title && item.url))
  const current = objectArray(existing)
    .filter((item) => Boolean(meaningfulPublicIntelText(item.url)))
  return dedupeObjects([...researched, ...current], normalizedSourceIdentity)
}

type AppDatabase = typeof db

function buildLeadPublicIntelPatch(
  lead: typeof leads.$inferSelect,
  intel: PublicIntelResult,
) {
  const scoring = objectValue(lead.scoring)
  const registry = objectValue(scoring.registry)
  const registryPatch: Record<string, unknown> = { ...registry }
  const registryFields: Array<[string, unknown]> = [
    ['registeredCapital', intel.registeredCapital],
    ['legalRepresentative', intel.legalRepresentative],
    ['foundedAt', intel.foundedAt],
    ['regLocation', intel.region],
    ['registeredAddress', intel.registeredAddress],
  ]
  for (const [key, value] of registryFields) {
    const researched = meaningfulPublicIntelText(value)
    if (researched) registryPatch[key] = researched
  }

  const fundingRounds = mergeFundingRounds([
    ...objectArray(scoring.fundingRoundsResearched),
    ...objectArray(lead.fundingRounds),
  ], intel.fundingRounds ?? [])
  const structuredShareholders = mergeShareholders(scoring.structuredShareholders, intel.shareholders ?? [])
  const competitors = mergeCompetitors(scoring.competitors, intel.competitors ?? [])
  const sources = mergeSources(lead.sources, intel)
  const existingResearchSources = objectArray(scoring.researchSources)
  const researchSources = dedupeObjects([
    ...(intel.sources ?? []).map((item) => ({
      title: meaningfulPublicIntelText(item.title) || '公开信息来源',
      url: meaningfulPublicIntelText(item.url),
      excerpt: '',
    })).filter((item) => Boolean(item.url)),
    ...existingResearchSources,
  ], normalizedSourceIdentity)

  const scoringPatch = {
    ...scoring,
    registry: registryPatch,
    fundingRoundsResearched: fundingRounds,
    structuredShareholders,
    competitors,
    researchSources,
    publicIntelUpdatedAt: new Date().toISOString(),
  }
  const patch: Partial<typeof leads.$inferInsert> = {
    scoring: scoringPatch,
    fundingRounds,
    sources,
  }
  const regionResolution = resolveLeadBusinessRegion({
    registry: registryPatch,
    subjectName: lead.name,
    companyName: lead.companyName,
  })
  if (regionResolution) {
    patch.businessRegion = regionResolution.region
    patch.businessRegionSource = regionResolution.source
    patch.businessRegionConfidence = regionResolution.confidence
  }
  const positioning = meaningfulPublicIntelText(intel.positioning)
  if (positioning && !meaningfulPublicIntelText(lead.summary)) patch.summary = positioning.slice(0, 1000)

  return patch
}

async function mergeLeadPublicIntelRecord(
  leadId: string,
  intel: PublicIntelResult,
  userId: string | undefined,
  database: AppDatabase,
  action = '补充公开信息',
) {
  const [lead] = await database.select().from(leads).where(eq(leads.id, leadId)).limit(1).for('update')
  if (!lead) return null
  const proposed = buildLeadPublicIntelPatch(lead, intel)
  const patch = applyLeadFieldPolicy(
    lead as unknown as Record<string, unknown>,
    proposed as Record<string, unknown>,
    'public_intel',
    {
      additiveFields: ['fundingRounds', 'sources'],
      alwaysReplaceFields: ['scoring'],
      linkedFields: [['businessRegion', 'businessRegionSource', 'businessRegionConfidence']],
      operation: 'machine_refresh',
    },
  )
  if (Object.keys(patch).length) await database.update(leads).set(patch as never).where(eq(leads.id, leadId))
  const [updated] = await database.select().from(leads).where(eq(leads.id, leadId)).limit(1)
  if (updated) {
    await database.insert(auditLogs).values({
      userId: userId ?? null,
      userName: '（系统）',
      module: '项目获取池',
      action,
      target: updated.name,
    })
  }
  return updated
}

export async function mergeLeadPublicIntel(
  leadId: string,
  intel: PublicIntelResult,
  userId: string,
) {
  return await db.transaction(async (tx) => await mergeLeadPublicIntelRecord(leadId, intel, userId, tx as never))
}

function publicIntelSourceId(company: string) {
  return `company:${company.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`
}

export function leadPublicIntelRawEventInput(companyInput: string, intel: PublicIntelResult): LeadPipelineRawEventInput {
  const company = companyInput.normalize('NFKC').trim().replace(/\s+/g, ' ')
  return {
    sourceType: 'public-intel',
    sourceId: publicIntelSourceId(company),
    sourceOccurredAt: intel.fetchedAt || null,
    payload: { company, intel },
  }
}

function publicIntelLockName(company: string) {
  return `public-intel:${createHash('sha256').update(publicIntelSourceId(company)).digest('hex').slice(0, 48)}`
}

async function withPublicIntelLock<T>(company: string, action: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  const lockName = publicIntelLockName(company)
  let acquired = false
  try {
    const [rows] = await connection.query<Array<RowDataPacket & { acquired: number | null }>>(
      'SELECT GET_LOCK(?, 15) AS acquired',
      [lockName],
    )
    acquired = Number(rows[0]?.acquired) === 1
    if (!acquired) {
      throw Object.assign(new Error('公开情报线索提交互斥锁等待超时，请稍后重试'), {
        code: 'PUBLIC_INTEL_LOCK_TIMEOUT',
        retryable: true,
      })
    }
    return await action(connection)
  } finally {
    if (acquired) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined)
    connection.release()
  }
}

export type PublicIntelCommitResult = {
  status: 'created' | 'updated' | 'unchanged'
  lead: typeof leads.$inferSelect
  eventId: string
  replayed: boolean
  duplicateMatches: number
}

type PublicIntelAmbiguityError = Error & {
  code: 'PUBLIC_INTEL_ENTITY_AMBIGUOUS'
  retryable: false
  candidates: Array<typeof leads.$inferSelect>
  reviewStaged: boolean
  eventId?: string
  reviewId?: string
}

function publicIntelAmbiguityError(company: string, candidates: Array<typeof leads.$inferSelect>) {
  const error = Object.assign(new Error(`公开情报主体匹配到多条正式线索，必须人工指定目标: ${company}`), {
    code: 'PUBLIC_INTEL_ENTITY_AMBIGUOUS' as const,
    retryable: false as const,
    reviewStaged: false,
  }) as PublicIntelAmbiguityError
  Object.defineProperty(error, 'candidates', { value: candidates, enumerable: false })
  return error
}

/**
 * Host-owned public-intel commit boundary.
 *
 * The collector only returns evidence. The host records that immutable evidence and then,
 * on the same MySQL connection and transaction, creates/merges the formal lead, appends the
 * audit log and binds the Pipeline item to ready. An identical event replay returns the
 * already-bound lead without creating another lead, transition or audit row.
 */
export async function commitLeadPublicIntel(input: {
  company: string
  intel: PublicIntelResult
  userId?: string
  targetLeadId?: string
}): Promise<PublicIntelCommitResult> {
  const company = input.company.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!company) throw new Error('公开情报提交必须提供明确主体名称')
  return await withPublicIntelLock(company, async (connection) => {
    await connection.beginTransaction()
    try {
      const transactionDb = drizzle({ client: connection, schema, mode: 'default' }) as unknown as AppDatabase
      const rawInput = leadPublicIntelRawEventInput(company, input.intel)
      const captured = await recordLeadPipelineRawEvent(rawInput, connection)
      if (!captured.created && captured.item.status === 'ready' && captured.item.leadId) {
        const [replayedLead] = await transactionDb.select().from(leads)
          .where(eq(leads.id, captured.item.leadId))
          .limit(1)
        if (replayedLead) {
          await connection.commit()
          return {
            status: 'unchanged' as const,
            lead: replayedLead,
            eventId: captured.event.id,
            replayed: true,
            duplicateMatches: 0,
          }
        }
      }

      let matches: Array<typeof leads.$inferSelect>
      if (input.targetLeadId) {
        matches = await transactionDb.select().from(leads)
          .where(and(eq(leads.id, input.targetLeadId), ne(leads.poolStatus, '已合并')))
          .limit(1)
        if (!matches.length) throw new Error(`公开情报目标线索不存在: ${input.targetLeadId}`)
        const target = matches[0]
        if (target.name !== company && target.companyName !== company) {
          throw Object.assign(new Error(`公开情报目标线索与当前主体不一致: ${company}`), {
            code: 'PUBLIC_INTEL_TARGET_SUBJECT_MISMATCH',
            retryable: false,
          })
        }
        if (target.poolStatus === '已转专属项目') {
          throw Object.assign(new Error(`公开情报目标线索已转为专属项目，不能继续合并: ${company}`), {
            code: 'PUBLIC_INTEL_TARGET_TERMINAL',
            retryable: false,
          })
        }
      } else {
        matches = await transactionDb.select().from(leads)
          .where(and(or(eq(leads.name, company), eq(leads.companyName, company)), ne(leads.poolStatus, '已合并')))
          .orderBy(asc(leads.createdAt), asc(leads.id))
        if (matches.length > 1) {
          throw publicIntelAmbiguityError(company, matches)
        }
      }

      let status: PublicIntelCommitResult['status'] = 'updated'
      let lead = matches[0]
      if (!lead) {
        const confidence = Math.max(0, Math.min(100, Math.round(Number(input.intel.confidence || 0) * 100)))
        const createValues = {
          name: company.slice(0, 128),
          companyName: company.slice(0, 128),
          industry: '待核验',
          source: '公开情报采集（主服务）',
          poolStatus: confidence > 0 ? '成功' : '待处理',
          score: confidence,
          radarProfile: { qualityRejected: false },
        }
        const [inserted] = await transactionDb.insert(leads).values({
          ...createValues,
          fieldProvenance: initialLeadFieldProvenance(createValues, 'public_intel'),
        }).$returningId()
        const [created] = await transactionDb.select().from(leads).where(eq(leads.id, inserted.id)).limit(1)
        if (!created) throw new Error(`公开情报正式线索创建失败: ${company}`)
        lead = created
        status = 'created'
      }

      const updated = await mergeLeadPublicIntelRecord(
        lead.id,
        input.intel,
        input.userId,
        transactionDb,
        status === 'created' ? '采集公开信息' : '补充公开信息',
      )
      if (!updated) throw new Error(`公开情报正式线索提交失败: ${company}`)
      const evidence = (input.intel.sources ?? []).slice(0, 10).map((source) => ({
        title: source.title,
        sourceUrl: source.url,
        reliability: source.reliability,
      }))
      const transitioned = await transitionLeadPipelineItem(captured.event.id, {
        status: 'ready',
        reason: 'host validated public-intel evidence and committed formal lead',
        evidence,
        confidence: Math.max(0, Math.min(100, Math.round(Number(input.intel.confidence || 0) * 100))),
        leadId: updated.id,
        actorType: 'system',
        actorId: 'public-intel-host',
      }, connection)
      if (transitioned.blocked || transitioned.item.leadId !== updated.id) {
        throw new Error('公开情报 Pipeline ready 状态未绑定正式线索')
      }
      await recordLeadPipelineEntityMatch({
        idempotencyKey: `${captured.event.id}:public-intel-entity-resolution:${updated.id}:v1`,
        eventId: captured.event.id,
        subjectType: 'company',
        subjectName: company,
        matchType: input.targetLeadId ? 'manual_target' : matches.length ? 'company_name' : 'no_match',
        candidateLeadId: updated.id,
        candidateName: updated.name,
        candidateCompanyName: updated.companyName,
        score: 10_000,
        status: status === 'created' ? 'created' : 'selected',
        resolutionType: status === 'created' ? 'created' : input.targetLeadId ? 'manual' : 'automatic',
        aliases: [company, updated.name, updated.companyName ?? ''].filter(Boolean),
        metadata: { commitStatus: status },
      }, connection)
      await connection.commit()
      return {
        status,
        lead: updated,
        eventId: captured.event.id,
        replayed: false,
        duplicateMatches: Math.max(0, matches.length - 1),
      }
    } catch (error) {
      await connection.rollback()
      const ambiguity = error as Partial<PublicIntelAmbiguityError>
      if (ambiguity.code === 'PUBLIC_INTEL_ENTITY_AMBIGUOUS') {
        const reason = `公开情报主体“${company}”匹配到多条正式线索，必须人工选择合并目标`
        await connection.beginTransaction()
        try {
          const captured = await recordLeadPipelineRawEvent(leadPublicIntelRawEventInput(company, input.intel), connection)
          const decision = await recordLeadPipelineDecision({
            idempotencyKey: `${captured.event.id}:public-intel-entity-ambiguity:v1`,
            eventId: captured.event.id,
            decisionType: 'entity_resolution',
            outcome: 'review',
            subjectType: 'company',
            subjectName: company,
            confidence: Math.max(0, Math.min(100, Math.round(Number(input.intel.confidence || 0) * 100))),
            reason,
            output: { duplicateMatches: Math.max(1, (ambiguity.candidates?.length ?? 2) - 1) },
            actorType: 'system',
            actorId: 'public-intel-entity-resolution',
            evidence: [{ sourceType: 'public-intel', claim: reason, verificationStatus: 'conflicted' }],
          }, connection)
          const review = await openLeadPipelineReview({
            idempotencyKey: `${captured.event.id}:public-intel-entity-ambiguity:v1`,
            eventId: captured.event.id,
            triggerDecisionId: decision.id,
            reason,
          }, connection)
          for (const candidate of ambiguity.candidates ?? []) {
            await recordLeadPipelineEntityMatch({
              idempotencyKey: `${captured.event.id}:public-intel-entity-ambiguity:${candidate.id}:v1`,
              eventId: captured.event.id,
              decisionId: decision.id,
              reviewId: review.id,
              subjectType: 'company',
              subjectName: company,
              matchType: 'company_name',
              candidateLeadId: candidate.id,
              candidateName: candidate.name,
              candidateCompanyName: candidate.companyName,
              score: 10_000,
              status: 'ambiguous',
              metadata: { poolStatus: candidate.poolStatus },
            }, connection)
          }
          const transitioned = await transitionLeadPipelineItem(captured.event.id, {
            status: 'review',
            reason,
            confidence: decision.confidence,
            actorType: 'system',
            actorId: 'public-intel-entity-resolution',
          }, connection)
          if (transitioned.blocked || transitioned.item.status !== 'review' || transitioned.item.leadId) {
            throw new Error('公开情报歧义复核状态未保持为未绑定 Lead')
          }
          await connection.commit()
          ambiguity.reviewStaged = true
          ambiguity.eventId = captured.event.id
          ambiguity.reviewId = review.id
        } catch (reviewError) {
          await connection.rollback()
          throw reviewError
        }
      }
      throw error
    }
  })
}
