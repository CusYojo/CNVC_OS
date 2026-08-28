import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, CalendarDays, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { useToast } from './Toast'
import { Badge, Button, Card, Modal } from './ui'
import { shanghaiToday, shiftDate, weekStartFor, type WeeklyManualItem } from '../../server/src/contracts/fdeWeeklyPlanContract'
import './fde-workspace.css'

type PlanItem = { needLeader: boolean; sourceStage: string | null; leaderTimeSource: { planId: string; itemId: string; stage: string | null } | null; id: string; itemKey: string; sourceKind: string; taskId: string | null; title: string; ownerUserId: string; dueDate: string; dueTime: string | null; deliverable: string; priority: string; task: { status: string; progress: number; dueDate: string | null; dueTime: string | null } | null }
type Data = { leaderTimePending: Array<{ id: string; issues: string[] }>; leaderTimePendingCount: number; canDraft: boolean; canPublish: boolean; members: Array<{ id: string; name: string }>; plans: Array<{ id: string; revision: number; version: number; goal: string; status: string; sourceChanged: boolean; sourceMeetingId: string | null; sourceMeetingVersion: number | null; items: PlanItem[]; events: Array<{ id: string; version: number; action: string; reason: string; createdAt: string }> }>; notices: Array<{ id: string; kind: string; readAt: string | null }> }
type Plan = Data['plans'][number]
type Action = 'reconcile' | 'submit' | 'publish' | 'return' | 'discard' | 'sync-leader-time'
const statusLabels: Record<string, string> = { draft: '草稿', submitted: '待负责人确认', published: '已发布', discarded: '已丢弃' }
const actionLabels: Record<string, string> = { create: '创建草稿', meeting: '由已确认例会生成草稿', save: '保存草稿', reconcile: '对账来源任务', submit: '提交确认', publish: '确认并发布', return: '退回修改', discard: '丢弃草稿', 'sync-leader-time': '核对项目领导需求' }

