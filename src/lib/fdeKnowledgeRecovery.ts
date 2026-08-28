import { ApiError } from '../../server/src/contracts/apiErrorContract'
import { knowledgeCommandTarget, knowledgeReceipt, knowledgeResolution, type KnowledgeCommandTarget } from '../../server/src/contracts/fdeKnowledgeCommandContract'
export { knowledgeCommandPath } from '../../server/src/contracts/fdeKnowledgeCommandContract'

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type KnowledgePending = KnowledgeCommandTarget
export const knowledgeRecoveryKey = (userId: string) => `fde-knowledge-pending:${userId}`
export function readKnowledgePending(storage: RecoveryStorage, key: string) {
  const raw = storage.getItem(key)
  return raw === null ? null : knowledgeCommandTarget.parse(JSON.parse(raw))
}
const same = (a: KnowledgePending, b: KnowledgePending) => a.id === b.id && a.clientRequestId === b.clientRequestId && a.action === b.action && a.commentId === b.commentId
export function rememberKnowledgePending(storage: RecoveryStorage, key: string, value: KnowledgePending) {
  const marker = knowledgeCommandTarget.parse({ id: value.id, action: value.action, clientRequestId: value.clientRequestId, ...(value.commentId ? { commentId: value.commentId } : {}) })
  const previous = readKnowledgePending(storage, key)
  if (previous && !same(previous, marker)) throw new Error('请先核对上一笔知识操作，不能替换恢复标识')
  storage.setItem(key, JSON.stringify(marker))
}
export function forgetKnowledgePending(storage: RecoveryStorage, key: string, marker: KnowledgePending) {
  const previous = readKnowledgePending(storage, key)
  if (previous && !same(previous, marker)) throw new Error('知识恢复标识已变化，请重新读取并核对')
  storage.removeItem(key)
}
export function knowledgeWriteReceipt(value: unknown, marker: KnowledgePending) {
  const receipt = knowledgeReceipt.parse(value)
  if (receipt.id !== marker.id) throw new Error('知识回执不属于原请求，请核对结果')
  return receipt
}
export function knowledgeResolvedResult(value: unknown, marker: KnowledgePending) {
  const result = knowledgeResolution.parse(value)
  if (result.state === 'committed') knowledgeWriteReceipt(result.receipt, marker)
  return result
}
export function knowledgeWriteResultUnknown(cause: unknown) {
  return !(cause instanceof ApiError) || cause.status === 0 || cause.status === 408 || cause.status >= 500 || ['TIMEOUT', 'BAD_RESPONSE', 'BAD_JSON', 'HTTP_ERROR'].includes(cause.code)
}
