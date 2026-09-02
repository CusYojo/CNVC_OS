import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, FileText, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore } from '../store/useAuthStore'
import { Badge, Button, Card, Modal } from './ui'
import { useToast } from './Toast'
import { shanghaiToday, shiftDate, weekStartFor } from '../../server/src/contracts/fdeWeeklyPlanContract'
import type { WeeklyReportFacts, WeeklyReportSourceOptions } from '../../server/src/contracts/fdeWeeklyReportContract'
import './fde-workspace.css'
import { milestoneSourceTarget } from '../../server/src/contracts/fdeMilestoneSourcesContract'

type Report = { id: string; weekStart: string; revision: number; version: number; status: string; own: boolean; restricted: boolean; body: string; facts: WeeklyReportFacts | null; sourceChanged: boolean; events: Array<{ action: string; version: number; reason: string; createdAt: string }>; recipients: Array<{ userId: string; name: string; readAt: string | null; closedAt: string | null }> }
type Action = 'regenerate' | 'publish' | 'withdraw' | 'discard'
const labels: Record<string, string> = { draft: '草稿', published: '已发布', withdrawn: '已撤回', discarded: '已丢弃', create: '生成草稿', save: '人工编辑', regenerate: '重新生成', publish: '确认发布', withdraw: '撤回发布', discard: '丢弃草稿' }

export function FdeWeeklyReportPanel({ initialWeek }: { initialWeek?: string } = {}) {
  const userId = useAuthStore(state => state.user?.id ?? '')
  return <WeeklyReportForAccount key={`${userId}:${initialWeek ?? ''}`} initialWeek={initialWeek} />
}

