import { z } from 'zod'
import { ApiError } from '../../server/src/contracts/apiErrorContract'
import { responsibilityReceipt } from '../../server/src/contracts/fdeResponsibilityContract'

export const responsibilityPending = z.object({ projectId: z.string().uuid(), recordId: z.string().uuid(), commandId: z.string().uuid(), action: z.enum(['confirm', 'appeal', 'review', 'reroute', 'read_notice']) }).strict()
export type ResponsibilityPending = z.infer<typeof responsibilityPending>
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const responsibilityRecoveryKey = (uid: string) => `fde-responsibility-pending:${uid}`
export const responsibilityCommandPath = (marker: ResponsibilityPending) => `/responsibility/projects/${responsibilityPending.parse(marker).projectId}/commands`
export function readResponsibilityPending(store: Store, key: string) {
  const raw = store.getItem(key)
  return raw === null ? null : responsibilityPending.parse(JSON.parse(raw))
}
const same = (a: ResponsibilityPending, b: ResponsibilityPending) => a.projectId === b.projectId && a.recordId === b.recordId && a.commandId === b.commandId && a.action === b.action
export function rememberResponsibilityPending(store: Store, key: string, input: ResponsibilityPending) {
  const marker = responsibilityPending.parse(input), prior = readResponsibilityPending(store, key)
  if (prior && !same(prior, marker)) throw new Error('须先核对上一笔责任记录操作')
  store.setItem(key, JSON.stringify(marker))
}
export function forgetResponsibilityPending(store: Store, key: string, marker: ResponsibilityPending) {
  const prior = readResponsibilityPending(store, key)
  if (prior && !same(prior, marker)) throw new Error('恢复标识已改变，不能清除其他请求')
  store.removeItem(key)
}
export function responsibilityWriteReceipt(value: unknown, marker: ResponsibilityPending) {
  const receipt = responsibilityReceipt.parse(value)
  if (receipt.commandId !== marker.commandId || receipt.projectId !== marker.projectId || receipt.recordId !== marker.recordId) throw new Error('回执与原请求目标不一致，结果仍待核对')
  return receipt
}
const resolution = z.discriminatedUnion('state', [z.object({ state: z.literal('committed'), receipt: responsibilityReceipt }).strict(), z.object({ state: z.literal('not_committed'), receipt: z.null() }).strict()])
export function responsibilityResolvedResult(value: unknown, marker: ResponsibilityPending) {
  const result = resolution.parse(value)
  if (result.state === 'committed') responsibilityWriteReceipt(result.receipt, marker)
  return result
}
export function responsibilityResultUnknown(error: unknown) {
  return !(error instanceof ApiError) || error.status === 0 || error.status === 408 || error.status >= 500 || ['TIMEOUT', 'BAD_RESPONSE', 'BAD_JSON', 'HTTP_ERROR'].includes(error.code)
}
