import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { leads, projects } from '../db/schema.js'
import { listLeads } from '../services/aiSummaryService.js'
import { listProjects } from '../services/projectService.js'

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
  for (const result of pages) assert.equal(result.total, fixtureSize, 'project pagination total changed')
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
    await db.insert(leads).values(leadIds.map((id, index) => ({
      id,
      name: `${marker}-lead-${index}`,
      source: 'pagination-acceptance',
      poolStatus: '成功',
      score: 77,
      scoring: { total: 77 },
      createdAt: tiedAt,
    })))

    const firstProjects = await projectPages(marker)
    const secondProjects = await projectPages(marker)
    assertStablePages('project pagination', firstProjects, secondProjects, projectIds)

    const firstLeadsByTime = await leadPages(marker)
    const secondLeadsByTime = await leadPages(marker)
    assertStablePages('lead time pagination', firstLeadsByTime, secondLeadsByTime, leadIds)

    const firstLeadsByScore = await leadPages(marker, 'score')
    const secondLeadsByScore = await leadPages(marker, 'score')
    assertStablePages('lead score pagination', firstLeadsByScore, secondLeadsByScore, leadIds)

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
        'lead-created-time-pagination-ties-use-unique-id-and-repeat-stably',
        'lead-score-pagination-ties-use-unique-id-and-repeat-stably',
        'lead-review-pagination-order-ends-in-unique-id',
      ],
    }))
  } finally {
    await db.delete(leads).where(inArray(leads.id, leadIds)).catch(() => undefined)
    await db.delete(projects).where(inArray(projects.id, projectIds)).catch(() => undefined)
    await pool.end()
  }
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
