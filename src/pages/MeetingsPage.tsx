import { CalendarDays, CheckCircle2, ChevronRight, Clock3, ListTodo, Plus, Sparkles, UsersRound } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, Modal, PageHeader, SearchInput, StatusBadge } from '../components/ui'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import type { Meeting } from '../types'
import { addShanghaiDaysDateKey, shanghaiDateTimeInputValue } from '../lib/dateTime'

type MeetingTodoSuggestion = {
  title: string
  owner?: string | null
  dueDate?: string | null
  priority?: '高' | '中' | '低' | null
}

function normalizeExplicitDate(value: string | null | undefined) {
  if (!value) return ''
  const match = value.match(/(\d{4})(?:-|年)(\d{1,2})(?:-|月)(\d{1,2})(?:日)?/)
  if (!match) return ''
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return ''
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function inferTodoOwner(title: string) {
  return title.match(/^(?:由|请)?([\u3400-\u9fffA-Za-z·]{2,24})(?:在|于)\d{4}(?:-|年)/)?.[1]?.trim() ?? ''
}

export function MeetingsPage() {
  const [searchParams] = useSearchParams()
  const projects = useAppStore((state) => state.projects)
  const meetings = useAppStore((state) => state.meetings)
  const addMeeting = useAppStore((state) => state.addMeeting)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const { showToast } = useToast()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [selectedId, setSelectedId] = useState(searchParams.get('meeting') ?? meetings[0]?.id)
  const [showNew, setShowNew] = useState(!!searchParams.get('project'))
  const [generating, setGenerating] = useState(false)
  const [taskReview, setTaskReview] = useState<{ meeting: Parameters<typeof addMeeting>[0]; todos: NonNullable<Parameters<typeof addMeeting>[1]>; members: Array<{ id: string; name: string }> } | null>(null)
  const localNow = shanghaiDateTimeInputValue()
  const [form, setForm] = useState({
    title: '',
    projectId: searchParams.get('project') ?? projects[0]?.id ?? '',
    meetingTime: localNow,
    participants: currentUser.name,
    type: '项目沟通会',
    rawText: '',
  })
  const filtered = useMemo(() => meetings.filter((meeting) => (!query || `${meeting.title}${meeting.projectName}`.includes(query)) && (!status || meeting.status === status)), [meetings, query, status])
  const selected = meetings.find((meeting) => meeting.id === selectedId) ?? filtered[0]

  const generate = async () => {
    if (!form.title.trim()) return showToast('请填写会议主题', 'error')
    if (!form.rawText.trim()) return showToast('请填写真实会议文本', 'error')
    const project = projects.find((item) => item.id === form.projectId) ?? projects[0]
    if (!project) return showToast('请先创建或选择项目', 'error')
    setGenerating(true)

    // 调统一主服务的 AI 网关生成结构化纪要（Web/API :4100 → LLM）
    let summaryText = ''
    let conclusions: string[] = []
    let todoSuggestions: MeetingTodoSuggestion[] = []
    try {
      const resp = await apiPost<{ summary: string; conclusions?: string[]; todos?: Array<string | MeetingTodoSuggestion>; confidence?: number }>(
        '/ai/meeting-summary',
        { transcript: form.rawText },
      )
      summaryText = resp.summary || ''
      conclusions = Array.isArray(resp.conclusions) ? resp.conclusions : []
      todoSuggestions = Array.isArray(resp.todos) ? resp.todos.map((item) => typeof item === 'string' ? { title: item } : item) : []
    } catch (err) {
      showToast(`AI 纪要生成失败：${(err as Error).message}。未保存会议或待办，请重试。`, 'error')
      setGenerating(false)
      return
    }

    const dueDate = (days: number) => addShanghaiDaysDateKey(days)
    const todoObjs = todoSuggestions.filter((item) => item.title?.trim()).map((item, i) => ({
      title: item.title.trim(),
      projectId: project.id,
      projectName: project.name,
      // 结构化字段优先；旧模型的字符串结果仍从明确的“某人在/于某日”中确定性回收。
      owner: item.owner?.trim() || inferTodoOwner(item.title) || currentUser.name,
      dueDate: normalizeExplicitDate(item.dueDate) || normalizeExplicitDate(item.title) || dueDate(2 + i * 2),
      priority: item.priority || (i === 0 ? '高' : '中') as '高' | '中' | '低',
      status: '未开始' as const,
      type: '会议' as const,
    }))

    const meetingInput = {
        projectId: project.id,
        projectName: project.name,
        title: form.title,
        meetingTime: form.meetingTime,
        participants: form.participants.split(/[、,，]/).filter(Boolean),
        type: form.type,
        status: '成功' as const,
        rawText: form.rawText,
        summary: summaryText,
        conclusions,
        todoCount: todoObjs.length,
      }
    try {
      if (project.workflowModel === 'fde-v1' && todoObjs.length) {
        const roster = await apiGet<{ members: Array<{ id: string; name: string }>; canAssign: boolean }>(`/projects/${project.id}/fde-tasks`)
        setTaskReview({ meeting: meetingInput, todos: todoObjs.map((todo) => ({ ...todo, ownerUserId: '' })), members: roster.members.filter((member) => roster.canAssign || member.id === currentUser.id) })
        setShowNew(false)
        return
      }
      const meeting = await addMeeting(meetingInput, todoObjs)
      setSelectedId(meeting.id)
      setShowNew(false)
      setForm((value) => ({ ...value, title: '', rawText: '' }))
      showToast(`会议纪要与 ${todoObjs.length} 项待办已生成，并同步到项目和工作台`)
    } catch (error) {
      showToast(`保存失败：${(error as Error).message}`, 'error')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div>
      <PageHeader title="会议纪要" description="粘贴真实会议文本，由 AI 提取摘要、结论和责任到人的待办。录音转写在建立正式文件处理契约前不开放。" actions={<Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4" />新建会议</Button>} />
      <div className="grid h-[calc(100vh-170px)] min-h-[650px] grid-cols-[390px_1fr] gap-5">
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-slate-100 p-4"><div className="flex gap-2"><SearchInput className="flex-1" placeholder="搜索会议…" value={query} onChange={(event) => setQuery(event.target.value)} /><select className="input w-28" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option>成功</option><option>生成中</option><option>失败</option></select></div></div>
          <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
            {filtered.map((meeting) => <button key={meeting.id} onClick={() => setSelectedId(meeting.id)} className={`mb-1 w-full rounded-xl p-3.5 text-left transition ${selected?.id === meeting.id ? 'bg-brand-50 ring-1 ring-brand-100' : 'hover:bg-slate-50'}`}><div className="flex items-start justify-between gap-2"><span className="min-w-0"><span className="block truncate text-sm font-semibold text-slate-700">{meeting.title}</span><span className="mt-1 block text-xs text-slate-400">{meeting.projectName}</span></span><StatusBadge status={meeting.status} /></div><div className="mt-3 flex items-center gap-3 text-[11px] text-slate-400"><span className="flex items-center gap-1"><CalendarDays className="h-3 w-3" />{meeting.meetingTime.slice(5, 16)}</span><span className="flex items-center gap-1"><ListTodo className="h-3 w-3" />{meeting.todoCount} 项待办</span></div></button>)}
          </div>
          <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-400">共 {filtered.length} 场会议</div>
        </Card>

        {selected ? (
          <div className="min-h-0 overflow-y-auto pr-1 scrollbar-thin">
            <Card className="mb-4 p-5">
              <div className="flex items-start justify-between">
                <div><div className="flex items-center gap-2"><h2 className="text-lg font-semibold text-slate-800">{selected.title}</h2><Badge tone="blue">{selected.type}</Badge></div><p className="mt-2 text-sm text-slate-500">{selected.projectName}</p></div>
              </div>
              <div className="mt-5 flex gap-6 border-t border-slate-100 pt-4 text-xs text-slate-500"><span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{selected.meetingTime}</span><span className="flex items-center gap-1.5"><UsersRound className="h-3.5 w-3.5" />{selected.participants.join('、')}</span></div>
            </Card>
            <Card className="mb-4 p-5">
              <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-brand-600" /><h3 className="font-semibold text-slate-800">一句话摘要</h3></div>
              <p className="mt-3 rounded-xl bg-brand-50 p-4 text-sm font-medium leading-7 text-brand-900">{selected.summary}</p>
            </Card>
            <div className="mb-4 grid grid-cols-2 gap-4">
              <Card className="p-5"><h3 className="font-semibold text-slate-800">关键结论</h3><div className="mt-4 space-y-3">{selected.conclusions.map((item, index) => <div key={item} className="flex gap-3 text-sm leading-6 text-slate-600"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-50 text-[10px] font-semibold text-emerald-600">{index + 1}</span>{item}</div>)}</div></Card>
              <Card className="p-5"><div className="flex items-center justify-between"><h3 className="font-semibold text-slate-800">会议待办</h3><Badge tone="amber">{selected.todoCount} 项</Badge></div><div className="mt-4 space-y-3">{useAppStore.getState().todos.filter((todo) => todo.meetingId === selected.id).map((todo) => <div key={todo.id} className="rounded-lg border border-slate-200 p-3"><p className="text-sm font-medium text-slate-700">{todo.title}</p><div className="mt-2 flex items-center justify-between text-[11px] text-slate-400"><span>{todo.owner} · {todo.dueDate}</span><Badge tone={todo.priority === '高' ? 'red' : 'amber'}>{todo.priority}</Badge></div></div>)}</div></Card>
            </div>
            <Card className="p-5"><h3 className="font-semibold text-slate-800">会议原文</h3><p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-600">{selected.rawText || '未保存会议原文'}</p></Card>
          </div>
        ) : <Card className="grid place-items-center text-sm text-slate-400">请选择一场会议</Card>}
      </div>

      <Modal open={showNew} onClose={() => !generating && setShowNew(false)} title="新建会议并生成纪要" width="max-w-3xl" footer={<><Button variant="secondary" onClick={() => setShowNew(false)}>取消</Button><Button loading={generating} onClick={generate}><Sparkles className="h-4 w-4" />生成纪要与待办</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          <label className="col-span-2"><span className="label">会议主题 <b className="text-rose-500">*</b></span><input className="input" placeholder="例如：睿影医疗投决沟通会" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label><span className="label">关联项目</span><select className="input" value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label><span className="label">会议类型</span><select className="input" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option>项目沟通会</option><option>立项会</option><option>尽调会</option><option>投委会</option><option>董事会</option><option>专家访谈</option></select></label>
          <label><span className="label">会议时间</span><input className="input" value={form.meetingTime} onChange={(event) => setForm({ ...form, meetingTime: event.target.value })} /></label>
          <label><span className="label">参与人</span><input className="input" value={form.participants} onChange={(event) => setForm({ ...form, participants: event.target.value })} /></label>
        </div>
        <div className="pt-4"><label><span className="label">会议原文</span><textarea className="textarea min-h-40" value={form.rawText} onChange={(event) => setForm({ ...form, rawText: event.target.value })} placeholder="粘贴真实速记、转写原文或会议记录…" /></label></div>
        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">AI 会生成一句话摘要、详细纪要、关键结论、分歧、风险点及待办。待办将自动同步到首页工作台。</p>
      </Modal>
      <Modal open={Boolean(taskReview)} onClose={() => { if (!generating) setTaskReview(null) }} title="确认会议任务负责人" width="max-w-3xl" footer={<><Button variant="secondary" disabled={generating} onClick={() => { setTaskReview(null); setShowNew(true) }}>返回编辑</Button><Button loading={generating} disabled={!taskReview?.todos.every((todo) => Boolean(todo.ownerUserId && todo.dueDate))} onClick={async () => {
        if (!taskReview) return
        setGenerating(true)
        try {
          const meeting = await addMeeting(taskReview.meeting, taskReview.todos)
          setSelectedId(meeting.id); setTaskReview(null); setForm((value) => ({ ...value, title: '', rawText: '' }))
          showToast('会议与已确认负责人的任务已保存，成果仍需异人验收')
        } catch (error) { showToast(`保存失败：${(error as Error).message}`, 'error') }
        finally { setGenerating(false) }
      }}>确认并保存会议</Button></>}>
        <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">AI 提取的姓名仅供参考。请为每项任务选择本项目真实账号，确认后才生成正式任务；不能按同名自动归属。</p>
        <div className="space-y-4">{taskReview?.todos.map((todo, index) => <div key={index} className="rounded-lg border border-slate-200 p-3"><p className="text-sm font-medium">{todo.title}</p><p className="mt-1 text-xs text-slate-500">原文/模型建议负责人：{todo.owner}</p><div className="mt-3 flex gap-3"><label className="flex-1"><span className="label">正式负责人</span><select className="input w-full" value={todo.ownerUserId ?? ''} onChange={(event) => setTaskReview({ ...taskReview, todos: taskReview.todos.map((item, i) => i === index ? { ...item, ownerUserId: event.target.value } : item) })}><option value="">请选择账号</option>{taskReview.members.map((member) => <option value={member.id} key={member.id}>{member.name} · {member.id.slice(0, 8)}</option>)}</select></label><label><span className="label">截止日期</span><input type="date" className="input" value={todo.dueDate} onChange={(event) => setTaskReview({ ...taskReview, todos: taskReview.todos.map((item, i) => i === index ? { ...item, dueDate: event.target.value } : item) })} /></label></div></div>)}</div>
      </Modal>
    </div>
  )
}
