import { useEffect, useRef, useState } from 'react'
import { agentScheduleAction, type AgentScheduleDashboard } from '../../server/src/contracts/fdeAgentScheduleContract'
import { agentReceiptSchema, agentResolutionSchema } from '../../server/src/contracts/fdeProjectAgentContract'
import { clearReplanPending, readReplanPending, saveReplanPending, type ReplanPending } from '../lib/fdeProjectReplanRecovery'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { Badge, Button, LoadingState } from './ui'

export function ScheduleApprovalReview({ projectId, requestId, onHandled, onBusyChange, onDirtyChange }: { projectId: string; requestId: string; onHandled: () => Promise<void>; onBusyChange: (value: boolean) => void; onDirtyChange: (value: boolean) => void }) {
  const uid = useAuthStore(s => s.user?.id ?? ''), key = `fde-schedule-review:${uid}:${projectId}`
  const root = `/projects/${projectId}/project-agent`
  const [data, setData] = useState<AgentScheduleDashboard | null>(null), [error, setError] = useState(''), [reason, setReason] = useState('')
  const [pending, setPending] = useState<ReplanPending | null>(null), [busy, setBusy] = useState(false), [ready, setReady] = useState(false)
  const active = useRef(true), working = useRef(false)
  useEffect(() => { onBusyChange(busy) }, [busy, onBusyChange])
  useEffect(() => { onDirtyChange(Boolean(reason.trim())) }, [reason, onDirtyChange])
  const refresh = async () => { const value = await apiGet<AgentScheduleDashboard>(`${root}/schedules`); if (active.current) setData(value) }
  useEffect(() => {
    active.current = true
    try { setPending(readReplanPending(sessionStorage, key)); setReady(true) } catch { setError('操作恢复信息不可读，请联系管理员核对') }
    void refresh().catch(() => { if (active.current) setError('改期审批读取失败，请返回列表重试') })
    return () => { active.current = false }
  }, [key])
  const row = data?.approvals.find(r => r.id === requestId)
  const verify = (raw: unknown, marker: ReplanPending) => {
    const receipt = agentReceiptSchema.parse(raw)
    if (marker.kind !== 'action' || receipt.kind !== 'schedule' || receipt.id !== marker.requestId || receipt.version !== marker.expectedVersion + 1) throw new Error('操作结果尚未确认，请核对上次操作')
  }
  const run = async (action?: 'approve' | 'reject' | 'withdraw') => {
    if (working.current || !ready || action && (!row || pending)) return
    working.current = true; setBusy(true); setError('')
    try {
      if (action && row) {
        const command = agentScheduleAction.parse({ clientRequestId: crypto.randomUUID(), expectedVersion: row.version, action, reason })
        const marker: ReplanPending = { kind: 'action', commandId: command.clientRequestId, requestId, expectedVersion: row.version }
        saveReplanPending(sessionStorage, key, marker); setPending(marker)
        verify(await apiPost(`${root}/schedules/${requestId}/action`, command), marker)
        clearReplanPending(sessionStorage, key, marker)
        if (active.current) { setPending(null); await onHandled() }
      } else if (pending) {
        const value = agentResolutionSchema.parse(await apiPost(`${root}/resolve-command`, { clientRequestId: pending.commandId }))
        if (value.state === 'committed') verify(value.receipt, pending)
        clearReplanPending(sessionStorage, key, pending)
        if (active.current) { setPending(null); await refresh() }
      }
    } catch (cause) { if (active.current) setError((cause as Error).message) }
    finally { working.current = false; if (active.current) setBusy(false) }
  }
  return <div className="space-y-5">
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {pending && <div className="flex flex-wrap items-center gap-3 text-sm text-amber-700">上次操作结果待核对<Button variant="secondary" disabled={busy} onClick={() => void run()}>核对处理结果</Button></div>}
    {!data && !error && <LoadingState />}
    {data && !row && <p role="alert">该审批已不可访问，请返回待办列表核对</p>}
    {row && <>
      <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{row.stage} · 节点改期</h3><Badge>{row.status}</Badge></div>
      <p className="text-sm">{row.previousDate} → {row.requestedDate}</p><p className="whitespace-pre-wrap text-sm leading-7">{row.reason}</p>
      <section className="space-y-3"><h3 className="text-sm font-semibold">审批进度</h3>{row.nodes.map((node, index) => <div key={index} className="border-l-2 border-slate-200 pl-3 text-sm"><p>{node.name} · {node.status}</p><p className="mt-1 text-xs text-slate-500">{node.approverNames.join('、')}</p></div>)}</section>
      {row.stale && <p role="alert" className="text-sm text-amber-700">申请依据已变化，请申请人撤回后重新提交</p>}
      {(row.canApprove || row.canWithdraw) && <><label className="block text-sm">审批意见（至少 6 字）<textarea className="textarea mt-2" value={reason} disabled={busy} onChange={e => setReason(e.target.value)} /></label><div className="flex flex-wrap justify-end gap-3">{row.canWithdraw && <Button variant="secondary" disabled={busy || !ready || Boolean(pending) || reason.trim().length < 6} onClick={() => void run('withdraw')}>撤回</Button>}{row.canApprove && <><Button variant="secondary" disabled={busy || !ready || Boolean(pending) || reason.trim().length < 6} onClick={() => void run('reject')}>拒绝</Button><Button disabled={busy || !ready || Boolean(pending) || row.stale || reason.trim().length < 6} onClick={() => void run('approve')}>同意改期</Button></>}</div></>}
      <details><summary className="cursor-pointer text-sm">审批记录</summary>{row.history.map((entry, index) => <p key={index} className="mt-3 text-xs leading-6">{entry.actor} · {entry.action}：{entry.reason}</p>)}</details>
    </>}
  </div>
}