function WeeklyReportForAccount({ initialWeek }: { initialWeek?: string }) {
  const { showToast } = useToast()
  const projects = useAppStore((state) => state.projects).filter((item) => item.workflowModel === 'fde-v1' && item.lifecycle !== 'deleted')
  const [week, setWeek] = useState(() => initialWeek ?? weekStartFor(shanghaiToday()))
  const [reports, setReports] = useState<Report[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [create, setCreate] = useState<{ projectIds: string[]; sourceOptions: WeeklyReportSourceOptions; requestId: string } | null>(null)
  const [editor, setEditor] = useState<{ report: Report; body: string; requestId: string } | null>(null)
  const [decision, setDecision] = useState<{ report: Report; action: Action; reason: string; recipientIds: string[]; candidates: Array<{ id: string; name: string }>; requestId: string } | null>(null)
  async function reload() {
    const data = await apiGet<{ reports: Report[] }>(`/weekly-reports?weekStart=${week}`)
    setReports(data.reports); setError('')
  }
  useEffect(() => {
    let current = true
    setLoading(true); setError(''); setReports([]); setCreate(null); setEditor(null); setDecision(null)
    apiGet<{ reports: Report[] }>(`/weekly-reports?weekStart=${week}`).then((data) => { if (current) setReports(data.reports) }).catch((cause) => { if (current) setError((cause as Error).message) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [week])
  async function run(operation: () => Promise<unknown>, message: string) {
    if (busy) return
    setBusy(true)
    try {
      await operation(); setCreate(null); setEditor(null); setDecision(null); showToast(message)
      try { await reload() } catch (cause) { showToast(`已保存，刷新失败：${(cause as Error).message}，请刷新核对。`, 'error') }
    } catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }
  async function ask(report: Report, action: Action) {
    setBusy(true)
    try {
      const candidates = action === 'publish' ? (await apiGet<{ recipients: Array<{ id: string; name: string }> }>(`/weekly-reports/${report.id}/recipients`)).recipients : []
      setDecision({ report, action, reason: '', recipientIds: [], candidates, requestId: crypto.randomUUID() })
    } catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }
  return <div className="fde-workspace space-y-4">
    <Card className="fde-panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-semibold"><FileText className="h-4 w-4" />个人周报</h2><div className="flex gap-2"><Button variant="secondary" disabled={busy || loading} onClick={() => { void reload().catch((cause) => setError((cause as Error).message)) }}><RefreshCw className="h-4 w-4" />刷新周报</Button><Button disabled={busy || loading || reports.some((report) => report.own && report.status === 'draft')} onClick={() => setCreate({ projectIds: [], sourceOptions: { calendar: true, privateCalendar: false, independentWork: false, office: false, projectTimeline: false }, requestId: crypto.randomUUID() })}>生成周报草稿</Button></div></div>
      <div className="mt-4 flex flex-wrap items-center gap-3"><Button variant="secondary" disabled={busy} onClick={() => setWeek(shiftDate(week, -7))}><ArrowLeft className="h-4 w-4" />上周</Button><span className="text-sm">{week} 至 {shiftDate(week, 6)} · 上海时区</span><Button variant="secondary" disabled={busy} onClick={() => setWeek(shiftDate(week, 7))}>下周<ArrowRight className="h-4 w-4" /></Button></div>
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}{loading && <p className="mt-4 text-sm text-slate-500">正在读取周报…</p>}{!loading && !error && !reports.length && <p className="mt-4 text-sm text-slate-500">本周暂无个人草稿或发给你的已发布周报。</p>}
    </Card>
    {reports.map((report) => <Card key={report.id} className="fde-panel p-5"><div className="flex items-start justify-between gap-3"><h3 className="font-semibold">{report.own ? '我的周报' : '收到的周报'}</h3><Badge tone={report.status === 'published' ? 'green' : 'slate'}>{labels[report.status]}</Badge></div>
      {report.restricted ? <p className="mt-4 text-sm text-amber-800">来源项目、日历、办公或独立工作权限已变化，正文与来源已隐藏。仍可撤回已发布内容或丢弃草稿。</p> : <>
        {report.sourceChanged && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">来源记录已变化，请重新生成并人工核对后再发布。</p>}
        <p className="mt-3 text-xs text-slate-500">{report.facts?.projects.map((item) => item.name).join('、') || '个人工作'} · {report.facts && new Date(report.facts.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
        <div className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm leading-7 text-slate-700">{report.body}</div>
        <details className="mt-4"><summary className="cursor-pointer text-xs text-slate-500">生成依据</summary><div className="mt-3 space-y-2 text-xs text-slate-600">{report.facts?.unavailable.map((item) => <p key={item} className="text-amber-700">{item}</p>)}<p>任务 {report.facts?.tasks.length ?? 0} 项 · 审批 {report.facts?.approvals.length ?? 0} 项 · 会议 {report.facts?.meetings.length ?? 0} 场 · 日历 {report.facts?.calendar?.length ?? 0} 项</p>{report.facts?.office?.map(item => <p key={item.id}>{item.kind} · {item.title} · {item.status}<Link className="ml-3 text-[#315f68] underline" to={`/workflow?office=${item.id}`}>查看申请</Link></p>)}{report.facts?.milestones?.map(item => <p key={item.id}>{item.projectName} · {item.stage} · {item.date}<Link className="ml-3 text-[#315f68] underline" to={milestoneSourceTarget(item)}>查看节点</Link></p>)}</div></details>
        {report.recipients.length > 0 && <p className="mt-3 text-xs text-slate-500">站内接收：{report.recipients.map((person) => `${person.name}（${person.closedAt ? '已关闭' : person.readAt ? '已读' : '未读'}）`).join('、')}</p>}
      </>}
      <div className="mt-4 flex flex-wrap gap-2">{report.own && report.status === 'draft' && <>{!report.restricted && <><Button variant="secondary" disabled={busy} onClick={() => setEditor({ report, body: report.body, requestId: crypto.randomUUID() })}>编辑周报</Button><Button variant="secondary" disabled={busy} onClick={() => { void ask(report, 'regenerate') }}>重新生成草稿</Button><Button disabled={busy || report.sourceChanged} onClick={() => { void ask(report, 'publish') }}>确认发布周报</Button></>}<Button variant="secondary" disabled={busy} onClick={() => { void ask(report, 'discard') }}>丢弃周报草稿</Button></>}{report.own && report.status === 'published' && <Button variant="secondary" disabled={busy} onClick={() => { void ask(report, 'withdraw') }}>撤回周报</Button>}{!report.own && report.recipients.some((person) => !person.readAt) && <Button variant="secondary" disabled={busy} onClick={() => { void run(() => apiPost(`/weekly-reports/${report.id}/read`, {}), '周报已标记阅读') }}>标记周报已读</Button>}</div>
      {report.events.length > 0 && <details className="mt-4"><summary className="cursor-pointer text-xs text-slate-500">操作记录</summary>{report.events.map((event) => <p key={event.version} className="mt-2 text-xs text-slate-600">{labels[event.action] ?? event.action} · {new Date(event.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} {event.reason}</p>)}</details>}
    </Card>)}
    <Modal open={Boolean(create)} title="生成个人周报草稿" onClose={() => { if (!busy) setCreate(null) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setCreate(null)}>取消</Button><Button loading={busy} disabled={!create || !(create.projectIds.length || create.sourceOptions.calendar || create.sourceOptions.independentWork || create.sourceOptions.office) || Boolean(create.sourceOptions.projectTimeline && !create.projectIds.length)} onClick={() => { if (create) void run(() => apiPost('/weekly-reports', { clientRequestId: create.requestId, projectIds: create.projectIds, sourceOptions: create.sourceOptions, weekStart: week }), '已生成事实草稿，尚未发布') }}>生成草稿</Button></>}>
      <p className="mb-4 text-sm text-slate-600">选择纳入本周报的项目和内容范围。</p><div className="space-y-3">{projects.map((project) => <label key={project.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(create?.projectIds.includes(project.id))} onChange={(event) => { if (create) setCreate({ ...create, requestId: crypto.randomUUID(), projectIds: event.target.checked ? [...create.projectIds, project.id] : create.projectIds.filter((id) => id !== project.id) }) }} />{project.name}</label>)}</div>
      <fieldset className="mt-5 space-y-3 rounded-lg bg-slate-50 p-4"><legend className="text-sm font-medium">来源范围</legend>{([['calendar','纳入本人日历与所选项目日程'],['privateCalendar','包含本人私人日历（无权人员不可接收）'],['independentWork','包含本人独立待办与非项目会议'],['office','包含本人办公申请/处理；选中日历时纳入获批出差/请假'],['projectTimeline','包含所选项目已批准节点日期（不计完成）']] as const).map(([key,label]) => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(create?.sourceOptions[key])} disabled={key === 'privateCalendar' && !create?.sourceOptions.calendar} onChange={event => { if(create) setCreate({ ...create, requestId:crypto.randomUUID(), sourceOptions:{...create.sourceOptions,[key]:event.target.checked,...(key==='calendar'&&!event.target.checked?{privateCalendar:false}:{})} }) }} />{label}</label>)}</fieldset>
    </Modal>
    <Modal open={Boolean(editor)} title="编辑周报" width="max-w-3xl" onClose={() => { if (!busy) setEditor(null) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setEditor(null)}>取消</Button><Button loading={busy} disabled={!editor?.body.trim()} onClick={() => { if (editor) void run(() => apiPost(`/weekly-reports/${editor.report.id}/save`, { clientRequestId: editor.requestId, expectedVersion: editor.report.version, body: editor.body }), '周报草稿已保存') }}>保存周报草稿</Button></>}><label className="block"><span className="label">周报正文</span><textarea className="textarea min-h-96 w-full" maxLength={20000} value={editor?.body ?? ''} onChange={(event) => { if (editor) setEditor({ ...editor, body: event.target.value, requestId: crypto.randomUUID() }) }} /></label></Modal>
    <Modal open={Boolean(decision)} title={decision ? labels[decision.action] : ''} onClose={() => { if (!busy) setDecision(null) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setDecision(null)}>取消</Button><Button loading={busy} disabled={Boolean(decision && ['withdraw', 'discard'].includes(decision.action) && decision.reason.trim().length < 5)} onClick={() => { if (decision) void run(() => apiPost(`/weekly-reports/${decision.report.id}/actions`, { clientRequestId: decision.requestId, expectedVersion: decision.report.version, action: decision.action, recipientIds: decision.recipientIds, reason: decision.reason }), `${labels[decision.action]}已保存`) }}>确认操作</Button></>}>
      {decision && <div className="space-y-4"><p className="text-sm text-slate-600">{decision.action === 'regenerate' ? '重新读取真实来源并重写当前草稿正文。已有人工补充保留在操作快照中，但需重新编辑；不会改写已发布的其他修订。' : decision.action === 'publish' ? '确认正文及接收范围后发布固定版本。仅选中人员收到站内通知；不勾选则仅本人留档。接收人必须持续有权访问全部来源项目、日历、办公申请及独立工作。办公快照只允许生成时与当前均有权的人员接收。私人快照不因原安排后来公开而获得分享权；附件权限不会扩大。' : '操作保留版本与审计，不删除原任务、审批或会议记录。撤回后接收人不能继续通过系统读取正文。'}</p>{decision.action === 'publish' && <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">站内接收人（可不选）</legend>{!decision.candidates.length && <p className="text-xs text-amber-800">暂无同时具有全部来源权限的接收人，可仅本人留档。</p>}{decision.candidates.map((person) => <label key={person.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={decision.recipientIds.includes(person.id)} onChange={(event) => setDecision({ ...decision, requestId: crypto.randomUUID(), recipientIds: event.target.checked ? [...decision.recipientIds, person.id] : decision.recipientIds.filter((id) => id !== person.id) })} />{person.name}</label>)}</fieldset>}{['withdraw', 'discard'].includes(decision.action) && <label className="block"><span className="label">操作原因（至少五字）</span><textarea className="textarea w-full" value={decision.reason} onChange={(event) => setDecision({ ...decision, reason: event.target.value, requestId: crypto.randomUUID() })} /></label>}</div>}
    </Modal>
  </div>
}
