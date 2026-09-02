import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { Badge, Button, Card, Modal } from './ui'
import { useToast } from './Toast'
import { fridayCreateSchema, nextMeetingWeek, type FridayMinutes } from '../../server/src/contracts/fdeFridayMeetingContract'
import { shanghaiToday, shiftDate, weekStartFor } from '../../server/src/contracts/fdeWeeklyPlanContract'
import './fde-workspace.css'

type Meeting = { id: string; title: string; startedAt: string; endsAt: string; hostUserId: string; host: string; version: number; workflowStatus: string; weeklyReview: FridayMinutes | null; participants: Array<{ userId: string; sourceName: string }>; nextWeek: string; plans: Array<{ id: string; weekStart: string; status: string; revision: number }>; events: Array<{ id: string; version: number; action: string; reason: string; createdAt: string; snapshot: { meeting: { weeklyReview: FridayMinutes | null } } }> }
type Data = { list: Meeting[]; canManage: boolean; canDerive: boolean; members: Array<{ id: string; name: string }>; notices: Array<{ id: string; meetingId: string; kind: string; readAt: string | null }> }
type Editor = { meeting?: Meeting; title: string; startsAt: string; endsAt: string; hostUserId: string; participantIds: string[]; minutes: FridayMinutes; reason: string; requestId: string }
type Action = 'schedule' | 'confirm' | 'cancel' | 'derive'
const status: Record<string, string> = { draft: '会前草稿', scheduled: '已排期 / 待确认纪要', completed: '纪要已确认', cancelled: '已取消' }
const actions: Record<string, string> = { create: '创建草稿', save: '保存修改', schedule: '确认排期', confirm: '确认纪要', cancel: '取消例会', derive: '生成下周计划草稿' }
const localTime = (value: string) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16)
const showTime = (value: string) => localTime(value).replace('T', ' ')

