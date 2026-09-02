import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after } from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { db, pool } from '../src/db/client.js'
import {
  leadPipelineItems,
  leadPipelineRawEvents,
  leadPipelineTransitions,
  leadSourceCandidates,
} from '../src/db/schema.js'
import { ensureSchema } from '../src/db/migrate.js'
import { upsertKr36ProjectCandidate } from '../src/services/kr36ProjectCandidateService.js'
import { mysqlIntegrationTestOptions } from './mysqlIntegrationTestSafety.js'

after(async () => await pool.end())

test('36氪候选当前态幂等且保留不可变变更事件', mysqlIntegrationTestOptions, async () => {
  await ensureSchema()
  const projectId = `acceptance-${randomUUID()}`
  const sourceId = `36kr:project:${projectId}`
  try {
    const first = await upsertKr36ProjectCandidate({
      projectId,
      listItem: { projectId, name: '验收芯片项目' },
      detail: { name: '验收芯片项目', setupDate: '2025-03-01', intro: '半导体芯片设计' },
    })
    const repeated = await upsertKr36ProjectCandidate({
      projectId,
      listItem: { projectId, name: '验收芯片项目' },
      detail: { name: '验收芯片项目', setupDate: '2025-03-01', intro: '半导体芯片设计' },
    })
    assert.equal(first.id, repeated.id)
    assert.equal(repeated.contentChanged, false)

    const changed = await upsertKr36ProjectCandidate({
      projectId,
      listItem: { projectId, name: '验收芯片项目' },
      detail: { name: '验收芯片项目', setupDate: '2025-03-01', intro: '半导体芯片及EDA设计' },
    })
    assert.equal(changed.contentChanged, true)
    const candidates = await db.select().from(leadSourceCandidates)
      .where(eq(leadSourceCandidates.sourceProjectId, projectId))
    assert.ok(candidates.some((candidate) => candidate.id === first.id && candidate.admissionStatus === 'ready'))
    const events = await db.select().from(leadPipelineRawEvents).where(eq(leadPipelineRawEvents.sourceId, sourceId))
    assert.equal(events.length, 2)
    const items = await db.select().from(leadPipelineItems)
      .where(inArray(leadPipelineItems.eventId, events.map((event) => event.id)))
    assert.deepEqual(items.map((item) => item.status).sort(), ['discovered', 'rejected'])
  } finally {
    const events = await db.select({ id: leadPipelineRawEvents.id }).from(leadPipelineRawEvents)
      .where(eq(leadPipelineRawEvents.sourceId, sourceId))
    const eventIds = events.map((event) => event.id)
    await db.delete(leadSourceCandidates).where(eq(leadSourceCandidates.sourceProjectId, projectId))
    if (eventIds.length) {
      await db.delete(leadPipelineTransitions).where(inArray(leadPipelineTransitions.eventId, eventIds))
      await db.delete(leadPipelineItems).where(inArray(leadPipelineItems.eventId, eventIds))
      await db.delete(leadPipelineRawEvents).where(inArray(leadPipelineRawEvents.id, eventIds))
    }
  }
})
