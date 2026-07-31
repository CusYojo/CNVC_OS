import { eq, and, inArray, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads } from '../db/schema.js'
import {
  mergeNonEmptyValue,
  mergeUniqueValues,
  mergeRadarSources,
  mergeRadarFundingRounds,
  isMeaningfulRadarValue,
} from '../services/leadRadarMerge.js'

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function firstMeaningfulString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() && isMeaningfulRadarValue(value)) {
      return value
    }
  }
  return null
}

async function main() {
  const apply = process.argv.includes('--apply')

  // 找出所有重复 name
  const duplicates = await db.execute<{ name: string }>(sql`
    SELECT name FROM leads
    WHERE pool_status != '已转专属项目'
    GROUP BY name
    HAVING COUNT(*) > 1
    ORDER BY name
  `)

  if (!duplicates.rows.length) {
    console.log(JSON.stringify({ status: 'clean', message: '没有重复数据' }))
    await pool.end()
    return
  }

  const duplicateNames = duplicates.rows.map((r) => r.name)

  console.log(JSON.stringify({
    mode: apply ? 'applied' : 'preview',
    duplicateNames: duplicates.rows.length,
    names: duplicateNames.slice(0, 20),
    message: `发现 ${duplicates.rows.length} 个重复名称`,
  }))

  // 按 name 查出所有重复记录
  const allDupRows = await db.select().from(leads)
    .where(and(
      inArray(leads.name, duplicateNames),
      sql`${leads.poolStatus} != '已转专属项目'`,
    ))
    .orderBy(leads.createdAt)

  // 按 name 分组
  const groups = new Map<string, (typeof leads.$inferSelect)[]>()
  for (const row of allDupRows) {
    const list = groups.get(row.name) || []
    list.push(row)
    groups.set(row.name, list)
  }

  let totalDeleted = 0
  let totalMerged = 0
  const results: Array<Record<string, unknown>> = []

  for (const [name, rows] of groups) {
    if (rows.length < 2) continue
    const keeper = rows[0] // 最早创建
    const younger = rows.slice(1)

    // 合并 radarSourceKeys
    let mergedSourceKeys: unknown[] = (keeper.radarSourceKeys ?? []) as unknown[]
    for (const row of younger) {
      mergedSourceKeys = mergeUniqueValues(mergedSourceKeys, row.radarSourceKeys ?? [])
    }

    // 合并 sources
    let mergedSources: unknown[] = (keeper.sources ?? []) as unknown[]
    for (const row of younger) {
      mergedSources = mergeRadarSources(mergedSources, row.sources ?? [])
    }

    // 合并 fundingRounds
    let mergedFundingRounds: unknown[] = (keeper.fundingRounds ?? []) as unknown[]
    for (const row of younger) {
      mergedFundingRounds = mergeRadarFundingRounds(mergedFundingRounds, row.fundingRounds ?? [])
    }

    // 合并 highlights / risks / riskTags
    let mergedHighlights: unknown[] = (keeper.highlights ?? []) as unknown[]
    let mergedRisks: unknown[] = (keeper.risks ?? []) as unknown[]
    let mergedRiskTags: unknown[] = (keeper.riskTags ?? []) as unknown[]
    for (const row of younger) {
      mergedHighlights = mergeUniqueValues(mergedHighlights, row.highlights ?? [])
      mergedRisks = mergeUniqueValues(mergedRisks, row.risks ?? [])
      mergedRiskTags = mergeUniqueValues(mergedRiskTags, row.riskTags ?? [])
    }

    // 合并 radarProfile
    let mergedRadarProfile: unknown = keeper.radarProfile ?? null
    for (const row of younger) {
      if (row.radarProfile) {
        mergedRadarProfile = mergeNonEmptyValue(mergedRadarProfile, row.radarProfile)
      }
    }

    // 拼 patch
    const patch: Record<string, unknown> = {}

    if (!sameValue(keeper.radarSourceKeys ?? [], mergedSourceKeys)) {
      patch.radarSourceKeys = (mergedSourceKeys as Array<unknown>).filter(
        (v): v is string => typeof v === 'string' && v.trim().length > 0,
      )
    }
    if (!sameValue(keeper.sources ?? [], mergedSources)) patch.sources = mergedSources
    if (!sameValue(keeper.fundingRounds ?? [], mergedFundingRounds)) patch.fundingRounds = mergedFundingRounds
    if (!sameValue(keeper.highlights ?? [], mergedHighlights)) patch.highlights = mergedHighlights
    if (!sameValue(keeper.risks ?? [], mergedRisks)) patch.risks = mergedRisks
    if (!sameValue(keeper.riskTags ?? [], mergedRiskTags)) patch.riskTags = mergedRiskTags
    if (!sameValue(keeper.radarProfile ?? null, mergedRadarProfile)) patch.radarProfile = mergedRadarProfile

    // 补齐空字段
    const betterCompany = firstMeaningfulString(
      keeper.companyName,
      ...younger.map((r) => r.companyName),
    )
    if (betterCompany && !sameValue(keeper.companyName, betterCompany)) patch.companyName = betterCompany

    const betterSummary = firstMeaningfulString(
      keeper.summary,
      ...younger.map((r) => r.summary),
    )
    if (betterSummary && !sameValue(keeper.summary, betterSummary)) patch.summary = betterSummary

    const betterTeam = firstMeaningfulString(
      keeper.team,
      ...younger.map((r) => r.team),
    )
    if (betterTeam && !sameValue(keeper.team, betterTeam)) patch.team = betterTeam

    const maxScore = Math.max(keeper.score, ...younger.map((r) => r.score))
    if (maxScore !== keeper.score) patch.score = maxScore

    const betterIndustry = firstMeaningfulString(
      keeper.industry,
      ...younger.map((r) => r.industry),
    )
    if (betterIndustry && !sameValue(keeper.industry, betterIndustry)) patch.industry = betterIndustry

    // 保 scoring: 如 keeper 无评分但 younger 有
    if (!keeper.scoring || Object.keys(keeper.scoring as object).length === 0) {
      for (const row of younger) {
        if (row.scoring && typeof row.scoring === 'object' && Object.keys(row.scoring as object).length > 0) {
          patch.scoring = row.scoring
          break
        }
      }
    }

    const youngerIds = younger.map((r) => r.id)
    const mergedFields = Object.keys(patch)

    results.push({
      name,
      keeperId: keeper.id,
      mergedCount: younger.length,
      deletedIds: youngerIds,
      mergedFields,
    })

    if (apply) {
      if (Object.keys(patch).length > 0) {
        await db.update(leads).set(patch as never).where(eq(leads.id, keeper.id))
      }
      await db.delete(leads).where(inArray(leads.id, youngerIds as [string, ...string[]]))
      totalDeleted += younger.length
      totalMerged += 1
    } else {
      totalDeleted += younger.length
      totalMerged += 1
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'applied' : 'preview',
    mergedGroups: totalMerged,
    deletedRecords: totalDeleted,
    details: results.slice(0, 20),
    detailCount: results.length,
  }))

  await pool.end()
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    // pool ended in main
  })
