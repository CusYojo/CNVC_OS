import { z } from 'zod'
import { typeRuntimeReceipt, type TypeRuntimeCommand } from '../../server/src/contracts/fdeTypeRuntimeContract'
const marker = z.object({ commandId: z.string().uuid(), projectId: z.string().uuid(), action: z.enum(['save_plan', 'submit_plan', 'submit_stage', 'decide', 'reconcile_times']), expectedVersion: z.number().int().nonnegative() }).strict()
export type TypeRuntimePending = z.infer<typeof marker>
export const typeRuntimePendingKey = (uid: string, projectId: string) => `fde-type-runtime:${uid}:${projectId}`
export function typeRuntimeMarker(projectId: string, command: TypeRuntimeCommand) { return marker.parse({ projectId, commandId: command.commandId, action: command.action, expectedVersion: command.expectedVersion }) }
export function readTypeRuntimePending(storage: Pick<Storage, 'getItem'>, key: string) { const raw = storage.getItem(key); return raw === null ? null : marker.parse(JSON.parse(raw)) }
export function verifyTypeRuntimeReceipt(raw: unknown, pending: TypeRuntimePending) {
  const receipt = typeRuntimeReceipt.parse(raw)
  if (receipt.projectId !== pending.projectId || receipt.commandId !== pending.commandId || receipt.action !== pending.action || receipt.version !== pending.expectedVersion + 1) throw new Error('命令回执与当前待核对操作不一致')
  return receipt
}
export function verifyTypeRuntimeRecovery(raw: unknown, pending: TypeRuntimePending) {
  const response = z.discriminatedUnion('state', [z.object({ state: z.literal('committed'), receipt: typeRuntimeReceipt }).strict(), z.object({ state: z.literal('not_committed'), receipt: z.null() }).strict()]).parse(raw)
  if (response.state === 'committed') verifyTypeRuntimeReceipt(response.receipt, pending)
  return response
}
