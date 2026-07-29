import { eq, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads } from '../db/schema.js'
import {
  deriveRadarSubjectName,
  isBetterLeadSubjectName,
  isLowValueRadarContent,
  isSpecificLeadSubjectName,
} from '../services/leadSubjectName.js'

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

async function main() {
  const apply = process.argv.includes('--apply')
  const rows = await db.select().from(leads)
    .where(sql`COALESCE(${leads.source}, '') ~ '^项目发现雷达'`)
  const changes: Array<{
    id: string
    current: string
    next: string
    radarProfile: Record<string, unknown>
    clearCompanyName: boolean
  }> = []

  for (const row of rows) {
    const radarProfile = asRecord(row.radarProfile)
    const profile = asRecord(radarProfile.profile)
    const scoring = asRecord(row.scoring)
    const registry = asRecord(scoring.registry)
    const sourceTitle = String(radarProfile.sourceTitle || firstSourceTitle(row.sources)).trim()
    const next = deriveRadarSubjectName({
      isPaper: String(radarProfile.channel ?? '') === '论文',
      companyNames: [registry.companyName, row.companyName, profile.companyName],
      projectName: profile.projectName,
      lab: profile.lab,
      team: profile.teamComposition || row.team,
      title: sourceTitle || row.name,
      articleText: radarProfile.articleText || row.summary,
      excludedNames: [radarProfile.sourceName, radarProfile.accountName],
    })
    if (!next || next === row.name || !isSpecificLeadSubjectName(next)) continue

    const currentIsLegalCompany = /(?:股份有限公司|有限责任公司|有限公司)$/.test(row.name)
    const currentIsImportedInference = (
      !isSpecificLeadSubjectName(row.name)
      || String(profile.projectName ?? '').trim() === row.name
      || String(row.companyName ?? '').trim() === row.name
    )
    if (currentIsLegalCompany || !currentIsImportedInference) continue

    const evidenceText = `${sourceTitle}\n${String(row.summary ?? '').slice(0, 2400)}`
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
        && !(primaryFinancingTitle && directFinancingEvidence)
        && !quotedTitleEvidence
        && !containedProjectUpgrade
      )
    ) {
      continue
    }

    const clearCompanyName = String(row.companyName ?? '').trim() === row.name
      && !/(?:股份有限公司|有限责任公司|有限公司)$/.test(String(row.companyName ?? ''))
    const nextRadarProfile = {
      ...radarProfile,
      profile: { ...profile, projectName: next },
    }
    changes.push({
      id: row.id,
      current: row.name,
      next,
      radarProfile: nextRadarProfile,
      clearCompanyName,
    })
  }

  for (const change of changes) {
    console.log(`${change.current} -> ${change.next}`)
    if (!apply) continue
    await db.update(leads).set({
      name: change.next,
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
