import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after } from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { db, pool } from '../src/db/client.js'
import {
  leadPipelineItems,
  leadPipelineRawEvents,
  leadPipelineTransitions,
  leadReserve,
  leads,
} from '../src/db/schema.js'
import { ensureSchema } from '../src/db/migrate.js'
import { runLeadReserveIntake } from '../src/services/leadReserveIntakeService.js'
import { mysqlIntegrationTestOptions } from './mysqlIntegrationTestSafety.js'

after(async () => await pool.end())

test('imports one reserve row transactionally and keeps retry idempotent', mysqlIntegrationTestOptions, async () => {
  await ensureSchema()
  const marker = `reserve-smoke-${randomUUID()}`
  const [created] = await db.insert(leadReserve).values({
    seq: -2_147_483_648,
    srcId: marker,
    name: marker,
    detailUrl: `https://example.invalid/${marker}`,
    detailJson: {
      name: marker,
      companyName: `${marker}有限公司`,
      oneWord: 'MySQL persistent intake smoke',
      provinceName: '浙江省',
      industryList: [{ name: '人工智能' }],
      financingList: [],
    },
  }).$returningId()
  let leadId = ''
  try {
    const first = await runLeadReserveIntake({ limit: 1 })
    assert.equal(first.selected, 1)
    leadId = first.insertedIds[0]
    const [reserve] = await db.select().from(leadReserve).where(eq(leadReserve.id, created.id)).limit(1)
    assert.equal(reserve?.imported, true)
    assert.equal(reserve?.importedLeadId, leadId)
    assert.equal(reserve?.scoreStatus, 'requested')
    const rawEvents = await db.select().from(leadPipelineRawEvents)
      .where(eq(leadPipelineRawEvents.sourceId, marker))
    assert.equal(rawEvents.length, 1)
    const [pipelineItem] = await db.select().from(leadPipelineItems)
      .where(eq(leadPipelineItems.eventId, rawEvents[0].id)).limit(1)
    assert.equal(pipelineItem?.status, 'ready')
    assert.equal(pipelineItem?.leadId, leadId)

    await db.update(leadReserve).set({ imported: false, scoreStatus: 'pending' }).where(eq(leadReserve.id, created.id))
    const second = await runLeadReserveIntake({ limit: 1 })
    assert.equal(second.insertedIds[0], leadId)
    const matching = await db.select({ id: leads.id }).from(leads).where(eq(leads.id, leadId))
    assert.equal(matching.length, 1)
    const repeatedRawEvents = await db.select().from(leadPipelineRawEvents)
      .where(eq(leadPipelineRawEvents.sourceId, marker))
    assert.equal(repeatedRawEvents.length, 1)
    const transitions = await db.select().from(leadPipelineTransitions)
      .where(eq(leadPipelineTransitions.eventId, repeatedRawEvents[0].id))
    assert.equal(transitions.length, 2)
  } finally {
    await db.delete(leadReserve).where(eq(leadReserve.id, created.id))
    if (leadId) await db.delete(leads).where(eq(leads.id, leadId))
    const rawEvents = await db.select({ id: leadPipelineRawEvents.id }).from(leadPipelineRawEvents)
      .where(eq(leadPipelineRawEvents.sourceId, marker))
    const eventIds = rawEvents.map((event) => event.id)
    if (eventIds.length) {
      await db.delete(leadPipelineTransitions).where(inArray(leadPipelineTransitions.eventId, eventIds))
      await db.delete(leadPipelineItems).where(inArray(leadPipelineItems.eventId, eventIds))
      await db.delete(leadPipelineRawEvents).where(inArray(leadPipelineRawEvents.id, eventIds))
    }
  }
})
