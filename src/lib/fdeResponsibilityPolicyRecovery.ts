import { z } from 'zod'
import { responsibilityPolicyReceipt, type ResponsibilityPolicyCommand } from '../../server/src/contracts/fdeResponsibilityPolicyContract'

const base = { commandId: z.string().uuid() }
export const responsibilityPolicyPending = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('create'), versionId: z.null(), enabled: z.null() }).strict(),
  ...(['save', 'approve', 'publish'] as const).map(action => z.object({ ...base, action: z.literal(action), versionId: z.string().uuid(), enabled: z.null() }).strict()),
  z.object({ ...base, action: z.literal('toggle'), versionId: z.null(), enabled: z.boolean() }).strict(),
])
export type ResponsibilityPolicyPending = z.infer<typeof responsibilityPolicyPending>
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const responsibilityPolicyRecoveryKey = (uid: string) => `fde-responsibility-policy-pending:${uid}`
export const policyPendingForCommand = (command: ResponsibilityPolicyCommand) => responsibilityPolicyPending.parse({ commandId: command.commandId, action: command.action, versionId: 'versionId' in command ? command.versionId : null, enabled: command.action === 'toggle' ? command.enabled : null })
export function readResponsibilityPolicyPending(store: Store, key: string) {
  const raw = store.getItem(key)
  return raw === null ? null : responsibilityPolicyPending.parse(JSON.parse(raw))
}
const same = (a: ResponsibilityPolicyPending, b: ResponsibilityPolicyPending) => a.commandId === b.commandId && a.action === b.action && a.versionId === b.versionId && a.enabled === b.enabled
export function rememberResponsibilityPolicyPending(store: Store, key: string, value: ResponsibilityPolicyPending) {
  const marker = responsibilityPolicyPending.parse(value), prior = readResponsibilityPolicyPending(store, key)
  if (prior && !same(prior, marker)) throw new Error('请先核对上一笔责任规则操作')
  store.setItem(key, JSON.stringify(marker))
}
export function forgetResponsibilityPolicyPending(store: Store, key: string, marker: ResponsibilityPolicyPending) {
  const prior = readResponsibilityPolicyPending(store, key)
  if (prior && !same(prior, marker)) throw new Error('恢复标识已变化，不能清除其他规则操作')
  store.removeItem(key)
}
export function responsibilityPolicyWriteReceipt(value: unknown, marker: ResponsibilityPolicyPending) {
  const receipt = responsibilityPolicyReceipt.parse(value)
  const expectedStatus = marker.action === 'create' || marker.action === 'save' ? 'draft' : marker.action === 'approve' ? 'approved' : marker.action === 'publish' ? 'published' : marker.enabled ? 'enabled' : 'disabled'
  if (receipt.commandId !== marker.commandId || receipt.action !== marker.action || receipt.status !== expectedStatus
    || (marker.action === 'create' ? !receipt.versionId : receipt.versionId !== marker.versionId)
    || (marker.action === 'toggle' ? receipt.draftVersion !== null : receipt.draftVersion === null)) throw new Error('规则回执与原命令、版本或状态不符，请继续核对')
  return receipt
}
const resolution = z.discriminatedUnion('state', [z.object({ state: z.literal('committed'), receipt: responsibilityPolicyReceipt }).strict(), z.object({ state: z.literal('not_committed'), receipt: z.null() }).strict()])
export function responsibilityPolicyResolvedResult(value: unknown, marker: ResponsibilityPolicyPending) {
  const result = resolution.parse(value)
  if (result.state === 'committed') responsibilityPolicyWriteReceipt(result.receipt, marker)
  return result
}
