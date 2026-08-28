import { z } from 'zod'
import { committeeEditorAccessQuery } from '../../server/src/contracts/fdeCommitteeContract'

const targetSchema = z.object({ meetingId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict()
export type CommitteeEditorTarget = Readonly<z.infer<typeof targetSchema>>
export function pinCommitteeEditorTarget(value: { id: string; version: number }): CommitteeEditorTarget {
  return Object.freeze(targetSchema.parse({ meetingId: value.id, expectedVersion: value.version }))
}
export type CommitteeEditorAccess = 'ready' | 'checking' | 'hidden' | 'conflict'
const accessReply = z.object({ allowed: z.literal(true), version: z.number().int().positive().nullable(), writable: z.boolean() }).strict()
export function reconcileCommitteeEditor(target: CommitteeEditorTarget | null, raw: unknown): CommitteeEditorAccess {
  const reply = accessReply.parse(raw)
  if ((target === null) !== (reply.version === null)) throw new Error('编辑权限回执不属于原表单')
  return !reply.writable || target && reply.version !== target.expectedVersion ? 'conflict' : 'ready'
}
export function committeeEditorAccessFailure(error: unknown): 'clear' | 'hidden' {
  const status = typeof error === 'object' && error ? (error as { status?: number }).status : undefined
  return status === 401 || status === 403 || status === 404 ? 'clear' : 'hidden'
}
export class CommitteeEditorEpoch {
  private generation = 0
  invalidate() { this.generation += 1 }
  capture(accountId: string, selectionId: string) { return { generation: this.generation, accountId, selectionId } }
  begin(accountId: string, selectionId: string) { this.invalidate(); return this.capture(accountId, selectionId) }
  accepts(token: { generation: number; accountId: string; selectionId: string }, accountId: string, selectionId: string) {
    return token.generation === this.generation && token.accountId === accountId && token.selectionId === selectionId
  }
}
export function committeeFormError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.join('.') || '表单'}：${issue.message}`).join('；')
  return error instanceof Error ? error.message : '操作失败，请重新核对'
}
export type CommitteeEditorAccessRequest = z.infer<typeof committeeEditorAccessQuery>
