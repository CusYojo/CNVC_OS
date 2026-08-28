import { z } from 'zod'
import { typePolicyReceipt, type TypePolicyCommand } from '../../server/src/contracts/fdeTypePolicyContract'

export const typePolicyPending = z.object({ commandId: z.string().uuid(), action: z.enum(['create', 'save', 'approve', 'publish', 'activate', 'deactivate']), policyId: z.string().uuid().nullable(), versionId: z.string().uuid().nullable() }).strict().superRefine((v, ctx) => {
  if (v.action === 'create' ? v.policyId !== null || v.versionId !== null : !v.policyId || !v.versionId) ctx.addIssue({ code: 'custom', message: '模板恢复标识不完整' })
})
export type TypePolicyPending = z.infer<typeof typePolicyPending>
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const typePolicyPendingKey = (uid: string) => `fde-type-policy-pending:${uid}`
export const markerForTypePolicy = (cmd: TypePolicyCommand) => typePolicyPending.parse({ commandId: cmd.commandId, action: cmd.action, policyId: 'policyId' in cmd ? cmd.policyId : null, versionId: 'versionId' in cmd ? cmd.versionId : null })
export function readTypePolicyPending(store: Store, key: string) { const raw = store.getItem(key); return raw === null ? null : typePolicyPending.parse(JSON.parse(raw)) }
export function rememberTypePolicyPending(store: Store, key: string, value: TypePolicyPending) {
  const marker = typePolicyPending.parse(value), prior = readTypePolicyPending(store, key)
  if (prior && JSON.stringify(prior) !== JSON.stringify(marker)) throw new Error('请先核对上一笔模板操作')
  store.setItem(key, JSON.stringify(marker))
}
export function forgetTypePolicyPending(store: Store, key: string, marker: TypePolicyPending) {
  const prior = readTypePolicyPending(store, key)
  if (prior && JSON.stringify(prior) !== JSON.stringify(marker)) throw new Error('不能清除另一笔模板操作')
  store.removeItem(key)
}
export function validateTypePolicyReceipt(raw: unknown, marker: TypePolicyPending) {
  const receipt = typePolicyReceipt.parse(raw), expectedStatus = marker.action === 'approve' ? 'approved' : ['publish', 'activate', 'deactivate'].includes(marker.action) ? 'published' : 'draft'
  if (receipt.commandId !== marker.commandId || receipt.action !== marker.action || receipt.status !== expectedStatus || marker.versionId && receipt.versionId !== marker.versionId || marker.policyId && receipt.policyId !== marker.policyId) throw new Error('模板回执不匹配原操作，请继续核对')
  return receipt
}
const recovery = z.discriminatedUnion('state', [z.object({ state: z.literal('committed'), receipt: typePolicyReceipt }).strict(), z.object({ state: z.literal('not_committed'), receipt: z.null() }).strict()])
export function validateTypePolicyRecovery(raw: unknown, marker: TypePolicyPending) { const result = recovery.parse(raw); if (result.state === 'committed') validateTypePolicyReceipt(result.receipt, marker); return result }
