import { z } from 'zod'
import { fdeDate, fdeDueTime } from './fdeTaskContract.js'
import type { TypeExecutionPlan, TypePlanReview, TypeStageReview } from './fdeTypeExecutionContract.js'

const uuid = z.string().uuid(), version = z.number().int().positive()
const key = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/)
const base = { commandId: uuid, expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().min(5).max(2000) }
export const typeRuntimePlanInput = z.object({
  expectedProjectVersion: version, expectedGovernanceVersion: version,
  expectedPolicyVersionId: uuid, expectedPolicySha256: z.string().regex(/^[a-f0-9]{64}$/),
  cycleDays: z.number().int(), targetDate: fdeDate,
  selections: z.array(z.object({ actionKey: key, userId: uuid, dueTime: fdeDueTime.nullable() }).strict()).max(80),
}).strict()
export const typeRuntimeMaterial = z.discriminatedUnion('kind', [
  z.object({ requirementKey: key, kind: z.literal('file'), fileId: uuid, version }).strict(),
  z.object({ requirementKey: key, kind: z.literal('waiver'), reason: z.string().trim().min(5).max(2000) }).strict(),
])
export const typeRuntimeCommand = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('save_plan'), plan: typeRuntimePlanInput }).strict(),
  z.object({ ...base, action: z.literal('submit_plan') }).strict(),
  z.object({ ...base, action: z.literal('reconcile_times') }).strict(),
  z.object({ ...base, action: z.literal('submit_stage'), stageKey: key, expectedGovernanceVersion: version, result: z.string().trim().min(5).max(8000), materials: z.array(typeRuntimeMaterial).max(30) }).strict(),
  z.object({ ...base, action: z.literal('decide'), requestId: uuid, expectedReviewVersion: version, decision: z.enum(['approve', 'return', 'withdraw']) }).strict(),
])
export type TypeRuntimeCommand = z.infer<typeof typeRuntimeCommand>
export const typeRuntimeReceipt = z.object({ commandId: uuid, projectId: uuid, version, action: z.enum(['save_plan', 'submit_plan', 'submit_stage', 'decide', 'reconcile_times']), requestId: uuid.nullable() }).strict()
export type TypeRuntimeReceipt = z.infer<typeof typeRuntimeReceipt>
export const typeRuntimeRecovery = z.object({ commandId: uuid }).strict()
export type TypeRuntimeReview = TypePlanReview | TypeStageReview
export type TypeRuntimeStatus = 'draft' | 'plan_review' | 'active' | 'stage_review' | 'closed'
export type TypeRuntimeView = {
  projectId: string; projectVersion: number; governanceVersion: number; policyEnabled: boolean; canAdvance: boolean
  instance: { version: number; status: TypeRuntimeStatus; stageKey: string; plan: TypeExecutionPlan; planId: string | null } | null
  reviews: Array<{ id: string; kind: 'plan' | 'stage'; version: number; status: TypeRuntimeReview['status']; snapshot: TypeRuntimeReview; createdAt: string; canDecide: boolean }>
  page: number; hasMore: boolean
  canPrepare: boolean; canWrite: boolean
  preparation: { policyVersionId: string; policySha256: string; configuration: TypeExecutionPlan['configuration'] } | null
  people: Array<{ id: string; name: string; duties: string[] }>
  tasks: Array<{ id: string; actionKey: string; title: string; status: string; version: number; dueDate: string | null; dueTime: string | null }>
  leaderTimes: { issues: string[]; requests: Array<{ id: string; taskId: string | null; leaderName: string; status: string; target: string; changed: boolean; reason: string }> }
}

// A date-only approved task has a deliberate null clock, not a missing projection.
export function typeRuntimeEffectiveDeadline(planned: { dueDate: string; dueTime: string | null }, task?: { dueDate: string | null; dueTime: string | null }) {
  return task ? { dueDate: task.dueDate, dueTime: task.dueTime } : { dueDate: planned.dueDate, dueTime: planned.dueTime }
}