export function FdeWeeklyPlanPanel({ projectId, initialWeek, onChanged }: { projectId: string; initialWeek?: string; onChanged?: () => Promise<void> }) {
  const navigate = useNavigate(), { showToast } = useToast()
  const [week, setWeek] = useState(() => initialWeek ?? weekStartFor(shanghaiToday()))
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<{ plan: Plan; goal: string; items: WeeklyManualItem[]; requestId: string } | null>(null)
  const [decision, setDecision] = useState<{ plan: Plan; action: Action; reason: string; requestId: string } | null>(null)
  const createRequest = useRef({ scope: '', id: '' })
  const endpoint = `/projects/${projectId}/weekly-plans`
  const scopeRef = useRef(`${projectId}:${week}`)
  scopeRef.current = `${projectId}:${week}`
  async function reload() {
    const scope = `${projectId}:${week}`
    const result = await apiGet<Data>(`${endpoint}?weekStart=${week}`)
    if (scopeRef.current === scope) { setData(result); setError('') }
  }
  useEffect(() => {
    let current = true
    setData(null); setError(''); setEditor(null); setDecision(null)
    apiGet<Data>(`${endpoint}?weekStart=${week}`).then((result) => { if (current) setData(result) }).catch((cause) => { if (current) setError((cause as Error).message) })
    return () => { current = false }
  }, [endpoint, week])
  async function run(operation: () => Promise<unknown>, message: string) {
    if (busy) return
    setBusy(true)
    try {
      await operation()
      setEditor(null); setDecision(null); createRequest.current = { scope: '', id: '' }
      showToast(message)
      try { await reload(); await onChanged?.() } catch (cause) { showToast(`操作已保存，刷新失败：${(cause as Error).message}，请刷新核对结果。`, 'error') }
    } catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }
  function createDraft() {
    const scope = `${projectId}:${week}`
    if (createRequest.current.scope !== scope) createRequest.current = { scope, id: crypto.randomUUID() }
    void run(() => apiPost(endpoint, { clientRequestId: createRequest.current.id, weekStart: week }), '周计划草稿已建立，尚未发布任务')
  }
  function edit(plan: Plan) {
    setEditor({ plan, goal: plan.goal, requestId: crypto.randomUUID(), items: plan.items.filter((item) => item.sourceKind === 'manual').map((item) => ({ key: item.itemKey.slice(7), title: item.title, ownerUserId: item.ownerUserId, dueDate: item.dueDate, dueTime: item.dueTime, needLeader: item.needLeader, deliverable: item.deliverable, priority: item.priority as WeeklyManualItem['priority'] })) })
  }
  function updateItem(index: number, patch: Partial<WeeklyManualItem>) {
    setEditor((current) => current ? { ...current, requestId: crypto.randomUUID(), items: current.items.map((item, i) => i === index ? { ...item, ...patch } : item) } : current)
  }
  const missingLeaderTime = editor?.items.some(item => item.needLeader && !item.dueTime) ?? false
  const ask = (plan: Plan, action: Action) => setDecision({ plan, action, reason: '', requestId: crypto.randomUUID() })
  return <div className="fde-workspace"><Card className="fde-panel p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 font-semibold"><CalendarDays className="h-4 w-4" />本周工作与周计划</h2><p className="mt-1 text-xs text-slate-500">秘书草拟 → 负责人确认发布 → 原任务执行与验收。当前周同时纳入未结束的逾期事项。</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={() => { void reload().catch((cause) => setError((cause as Error).message)) }}><RefreshCw className="h-4 w-4" />刷新</Button>{data?.canDraft && !data.plans.some((plan) => ['draft', 'submitted'].includes(plan.status)) && <Button disabled={busy} onClick={createDraft}><Plus className="h-4 w-4" />{data.plans.length ? '草拟新版本' : '草拟周计划'}</Button>}</div></div>
    <div className="my-4 flex flex-wrap items-center gap-3"><Button variant="secondary" disabled={busy} onClick={() => setWeek(shiftDate(week, -7))}><ArrowLeft className="h-4 w-4" />上周</Button><label className="flex items-center gap-2 text-sm">选择周<input aria-label="周计划日期" className="input" type="date" value={week} disabled={busy} onChange={(event) => { if (event.target.value) setWeek(weekStartFor(event.target.value)) }} /></label><span className="text-xs text-slate-500">至 {shiftDate(week, 6)} · 上海时区</span><Button variant="secondary" disabled={busy} onClick={() => setWeek(shiftDate(week, 7))}>下周<ArrowRight className="h-4 w-4" /></Button></div>
    {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {!data && !error && <p className="py-6 text-sm text-slate-500">正在读取周计划…</p>}
    {data && <>
      {data.leaderTimePendingCount > 0 && <div role="alert" className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>项目有 {data.leaderTimePendingCount} 条领导需求联动待处理，以下显示最近 {data.leaderTimePending.length} 条。任务发布不代表领导需求已全部生成或确认。</p>{data.leaderTimePending.map(item => <p key={item.id} className="mt-1 text-xs">{item.issues.join('；')}</p>)}<p className="mt-2 text-xs">请先完善有效职责或来源，再通过已发布计划的“核对项目领导需求”重试；不会自动补授权。</p></div>}
      {data.notices.filter((notice) => !notice.readAt).map((notice) => <div key={notice.id} className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-teal-50 p-3 text-sm"><span>{notice.kind === 'review' ? '周计划等待你确认' : notice.kind === 'returned' ? '周计划已退回，请修改' : '周计划已发布，请按正式任务执行'}（站内通知）</span><Button variant="secondary" disabled={busy} onClick={() => { void run(() => apiPost(`/projects/${projectId}/weekly-notices/${notice.id}/read`, {}), '已标记阅读') }}>标记已读</Button></div>)}
      {!data.plans.length && <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-500">当前周尚无可见计划。秘书可草拟；其他成员在负责人发布后查看。原项目任务继续在“项目待办”处理。</p>}
      <div className="space-y-4">{data.plans.map((plan) => <section key={plan.id} className="rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium">周计划 R{plan.revision}<span className="ml-2 text-xs font-normal text-slate-400">记录 v{plan.version}</span></h3><p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{plan.goal || '尚未填写本周目标'}</p></div><Badge tone={plan.status === 'published' ? 'green' : plan.status === 'submitted' ? 'amber' : 'slate'}>{statusLabels[plan.status]}</Badge></div>
        {plan.sourceChanged && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">来源任务、人员或期限已变化。{plan.status === 'submitted' ? '请负责人退回，秘书对账后重新提交。' : '请先对账来源任务再提交确认。'}</p>}
        {plan.sourceMeetingId && <button className="mt-3 text-xs text-teal-800 underline" onClick={() => navigate(`/collaboration?view=friday&project=${projectId}`)}>来自已确认例会 v{plan.sourceMeetingVersion} · 查看来源纪要</button>}
        <div className="mt-3 divide-y divide-slate-100">{plan.items.map((item) => <div key={item.id} className="py-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="font-medium">{item.title}</strong><span className="text-xs text-slate-500">{item.task?.status ?? (item.sourceKind === 'manual' ? '拟新增，未发布' : '已批准计划待对账')}</span></div><p className="mt-1 text-xs text-slate-500">{data.members.find((person) => person.id === item.ownerUserId)?.name ?? '原负责人已不可用'} · 计划快照 {item.dueDate} {item.dueTime ?? ''}{item.task && (item.task.dueDate !== item.dueDate || item.task.dueTime !== item.dueTime) ? ` · 当前有效期限 ${item.task.dueDate} ${item.task.dueTime ?? ''}` : ''} · {item.sourceKind === 'manual' ? '手工计划' : '正式来源'}</p>{(item.needLeader || item.leaderTimeSource) && <p className="mt-1 text-xs text-teal-800">需领导参与 · {plan.status === 'published' || item.leaderTimeSource ? '领导需求引用原任务当前期限，仍须领导确认' : '负责人发布后才生成时间需求'}</p>}{item.deliverable && <p className="mt-1 text-xs text-slate-600">交付物：{item.deliverable}</p>}{item.taskId && <button className="mt-2 text-xs text-brand-700 underline" onClick={() => navigate(`/projects/${projectId}?tab=tasks`)}>进入原任务反馈与验收</button>}{item.taskId && (item.needLeader || item.leaderTimeSource) && <button className="ml-3 mt-2 text-xs text-brand-700 underline" onClick={() => navigate(`/collaboration?view=time&week=${weekStartFor(item.task?.dueDate ?? item.dueDate)}`)}>查看领导时间</button>}</div>)}</div>
        <div className="mt-3 flex flex-wrap gap-2">{plan.status === 'draft' && data.canDraft && <><Button variant="secondary" disabled={busy} onClick={() => edit(plan)}>编辑目标与新增行动</Button><Button variant="secondary" disabled={busy} onClick={() => ask(plan, 'reconcile')}>对账来源任务</Button><Button disabled={busy || plan.sourceChanged} onClick={() => ask(plan, 'submit')}>提交负责人确认</Button><Button variant="secondary" disabled={busy} onClick={() => ask(plan, 'discard')}>丢弃草稿</Button></>}{plan.status === 'submitted' && data.canPublish && <><Button disabled={busy || plan.sourceChanged} onClick={() => ask(plan, 'publish')}>确认并发布</Button><Button variant="secondary" disabled={busy} onClick={() => ask(plan, 'return')}>退回修改</Button></>}{plan.status === 'published' && (data.canDraft || data.canPublish) && <Button variant="secondary" disabled={busy} onClick={() => ask(plan, 'sync-leader-time')}>核对项目领导需求</Button>}</div>
        <details className="mt-4 border-t border-slate-100 pt-3"><summary className="cursor-pointer text-xs text-slate-500">版本与操作记录（{plan.events.length}）</summary><div className="mt-2 space-y-2">{plan.events.map((event) => <p key={event.id} className="text-xs text-slate-600">v{event.version} · {actionLabels[event.action] ?? event.action} · {new Date(event.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}{event.reason ? ` · ${event.reason}` : ''}</p>)}</div></details>
      </section>)}</div>
    </>}
  </Card>
    <Modal open={Boolean(editor)} title="编辑周计划草稿" width="max-w-3xl" onClose={() => { if (!busy) setEditor(null) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setEditor(null)}>取消</Button><Button loading={busy} disabled={!editor?.goal.trim() || missingLeaderTime} onClick={() => { if (editor) void run(() => apiPost(`${endpoint}/${editor.plan.id}/save`, { clientRequestId: editor.requestId, expectedVersion: editor.plan.version, goal: editor.goal, manualItems: editor.items }), '草稿已保存，尚未发布任务') }}>保存草稿</Button></>}>
      {editor && <div className="space-y-4"><label className="block"><span className="label">本周目标</span><textarea className="textarea w-full" maxLength={4000} value={editor.goal} onChange={(event) => setEditor({ ...editor, goal: event.target.value, requestId: crypto.randomUUID() })} /></label><p className="text-xs text-slate-500">原任务的负责人和期限只能在对应业务流程修改，这里仅编辑新增行动。需领导参与时请填写精确时刻；保存或提交草稿不会创建正式任务及时间需求。</p>{missingLeaderTime && <p role="alert" className="text-sm text-amber-800">需领导参与的行动缺少截止时刻，请补齐后保存。</p>}{editor.items.map((item, index) => <fieldset key={item.key} className="grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-2"><legend className="text-sm font-medium">新增行动 {index + 1}</legend><label><span className="label">行动名称</span><input className="input w-full" value={item.title} onChange={(event) => updateItem(index, { title: event.target.value })} /></label><label><span className="label">负责人</span><select className="input w-full" value={item.ownerUserId} onChange={(event) => updateItem(index, { ownerUserId: event.target.value })}><option value="">请选择实际账号</option>{data?.members.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label><span className="label">截止日期</span><input type="date" className="input w-full" min={week} max={shiftDate(week, 6)} value={item.dueDate} onInput={(event) => updateItem(index, { dueDate: event.currentTarget.value })} onChange={(event) => updateItem(index, { dueDate: event.target.value })} /></label><label><span className="label">截止时刻（上海时间）</span><input type="time" step={60} className="input w-full" required={item.needLeader} value={item.dueTime ?? ''} onInput={event => updateItem(index, { dueTime: event.currentTarget.value || null })} onChange={event => updateItem(index, { dueTime: event.target.value || null })} /></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.needLeader ?? false} onChange={event => updateItem(index, { needLeader: event.target.checked })} />该行动需要领导参与</label><label><span className="label">优先级</span><select className="input w-full" value={item.priority} onChange={(event) => updateItem(index, { priority: event.target.value as WeeklyManualItem['priority'] })}><option>高</option><option>中</option><option>低</option></select></label><label className="sm:col-span-2"><span className="label">交付物</span><textarea className="textarea w-full" value={item.deliverable} onChange={(event) => updateItem(index, { deliverable: event.target.value })} /></label><Button variant="secondary" disabled={busy} onClick={() => setEditor({ ...editor, requestId: crypto.randomUUID(), items: editor.items.filter((_, i) => i !== index) })}><Trash2 className="h-4 w-4" />移除草稿行动</Button></fieldset>)}<Button variant="secondary" disabled={busy || editor.items.length >= 100} onClick={() => setEditor({ ...editor, requestId: crypto.randomUUID(), items: [...editor.items, { key: crypto.randomUUID(), title: '', ownerUserId: '', dueDate: week, dueTime: null, needLeader: false, deliverable: '', priority: '中' }] })}><Plus className="h-4 w-4" />新增行动</Button></div>}
    </Modal>
    <Modal open={Boolean(decision)} title={decision ? actionLabels[decision.action] : ''} onClose={() => { if (!busy) setDecision(null) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setDecision(null)}>取消</Button><Button loading={busy} disabled={Boolean(decision && ['return', 'discard'].includes(decision.action) && decision.reason.trim().length < 5)} onClick={() => { if (decision) void run(() => apiPost(`${endpoint}/${decision.plan.id}/actions`, { clientRequestId: decision.requestId, expectedVersion: decision.plan.version, action: decision.action, reason: decision.reason }), `${actionLabels[decision.action]}已保存`) }}>确认</Button></>}>
      {decision && <div className="space-y-4"><p className="text-sm text-slate-600">{decision.action === 'publish' ? '发布将创建新增正式任务和站内通知。需领导参与的行动按发布时的阶段及有效职责派生待协调需求，不代表领导已确认；缺岗时保留可见待处理。原任务状态、有效期限及已发布历史不变，不包含外部 IM 投递。' : decision.action === 'sync-leader-time' ? '按项目当前有效职责及已发布人工行动核对领导需求。只更新未经人工处理的派生需求，已确认安排须按原权限重新确认；不改任务期限或已发布计划快照。' : decision.action === 'reconcile' ? '重新读取正式任务和已批准计划；只更新草稿来源快照，不修改原任务或已发布版本。' : `对 R${decision.plan.revision} 执行“${actionLabels[decision.action]}”，操作和当前快照将保留。`}</p>{['return', 'discard'].includes(decision.action) && <label className="block"><span className="label">原因（至少五字）</span><textarea className="textarea w-full" value={decision.reason} onChange={(event) => setDecision({ ...decision, requestId: crypto.randomUUID(), reason: event.target.value })} /></label>}</div>}
    </Modal>
  </div>
}
