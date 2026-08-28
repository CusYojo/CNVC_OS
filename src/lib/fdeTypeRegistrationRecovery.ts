import { z } from 'zod'
import { typeRegistrationReceipt, type TypeRegistrationCommand } from '../../server/src/contracts/fdeTypeRegistrationContract'

const pending = z.object({ commandId: z.string().uuid(), policyId: z.string().uuid(), versionId: z.string().uuid() }).strict()
export type TypeRegistrationPending = z.infer<typeof pending>
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const typeRegistrationPendingKey = (uid: string) => `fde-type-registration-pending:${uid}`
export const registrationMarker = (command: TypeRegistrationCommand) => pending.parse({ commandId: command.commandId, policyId: command.policyId, versionId: command.versionId })
export function readRegistrationPending(store: Store, key: string) { const raw = store.getItem(key); return raw === null ? null : pending.parse(JSON.parse(raw)) }
export function rememberRegistrationPending(store: Store, key: string, value: TypeRegistrationPending) {
  const marker = pending.parse(value), prior = readRegistrationPending(store, key)
  if (prior && JSON.stringify(prior) !== JSON.stringify(marker)) throw new Error('请先核对上一笔登记请求')
  store.setItem(key, JSON.stringify(marker))
}
export function forgetRegistrationPending(store: Store, key: string, marker: TypeRegistrationPending) {
  const prior = readRegistrationPending(store, key)
  if (prior && JSON.stringify(prior) !== JSON.stringify(marker)) throw new Error('不能清除其他标签页的登记请求')
  store.removeItem(key)
}
export function validateRegistrationReceipt(raw: unknown, marker: TypeRegistrationPending) {
  const receipt = typeRegistrationReceipt.parse(raw)
  if (receipt.commandId !== marker.commandId || receipt.policyId !== marker.policyId || receipt.versionId !== marker.versionId) throw new Error('登记回执与原请求不一致，请继续核对')
  return receipt
}
const recovery = z.discriminatedUnion('state', [z.object({ state: z.literal('committed'), receipt: typeRegistrationReceipt }).strict(), z.object({ state: z.literal('not_committed'), receipt: z.null() }).strict()])
export function validateRegistrationRecovery(raw: unknown, marker: TypeRegistrationPending) { const result = recovery.parse(raw); if (result.state === 'committed') validateRegistrationReceipt(result.receipt, marker); return result }
