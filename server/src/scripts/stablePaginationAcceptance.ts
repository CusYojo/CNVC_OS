import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

assertIsolatedMysqlAcceptanceDatabase('stablePaginationAcceptance')

const [{ db, pool }, { ensureSchema }, { leads, projects }, { listLeads }, { listProjects }] = await Promise.all([
  import('../db/client.js'),
  import('../db/migrate.js'),
  import('../db/schema.js'),
  import('../services/aiSummaryService.js'),
  import('../services/projectService.js'),
])

const fixtureSize = 7
const pageSize = 3

function assertStablePages(
  label: string,
  first: string[],
  second: string[],
  expectedIds: string[],
): void {
  assert.deepEqual(second, first, `${label} changed order across identical repeated reads`)
  assert.equal(first.length, expectedIds.length, `${label} omitted rows across pages`)
  assert.equal(new Set(first).size, first.length, `${label} duplicated rows across pages`)
  assert.deepEqual(new Set(first), new Set(expectedIds), `${label} returned a different fixture set`)
}

async function projectPages(keyword: string): Promise<string[]> {
  const pages = await Promise.all([1, 2, 3].map((page) => listProjects({ keyword, page, pageSize })))
  for (const result of pages) {
    assert.equal(result.total, fixtureSize, 'project pagination total changed')
    assert.equal(result.counts.normal, fixtureSize, 'project normal classification count changed')
    assert.equal(result.counts.key, 0, 'project key classification count changed')
  }
  return pages.flatMap((result) => result.list.map((row) => row.id))
}

async function leadPages(keyword: string, sort?: string): Promise<string[]> {
  const pages = await Promise.all([1, 2, 3].map((page) => listLeads({ keyword, sort, page, pageSize })))
  for (const result of pages) assert.equal(result.total, fixtureSize, 'lead pagination total changed')
  return pages.flatMap((result) => result.list.map((row) => row.id))
}

