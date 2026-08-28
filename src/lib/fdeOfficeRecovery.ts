import { z } from 'zod'
import { ApiError } from '../../server/src/contracts/apiErrorContract'
import { officeReceipt, officeResolution } from '../../server/src/contracts/fdeOfficeContract'

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const uuid = z.string().uuid()
const pendingSchema = z.object({ id: uuid, commandId: uuid, path: z.string() }).strict().refine(value => {
  const prefix = `/oa/office/requests/${value.id}/`
  if (!value.path.startsWith(prefix)) return false
  const suffix = value.path.slice(prefix.length)
  if (['save', 'actions', 'executions'].includes(suffix)) return true
  const parts = suffix.split('/')
  return parts[0] === 'attachments' && uuid.safeParse(parts[1]).success && (parts.length === 2 || parts.length === 3 && parts[2] === 'grants')
}, '恢复记录的操作路径无效')
export type OfficePending = z.infer<typeof pendingSchema>
// Keep the existing key/shape so an in-flight command from the previous UI can
// still be resolved after upgrade. Never persist the request body or file data.
export const officeRecoveryKey = (userId: string) => `fde-office-pending:${userId}`
export function readOfficePending(storage: RecoveryStorage, key: string): OfficePending | null {
  const raw = storage.getItem(key)
  return raw === null ? null : pendingSchema.parse(JSON.parse(raw))
}
export function rememberOfficePending(storage: RecoveryStorage, key: string, pending: OfficePending) {
  const value = pendingSchema.parse({ id: pending.id, commandId: pending.commandId, path: pending.path })
  const existing = readOfficePending(storage, key)
  if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('请先核对上一笔办公操作，不能替换恢复标识')
  storage.setItem(key, JSON.stringify(value))
}
export function forgetOfficePending(storage: RecoveryStorage, key: string, pending: OfficePending) {
  const existing = readOfficePending(storage, key)
  if (!existing) return true
  if (existing.id !== pending.id || existing.commandId !== pending.commandId || existing.path !== pending.path) return false
  storage.removeItem(key)
  return true
}
export function officeWriteResultUnknown(cause: unknown) {
  return !(cause instanceof ApiError) || cause.status === 0 || cause.status === 408 || cause.status >= 500 || ['BAD_RESPONSE', 'BAD_JSON', 'HTTP_ERROR'].includes(cause.code)
}
export function officeWriteReceipt(result: unknown, requestId: string) {
  const receipt = officeReceipt.parse(result)
  if (receipt.id !== requestId) throw new Error('操作回执不属于原申请，请核对原请求')
  return receipt
}
export function officeResolvedResult(result: unknown, requestId: string) {
  const resolution = officeResolution.parse(result)
  if (resolution.state === 'committed') officeWriteReceipt(resolution.receipt, requestId)
  return resolution
}
