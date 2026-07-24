import { useAuthStore } from '../store/useAuthStore'
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  FileCheck2,
  FileText,
  FolderKanban,
  ListTodo,
  Plus,
  ShieldAlert,
  Sparkles,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ProjectModal } from '../components/ProjectModal'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, ProgressBar, RiskBadge, StageBadge, StatusBadge } from '../components/ui'

const quickActions = [
  { label: '项目获取', desc: '上传 BP 并自动解析', icon: UploadCloud, color: 'text-blue-600 bg-blue-50', to: '/sourcing' },
  { label: 'AI 问答', desc: '检索机构投资知识', icon: Bot, color: 'text-violet-600 bg-violet-50', to: '/ai' },
  { label: '生成材料', desc: '快速准备投委会', icon: FileText, color: 'text-amber-600 bg-amber-50', to: '/materials' },
  { label: '会议纪要', desc: '提取结论与待办', icon: ClipboardCheck, color: 'text-emerald-600 bg-emerald-50', to: '/meetings' },
]

export function DashboardPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [showCreate, setShowCreate] = useState(false)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const projects = useAppStore((state) => state.projects)
  const todos = useAppStore((state) => state.todos)
  const files = useAppStore((state) => state.files)
  const meetings = useAppStore((state) => state.meetings)
  const risks = useAppStore((state) => state.risks)
  const materialJobs = useAppStore((state) => state.materialJobs)
  const approvalRequests = useAppStore((state) => state.approvalRequests)
  const updateTodo = useAppStore((state) => state.updateTodo)
  const addTodo = useAppStore((state) => state.addTodo)
  const deleteTodo = useAppStore((state) => state.deleteTodo)
  const [newTodoTitle, setNewTodoTitle] = useState('')
  const activeTodos = todos.filter((todo) => todo.status !== '已完成').slice(0, 5)

  const handleAddTodo = async () => {
    const title = newTodoTitle.trim()
    if (!title) return
    try {
      await addTodo({
        title,
        owner: currentUser.name,
        priority: '中',
        status: '未开始',
        type: '待办',
      } as never)
      setNewTodoTitle('')
      showToast('待办已添加')
    } catch {
      showToast('待办添加失败')
    }
  }

  const handleDeleteTodo = async (todoId: string) => {
    try {
      await deleteTodo(todoId)
      showToast('待办已删除')
    } catch {
      showToast('待办删除失败')
    }
  }
  const highRisks = risks.filter((risk) => risk.level === '高' && risk.status !== '已关闭')
  const keyProjects = projects.filter((project) => !['放弃', '退出'].includes(project.stage)).sort((a, b) => b.score - a.score).slice(0, 4)
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())

  const stats = [
    { label: '我的项目', value: projects.filter((project) => project.owner === currentUser.name).length, suffix: '个', icon: FolderKanban, color: 'text-blue-600 bg-blue-50', note: '本周新增 2 个', to: '/projects' },
    { label: '待处理流程', value: approvalRequests.filter((item) => item.status === '审批中').length, suffix: '项', icon: CircleDot, color: 'text-violet-600 bg-violet-50', note: '项目阶段由 OA 结果同步', to: '/workflow?view=pending' },
    { label: '待生成材料', value: materialJobs.filter((job) => job.status === '生成中' || job.status === '待处理').length + 2, suffix: '份', icon: FileCheck2, color: 'text-amber-600 bg-amber-50', note: '本周已生成 5 份', to: '/materials' },
    { label: '风险提醒', value: risks.filter((risk) => risk.status !== '已关闭').length, suffix: '条', icon: ShieldAlert, color: 'text-rose-600 bg-rose-50', note: `${highRisks.length} 条高风险`, to: '/risks' },
    { label: '我的待办', value: activeTodos.length, suffix: '项', icon: ListTodo, color: 'text-emerald-600 bg-emerald-50', note: '今日到期 2 项', to: '/workflow' },
  ]

  return (
    <div>
      <div className="mb-5 flex items-end justify-between">
        <div>
          <p className="text-sm text-slate-500">{date}</p>
          <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-ink">早上好，{currentUser.name}</h1>
          <p className="mt-1 text-sm text-slate-500">这里是你今天的投资工作概览，有 <strong className="font-medium text-rose-600">2 项</strong> 任务需要优先处理。</p>
        </div>
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" />创建项目</Button>
      </div>

      <div className="mb-5 grid grid-cols-5 gap-3">
        {stats.map((stat) => (
          <button key={stat.label} type="button" onClick={() => navigate(stat.to)} className="block w-full cursor-pointer rounded-xl border border-slate-200/90 bg-white p-4 text-left shadow-card transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md">
            <div className="flex items-center justify-between"><div className={`grid h-9 w-9 place-items-center rounded-lg ${stat.color}`}><stat.icon className="h-[18px] w-[18px]" /></div><span className="text-[11px] text-slate-400">{stat.note}</span></div>
            <div className="mt-3"><span className="text-[26px] font-semibold tracking-tight text-ink">{stat.value}</span><span className="ml-1 text-xs text-slate-400">{stat.suffix}</span></div>
            <p className="mt-0.5 text-xs font-medium text-slate-500">{stat.label}</p>
          </button>
        ))}
      </div>

      <div className="mb-5 grid grid-cols-[1.02fr_.98fr] gap-5">
        <Card>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="font-semibold text-slate-800">我的待办</h2><p className="mt-0.5 text-xs text-slate-400">按优先级与截止时间排序</p></div><button onClick={() => navigate('/workflow')} className="flex items-center text-xs font-medium text-brand-600">查看全部<ChevronRight className="h-4 w-4" /></button></div>
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
            <input
              value={newTodoTitle}
              onChange={(e) => setNewTodoTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAddTodo() } }}
              placeholder="添加一条待办，回车或点击添加"
              className="h-9 flex-1 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 placeholder:text-slate-300 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
            <Button onClick={() => void handleAddTodo()} disabled={!newTodoTitle.trim()} className="shrink-0"><Plus className="h-4 w-4" />添加</Button>
          </div>
          <div className="divide-y divide-slate-100">
            {activeTodos.length === 0 && (
              <div className="px-5 py-6 text-center text-sm text-slate-400">暂无待办，添加一条试试</div>
            )}
            {activeTodos.map((todo) => (
              <div key={todo.id} className="group flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50/70">
                <button
                  aria-label={todo.type === '流程' ? '进入流程处理' : '完成待办'}
                  onClick={() => todo.type === '流程' ? navigate(`/workflow?project=${todo.projectId}`) : (updateTodo(todo.id, { status: '已完成' }), showToast('待办已完成'))}
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${todo.type === '流程' ? 'border-violet-300 bg-violet-50 text-violet-500' : 'border-slate-300 text-transparent hover:border-emerald-500 hover:bg-emerald-50 hover:text-emerald-500'}`}
                >{todo.type === '流程' ? <CircleDot className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-4 w-4" />}</button>
                <button onClick={() => navigate(todo.type === '流程' ? `/workflow?project=${todo.projectId}` : `/projects/${todo.projectId}`)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-slate-700 group-hover:text-brand-700">{todo.title}</p>
                  <p className="mt-1 text-xs text-slate-400">{todo.projectName} · {todo.owner}</p>
                </button>
                <Badge tone={todo.priority === '高' ? 'red' : todo.priority === '中' ? 'amber' : 'slate'}>{todo.priority}</Badge>
                <span className="flex w-[82px] items-center justify-end gap-1 text-xs text-slate-400"><CalendarDays className="h-3.5 w-3.5" />{todo.dueDate?.slice(5) ?? '—'}</span>
                <button
                  aria-label="删除待办"
                  onClick={() => void handleDeleteTodo(todo.id)}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100"
                ><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="font-semibold text-slate-800">重点项目</h2><p className="mt-0.5 text-xs text-slate-400">按项目评分与近期活跃度推荐</p></div><button onClick={() => navigate('/projects')} className="flex items-center text-xs font-medium text-brand-600">项目台账<ChevronRight className="h-4 w-4" /></button></div>
          <div className="grid grid-cols-2 gap-3 p-4">
            {keyProjects.map((project) => (
              <button key={project.id} onClick={() => navigate(`/projects/${project.id}`)} className="rounded-xl border border-slate-200 p-3.5 text-left transition hover:border-brand-200 hover:bg-brand-50/30 hover:shadow-sm">
                <div className="flex items-start justify-between gap-2"><div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs font-semibold text-slate-600">{(project.name ?? '—').slice(0, 2)}</div><StageBadge stage={project.stage} /></div>
                <h3 className="mt-3 truncate text-sm font-semibold text-slate-800">{project.name}</h3>
                <p className="mt-1 text-xs text-slate-400">{project.industry} · {project.round}</p>
                <div className="mt-3"><div className="mb-1.5 flex justify-between text-[10px] text-slate-400"><span>项目健康度</span><span>{project.progress}%</span></div><ProgressBar value={project.progress} tone={project.riskLevel === '高' ? 'amber' : 'blue'} /></div>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <div className="mb-5 grid grid-cols-[1.15fr_.85fr] gap-5">
        <Card>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><h2 className="font-semibold text-slate-800">最近动态</h2><span className="text-xs text-slate-400">实时同步项目操作</span></div>
          <div className="grid grid-cols-2 divide-x divide-slate-100">
            <div className="p-4">
              <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-500"><FileText className="h-4 w-4 text-blue-500" />最近上传资料</h3>
              <div className="space-y-3">{files.slice(0, 3).map((file) => <button key={file.id} onClick={() => file.projectId && navigate(`/projects/${file.projectId}?tab=files`)} className="flex w-full items-center gap-3 text-left"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-50 text-[9px] font-semibold text-blue-600">{file.type}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-slate-700">{file.name}</span><span className="mt-0.5 block text-[11px] text-slate-400">{file.uploader} · {file.uploadedAt?.slice(5, 16) ?? ''}</span></span><StatusBadge status={file.parseStatus} /></button>)}</div>
            </div>
            <div className="p-4">
              <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-500"><ClipboardCheck className="h-4 w-4 text-emerald-500" />最近会议</h3>
              <div className="space-y-3">{meetings.slice(0, 3).map((meeting) => <button key={meeting.id} onClick={() => navigate('/meetings')} className="flex w-full items-center gap-3 text-left"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-600"><CalendarDays className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-slate-700">{meeting.title}</span><span className="mt-0.5 block text-[11px] text-slate-400">{meeting.meetingTime?.slice(5, 16) ?? ''} · {meeting.todoCount} 项待办</span></span><ChevronRight className="h-4 w-4 text-slate-300" /></button>)}</div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-rose-500" /><h2 className="font-semibold text-slate-800">风险提醒</h2></div><button onClick={() => navigate('/risks')} className="text-xs font-medium text-brand-600">全部风险</button></div>
          <div className="divide-y divide-slate-100">
            {risks.filter((risk) => risk.status !== '已关闭').slice(0, 3).map((risk) => (
              <button key={risk.id} onClick={() => navigate(`/projects/${risk.projectId}?tab=risks`)} className="flex w-full items-start gap-3 px-5 py-3.5 text-left hover:bg-slate-50">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${risk.level === '高' ? 'bg-rose-500' : 'bg-amber-500'}`} />
                <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><strong className="truncate text-sm font-medium text-slate-700">{risk.projectName}</strong><RiskBadge level={risk.level} /></span><span className="mt-1.5 block line-clamp-1 text-xs text-slate-500">{risk.description}</span></span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-[180px_repeat(4,1fr)] items-center gap-3">
          <div><p className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Sparkles className="h-4 w-4 text-brand-600" />快捷开始</p><p className="mt-1 text-xs text-slate-400">常用投资工作入口</p></div>
          {quickActions.map((action) => <button key={action.label} onClick={() => navigate(action.to)} className="group flex items-center gap-3 rounded-xl border border-slate-200 px-3.5 py-3 text-left hover:border-brand-200 hover:bg-brand-50/30"><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${action.color}`}><action.icon className="h-[18px] w-[18px]" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-700">{action.label}</span><span className="mt-0.5 block text-[11px] text-slate-400">{action.desc}</span></span><ArrowRight className="h-4 w-4 text-slate-300 group-hover:translate-x-0.5 group-hover:text-brand-500" /></button>)}
        </div>
      </Card>
      <ProjectModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  )
}
