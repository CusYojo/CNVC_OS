import { officePolicyCommandTarget, officePolicyReceipt, officePolicyResolution, type OfficePolicyCommandTarget } from '../../server/src/contracts/fdeOfficePolicyCommandContract'

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type PolicyPending = OfficePolicyCommandTarget
export const policyRecoveryKey = (userId: string) => `fde-office-policy-pending:${userId}`
export function readPolicyPending(storage: RecoveryStorage, key: string) {
  const raw = storage.getItem(key)
  return raw === null ? null : officePolicyCommandTarget.parse(JSON.parse(raw))
}
export function rememberPolicyPending(storage: RecoveryStorage, key: string, value: PolicyPending) {
  const marker = officePolicyCommandTarget.parse({ id: value.id, action: value.action, clientRequestId: value.clientRequestId })
  const previous = readPolicyPending(storage, key)
  if (previous && JSON.stringify(previous) !== JSON.stringify(marker)) throw new Error('请先核对上一笔规则操作')
  storage.setItem(key, JSON.stringify(marker))
}
export function forgetPolicyPending(storage: RecoveryStorage, key: string, marker: PolicyPending) {
  const previous = readPolicyPending(storage, key)
  if (previous && (previous.id !== marker.id || previous.action !== marker.action || previous.clientRequestId !== marker.clientRequestId)) throw new Error('恢复标识已变化，请重新核对')
  storage.removeItem(key)
}
export function policyCommandPath(marker: PolicyPending) {
  const { id, action } = officePolicyCommandTarget.parse(marker)
  return `/system-administration/${action === 'enabled' ? 'office-policies' : 'office-policy-versions'}/${id}/${action}`
}
export function policyWriteReceipt(value: unknown, marker: PolicyPending) {
  const result = officePolicyReceipt.parse(value)
  if (result.id !== marker.id || result.action !== marker.action) throw new Error('规则回执不属于本次操作，请核对原请求')
  return result
}
export function policyResolvedResult(value: unknown, marker: PolicyPending) {
  const result = officePolicyResolution.parse(value)
  if (result.state === 'committed') policyWriteReceipt(result.receipt, marker)
  return result
}
