import { z } from 'zod'
import { committeeReceipt, type CommitteeCommand } from '../../server/src/contracts/fdeCommitteeContract'

export const committeePending = z.object({ commandId: z.string().uuid(), action: committeeReceipt.shape.action, meetingId: z.string().uuid().nullable() }).strict().superRefine((value, ctx) => {
  if (value.action === 'create' ? value.meetingId !== null : !value.meetingId) ctx.addIssue({ code: 'custom', message: '投决会恢复标识不完整' })
})
export type CommitteePending = z.infer<typeof committeePending>
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const committeePendingKey = (uid: string) => `fde-committee-pending:${uid}`
export const markerForCommittee = (command: CommitteeCommand) => committeePending.parse({ commandId: command.commandId, action: command.action, meetingId: 'meetingId' in command ? command.meetingId : null })
export function readCommitteePending(store: Store, key: string) { const value = store.getItem(key); return value === null ? null : committeePending.parse(JSON.parse(value)) }
export function rememberCommitteePending(store: Store, key: string, marker: CommitteePending) {
  const value = committeePending.parse(marker), prior = readCommitteePending(store, key)
  if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('请先核对上一笔投决会操作')
  store.setItem(key, JSON.stringify(value))
}
// Serialize reservation across tabs. A same-account pending marker must not be
// overwritten by two tabs which both read an empty localStorage slot.
export async function reserveCommitteePending(locks: Pick<LockManager, 'request'> | undefined, store: Store, key: string, marker: CommitteePending) {
  if (!locks) throw new Error('当前浏览器不支持跨标签提交保护，请使用支持 Web Locks 的浏览器')
  await locks.request(key, async () => { rememberCommitteePending(store, key, marker) })
}
export function forgetCommitteePending(store: Store, key: string, marker: CommitteePending) {
  const prior = readCommitteePending(store, key)
  if (prior && JSON.stringify(prior) !== JSON.stringify(marker)) throw new Error('不能清除另一笔投决会操作')
  store.removeItem(key)
}
export function validateCommitteeReceipt(raw: unknown, marker: CommitteePending) {
  const receipt = committeeReceipt.parse(raw)
  if (receipt.commandId !== marker.commandId || receipt.action !== marker.action || marker.meetingId && receipt.meetingId !== marker.meetingId) throw new Error('投决会回执不匹配原操作，请继续核对')
  return receipt
}
const recovery = z.discriminatedUnion('state', [z.object({ state: z.literal('committed'), receipt: committeeReceipt }).strict(), z.object({ state: z.literal('not_committed'), receipt: z.null() }).strict()])
export function validateCommitteeRecovery(raw: unknown, marker: CommitteePending) { const value = recovery.parse(raw); if (value.state === 'committed') validateCommitteeReceipt(value.receipt, marker); return value }
