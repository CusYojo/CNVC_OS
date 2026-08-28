import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { AgentScheduleDashboard } from '../../server/src/contracts/fdeAgentScheduleContract'
import { Button, Modal } from './ui'

export function FdeAgentSchedulePanel({ data, disabled, perform }: { data: AgentScheduleDashboard; disabled: boolean; perform: (path: string, body: object) => Promise<void> }) {
  const [form, setForm] = useState<{ path: string; version: number; title: string; action?: string; date: string } | null>(null)
  const [reason, setReason] = useState('')
  const [params] = useSearchParams(), selected = params.get('schedule'), focused = useRef<string | null>(null)
  useEffect(() => {
    if (!selected || focused.current === selected || !data.approvals.some(item => item.id === selected)) return
    const node = document.getElementById(`agent-schedule-${selected}`)
    if (node) { node.scrollIntoView({ block: 'center' }); node.focus({ preventScroll: true }); focused.current = selected }
  }, [selected, data.approvals])
  return <section className="mt-5 border-t border-[#dfe6e4] pt-4" aria-label="节点改期审批">
    <h3 className="font-semibold">节点日期与改期审批</h3>
    <p className="mt-1 text-xs leading-5 text-slate-500">采纳 → 提交改期 → 指定领导独立审批 → 节点日期生效。项目阶段、最终目标日和独立任务期限不会被自动替换。</p>
    <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">{data.timeline.map(item => <div key={item.stage} className="rounded-lg bg-slate-50 p-2 text-xs"><strong>{item.stage}</strong><p>{item.date}</p><small>{item.basis === 'approved' ? `批准日期 V${item.version}` : '周期推算'}</small></div>)}</div>
    {data.submissions.map(item => <div key={item.recommendationId} className="mt-3 rounded-lg border border-amber-200 p-3 text-sm"><p>待提交草案：{item.date}</p><p className="my-2 text-xs text-slate-500">允许区间：{data.window?.minimum ?? '未确定'} 至 {data.window?.maximum ?? '未确定'}；修改申请日期需说明理由。</p><Button disabled={disabled || !data.window?.available} onClick={() => { setReason(''); setForm({ path: `/recommendations/${item.recommendationId}/schedule`, version: item.version, title: '发起节点改期', date: item.date }) }}>发起节点改期审批</Button></div>)}
    {data.approvals.map(item => <article key={item.id} id={`agent-schedule-${item.id}`} tabIndex={-1} className={`mt-3 rounded-lg border p-3 text-sm ${selected === item.id ? 'border-[#315f68] ring-2 ring-[#a8c5c3]' : ''}`}><div className="flex flex-wrap justify-between gap-2"><strong>{item.stage}：{item.previousDate} → {item.requestedDate}</strong><span>{item.status} · {item.currentNodeName}</span></div><p className="mt-2 break-words">申请原因：{item.reason}</p>
      <p className="mt-2 text-xs text-slate-500">{item.nodes.map(node => `${node.name}（${node.approverNames.join('、')}）：${node.status}`).join(' → ')}</p>
      {item.stale && <p className="mt-2 text-amber-800">依据或权限已变化，不能批准；申请人可撤回后重新研判。</p>}
      <div className="mt-3 flex flex-wrap gap-2">{(['approve', 'reject', 'withdraw'] as const).filter(action => action === 'withdraw' ? item.canWithdraw : item.canApprove).map(action => <Button key={action} variant="secondary" disabled={disabled || action === 'approve' && item.stale} onClick={() => { setReason(''); setForm({ path: `/schedules/${item.id}/action`, version: item.version, title: action === 'approve' ? '同意节点改期' : action === 'reject' ? '拒绝节点改期' : '撤回改期申请', action, date: '' }) }}>{action === 'approve' ? '同意改期' : action === 'reject' ? '拒绝改期' : '撤回申请'}</Button>)}</div>
      <details className="mt-3"><summary>审批记录</summary>{item.history.map((entry, index) => <p key={index} className="mt-2 break-words text-xs">{entry.actor} · {entry.action} · {new Date(entry.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}：{entry.reason}</p>)}</details>
    </article>)}
    {form && <Modal open title={form.title} onClose={() => { if (!disabled) setForm(null) }}><form className="space-y-4" onSubmit={event => { event.preventDefault(); void perform(form.path, { expectedVersion: form.version, reason, ...(form.action ? { action: form.action } : { requestedDate: form.date }) }) }}>
      {!form.action && <label className="block text-sm">申请节点日期<input className="mt-1 block w-full rounded border p-2" type="date" required min={data.window?.minimum} max={data.window?.maximum} value={form.date} disabled={disabled} onChange={event => setForm({ ...form, date: event.target.value })} /></label>}
      <p className="text-xs leading-5 text-slate-500">批准只更新本次申请的节点日期；不代办阶段审批、付款、任务延期或领导日程确认。审批岗位由当前项目职责及机构角色确定。</p>
      <label className="block text-sm">原因或审批意见<textarea className="mt-1 block w-full rounded border p-2" required minLength={6} maxLength={600} value={reason} disabled={disabled} onChange={event => setReason(event.target.value)} /></label><Button type="submit" disabled={disabled}>确认{form.action ? '处理' : '提交'}</Button>
    </form></Modal>}
  </section>
}
