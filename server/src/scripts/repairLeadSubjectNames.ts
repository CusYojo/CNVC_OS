import { and, eq, gte, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads } from '../db/schema.js'
import {
  deriveRadarSubjectName,
  isBetterLeadSubjectName,
  isLowValueRadarContent,
  isNonInvestableRadarContent,
  isSpecificLeadSubjectName,
} from '../services/leadSubjectName.js'

const SUBJECT_MARKER_RE = /(?:股份有限公司|有限责任公司|有限公司|公司|企业|项目|团队|实验室|研究院|研究所|研究中心|工程中心|课题组|创新群体|创新联合体|中试基地|产业基地|创新平台|技术平台|研发平台|试验平台|装置|系统|产品|计划)$/

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function firstSourceTitle(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const source = asRecord(value[0])
  return typeof source.title === 'string' ? source.title.trim() : ''
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isClearlyBadName(name: string): boolean {
  // 名称未通过当前 isSpecificLeadSubjectName 检查（新的 GENERIC_SUBJECTS/长度规则等）
  if (!isSpecificLeadSubjectName(name)) return true
  return (
    /[？！。！]/.test(name) ||
    /^(?:19|20)\d{2}[年\s]/.test(name) ||
    /^\d+[月日年个只家项位次]/.test(name) ||
    (/^[A-Za-z0-9\s:,\-()]+$/.test(name) && name.length > 25) ||
    (/(?:如何|为什么|是否|怎么|怎样|什么)/.test(name) && !SUBJECT_MARKER_RE.test(name)) ||
    (/\d+\s*[家个]/.test(name) && /(?:企业|公司|融资|上市)/.test(name)) ||
    // 短中文名（2-3字）无主体标记
    (name.length < 4 && !SUBJECT_MARKER_RE.test(name) && !/[A-Za-z]/.test(name)) ||
    // 新闻标题：含融资/估值/亿元+长句或逗号
    (/(?:融资|估值|(?:万亿|亿元)|万美元|上市|IPO|登陆|完成.{0,8}轮|获得.{0,8}投)/.test(name) &&
     (name.length > 10 || /[，,、]/.test(name))) ||
    // 纯英文小写开头长片段
    (/^[a-z]/.test(name) && /^[A-Za-z0-9\s:,\-()]+$/.test(name) && name.length > 25)
  )
}

async function main() {
  const apply = process.argv.includes('--apply')
  const sinceArg = process.argv.find((value) => value.startsWith('--since='))
  const sinceValue = sinceArg?.slice('--since='.length)
  const since = sinceValue ? new Date(sinceValue) : null
  if (sinceValue && Number.isNaN(since?.getTime())) {
    throw new Error(`invalid --since timestamp: ${sinceValue}`)
  }
  if (apply && !since) {
    throw new Error('--apply requires --since=<ISO timestamp> to prevent an unbounded repair')
  }
  const radarSourceCondition = sql`COALESCE(${leads.source}, '') ~ '^项目发现雷达'`
  const rows = await db.select().from(leads)
    .where(since
      ? and(radarSourceCondition, gte(leads.createdAt, since))
      : radarSourceCondition)
  const changes: Array<{
    id: string
    current: string
    next: string
    radarProfile: Record<string, unknown>
    clearCompanyName: boolean
    reject: boolean
    reason: string
  }> = []

  for (const row of rows) {
    const radarProfile = asRecord(row.radarProfile)
    const profile = asRecord(radarProfile.profile)
    const scoring = asRecord(row.scoring)
    const registry = asRecord(scoring.registry)
    const sourceTitle = String(radarProfile.sourceTitle || firstSourceTitle(row.sources)).trim()
    const channel = String(radarProfile.channel ?? '')
    const next = deriveRadarSubjectName({
      isPaper: channel === '论文',
      companyNames: [registry.companyName, row.companyName, profile.companyName],
      projectName: profile.projectName,
      lab: profile.lab,
      team: profile.teamComposition || row.team,
      title: sourceTitle || row.name,
      articleText: radarProfile.articleText || row.summary,
      excludedNames: [radarProfile.sourceName, radarProfile.accountName],
      channel,
    })

    const currentIsClearlyBad = isClearlyBadName(row.name)
    const evidenceText = `${sourceTitle}\n${String(row.summary ?? '').slice(0, 2400)}`
    const hasInvestmentEvidence = /(?:(?:完成|宣布|获得|获|拿到).{0,20}(?:融资|投资)|(?:融资|投资).{0,20}(?:领投|跟投|交割)|估值.{0,12}(?:亿元|万美元|亿美元|万元))/i.test(evidenceText)
      || /(?:天使|种子|Pre-?A|A\+?轮|A1|B\+?轮|C\+?轮|D轮|E轮|Pre-?IPO|战略投资|战略融资|新一轮融资)/i.test(String(profile.projectRound ?? ''))
    const nonInvestable = isNonInvestableRadarContent({
      hasCompanySubject: isSpecificLeadSubjectName(registry.companyName)
        || isSpecificLeadSubjectName(row.companyName)
        || isSpecificLeadSubjectName(profile.companyName),
      hasInvestmentEvidence,
      subjectName: next || row.name,
      values: [
        sourceTitle,
        row.summary,
        profile.projectName,
        profile.coreHighlights,
        profile.teamComposition,
      ],
    })
    const clearCompanyName = String(row.companyName ?? '').trim() === row.name
      && !/(?:股份有限公司|有限责任公司|有限公司)$/.test(String(row.companyName ?? ''))

    if (nonInvestable || !next || !isSpecificLeadSubjectName(next)) {
      const nextRadarProfile = {
        ...radarProfile,
        qualityRejected: true,
        qualityRejectReason: nonInvestable ? '非单一可投资线索' : '无法确认明确主体名称',
      }
      const alreadyRejected = radarProfile.qualityRejected === true
      if (!alreadyRejected) {
        changes.push({
          id: row.id,
          current: row.name,
          next: row.name,
          radarProfile: nextRadarProfile,
          clearCompanyName: false,
          reject: true,
          reason: String(nextRadarProfile.qualityRejectReason),
        })
      }
      continue
    }

    if (next === row.name) continue
    const currentIsLegalCompany = /(?:股份有限公司|有限责任公司|有限公司)$/.test(row.name)
    const currentIsImportedInference = (
      currentIsClearlyBad
      || String(profile.projectName ?? '').trim() === row.name
      || String(row.companyName ?? '').trim() === row.name
    )
    if (currentIsLegalCompany || !currentIsImportedInference) continue

    const escapedNext = escapeRegex(next)
    const verifiedTitle = (
      /北航机器人所团队创业.{0,24}智能变刚度关节/.test(sourceTitle)
      || /清华系初创完成数亿元种子轮融资.{0,30}世界模型/.test(sourceTitle)
      || /前大疆科学家创业.{0,30}(?:四轮|耀途资本|锦秋基金)/.test(sourceTitle)
    )
    const directFinancingEvidence = new RegExp(
      `${escapedNext}.{0,48}(?:完成|获得|获|宣布|官宣|融资|投资)|(?:投资|融资).{0,24}${escapedNext}`,
      'i',
    ).test(evidenceText)
    const explicitSubjectEvidence = evidenceText.replace(/\s+/g, '').toLowerCase()
      .includes(next.replace(/\s+/g, '').toLowerCase())
      && hasInvestmentEvidence
    const primaryFinancingTitle = /(?:(?:完成|获得|获|宣布|官宣).{0,40}(?:融资|投资)|(?:融资|投资).{0,28}(?:完成|领投|跟投|亿元|万元|美元|天使轮|种子轮|pre-?a|a轮|b轮|c轮|d轮)|估值.{0,20}(?:亿元|万美元|亿美元|万元))/i.test(sourceTitle)
      && !/(?:\d+\s*家|多家).{0,30}(?:企业|公司).{0,30}(?:融资|投资)|上市|港交所|IPO|获奖|荣誉|表彰|党组织/i.test(sourceTitle)
    const quotedTitleEvidence = new RegExp(
      `[「『“"]${escapedNext}[」』”"][^「『“"]{0,36}(?:完成|获得|获|融资|投资)`,
      'i',
    ).test(sourceTitle)
    const containedProjectUpgrade = isSpecificLeadSubjectName(row.name)
      && isBetterLeadSubjectName(row.name, next)
    const lowValueSource = isLowValueRadarContent(sourceTitle)
    if (
      lowValueSource
      || (
        !verifiedTitle
        && !explicitSubjectEvidence
        && !(primaryFinancingTitle && directFinancingEvidence)
        && !quotedTitleEvidence
        && !containedProjectUpgrade
      )
    ) {
      continue
    }

    const nextRadarProfile = {
      ...radarProfile,
      qualityRejected: false,
      qualityRejectReason: '',
      profile: { ...profile, projectName: next },
    }
    changes.push({
      id: row.id,
      current: row.name,
      next,
      radarProfile: nextRadarProfile,
      clearCompanyName,
      reject: false,
      reason: '使用当前标题/正文中的明确主体',
    })
  }

  for (const change of changes) {
    console.log(`${change.reject ? '[reject]' : '[rename]'} ${change.current} -> ${change.next} (${change.reason})`)
    if (!apply) continue
    await db.update(leads).set({
      ...(change.reject ? {} : { name: change.next }),
      radarProfile: change.radarProfile,
      ...(change.clearCompanyName ? { companyName: null } : {}),
    }).where(eq(leads.id, change.id))
  }

  console.log(`${apply ? 'updated' : 'preview'}=${changes.length}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
