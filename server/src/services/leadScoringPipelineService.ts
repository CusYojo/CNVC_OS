import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  recordLeadPipelineRawEvent,
  transitionLeadPipelineItem,
} from './leadPipelineEventService.js'
import type { LeadScoringAuditContext } from './inProcessAiWorkflowService.js'
import type { ScoreWorkflow } from './inProcessAiWorkflowService.js'

const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))

export async function prepareLeadScoringAuditContext(input: {
  leadId: string
  workflow: ScoreWorkflow
  scoringInput: Record<string, unknown>
  queueAttempt: number
}): Promise<LeadScoringAuditContext> {
  const snapshot = await recordLeadPipelineRawEvent({
    sourceType: 'lead-scoring-input',
    sourceId: `${input.leadId}:${input.workflow}`,
    payload: {
      version: 'lead-scoring-input-v1',
      leadId: input.leadId,
      workflow: input.workflow,
      input: input.scoringInput,
    },
  })
  const transition = await transitionLeadPipelineItem(snapshot.event.id, {
    status: 'ready',
    reason: 'immutable host-validated scoring input snapshot linked to formal lead',
    evidence: [{ workflow: input.workflow, inputContentHash: snapshot.event.contentHash }],
    confidence: 100,
    leadId: input.leadId,
    actorType: 'system',
    actorId: 'lead-score-worker',
  })
  if (transition.blocked || transition.item.leadId !== input.leadId) {
    throw new Error('lead scoring input snapshot could not be linked to the formal lead')
  }
  const [rows] = await pool.query<Array<RowDataPacket & { event_id: string }>>(
    `SELECT i.event_id FROM ${itemsTable} i
     JOIN ${rawTable} r ON r.id=i.event_id
     WHERE i.lead_id=? AND r.source_type<>'lead-scoring-input'
     ORDER BY i.created_at,i.event_id`,
    [input.leadId],
  )
  const related = rows.map((row) => row.event_id)
  return {
    inputEventId: snapshot.event.id,
    eventIds: [snapshot.event.id, ...related],
    leadId: input.leadId,
    queueAttempt: input.queueAttempt,
    entityType: 'lead',
  }
}

export async function prepareProjectScoringAuditContext(input: {
  projectId: string
  scoringInput: Record<string, unknown>
  queueAttempt: number
}): Promise<LeadScoringAuditContext> {
  const snapshot = await recordLeadPipelineRawEvent({
    sourceType: 'project-scoring-input',
    sourceId: input.projectId,
    payload: {
      version: 'project-scoring-input-v1',
      projectId: input.projectId,
      workflow: 'score-project',
      input: input.scoringInput,
    },
  })
  // Project scores reuse the immutable event/run/decision/evidence audit tables, but must not
  // enter the lead-only `ready` state: that state intentionally requires a formal lead_id.
  return {
    inputEventId: snapshot.event.id,
    eventIds: [snapshot.event.id],
    projectId: input.projectId,
    entityType: 'project',
    queueAttempt: input.queueAttempt,
  }
}
