import { z } from 'zod'
import { agentReceiptSchema, agentResolutionSchema } from '../../server/src/contracts/fdeProjectAgentContract'

type Port = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const uuid = z.string().uuid()
export const replanPendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('submit'), commandId: uuid }).strict(),
  z.object({ kind: z.literal('action'), commandId: uuid, requestId: uuid, expectedVersion: z.number().int().positive() }).strict(),
])
export type ReplanPending = z.infer<typeof replanPendingSchema>
export const replanRecoveryKey = (userId: string, projectId: string) => `fde-replan:v1:${uuid.parse(userId)}:${uuid.parse(projectId)}`
export function readReplanPending(storage: Port, key: string) {
  const raw = storage.getItem(key)
  return raw === null ? null : replanPendingSchema.parse(JSON.parse(raw))
}
export function saveReplanPending(storage: Port, key: string, value: ReplanPending) {
  if (readReplanPending(storage, key)) throw new Error('已有整体重排操作待核对，不能覆盖')
  const serialized = JSON.stringify(replanPendingSchema.parse(value))
  storage.setItem(key, serialized)
  if (storage.getItem(key) !== serialized) throw new Error('恢复标识未可靠保存，不发送操作')
}
export function clearReplanPending(storage: Port, key: string, value: ReplanPending) {
  if (JSON.stringify(readReplanPending(storage, key)) !== JSON.stringify(value)) throw new Error('恢复标识已变化，不能清除其他操作')
  storage.removeItem(key)
  if (storage.getItem(key) !== null) throw new Error('恢复标识未清除，请重新核对')
}
export function validateReplanReceipt(raw: unknown, value: ReplanPending) {
  const receipt = agentReceiptSchema.parse(raw)
  if (receipt.kind !== 'replan' || receipt.version !== (value.kind === 'submit' ? 1 : value.expectedVersion + 1) || value.kind === 'action' && receipt.id !== value.requestId) throw new Error('操作回执不匹配，保留标识等待核对')
  return receipt
}
export function validateReplanResolution(raw: unknown, value: ReplanPending) {
  const resolution = agentResolutionSchema.parse(raw)
  if (resolution.state === 'committed') validateReplanReceipt(resolution.receipt, value)
  return resolution
}
