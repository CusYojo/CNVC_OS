import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../db/client.js'
import { auditLogs, knowledgeChunks, leads } from '../db/schema.js'
import { syncRadarLeadByName } from '../services/aiSummaryService.js'
import { radarJobHealth, runRadarJob } from '../services/radarJobService.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

assertIsolatedMysqlAcceptanceDatabase('radarJobIsolationAcceptance')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function capturedError(task: () => Promise<unknown>) {
  return await task().then(() => null, (error: unknown) => error as Error & { code?: unknown })
}

async function waitForLeadKnowledge(leadId: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const [row] = await db.select({ id: knowledgeChunks.id }).from(knowledgeChunks)
      .where(eq(knowledgeChunks.refId, leadId))
      .limit(1)
    if (row) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function main() {
  const marker = randomUUID()
  const leadName = `Radar并发隔离验收-${marker}`
  let leadId = ''
  try {
    const externalProcess = await capturedError(async () => await runRadarJob(
      'health', [], 2_000, undefined, { executable: process.execPath, jobPath: '/tmp/retired-radar-entrypoint' },
    ))
    assert(externalProcess?.message.includes('外部进程执行入口已退场'), 'Radar compatibility facade allowed an external process')

    const [aliveRows] = await pool.query<Array<RowDataPacket & { alive: number }>>('SELECT 1 AS alive')
    assert(Number(aliveRows[0]?.alive) === 1, 'main process MySQL work did not continue after Radar failures')
    const healthAfterFailures = await radarJobHealth()
    assert(
      healthAfterFailures.ok === true && healthAfterFailures.mode === 'node-in-process',
      'Radar TypeScript collector health is not available in the main process',
    )

    const input = {
      name: leadName,
      companyName: leadName,
      industry: '验收行业',
      source: '项目发现雷达 · 隔离验收',
      poolStatus: '成功',
      summary: '用于验证跨实例互斥与重复执行幂等。',
      highlights: ['并发安全'],
      risks: [],
      team: '验收团队',
      fundingRounds: [],
      riskTags: [],
      sources: [{ title: '隔离验收来源', url: `https://example.invalid/${marker}` }],
      radarProfile: { link: `https://example.invalid/${marker}` },
      radarSourceKeys: [`acceptance:${marker}`],
    }
    const concurrent = await Promise.all([
      syncRadarLeadByName(input),
      syncRadarLeadByName(input),
    ])
    const repeated = await syncRadarLeadByName(input)
    const stored = await db.select().from(leads).where(eq(leads.name, leadName))
    assert(
      concurrent.filter((result) => result.status === 'created').length === 1
      && concurrent.every((result) => result.row.id === concurrent[0].row.id)
      && repeated.row.id === concurrent[0].row.id
      && repeated.status === 'unchanged'
      && stored.length === 1,
      'concurrent or repeated Radar sync created duplicate leads',
    )
    leadId = stored[0].id
    await waitForLeadKnowledge(leadId)

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'radar-python-process-entrypoint-is-rejected',
        'radar-collector-health-is-node-in-process',
        'main-process-mysql-work-continues-after-rejected-external-process',
        'concurrent-radar-source-sync-creates-one-lead',
        'repeated-radar-source-sync-is-idempotent',
      ],
    }))
  } finally {
    if (leadId) await db.delete(knowledgeChunks).where(eq(knowledgeChunks.refId, leadId)).catch(() => {})
    await db.delete(auditLogs).where(eq(auditLogs.target, leadName)).catch(() => {})
    await db.delete(leads).where(eq(leads.name, leadName)).catch(() => {})
  }
}

await main().finally(async () => pool.end())
