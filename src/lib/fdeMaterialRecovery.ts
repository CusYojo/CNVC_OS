import { ApiError } from '../../server/src/contracts/apiErrorContract'

export type MaterialPendingRequest = { clientRequestId: string; kind: 'submit' | 'approve' | 'return' | 'withdraw' }
export type MaterialResolution = { state: 'committed'; id: string; action: string } | { state: 'not_applied' }
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const materialRecoveryKey = (userId: string, projectId: string) => `fde-material-pending:v1:${userId}:${projectId}`
export function readMaterialPending(storage: RecoveryStorage, key: string): MaterialPendingRequest | null {
  const raw = storage.getItem(key)
  if (!raw) return null
  const value = JSON.parse(raw) as MaterialPendingRequest
  if (!value || !uuid.test(value.clientRequestId) || !['submit', 'approve', 'return', 'withdraw'].includes(value.kind) || Object.keys(value).some(key => !['clientRequestId', 'kind'].includes(key))) throw new Error('送审恢复记录无效，请保留当前页面并联系管理员核对，暂不能重新提交')
  return value
}
export function rememberMaterialPending(storage: RecoveryStorage, key: string, pending: MaterialPendingRequest) {
  const existing = readMaterialPending(storage, key)
  if (existing && existing.clientRequestId !== pending.clientRequestId) throw new Error('请先核对上一笔送审操作的结果')
  // Only recovery identifiers, never title, feedback, file names or request bodies.
  storage.setItem(key, JSON.stringify({ clientRequestId: pending.clientRequestId, kind: pending.kind }))
}
export function forgetMaterialPending(storage: RecoveryStorage, key: string, requestId: string) {
  if (readMaterialPending(storage, key)?.clientRequestId === requestId) storage.removeItem(key)
}
export function materialWriteResultUnknown(cause: unknown) {
  return !(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500 || ['BAD_RESPONSE', 'BAD_JSON', 'HTTP_ERROR'].includes(cause.code)
}
export function materialWriteId(result: unknown): string {
  const id = result && typeof result === 'object' && 'id' in result ? result.id : null
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('提交响应不完整，请核对原请求结果')
  return id
}
