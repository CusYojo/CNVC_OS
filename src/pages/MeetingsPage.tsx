import { Ban, CalendarDays, CheckCircle2, ChevronRight, Clock3, FileText, ListTodo, Paperclip, Play, Plus, Square, Trash2, UploadCloud, UsersRound } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, Modal, PageHeader, SearchInput, StatusBadge } from '../components/ui'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import type { Meeting, ProjectFile } from '../types'
import { addShanghaiDaysDateKey, formatShanghaiDateTime, shanghaiDateTimeInputValue } from '../lib/dateTime'

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

type ProjectMember = { id: string; name: string; role: string; status?: string }

function shiftLocalDateTime(value: string, minutes: number) {
  const normalized = value.replace(' ', 'T')
  const date = new Date(`${normalized}:00+08:00`)
  return shanghaiDateTimeInputValue(new Date(date.getTime() + minutes * 60_000)).replace(' ', 'T')
}

function readFileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`))
    reader.readAsDataURL(file)
  })
}

export function MeetingsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const projects = useAppStore((state) => state.projects)
  const meetings = useAppStore((state) => state.meetings)
  const addMeeting = useAppStore((state) => state.addMeeting)
  const deleteMeeting = useAppStore((state) => state.deleteMeeting)
  const hydrateFromServer = useAppStore((state) => state.hydrateFromServer)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const { showToast } = useToast()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [selectedId, setSelectedId] = useState<string | undefined>(searchParams.get('meeting') ?? meetings[0]?.id)
  const [showNew, setShowNew] = useState(!!searchParams.get('project'))
  const [generating, setGenerating] = useState(false)
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [contributionText, setContributionText] = useState('')
  const [contributionFiles, setContributionFiles] = useState<File[]>([])
  const [preMeetingFiles, setPreMeetingFiles] = useState<File[]>([])
  const [contributing, setContributing] = useState(false)
  const [minutesOpen, setMinutesOpen] = useState(false)
  const [minutesSummary, setMinutesSummary] = useState('')
  const [minutesConclusions, setMinutesConclusions] = useState('')
  const [minutesMembers, setMinutesMembers] = useState<ProjectMember[]>([])
  const [minutesTasks, setMinutesTasks] = useState<Array<{ title: string; selected: boolean; ownerUserId: string; dueDate: string }>>([])
  const [finalizing, setFinalizing] = useState(false)
  const [deleting, setDeleting] = useState<{ meeting: Meeting; reason: string; requestId: string } | null>(null)
  const [taskReview, setTaskReview] = useState<{ meeting: Parameters<typeof addMeeting>[0]; todos: NonNullable<Parameters<typeof addMeeting>[1]>; members: Array<{ id: string; name: string }> } | null>(null)
  const localNow = shanghaiDateTimeInputValue().replace(' ', 'T')
  const [form, setForm] = useState({
    clientRequestId: crypto.randomUUID(),
    title: '',
    projectId: searchParams.get('project') ?? projects[0]?.id ?? '',
    meetingTime: localNow,
    meetingEndTime: shiftLocalDateTime(localNow, 60),
    participantUserIds: currentUser.id ? [currentUser.id] : [] as string[],
    type: '项目沟通会',
    purpose: '',
    requirements: '',
    rawText: '',
  })
  const filtered = useMemo(() => meetings.filter((meeting) => (!query || `${meeting.title}${meeting.projectName}`.includes(query)) && (!status || meeting.status === status)), [meetings, query, status])
  const selected = meetings.find((meeting) => meeting.id === selectedId) ?? filtered[0]

  useEffect(() => {
    if (!form.projectId) { setMembers([]); return }
    let cancelled = false
    setMembersLoading(true)
    void apiGet<{ list: Array<{ userId: string; name: string; role: string; status: string }> }>(`/projects/${form.projectId}/members`).then((membership) => {
      if (cancelled) return
      const roster = membership.list.filter((person) => person.status !== '禁用').map((person) => ({ id: person.userId, name: person.name, status: person.status, role: person.role || '项目成员' }))
      setMembers(roster)
      setForm((previous) => {
        const available = new Set(roster.map((person) => person.id))
        const retained = previous.participantUserIds.filter((id) => available.has(id))
        const participantUserIds = currentUser.id && available.has(currentUser.id) ? [...new Set([currentUser.id, ...retained])] : retained
        return { ...previous, participantUserIds }
      })
    }).catch((error) => { if (!cancelled) { setMembers([]); showToast(`项目成员读取失败：${(error as Error).message}`, 'error') } }).finally(() => { if (!cancelled) setMembersLoading(false) })
    return () => { cancelled = true }
  }, [form.projectId, currentUser.id, showToast])

  useEffect(() => {
    if (!selected?.unreadNoticeId) return
    const noticeId = selected.unreadNoticeId
    void apiPost(`/meetings/${selected.id}/notices/${noticeId}/read`, {}).then(() => {
      useAppStore.setState((state) => ({ meetings: state.meetings.map((meeting) => meeting.id === selected.id ? { ...meeting, unreadNoticeId: null } : meeting) }))
    }).catch(() => {})
  }, [selected?.id, selected?.unreadNoticeId])

  const generate = async () => {
    if (!form.title.trim()) return showToast('请填写会议主题', 'error')
    if (!form.purpose.trim()) return showToast('请填写会议目的', 'error')
    if (!form.participantUserIds.length) return showToast('请至少选择一位参会人员', 'error')
    if (form.meetingEndTime <= form.meetingTime) return showToast('会议结束时间必须晚于开始时间', 'error')
    const project = projects.find((item) => item.id === form.projectId) ?? projects[0]
    if (!project) return showToast('请先创建或选择项目', 'error')
    const participants = form.participantUserIds.map((id) => members.find((person) => person.id === id)?.name).filter((name): name is string => Boolean(name))
    if (participants.length !== form.participantUserIds.length) return showToast('参会人员信息已变化，请重新选择', 'error')
    setGenerating(true)

    if (!form.rawText.trim()) {
      try {
        const meeting = await addMeeting({
          projectId: project.id, projectName: project.name, title: form.title, meetingTime: form.meetingTime,
          meetingEndTime: form.meetingEndTime, participants, participantUserIds: form.participantUserIds, type: form.type,
          purpose: form.purpose, requirements: form.requirements,
          status: '待开始', rawText: '', summary: '', conclusions: [], todoCount: 0,
        } as Parameters<typeof addMeeting>[0], [], form.clientRequestId)
        let attachmentWarning = ''
        if (preMeetingFiles.length) {
          try {
            const uploaded: ProjectFile[] = []
            for (const file of preMeetingFiles) {
              if (file.size > 100 * 1024 * 1024) throw new Error(`文件超过 100MB：${file.name}`)
              const response = await apiPost<{ file: ProjectFile }>('/projects/files/upload', { projectId: project.id, name: file.name, type: file.name.split('.').pop()?.toUpperCase() ?? 'FILE', category: '会前资料', uploader: currentUser.name, visibility: '项目成员', dataBase64: await readFileBase64(file), force: true })
              uploaded.push(response.file)
            }
            const updated = await apiPost<Meeting>(`/meetings/${meeting.id}/contributions`, { expectedVersion: meeting.version, content: '会前资料', fileIds: uploaded.map(file => file.id) })
            useAppStore.setState((state) => ({ meetings: state.meetings.map((item) => item.id === updated.id ? updated : item) }))
          } catch (error) {
            attachmentWarning = (error as Error).message
          }
        }
        setSelectedId(meeting.id); setShowNew(false); setPreMeetingFiles([]); setForm(value => ({ ...value, clientRequestId: crypto.randomUUID(), title: '', purpose: '', requirements: '', rawText: '' }))
        showToast(attachmentWarning ? `会议已发起；会前资料未全部上传：${attachmentWarning}` : '项目会议已发起，参会人员已收到提醒并同步到日程', attachmentWarning ? 'info' : 'success')
      } catch (error) { showToast(`发起失败：${(error as Error).message}`, 'error') }
      finally { setGenerating(false) }
      return
    }

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
        meetingEndTime: form.meetingEndTime,
        participants,
        participantUserIds: form.participantUserIds,
        type: form.type,
        purpose: form.purpose,
        requirements: form.requirements,
        status: '待开始' as const,
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
      const meeting = await addMeeting(meetingInput, todoObjs, form.clientRequestId)
      setSelectedId(meeting.id)
      setShowNew(false)
      setForm((value) => ({ ...value, clientRequestId: crypto.randomUUID(), title: '', purpose: '', requirements: '', rawText: '' }))
      showToast(`会议纪要与 ${todoObjs.length} 项待办已生成，并同步到项目和工作台`)
    } catch (error) {
      showToast(`保存失败：${(error as Error).message}`, 'error')
    } finally {
      setGenerating(false)
    }
  }

  const submitContribution = async () => {
    if (!selected || contributing || (!contributionText.trim() && !contributionFiles.length)) return
    if (!selected.projectId) return showToast('该会议未关联项目，无法保存会议文件', 'error')
    setContributing(true)
    try {
      const uploaded: ProjectFile[] = []
      for (const file of contributionFiles) {
        if (file.size > 100 * 1024 * 1024) throw new Error(`文件超过 100MB：${file.name}`)
        const response = await apiPost<{ file: ProjectFile }>('/projects/files/upload', {
          projectId: selected.projectId,
          name: file.name,
          type: file.name.split('.').pop()?.toUpperCase() ?? 'FILE',
          category: '会议资料',
          uploader: currentUser.name,
          visibility: '项目成员',
          dataBase64: await readFileBase64(file),
          force: true,
        })
        uploaded.push(response.file)
      }
      const updated = await apiPost<Meeting>(`/meetings/${selected.id}/contributions`, {
        expectedVersion: selected.version,
        content: contributionText,
        fileIds: uploaded.map((file) => file.id),
      })
      useAppStore.setState((state) => ({ meetings: state.meetings.map((meeting) => meeting.id === updated.id ? updated : meeting) }))
      setContributionText(''); setContributionFiles([])
      await hydrateFromServer().catch(() => {})
      showToast('会议想法和文件已同步给本场参会人员')
    } catch (error) {
      showToast(`提交失败：${(error as Error).message}`, 'error')
      await hydrateFromServer().catch(() => {})
    } finally { setContributing(false) }
  }

  const changeLifecycle = async (action: 'start' | 'end' | 'cancel') => {
    if (!selected || generating) return
    setGenerating(true)
    try {
      const updated = await apiPost<Meeting>(`/meetings/${selected.id}/lifecycle`, { expectedVersion: selected.version, action })
      useAppStore.setState((state) => ({
        meetings: action === 'cancel' ? state.meetings.filter((meeting) => meeting.id !== updated.id) : state.meetings.map((meeting) => meeting.id === updated.id ? updated : meeting),
        todos: action === 'cancel' ? state.todos.map((todo) => todo.meetingId === updated.id && !['已完成', '已关闭', '已取消', '已归档'].includes(todo.status) ? { ...todo, status: '已取消' as const } : todo) : state.todos,
      }))
      if (action === 'cancel') {
        setSelectedId(undefined)
        window.dispatchEvent(new Event('fde-calendar-refresh'))
      }
      showToast(action === 'start' ? '会议已开始' : action === 'end' ? '会议已结束，请确认最终纪要' : '会议已取消')
    } catch (error) { showToast((error as Error).message, 'error'); await hydrateFromServer().catch(() => {}) }
    finally { setGenerating(false) }
  }

  const confirmDelete = async () => {
    if (!deleting || generating) return
    setGenerating(true)
    try {
      await deleteMeeting(deleting.meeting.id, deleting.reason.trim(), deleting.requestId)
      setDeleting(null)
      setSelectedId(undefined)
      window.dispatchEvent(new Event('fde-calendar-refresh'))
      showToast('会议已删除')
    } catch (error) { showToast((error as Error).message, 'error') }
    finally { setGenerating(false) }
  }

  const openMinutes = async () => {
    if (!selected) return
    setMinutesSummary(selected.summary || '')
    setMinutesConclusions(selected.conclusions.join('\n'))
    try {
      const result = await apiGet<{ list: Array<{ userId: string; name: string; role: string; status: string }> }>(`/projects/${selected.projectId}/members`)
      const roster = result.list.filter(person => person.status !== '禁用' && selected.participants.includes(person.name)).map(person => ({ id: person.userId, name: person.name, role: person.role }))
      setMinutesMembers(roster)
      setMinutesTasks(selected.conclusions.map(title => ({ title, selected: false, ownerUserId: roster[0]?.id ?? '', dueDate: addShanghaiDaysDateKey(3) })))
      setMinutesOpen(true)
    } catch (error) { showToast(`参会人员读取失败：${(error as Error).message}`, 'error') }
  }

  const syncMinuteTasks = (value: string) => {
    setMinutesConclusions(value)
    const lines = value.split('\n').map(item => item.trim()).filter(Boolean)
    setMinutesTasks(current => lines.map(title => current.find(item => item.title === title) ?? { title, selected: false, ownerUserId: minutesMembers[0]?.id ?? '', dueDate: addShanghaiDaysDateKey(3) }))
  }

  const finalizeMinutes = async () => {
    if (!selected || !minutesSummary.trim()) return showToast('请填写最终会议纪要', 'error')
    const tasks = minutesTasks.filter(task => task.selected)
    if (tasks.some(task => !task.ownerUserId || !task.dueDate)) return showToast('请完整设置所选任务的负责人和截止日期', 'error')
    setFinalizing(true)
    try {
      const updated = await apiPost<Meeting & { createdTodos: unknown[] }>(`/meetings/${selected.id}/finalize`, { expectedVersion: selected.version, summary: minutesSummary.trim(), conclusions: minutesTasks.map(task => task.title), tasks: tasks.map(({ title, ownerUserId, dueDate }) => ({ title, ownerUserId, dueDate })) })
      useAppStore.setState((state) => ({ meetings: state.meetings.map((meeting) => meeting.id === updated.id ? updated : meeting) }))
      await hydrateFromServer()
      setMinutesOpen(false)
      showToast(`最终纪要已确认${tasks.length ? `，${tasks.length} 项结论已生成任务并写入日历` : ''}`)
    } catch (error) { showToast((error as Error).message, 'error'); await hydrateFromServer().catch(() => {}) }
    finally { setFinalizing(false) }
  }

  return (
    <div>
      <PageHeader title="项目会议" actions={<Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4" />发起项目会议</Button>} />
      <div className="grid h-[calc(100vh-170px)] min-h-[650px] grid-cols-[390px_1fr] gap-5">
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-slate-100 p-4"><div className="flex gap-2"><SearchInput className="flex-1" placeholder="搜索会议…" value={query} onChange={(event) => setQuery(event.target.value)} /><select className="input w-28" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option>待开始</option><option>进行中</option><option>已结束</option></select></div></div>
          <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
            {filtered.map((meeting) => <button key={meeting.id} onClick={() => setSelectedId(meeting.id)} className={`mb-1 w-full rounded-xl p-3.5 text-left transition ${selected?.id === meeting.id ? 'bg-brand-50 ring-1 ring-brand-100' : 'hover:bg-slate-50'}`}><div className="flex items-start justify-between gap-2"><span className="min-w-0"><span className="block truncate text-sm font-semibold text-slate-700">{meeting.title}</span><span className="mt-1 block text-xs text-slate-400">{meeting.projectName}</span></span><StatusBadge status={meeting.status} /></div><div className="mt-3 flex items-center gap-3 text-xs text-slate-400"><span className="flex items-center gap-1"><CalendarDays className="h-3 w-3" />{meeting.meetingTime.slice(5, 16)}</span><span className="flex items-center gap-1"><ListTodo className="h-3 w-3" />{meeting.todoCount} 项待办</span></div></button>)}
          </div>
          <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-400">共 {filtered.length} 场会议</div>
        </Card>

        {selected ? (
          <div className="min-h-0 overflow-y-auto pr-1 scrollbar-thin">
            <Card className="mb-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><div className="flex items-center gap-2"><h2 className="text-lg font-semibold text-slate-800">{selected.title}</h2><StatusBadge status={selected.status} /><Badge tone="blue">{selected.type}</Badge></div><p className="mt-2 text-sm text-slate-500">{selected.projectName}</p></div>
                {selected.canManage && selected.status !== '已取消' && <div className="flex flex-wrap gap-2">{selected.status === '待开始' && <Button variant="secondary" loading={generating} onClick={() => void changeLifecycle('start')}><Play className="h-4 w-4" />开始会议</Button>}{selected.status === '进行中' && <Button variant="secondary" loading={generating} onClick={() => void changeLifecycle('end')}><Square className="h-4 w-4" />结束会议</Button>}{selected.status === '已结束' && !selected.minutesConfirmedAt && <Button onClick={() => void openMinutes()}><CheckCircle2 className="h-4 w-4" />确认最终纪要</Button>}{selected.status === '待开始' && <Button variant="secondary" loading={generating} onClick={() => void changeLifecycle('cancel')}><Ban className="h-4 w-4" />取消</Button>}{selected.canDelete && <Button variant="secondary" disabled={generating} onClick={() => setDeleting({ meeting: selected, reason: '会议未召开', requestId: crypto.randomUUID() })}><Trash2 className="h-4 w-4" />删除</Button>}</div>}
              </div>
              <div className="mt-5 flex flex-wrap gap-6 border-t border-slate-100 pt-4 text-xs text-slate-500"><span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{formatShanghaiDateTime(selected.meetingTime)}{selected.meetingEndTime ? ` — ${formatShanghaiDateTime(selected.meetingEndTime)}` : ''}</span><span className="flex items-center gap-1.5"><UsersRound className="h-3.5 w-3.5" />{selected.participants.join('、')}</span></div>
            </Card>
            {(selected.purpose || selected.requirements) && <Card className="mb-4 overflow-hidden"><div className="grid gap-px bg-slate-100 md:grid-cols-2"><div className="bg-white p-5"><span className="text-xs font-medium text-brand-700">会议目的</span><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{selected.purpose || '未填写'}</p></div><div className="bg-white p-5"><span className="text-xs font-medium text-brand-700">会前要求</span><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{selected.requirements || '无额外要求'}</p></div></div></Card>}
            {selected.summary ? <Card className="mb-4 p-5">
              <h3 className="font-semibold text-slate-800">最终会议纪要</h3>
              <p className="mt-3 rounded-xl bg-brand-50 p-4 text-sm leading-7 text-brand-900">{selected.summary}</p>
            </Card> : null}
            {(selected.conclusions.length > 0 || selected.todoCount > 0) && <div className="mb-4 grid grid-cols-2 gap-4">
              <Card className="p-5"><h3 className="font-semibold text-slate-800">关键结论</h3><div className="mt-4 space-y-3">{selected.conclusions.map((item, index) => <div key={item} className="flex gap-3 text-sm leading-6 text-slate-600"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-600">{index + 1}</span>{item}</div>)}</div></Card>
              <Card className="p-5"><div className="flex items-center justify-between"><h3 className="font-semibold text-slate-800">会议待办</h3><Badge tone="amber">{selected.todoCount} 项</Badge></div><div className="mt-4 space-y-3">{useAppStore.getState().todos.filter((todo) => todo.meetingId === selected.id).map((todo) => <div key={todo.id} className="rounded-lg border border-slate-200 p-3"><p className="text-sm font-medium text-slate-700">{todo.title}</p><div className="mt-2 flex items-center justify-between text-xs text-slate-400"><span>{todo.owner} · {todo.dueDate}</span><Badge tone={todo.priority === '高' ? 'red' : 'amber'}>{todo.priority}</Badge></div></div>)}</div></Card>
            </div>}
            {selected.rawText && <Card className="mb-4 p-5"><h3 className="font-semibold text-slate-800">会议原文</h3><p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-600">{selected.rawText}</p></Card>}
            <Card className="mb-4 overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h3 className="font-semibold text-slate-800">参会交流与会议文件</h3><p className="mt-1 text-xs text-slate-400">{selected.contributions?.length ?? 0} 条内容</p></div><UsersRound className="h-5 w-5 text-brand-500" /></div>
              <div className="divide-y divide-slate-100">{selected.contributions?.map((item) => <article key={item.id} className="p-5"><div className="flex items-center justify-between gap-3"><strong className="text-sm text-slate-700">{item.authorName}</strong><time className="text-xs text-slate-400">{formatShanghaiDateTime(item.createdAt)}</time></div>{item.content && <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-600">{item.content}</p>}{item.files.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{item.files.map((file) => <button key={file.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 hover:border-brand-200 hover:bg-brand-50" onClick={() => navigate(`/projects/${selected.projectId}?tab=files&file=${encodeURIComponent(file.id)}`)}><FileText className="h-3.5 w-3.5 text-brand-600" />{file.name}<span className="text-slate-400">V{file.version}</span></button>)}</div>}</article>)}</div>
              {!selected.contributions?.length && <p className="p-6 text-center text-sm text-slate-400">暂无参会交流或会议文件</p>}
              {selected.canContribute && <div className="border-t border-slate-100 bg-slate-50/60 p-5"><label className="block"><span className="label">我的想法 / 会议纪要</span><textarea className="textarea mt-2 min-h-24 w-full bg-white" maxLength={4000} value={contributionText} onChange={(event) => setContributionText(event.target.value)} placeholder="填写观点、结论、补充说明或会议纪要" /></label><div className="mt-3 flex flex-wrap items-center justify-between gap-3"><label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:border-brand-200"><Paperclip className="h-4 w-4" />选择文件<input className="sr-only" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.txt,.md,.csv" onChange={(event) => setContributionFiles(Array.from(event.target.files ?? []))} /></label><span className="min-w-0 flex-1 truncate text-xs text-slate-400">{contributionFiles.length ? `已选择 ${contributionFiles.length} 个：${contributionFiles.map((file) => file.name).join('、')}` : '支持 PDF、Office、图片及常见文本格式'}</span><Button loading={contributing} disabled={!contributionText.trim() && !contributionFiles.length} onClick={() => { void submitContribution() }}><UploadCloud className="h-4 w-4" />发布给参会人员</Button></div></div>}
            </Card>
          </div>
        ) : <Card className="grid place-items-center text-sm text-slate-400">请选择一场会议</Card>}
      </div>

      <Modal open={showNew} onClose={() => !generating && setShowNew(false)} title="发起项目会议" width="max-w-4xl" footer={<><Button variant="secondary" onClick={() => setShowNew(false)}>取消</Button><Button loading={generating} disabled={membersLoading} onClick={generate}>发起会议并提醒成员</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          <label className="col-span-2"><span className="label">会议主题 <b className="text-rose-500">*</b></span><input className="input" placeholder="例如：睿影医疗投决沟通会" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label><span className="label">关联项目</span><select className="input" value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label><span className="label">会议类型</span><select className="input" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option>项目沟通会</option><option>立项会</option><option>尽调会</option><option>投委会</option><option>董事会</option><option>专家访谈</option></select></label>
          <label><span className="label">开始时间 <b className="text-rose-500">*</b></span><input type="datetime-local" className="input" value={form.meetingTime} onChange={(event) => setForm({ ...form, meetingTime: event.target.value })} /></label>
          <label><span className="label">结束时间 <b className="text-rose-500">*</b></span><input type="datetime-local" className="input" min={form.meetingTime} value={form.meetingEndTime} onChange={(event) => setForm({ ...form, meetingEndTime: event.target.value })} /></label>
          <label className="col-span-2"><span className="label">会议目的 <b className="text-rose-500">*</b></span><textarea className="textarea min-h-24" maxLength={2000} value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} placeholder="说明本次会议需要讨论和达成的目标" /></label>
          <label className="col-span-2"><span className="label">会前要求</span><textarea className="textarea min-h-20" maxLength={2000} value={form.requirements} onChange={(event) => setForm({ ...form, requirements: event.target.value })} placeholder="例如：请参会人员提前阅读材料，并准备各自的判断与问题" /></label>
          <label className="col-span-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 p-4"><span className="flex items-center gap-2 text-sm font-semibold text-slate-700"><Paperclip className="h-4 w-4 text-brand-600" />会前资料</span><span className="mt-1 block text-xs text-slate-500">可批量选择 PDF、Office、图片和常见文本文件</span><input className="mt-3 block w-full text-sm text-slate-600" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.txt,.md,.csv" onChange={(event) => setPreMeetingFiles(Array.from(event.target.files ?? []))} />{preMeetingFiles.length > 0 && <span className="mt-2 block text-xs text-brand-700">已选择 {preMeetingFiles.length} 个文件</span>}</label>
        </div>
        <fieldset className="mt-4 rounded-xl border border-slate-200 p-4"><legend className="px-2 text-sm font-semibold text-slate-700">参会人员 <span className="font-normal text-slate-400">（项目组内选择）</span></legend>{membersLoading ? <p className="py-4 text-sm text-slate-400">正在读取项目成员…</p> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{members.map((person) => { const checked = form.participantUserIds.includes(person.id); const self = person.id === currentUser.id; return <label key={person.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${checked ? 'border-brand-300 bg-brand-50' : 'border-slate-200 hover:border-slate-300'}`}><input type="checkbox" checked={checked} disabled={self} onChange={(event) => setForm({ ...form, participantUserIds: event.target.checked ? [...form.participantUserIds, person.id] : form.participantUserIds.filter((id) => id !== person.id) })} /><span className="min-w-0"><strong className="block truncate text-sm text-slate-700">{person.name}{self ? '（发起人）' : ''}</strong><small className="mt-0.5 block truncate text-xs text-slate-400">{person.role || '项目成员'}</small></span></label> })}</div>}{!membersLoading && !members.length && <p className="py-4 text-sm text-amber-700">当前项目没有可选择的项目组成员，请先完成项目人员配置。</p>}</fieldset>
      </Modal>
      <Modal open={Boolean(deleting)} onClose={() => !generating && setDeleting(null)} title="删除会议" footer={<><Button variant="secondary" disabled={generating} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" loading={generating} disabled={!deleting || deleting.reason.trim().length < 2} onClick={() => void confirmDelete()}>确认删除</Button></>}>
        <div className="space-y-4"><div className="rounded-xl bg-rose-50 p-4"><strong className="text-sm text-rose-900">{deleting?.meeting.title}</strong><p className="mt-1 text-sm leading-6 text-rose-700">删除后将从会议列表和参会人的日历中移除，关联的未完成会议任务会同步取消。</p></div><label className="block"><span className="label">删除原因</span><textarea className="textarea mt-2 w-full" maxLength={500} value={deleting?.reason ?? ''} onChange={(event) => deleting && setDeleting({ ...deleting, reason: event.target.value, requestId: crypto.randomUUID() })} /></label></div>
      </Modal>
      <Modal open={minutesOpen} onClose={() => !finalizing && setMinutesOpen(false)} title="确认最终会议纪要" width="max-w-4xl" footer={<><Button variant="secondary" disabled={finalizing} onClick={() => setMinutesOpen(false)}>取消</Button><Button loading={finalizing} onClick={() => void finalizeMinutes()}>确认纪要并同步任务</Button></>}>
        <div className="space-y-5"><label className="block"><span className="label">最终纪要 <b className="text-rose-500">*</b></span><textarea className="textarea mt-2 min-h-32" value={minutesSummary} onChange={event => setMinutesSummary(event.target.value)} placeholder="由发起人整理本次会议的最终共识、分歧和决策" /></label><label className="block"><span className="label">会议结论</span><textarea className="textarea mt-2 min-h-28" value={minutesConclusions} onChange={event => syncMinuteTasks(event.target.value)} placeholder="每行填写一条结论，可从中选择生成任务" /></label>{minutesTasks.length > 0 && <section><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">选择需要落地的任务</h3><span className="text-xs text-slate-500">将同步到负责人待办与日历</span></div><div className="space-y-2">{minutesTasks.map((task, index) => <div key={`${task.title}-${index}`} className={`grid items-center gap-3 rounded-xl border p-3 sm:grid-cols-[auto_1fr_160px_150px] ${task.selected ? 'border-brand-300 bg-brand-50/40' : 'border-slate-200'}`}><input aria-label={`生成任务 ${task.title}`} type="checkbox" checked={task.selected} onChange={event => setMinutesTasks(items => items.map((item, i) => i === index ? { ...item, selected: event.target.checked } : item))} /><strong className="text-sm text-slate-700">{task.title}</strong><select aria-label="任务负责人" className="input" disabled={!task.selected} value={task.ownerUserId} onChange={event => setMinutesTasks(items => items.map((item, i) => i === index ? { ...item, ownerUserId: event.target.value } : item))}><option value="">选择负责人</option>{minutesMembers.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select><input aria-label="任务截止日期" className="input" type="date" disabled={!task.selected} value={task.dueDate} onChange={event => setMinutesTasks(items => items.map((item, i) => i === index ? { ...item, dueDate: event.target.value } : item))} /></div>)}</div></section>}</div>
      </Modal>
      <Modal open={Boolean(taskReview)} onClose={() => { if (!generating) setTaskReview(null) }} title="确认会议任务负责人" width="max-w-3xl" footer={<><Button variant="secondary" disabled={generating} onClick={() => { setTaskReview(null); setShowNew(true) }}>返回编辑</Button><Button loading={generating} disabled={!taskReview?.todos.every((todo) => Boolean(todo.ownerUserId && todo.dueDate))} onClick={async () => {
        if (!taskReview) return
        setGenerating(true)
        try {
          const meeting = await addMeeting(taskReview.meeting, taskReview.todos, form.clientRequestId)
          setSelectedId(meeting.id); setTaskReview(null); setForm((value) => ({ ...value, clientRequestId: crypto.randomUUID(), title: '', rawText: '' }))
          showToast('会议与已确认负责人的任务已保存，成果仍需异人验收')
        } catch (error) { showToast(`保存失败：${(error as Error).message}`, 'error') }
        finally { setGenerating(false) }
      }}>确认并保存会议</Button></>}>
        <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">请为每项会议任务确认本项目中的实际负责人。</p>
        <div className="space-y-4">{taskReview?.todos.map((todo, index) => <div key={index} className="rounded-lg border border-slate-200 p-3"><p className="text-sm font-medium">{todo.title}</p><p className="mt-1 text-xs text-slate-500">建议负责人：{todo.owner}</p><div className="mt-3 flex gap-3"><label className="flex-1"><span className="label">正式负责人</span><select className="input w-full" value={todo.ownerUserId ?? ''} onChange={(event) => setTaskReview({ ...taskReview, todos: taskReview.todos.map((item, i) => i === index ? { ...item, ownerUserId: event.target.value } : item) })}><option value="">请选择账号</option>{taskReview.members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label><label><span className="label">截止日期</span><input type="date" className="input" value={todo.dueDate} onChange={(event) => setTaskReview({ ...taskReview, todos: taskReview.todos.map((item, i) => i === index ? { ...item, dueDate: event.target.value } : item) })} /></label></div></div>)}</div>
      </Modal>
    </div>
  )
}
