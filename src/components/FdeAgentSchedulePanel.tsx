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
  return <section className="fde-agent-schedule" aria-label="节点改期审批">
    <header><div><span>项目时间治理</span><h3>节点日期与改期审批</h3></div><p>采纳建议 → 提交改期 → 指定领导独立审批 → 节点日期生效。项目阶段、最终目标日和独立任务期限不会被自动替换。</p></header>
    <div className="fde-agent-schedule-timeline">{data.timeline.map(item => <div key={item.stage}><span>{item.basis === 'approved' ? '已批准' : '计划'}</span><strong>{item.stage}</strong><p>{item.date}</p><small>{item.basis === 'approved' ? `批准日期 V${item.version}` : '周期推算'}</small></div>)}</div>
    <div className="fde-agent-schedule-content">
    {data.submissions.map(item => <div key={item.recommendationId} className="fde-agent-schedule-draft"><div><span>待提交改期草案</span><strong>{item.date}</strong><p>允许区间：{data.window?.minimum ?? '未确定'} 至 {data.window?.maximum ?? '未确定'}；修改申请日期需说明理由。</p></div><Button disabled={disabled || !data.window?.available} onClick={() => { setReason(''); setForm({ path: `/recommendations/${item.recommendationId}/schedule`, version: item.version, title: '发起节点改期', date: item.date }) }}>发起节点改期审批</Button></div>)}
    {data.approvals.map(item => <article key={item.id} id={`agent-schedule-${item.id}`} tabIndex={-1} className={`fde-agent-schedule-approval ${selected === item.id ? 'selected' : ''}`}><div className="flex flex-wrap justify-between gap-2"><strong>{item.stage}：{item.previousDate} → {item.requestedDate}</strong><span>{item.status} · {item.currentNodeName}</span></div><p className="mt-2 break-words">申请原因：{item.reason}</p>
      <p className="mt-2 text-xs text-slate-500">{item.nodes.map(node => `${node.name}（${node.approverNames.join('、')}）：${node.status}`).join(' → ')}</p>
      {item.stale && <p className="mt-2 text-amber-800">依据或权限已变化，不能批准；申请人可撤回后重新研判。</p>}
      <div className="mt-3 flex flex-wrap gap-2">{(['approve', 'reject', 'withdraw'] as const).filter(action => action === 'withdraw' ? item.canWithdraw : item.canApprove).map(action => <Button key={action} variant="secondary" disabled={disabled || action === 'approve' && item.stale} onClick={() => { setReason(''); setForm({ path: `/schedules/${item.id}/action`, version: item.version, title: action === 'approve' ? '同意节点改期' : action === 'reject' ? '拒绝节点改期' : '撤回改期申请', action, date: '' }) }}>{action === 'approve' ? '同意改期' : action === 'reject' ? '拒绝改期' : '撤回申请'}</Button>)}</div>
      <details className="mt-3"><summary>审批记录</summary>{item.history.map((entry, index) => <p key={index} className="mt-2 break-words text-xs">{entry.actor} · {entry.action} · {new Date(entry.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}：{entry.reason}</p>)}</details>
    </article>)}
    {!data.submissions.length && !data.approvals.length && <p className="fde-agent-schedule-empty">当前没有待提交或审批中的节点改期</p>}
    </div>
    {form && <Modal open title={form.title} onClose={() => { if (!disabled) setForm(null) }}><form className="space-y-4" onSubmit={event => { event.preventDefault(); void perform(form.path, { expectedVersion: form.version, reason, ...(form.action ? { action: form.action } : { requestedDate: form.date }) }) }}>
      {!form.action && <label className="block text-sm">申请节点日期<input className="mt-1 block w-full rounded border p-2" type="date" required min={data.window?.minimum} max={data.window?.maximum} value={form.date} disabled={disabled} onChange={event => setForm({ ...form, date: event.target.value })} /></label>}
      <label className="block text-sm">原因或审批意见<textarea className="mt-1 block w-full rounded border p-2" required minLength={6} maxLength={600} value={reason} disabled={disabled} onChange={event => setReason(event.target.value)} /></label><Button type="submit" disabled={disabled}>确认{form.action ? '处理' : '提交'}</Button>
    </form></Modal>}
  </section>
}
