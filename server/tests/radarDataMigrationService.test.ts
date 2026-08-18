import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { count, eq } from 'drizzle-orm'
import { db, pool } from '../src/db/client.js'
import { radarCandidates, radarRawEvents } from '../src/db/schema.js'
import { ensureSchema } from '../src/db/migrate.js'
import {
  ingestRadarDataToMySql,
  materializeRadarWorkingStateFromMySql,
} from '../src/services/radarDataMigrationService.js'
import { fetchRadarWindow } from '../src/services/radarSyncService.js'
import { mysqlIntegrationTestOptions } from './mysqlIntegrationTestSafety.js'

after(async () => await pool.end())

test('migrates Radar JSONL into idempotent MySQL raw events and current projection', mysqlIntegrationTestOptions, async () => {
  await ensureSchema()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'radar-mysql-test-'))
  const source = `mysql-test-${randomUUID()}`
  const previousDataDir = process.env.RADAR_DATA_DIR
  process.env.RADAR_DATA_DIR = directory
  try {
    await writeFile(path.join(directory, 'investment_candidates.jsonl'), `${JSON.stringify({
      source,
      source_id: 'candidate-1',
      source_group: '创投新闻',
      title: 'MySQL Radar migration fixture',
      published_at: '2026-08-08T08:00:00+08:00',
      attention_score: 88,
      worth_attention: true,
    })}\n`)

    await ingestRadarDataToMySql(undefined, { includeSnapshot: false })
    await ingestRadarDataToMySql(undefined, { includeSnapshot: false })

    const window = await fetchRadarWindow({ pageSize: 1, maxPages: 2, source })
    assert.equal(window.total, 1)
    assert.equal(window.items[0]?.source_id, 'candidate-1')

    const [{ value: rawCount }] = await db.select({ value: count() }).from(radarRawEvents)
      .where(eq(radarRawEvents.source, source))
    const [{ value: currentCount }] = await db.select({ value: count() }).from(radarCandidates)
      .where(eq(radarCandidates.source, source))
    assert.equal(Number(rawCount), 1)
    assert.equal(Number(currentCount), 1)

    const materialized = await materializeRadarWorkingStateFromMySql()
    assert.ok(materialized.states >= 3)
    const autoState = JSON.parse(await readFile(path.join(directory, 'auto_crawler_status.json'), 'utf8'))
    assert.equal(typeof autoState, 'object')
  } finally {
    await db.delete(radarCandidates).where(eq(radarCandidates.source, source))
    await db.delete(radarRawEvents).where(eq(radarRawEvents.source, source))
    if (previousDataDir == null) delete process.env.RADAR_DATA_DIR
    else process.env.RADAR_DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  }
})