export function FdeFridayMeetingPanel({ projectId }: { projectId: string }) {
  const endpoint = `/projects/${projectId}/friday-meetings`, navigate = useNavigate(), { showToast } = useToast()
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null), [validation, setValidation] = useState('')
  const [decision, setDecision] = useState<{ meeting: Meeting; action: Action; reason: string; requestId: string } | null>(null)
  const [detail, setDetail] = useState<Meeting | null>(null)
  async function reload() { const result = await apiGet<Data>(endpoint); setData(result); setError('') }
  useEffect(() => {
    let current = true
    setData(null); setError(''); setEditor(null); setDecision(null); setDetail(null)
    apiGet<Data>(endpoint).then((result) => { if (current) setData(result) }).catch((cause) => { if (current) setError((cause as Error).message) })
    return () => { current = false }
  }, [endpoint])
  async function run(operation: () => Promise<unknown>, message: string) {
    if (busy) return
    setBusy(true)
    try {
      await operation(); setEditor(null); setDecision(null); setDetail(null); showToast(message)
      try { await reload() } catch (cause) { setError(`操作已保存，刷新失败：${(cause as Error).message}。请重试读取，不要重复建会。`) }
    } catch (cause) { setValidation((cause as Error).message); showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }
  function openEditor(meeting?: Meeting) {
    const friday = shiftDate(weekStartFor(shanghaiToday()), 4)
    setValidation('')
    setEditor(meeting ? { meeting, title: meeting.title, startsAt: localTime(meeting.startedAt), endsAt: localTime(meeting.endsAt), hostUserId: meeting.hostUserId, participantIds: meeting.participants.map((person) => person.userId), minutes: structuredClone(meeting.weeklyReview!), reason: '', requestId: crypto.randomUUID() } : { title: '周五例会', startsAt: `${friday}T16:00`, endsAt: `${friday}T17:00`, hostUserId: '', participantIds: [], minutes: { agenda: '', result: '', blocked: '', decision: '', nextGoal: '', nextActions: [] }, reason: '', requestId: crypto.randomUUID() })
  }
  function update(patch: Partial<Editor>) { setEditor((current) => current ? { ...current, ...patch, requestId: crypto.randomUUID() } : current) }
  function updateMinutes(patch: Partial<FridayMinutes>) { setEditor((current) => current ? { ...current, requestId: crypto.randomUUID(), minutes: { ...current.minutes, ...patch } } : current) }
  function updateAction(index: number, patch: Partial<FridayMinutes['nextActions'][number]>) { setEditor((current) => current ? { ...current, requestId: crypto.randomUUID(), minutes: { ...current.minutes, nextActions: current.minutes.nextActions.map((item, i) => i === index ? { ...item, ...patch } : item) } } : current) }
  function save() {
    if (!editor) return
    const body = { clientRequestId: editor.requestId, title: editor.title, startsAt: editor.startsAt, endsAt: editor.endsAt, hostUserId: editor.hostUserId, participantIds: editor.participantIds, minutes: editor.minutes }
    const parsed = fridayCreateSchema.safeParse(body)
    if (!parsed.success) { setValidation(parsed.error.issues.map((issue) => issue.message).join('；')); return }
    if (editor.meeting && editor.reason.trim().length < 5) { setValidation('请填写至少五字修改说明'); return }
    void run(() => apiPost(editor.meeting ? `${endpoint}/${editor.meeting.id}/save` : endpoint, editor.meeting ? { ...body, expectedVersion: editor.meeting.version, reason: editor.reason } : body), '例会已保存，尚未发布下周任务')
  }
  function openAction(meeting: Meeting, action: Action) { setValidation(''); setDecision({ meeting, action, reason: '', requestId: crypto.randomUUID() }) }
  return <div className="fde-workspace space-y-4">
    <Card className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-semibold"><CalendarDays className="h-5 w-5" />周五例会</h2><div className="flex gap-2"><Button variant="secondary" disabled={busy} onClick={() => { void reload().catch((cause) => setError((cause as Error).message)) }}><RefreshCw className="h-4 w-4" />刷新</Button>{data?.canManage && <Button disabled={busy} onClick={() => openEditor()}><Plus className="h-4 w-4" />新建例会</Button>}</div></div></Card>
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-4 text-sm text-rose-700">{error}</p>}
    {!data && !error && <p className="p-6 text-sm text-slate-500">正在读取例会…</p>}
    {data?.notices.filter((notice) => !notice.readAt).map((notice) => <div key={notice.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-teal-50 p-3 text-sm"><span>{data.list.find((meeting) => meeting.id === notice.meetingId)?.title}：{notice.kind === 'updated' ? '安排或纪要草稿已更新' : status[notice.kind]}（站内通知）</span><Button variant="secondary" disabled={busy} onClick={() => { void run(() => apiPost(`/projects/${projectId}/friday-notices/${notice.id}/read`, {}), '已标记阅读') }}>标记已读</Button></div>)}
    {data && !data.list.length && <Card className="p-8 text-center text-sm text-slate-500">暂无可见例会；未排期草稿只对项目负责人和推进秘书可见。</Card>}
    {data?.list.map((meeting) => <Card key={meeting.id} className="p-5"><div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold">{meeting.title}</h3><p className="mt-2 text-xs text-slate-500">{showTime(meeting.startedAt)} — {showTime(meeting.endsAt)} · 主持 {meeting.host}</p><p className="mt-1 text-xs text-slate-500">参会：{meeting.participants.map((person) => person.sourceName).join('、')}</p></div><Badge tone={meeting.workflowStatus === 'completed' ? 'green' : 'slate'}>{status[meeting.workflowStatus]}</Badge></div>
      {meeting.weeklyReview ? <div className="mt-4 space-y-2 text-sm"><p className="whitespace-pre-wrap">议题：{meeting.weeklyReview.agenda}</p>{meeting.workflowStatus === 'completed' && <><p className="whitespace-pre-wrap">结果：{meeting.weeklyReview.result}</p><p className="whitespace-pre-wrap">阻塞：{meeting.weeklyReview.blocked || '未记录阻塞'}</p><p className="whitespace-pre-wrap">决定：{meeting.weeklyReview.decision}</p><p className="whitespace-pre-wrap">下周目标：{meeting.weeklyReview.nextGoal}</p></>}</div> : <p className="mt-3 text-sm text-slate-500">纪要尚未人工确认，不展示为正式结论。</p>}
      <div className="mt-4 flex flex-wrap gap-2">{data.canManage && ['draft', 'scheduled'].includes(meeting.workflowStatus) && <Button variant="secondary" disabled={busy} onClick={() => openEditor(meeting)}>编辑议题与纪要</Button>}{data.canManage && meeting.workflowStatus === 'draft' && <Button disabled={busy} onClick={() => openAction(meeting, 'schedule')}>确认排期</Button>}{data.canManage && meeting.workflowStatus === 'scheduled' && <Button disabled={busy} onClick={() => openAction(meeting, 'confirm')}>确认纪要</Button>}{data.canManage && ['draft', 'scheduled'].includes(meeting.workflowStatus) && <Button variant="danger" disabled={busy} onClick={() => openAction(meeting, 'cancel')}>取消例会</Button>}{data.canDerive && meeting.workflowStatus === 'completed' && !meeting.plans.some((plan) => plan.status !== 'discarded') && <Button disabled={busy} onClick={() => openAction(meeting, 'derive')}>生成下周计划草稿</Button>}{data.canManage && <Button variant="ghost" onClick={() => setDetail(meeting)}>查看版本历史</Button>}{meeting.plans.filter((plan) => plan.status !== 'discarded').map((plan) => <Button key={plan.id} variant="secondary" onClick={() => navigate(`/collaboration?view=weekly&project=${projectId}&week=${plan.weekStart}`)}>查看 {plan.weekStart} 计划 R{plan.revision}</Button>)}</div>
    </Card>)}
    <Modal open={Boolean(editor)} title={editor?.meeting ? '编辑例会议题与纪要' : '新建周五例会'} width="max-w-3xl" onClose={() => { if (!busy) setEditor(null) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setEditor(null)}>取消</Button><Button loading={busy} onClick={save}>保存例会</Button></>}>
      {editor && <div className="space-y-4">{validation && <p role="alert" className="text-sm text-rose-700">{validation}</p>}<p className="text-xs text-slate-500">默认周五，可按实际日期调整；开始和结束均为上海时间。主持人需同时勾选为参会人。</p><label className="block"><span className="label">例会标题</span><input className="input w-full" maxLength={255} value={editor.title} onChange={(event) => update({ title: event.target.value })} /></label>
        <div className="grid gap-3 sm:grid-cols-2">{(['startsAt', 'endsAt'] as const).map((key) => <label key={key}><span className="label">{key === 'startsAt' ? '开始时间' : '结束时间'}</span><input type="datetime-local" className="input w-full" value={editor[key]} onInput={(event) => update({ [key]: event.currentTarget.value })} onChange={(event) => update({ [key]: event.target.value })} /></label>)}</div>
        <label className="block"><span className="label">主持人</span><select className="input w-full" value={editor.hostUserId} onChange={(event) => update({ hostUserId: event.target.value })}><option value="">请选择实际账号</option>{data?.members.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><fieldset><legend className="label">参会人</legend><div className="flex flex-wrap gap-3">{data?.members.map((person) => <label key={person.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editor.participantIds.includes(person.id)} onChange={(event) => update({ participantIds: event.target.checked ? [...editor.participantIds, person.id] : editor.participantIds.filter((id) => id !== person.id) })} />{person.name}</label>)}</div></fieldset>
        {([['agenda', '会前议题'], ['result', '本周结果'], ['blocked', '阻塞与风险'], ['decision', '会议决定'], ['nextGoal', '下周目标']] as const).map(([key, label]) => <label className="block" key={key}><span className="label">{label}</span><textarea className="textarea w-full" maxLength={4000} value={editor.minutes[key]} onChange={(event) => updateMinutes({ [key]: event.target.value })} /></label>)}
        <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">下方仅拟定下周行动；确认纪要不会创建任务。生成计划后，秘书仍可调整，再提交负责人发布。</div>
        {editor.minutes.nextActions.map((item, index) => <fieldset key={item.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"><legend className="text-sm">下周行动 {index + 1}</legend><label><span className="label">行动名称</span><input className="input w-full" maxLength={255} value={item.title} onChange={(event) => updateAction(index, { title: event.target.value })} /></label><label><span className="label">行动负责人</span><select className="input w-full" value={item.ownerUserId} onChange={(event) => updateAction(index, { ownerUserId: event.target.value })}><option value="">请选择</option>{data?.members.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label><span className="label">截止日期</span><input type="date" className="input w-full" value={item.dueDate} onInput={(event) => updateAction(index, { dueDate: event.currentTarget.value })} onChange={(event) => updateAction(index, { dueDate: event.target.value })} /></label><label><span className="label">优先级</span><select className="input w-full" value={item.priority} onChange={(event) => updateAction(index, { priority: event.target.value as '高' | '中' | '低' })}><option>高</option><option>中</option><option>低</option></select></label><label className="sm:col-span-2"><span className="label">交付物</span><textarea className="textarea w-full" maxLength={2000} value={item.deliverable} onChange={(event) => updateAction(index, { deliverable: event.target.value })} /></label><Button variant="secondary" onClick={() => updateMinutes({ nextActions: editor.minutes.nextActions.filter((_, i) => i !== index) })}><Trash2 className="h-4 w-4" />移除拟定行动</Button></fieldset>)}
        <Button variant="secondary" disabled={editor.minutes.nextActions.length >= 100} onClick={() => updateMinutes({ nextActions: [...editor.minutes.nextActions, { key: crypto.randomUUID(), title: '', ownerUserId: '', dueDate: /^\d{4}-\d{2}-\d{2}T/.test(editor.startsAt) ? nextMeetingWeek(editor.startsAt) : '', deliverable: '', priority: '中' }] })}>新增下周行动</Button>
        {editor.meeting && <label className="block"><span className="label">修改说明（至少五字）</span><textarea className="textarea w-full" maxLength={2000} value={editor.reason} onChange={(event) => update({ reason: event.target.value })} /></label>}
      </div>}
    </Modal>
    <Modal open={Boolean(decision)} title={decision ? actions[decision.action] : ''} onClose={() => { if (!busy) setDecision(null) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setDecision(null)}>返回</Button><Button loading={busy} disabled={decision?.action === 'cancel' && decision.reason.trim().length < 5} onClick={() => { if (decision) void run(() => apiPost(`${endpoint}/${decision.meeting.id}/actions`, { clientRequestId: decision.requestId, expectedVersion: decision.meeting.version, action: decision.action, reason: decision.reason }), `${actions[decision.action]}已保存`) }}>确认操作</Button></>}>
      {decision && <div className="space-y-4">{validation && <p role="alert" className="text-sm text-rose-700">{validation}</p>}<p className="text-sm text-slate-600">{decision.action === 'confirm' ? '请核对真实会议结果。确认后纪要固定为正式版本，不能覆盖；不会完成原任务或批准新计划。' : decision.action === 'derive' ? `将为 ${decision.meeting.nextWeek} 开始的一周生成草稿；已有下周草稿不会被覆盖，发布仍须项目负责人确认。` : decision.action === 'cancel' ? '取消后保留历史，已发送的站内排期通知将关闭。不会删除任务或项目。' : '确认排期后参会人可收到站内通知；这不是领导时间批准，也不代表外部消息已送达。'}</p>{decision.action === 'cancel' && <label className="block"><span className="label">取消原因</span><textarea className="textarea w-full" value={decision.reason} onChange={(event) => setDecision({ ...decision, reason: event.target.value, requestId: crypto.randomUUID() })} /></label>}</div>}
    </Modal>
    <Modal open={Boolean(detail)} title="例会处理历史" width="max-w-3xl" onClose={() => setDetail(null)}>{detail?.events.map((event) => <details key={event.id} className="border-b py-3 text-sm"><summary className="cursor-pointer">版本 {event.version} · {actions[event.action] ?? event.action} · {showTime(event.createdAt)} {event.reason}</summary><pre className="mt-3 whitespace-pre-wrap break-words text-xs text-slate-600">{JSON.stringify(event.snapshot.meeting.weeklyReview, null, 2)}</pre></details>)}</Modal>
  </div>
}