async function main(): Promise<void> {
  await ensureSchema()
  const marker = `page-${randomUUID()}`
  const projectIds = Array.from({ length: fixtureSize }, () => randomUUID())
  const leadIds = Array.from({ length: fixtureSize }, () => randomUUID())
  const tiedAt = new Date('2026-08-10T08:08:08.888Z')
  const reviewService = await readFile(
    path.resolve(process.cwd(), 'server/src/services/leadPipelineReviewService.ts'),
    'utf8',
  )

  try {
    await db.insert(projects).values(projectIds.map((id, index) => ({
      id,
      name: `${marker}-project-${index}`,
      owner: 'pagination-acceptance',
      pinned: true,
      createdAt: tiedAt,
      updatedAt: tiedAt,
    })))
    const leadFixtures = leadIds.map((id, index) => ({
      id,
      name: `${marker}-lead-${index}`,
      source: 'pagination-acceptance',
      poolStatus: '成功',
      score: 77,
      scoring: { total: 77 },
      industry: ['空间计算', '人工智能', '医疗健康', '机器人', '软件工程', '新能源', '教育'][index],
      businessRegion: index === 0 ? '北京' : index === 1 ? '上海' : null,
      businessRegionSource: index <= 1 ? 'acceptance-fixture' : null,
      businessRegionConfidence: index <= 1 ? '高' : null,
      team: index === 2 ? `${marker}-team-unique` : null,
      fundingRounds: index === 2
        ? [{ round: 'Pre-B轮' }]
        : index === 4
          ? [{ round: '股权融资' }]
          : index === 5
            ? [{ round: '新一轮融资' }]
            : [],
      radarProfile: index === 0
        ? {
            profile: {
              region: '上海',
              regionSource: 'acceptance-derived-conflict',
              regionConfidence: '高',
            },
          }
        : index === 3
          ? {
              channel: '论文',
              paperMeta: { titleZh: `${marker}-paper` },
              profile: {
                region: '广东',
                regionSource: 'acceptance-derived-without-authoritative-value',
                regionConfidence: '高',
              },
            }
          : {},
      createdAt: tiedAt,
    }))
    await db.insert(leads).values(leadFixtures)

    const firstProjects = await projectPages(marker)
    const secondProjects = await projectPages(marker)
    assertStablePages('project pagination', firstProjects, secondProjects, projectIds)

    const firstLeadsByTime = await leadPages(marker)
    const secondLeadsByTime = await leadPages(marker)
    assertStablePages('lead time pagination', firstLeadsByTime, secondLeadsByTime, leadIds)

    const firstLeadsByScore = await leadPages(marker, 'score')
    const secondLeadsByScore = await leadPages(marker, 'score')
    assertStablePages('lead score pagination', firstLeadsByScore, secondLeadsByScore, leadIds)

    const other = await listLeads({ keyword: marker, industry: '其他', page: 1, pageSize: 20 })
    assert.equal(other.total, 1)
    assert.deepEqual(other.list.map((lead) => lead.id), [leadIds[0]])
    assert.ok(other.list[0]?.businessTags.industry.includes('其他'))

    const beijing = await listLeads({ keyword: marker, region: '北京', page: 1, pageSize: 20 })
    assert.equal(beijing.total, 1)
    assert.equal(beijing.list[0]?.id, leadIds[0])
    assert.equal(beijing.list[0]?.region, '北京')

    const shanghai = await listLeads({ keyword: marker, region: '上海', page: 1, pageSize: 20 })
    assert.equal(shanghai.total, 1)
    assert.deepEqual(shanghai.list.map((lead) => lead.id), [leadIds[1]])

    const guangdong = await listLeads({ keyword: marker, region: '广东', page: 1, pageSize: 20 })
    assert.equal(guangdong.total, 0)
    const researchLead = (await listLeads({ keyword: marker, stage: '科研成果', page: 1, pageSize: 20 })).list[0]
    assert.equal(researchLead?.id, leadIds[3])
    assert.equal(researchLead?.region, '待确认')

    const team = await listLeads({ keyword: `${marker}-team-unique`, page: 1, pageSize: 20 })
    assert.equal(team.total, 1)
    assert.equal(team.list[0]?.id, leadIds[2])

    const preB = await listLeads({ keyword: marker, stage: 'Pre-B轮', page: 1, pageSize: 20 })
    assert.equal(preB.total, 1)
    assert.equal(preB.list[0]?.id, leadIds[2])

    const undisclosedEquity = await listLeads({
      keyword: marker,
      stage: '股权融资/轮次未披露',
      page: 1,
      pageSize: 20,
    })
    assert.equal(undisclosedEquity.total, 2)
    assert.deepEqual(new Set(undisclosedEquity.list.map((lead) => lead.id)), new Set([leadIds[4], leadIds[5]]))

    const combined = await listLeads({
      keyword: marker,
      industry: '其他',
      region: '北京',
      page: 1,
      pageSize: 20,
    })
    assert.equal(combined.total, 1)
    assert.equal(combined.list[0]?.id, leadIds[0])

    await db.delete(leads).where(inArray(leads.id, leadIds.slice(4)))
    const shrunken = await listLeads({ keyword: marker, page: 3, pageSize })
    assert.equal(shrunken.total, 4)
    assert.equal(shrunken.totalPages, 2)
    assert.equal(shrunken.page, 2)
    assert.equal(shrunken.list.length, 1)

    assert.match(
      reviewService,
      /ORDER BY CASE WHEN r\.status='pending' THEN 0 ELSE 1 END, r\.created_at ASC, r\.id ASC\s+LIMIT \? OFFSET \?/,
      'lead review pagination must end with a unique id ordering key',
    )

    console.log(JSON.stringify({
      ok: true,
      fixtureRowsPerDomain: fixtureSize,
      pageSize,
      checks: [
        'project-pagination-tied-sort-values-use-unique-id-without-duplicates-or-omissions',
        'project-pagination-classification-counts-share-filter-scope',
        'lead-created-time-pagination-ties-use-unique-id-and-repeat-stably',
        'lead-score-pagination-ties-use-unique-id-and-repeat-stably',
        'lead-filtered-pagination-shrink-returns-new-final-page',
        'lead-other-industry-display-and-filter-sets-match',
        'lead-authoritative-region-wins-derived-conflicts-and-empty-values-stay-unconfirmed',
        'lead-direct-team-keyword-matches',
        'lead-pre-b-equity-and-undisclosed-round-stage-filters-match',
        'lead-combined-filters-use-and-semantics',
        'lead-review-pagination-order-ends-in-unique-id',
      ],
    }))
  } finally {
    await db.delete(leads).where(inArray(leads.id, leadIds)).catch(() => undefined)
    await db.delete(projects).where(inArray(projects.id, projectIds)).catch(() => undefined)
    const [remainingLeads, remainingProjects] = await Promise.all([
      db.select({ id: leads.id }).from(leads).where(inArray(leads.id, leadIds)),
      db.select({ id: projects.id }).from(projects).where(inArray(projects.id, projectIds)),
    ])
    assert.equal(remainingLeads.length, 0, 'lead pagination fixtures were not cleaned')
    assert.equal(remainingProjects.length, 0, 'project pagination fixtures were not cleaned')
  }
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => pool.end())
