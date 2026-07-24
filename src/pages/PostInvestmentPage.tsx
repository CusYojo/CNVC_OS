import { BarChart3, Building2, CalendarDays, ChevronRight, CircleDollarSign, FileText, Plus, Sparkles, UploadCloud } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, DataTable, FileUpload, Modal, PageHeader, ProgressBar, SearchInput, TableCell } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'

export function PostInvestmentPage() {
  const projects = useAppStore((state) => state.projects)
  const navigate = useNavigate()
  const updates = useAppStore((state) => state.postUpdates)
  const addPostUpdate = useAppStore((state) => state.addPostUpdate)
  const { showToast } = useToast()
  const candidateProjects = projects.filter((project) => project.stage === '投后')
  const [selectedId, setSelectedId] = useState(candidateProjects[0]?.id ?? projects[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [showUpdate, setShowUpdate] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [form, setForm] = useState({ period: '2026 Q3', revenue: '¥0 万', grossMargin: '0%', cashFlow: '¥0 万', milestone: '' })
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0]
  const projectUpdates = useMemo(() => updates.filter((update) => update.projectId === selected.id), [updates, selected.id])

  const submit = () => {
    if (!form.milestone.trim()) return showToast('请填写本期经营里程碑', 'error')
    addPostUpdate({ ...form, projectId: selected.id })
    setShowUpdate(false)
    showToast('经营更新已归档，可在项目详情中同步查看')
  }

  return (
    <div>
      <PageHeader title="投后工具" description="仅接收已完成“投后移交审批”的项目，跟踪经营数据、月报、董事会记录和重大事项。" actions={<><Button variant="secondary" onClick={() => setShowUpload(true)}><UploadCloud className="h-4 w-4" />上传月报</Button><Button onClick={() => setShowUpdate(true)}><Plus className="h-4 w-4" />经营更新</Button></>} />
      <div className="grid grid-cols-[310px_1fr] gap-5">
        <Card className="overflow-hidden">
          <div className="border-b border-slate-100 p-4"><SearchInput placeholder="搜索投后项目…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="p-2">{candidateProjects.filter((project) => !query || project.name.includes(query)).map((project) => <button key={project.id} onClick={() => setSelectedId(project.id)} className={`mb-1 w-full rounded-xl p-3.5 text-left ${selectedId === project.id ? 'bg-brand-50 ring-1 ring-brand-100' : 'hover:bg-slate-50'}`}><div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-xs font-semibold text-brand-700 shadow-sm">{project.name.slice(0, 2)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{project.name}</span><span className="mt-1 block text-xs text-slate-400">{project.industry} · {project.stage}</span></span><ChevronRight className="h-4 w-4 text-slate-300" /></div><div className="mt-3"><ProgressBar value={project.progress} tone="green" /></div></button>)}</div>
          <div className="border-t border-slate-100 px-4 py-3 text-[11px] leading-5 text-slate-400">项目只有在投决通过、交割完成并通过“投后移交审批”后才会出现在这里；基金出资、分配和 LP Portal 暂不在一期范围。</div>
        </Card>
        <div className="space-y-5">
          <Card className="p-5">
            <div className="flex items-start justify-between"><div className="flex items-center gap-3"><span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-50 text-sm font-semibold text-brand-700">{selected.name.slice(0, 2)}</span><div><div className="flex items-center gap-2"><h2 className="text-lg font-semibold text-slate-800">{selected.name}</h2><Badge tone="green">已完成投后移交</Badge></div><p className="mt-1 text-sm text-slate-400">{selected.companyName} · 阶段来源 {selected.stageSource ?? '历史数据'}</p></div></div><Button variant="secondary" size="sm" onClick={() => navigate(`/projects/${selected.id}?tab=post`)}><Building2 className="h-3.5 w-3.5" />项目详情</Button></div>
            <div className="mt-6 grid grid-cols-4 gap-3">{[['最新收入', projectUpdates[0]?.revenue ?? '待更新', CircleDollarSign, 'text-blue-600 bg-blue-50'], ['综合毛利率', projectUpdates[0]?.grossMargin ?? '待更新', BarChart3, 'text-emerald-600 bg-emerald-50'], ['经营现金流', projectUpdates[0]?.cashFlow ?? '待更新', CircleDollarSign, 'text-amber-600 bg-amber-50'], ['最新报告期', projectUpdates[0]?.period ?? '暂无', CalendarDays, 'text-violet-600 bg-violet-50']].map(([label, value, Icon, color]) => { const IconComponent = Icon as typeof CircleDollarSign; return <div key={label as string} className="rounded-xl border border-slate-200 p-4"><span className={`grid h-8 w-8 place-items-center rounded-lg ${color}`}><IconComponent className="h-4 w-4" /></span><p className="mt-3 text-xs text-slate-400">{label as string}</p><p className="mt-1 text-base font-semibold text-slate-800">{value as string}</p></div> })}</div>
          </Card>
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h3 className="font-semibold text-slate-800">经营更新历史</h3><p className="mt-1 text-xs text-slate-400">按报告期查看核心财务指标与经营里程碑</p></div><Button size="sm" onClick={() => setShowUpdate(true)}><Plus className="h-3.5 w-3.5" />新增更新</Button></div>
            <DataTable headers={['报告期', '营业收入', '综合毛利率', '经营现金流', '关键里程碑', '更新时间']}>{projectUpdates.map((update) => <tr key={update.id}><TableCell><Badge tone="blue">{update.period}</Badge></TableCell><TableCell><span className="font-medium text-slate-700">{update.revenue}</span></TableCell><TableCell>{update.grossMargin}</TableCell><TableCell>{update.cashFlow}</TableCell><TableCell><p className="max-w-[360px] line-clamp-2 text-xs leading-5">{update.milestone}</p></TableCell><TableCell>{update.updatedAt}</TableCell></tr>)}</DataTable>{!projectUpdates.length && <div className="p-12 text-center text-sm text-slate-400">暂无经营更新</div>}
          </Card>
          <div className="grid grid-cols-2 gap-5">
            <Card className="p-5"><div className="flex items-center justify-between"><h3 className="font-semibold text-slate-800">董事会记录</h3><Button size="sm" variant="secondary">上传记录</Button></div><div className="mt-4 space-y-3">{['2026 年第二次董事会决议.docx', '2026 Q1 董事会汇报材料.pdf'].map((file) => <div key={file} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3"><FileText className="h-4 w-4 text-brand-500" /><span className="flex-1 truncate text-xs text-slate-600">{file}</span><Badge tone="green">已解析</Badge></div>)}</div></Card>
            <Card className="p-5"><div className="flex items-center justify-between"><h3 className="font-semibold text-slate-800">LP 报告素材</h3><Badge>轻量工具</Badge></div><p className="mt-4 text-sm leading-6 text-slate-500">基于最新月报和董事会资料生成一段可供 LP 季报使用的项目进展初稿。</p><Button variant="secondary" className="mt-4 w-full" onClick={() => showToast('LP 报告段落初稿已生成并保存')}><Sparkles className="h-4 w-4" />生成报告段落</Button></Card>
          </div>
        </div>
      </div>
      <Modal open={showUpdate} title={`新增经营更新 · ${selected.name}`} onClose={() => setShowUpdate(false)} footer={<><Button variant="secondary" onClick={() => setShowUpdate(false)}>取消</Button><Button onClick={submit}>保存更新</Button></>}>
        <div className="grid grid-cols-2 gap-4"><label><span className="label">报告期</span><input className="input" value={form.period} onChange={(event) => setForm({ ...form, period: event.target.value })} /></label><label><span className="label">营业收入</span><input className="input" value={form.revenue} onChange={(event) => setForm({ ...form, revenue: event.target.value })} /></label><label><span className="label">综合毛利率</span><input className="input" value={form.grossMargin} onChange={(event) => setForm({ ...form, grossMargin: event.target.value })} /></label><label><span className="label">经营现金流</span><input className="input" value={form.cashFlow} onChange={(event) => setForm({ ...form, cashFlow: event.target.value })} /></label><label className="col-span-2"><span className="label">关键里程碑</span><textarea className="textarea min-h-24" value={form.milestone} onChange={(event) => setForm({ ...form, milestone: event.target.value })} placeholder="本期产品、客户、团队、融资等重要进展…" /></label></div>
      </Modal>
      <Modal open={showUpload} title={`上传月报 · ${selected.name}`} onClose={() => setShowUpload(false)}><FileUpload onFile={(file) => { setShowUpload(false); showToast(`${file.name} 已上传，AI 月报摘要生成完成`) }} /><p className="mt-4 rounded-lg bg-brand-50 p-3 text-xs leading-5 text-brand-700">月报解析后会自动提取收入、毛利、现金流、客户和团队变化，并归档到项目详情。</p></Modal>
    </div>
  )
}
