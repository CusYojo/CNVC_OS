import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  auditLogs,
  leadPipelineItems,
  leadPipelineRawEvents,
  leadPipelineTransitions,
  leadScoreJobs,
  leads,
  migrationEntityMappings,
  migrationIssues,
  migrationRuns,
} from '../db/schema.js'

const apply = process.argv.includes('--apply')
const migrationType = 'orphan-ready-pipeline-quarantine'

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function workflowSourceId(leadId: string, workflow: string) {
  return `${leadId}:${workflow}`
}

async function candidates() {
  const rows = await db.select({
    eventId: leadPipelineItems.eventId,
    status: leadPipelineItems.status,
    leadId: leadPipelineItems.leadId,
    sourceType: leadPipelineRawEvents.sourceType,
    sourceIdHash: leadPipelineRawEvents.sourceIdHash,
    contentHash: leadPipelineRawEvents.contentHash,
    payload: leadPipelineRawEvents.payload,
  }).from(leadPipelineItems)
    .innerJoin(leadPipelineRawEvents, eq(leadPipelineRawEvents.id, leadPipelineItems.eventId))
    .where(and(eq(leadPipelineItems.status, 'ready'), isNull(leadPipelineItems.leadId)))
  return rows.map((row) => {
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {}
    const leadId = typeof payload.leadId === 'string' ? payload.leadId : ''
    const workflow = typeof payload.workflow === 'string' ? payload.workflow : ''
    const version = typeof payload.version === 'string' ? payload.version : ''
    return { ...row, leadIdFromPayload: leadId, workflow, version }
  })
}

async function main() {
  const found = await candidates()
  if (!found.length) {
    console.log(JSON.stringify({ ok: true, mode: apply ? 'apply' : 'preview', candidates: 0, writes: 0 }))
    return
  }
  const leadIds = [...new Set(found.map((row) => row.leadIdFromPayload).filter(Boolean))]
  const [existingLeads, existingJobs, existingMappings] = await Promise.all([
    leadIds.length ? db.select({ id: leads.id }).from(leads).where(inArray(leads.id, leadIds)) : [],
    leadIds.length ? db.select({ leadId: leadScoreJobs.leadId }).from(leadScoreJobs).where(inArray(leadScoreJobs.leadId, leadIds)) : [],
    leadIds.length ? db.select({ targetId: migrationEntityMappings.targetId }).from(migrationEntityMappings)
      .where(and(eq(migrationEntityMappings.targetTable, 'leads'), inArray(migrationEntityMappings.targetId, leadIds))) : [],
  ])
  const existingLeadIds = new Set(existingLeads.map((row) => row.id))
  const jobLeadIds = new Set(existingJobs.map((row) => row.leadId))
  const mappedLeadIds = new Set(existingMappings.map((row) => row.targetId))
  for (const row of found) {
    if (
      row.sourceType !== 'lead-scoring-input'
      || row.version !== 'lead-scoring-input-v1'
      || !row.leadIdFromPayload
      || !['score-project', 'score-paper'].includes(row.workflow)
      || row.sourceIdHash !== sha256(workflowSourceId(row.leadIdFromPayload, row.workflow))
      || existingLeadIds.has(row.leadIdFromPayload)
      || jobLeadIds.has(row.leadIdFromPayload)
      || mappedLeadIds.has(row.leadIdFromPayload)
    ) {
      throw new Error('orphan ready pipeline candidate is not an approved deleted scoring-input shape')
    }
  }
  const sourceRows = found.map((row) => ({
    eventId: row.eventId,
    contentHash: row.contentHash,
    sourceIdHash: row.sourceIdHash,
    leadIdSha256: sha256(row.leadIdFromPayload),
    workflow: row.workflow,
  })).sort((left, right) => left.eventId.localeCompare(right.eventId))
  const sourceSha256 = sha256(JSON.stringify(sourceRows))
  if (!apply) {
    console.log(JSON.stringify({
      ok: false,
      mode: 'preview',
      candidates: found.length,
      sourceSha256,
      approvedShape: true,
      writes: 0,
    }))
    process.exitCode = 2
    return
  }

  const result = await db.transaction(async (tx) => {
    const [prior] = await tx.select({ id: migrationRuns.id }).from(migrationRuns).where(and(
      eq(migrationRuns.migrationType, migrationType),
      eq(migrationRuns.sourceSha256, sourceSha256),
      eq(migrationRuns.status, 'succeeded'),
    )).limit(1)
    if (prior) return { runId: prior.id, quarantined: 0, idempotent: true }
    const eventIds = found.map((row) => row.eventId)
    const locked = await tx.select({
      eventId: leadPipelineItems.eventId,
      status: leadPipelineItems.status,
      leadId: leadPipelineItems.leadId,
    }).from(leadPipelineItems).where(inArray(leadPipelineItems.eventId, eventIds)).for('update')
    if (
      locked.length !== found.length
      || locked.some((row) => row.status !== 'ready' || row.leadId !== null)
    ) throw new Error('orphan ready pipeline candidates changed before repair')

    const runId = randomUUID()
    const now = new Date()
    await tx.insert(migrationRuns).values({
      id: runId,
      migrationType,
      sourceLocator: 'mysql:lead_pipeline_items/status=ready/lead_id=null',
      sourceSha256,
      mode: 'apply',
      status: 'running',
      sourceCounts: { candidates: found.length },
      targetCounts: {},
      sourceChecksum: sourceSha256,
      report: { policy: 'preserve-event-and-decisions; quarantine-through-valid-state-path' },
      startedAt: now,
    })
    for (const row of found) {
      await tx.insert(leadPipelineTransitions).values({
        eventId: row.eventId,
        fromStatus: 'ready',
        toStatus: 'review',
        reason: 'formal lead no longer exists; preserve scoring evidence and enter migration review quarantine',
        evidence: [{ code: 'ORPHAN_READY_PIPELINE_ITEM', sourceSha256 }],
        actorType: 'migration-repair',
        actorId: runId,
      })
      await tx.insert(leadPipelineTransitions).values({
        eventId: row.eventId,
        fromStatus: 'review',
        toStatus: 'rejected',
        reason: 'deleted unmapped scoring fixture cannot remain ready without a formal lead',
        evidence: [{ code: 'ORPHAN_READY_PIPELINE_ITEM_QUARANTINED', sourceSha256 }],
        actorType: 'migration-repair',
        actorId: runId,
      })
      await tx.update(leadPipelineItems).set({
        status: 'rejected',
        decisionReason: 'orphan scoring input quarantined; raw event and decisions preserved',
        updatedAt: now,
      }).where(and(
        eq(leadPipelineItems.eventId, row.eventId),
        eq(leadPipelineItems.status, 'ready'),
        isNull(leadPipelineItems.leadId),
      ))
      await tx.insert(migrationIssues).values({
        runId,
        severity: 'warning',
        sourceSystem: 'mysql-target-repair',
        sourceTable: 'lead_pipeline_items',
        sourceKey: row.eventId,
        code: 'ORPHAN_READY_PIPELINE_ITEM_QUARANTINED',
        message: 'Ready scoring input lost its unmapped formal lead; item quarantined without deleting audit evidence.',
        payload: {
          eventIdSha256: sha256(row.eventId),
          leadIdSha256: sha256(row.leadIdFromPayload),
          contentHash: row.contentHash,
          sourceIdHash: row.sourceIdHash,
          workflow: row.workflow,
          fromStatus: 'ready',
          finalStatus: 'rejected',
        },
      })
    }
    const targetChecksum = sha256(JSON.stringify(sourceRows.map((row) => ({ eventId: row.eventId, status: 'rejected' }))))
    await tx.update(migrationRuns).set({
      status: 'succeeded',
      targetCounts: { quarantined: found.length },
      targetChecksum,
      report: {
        policy: 'preserve-event-and-decisions; quarantine-through-valid-state-path',
        transitionsPerItem: 2,
        physicalDeletes: 0,
      },
      completedAt: now,
    }).where(eq(migrationRuns.id, runId))
    await tx.insert(auditLogs).values({
      userName: 'migration-repair',
      module: '迁移控制',
      action: '隔离孤立Ready线索项',
      target: JSON.stringify({ runId, candidates: found.length, sourceSha256, physicalDeletes: 0 }),
    })
    return { runId, quarantined: found.length, idempotent: false }
  })
  console.log(JSON.stringify({
    ok: true,
    mode: 'apply',
    candidates: found.length,
    quarantined: result.quarantined,
    idempotent: result.idempotent,
    sourceSha256,
    physicalDeletes: 0,
  }))
}

await main().finally(async () => pool.end())
