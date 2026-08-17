import { ChevronRight, Plus, ShieldAlert } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, DataTable, Drawer, Modal, PageHeader, RiskBadge, SearchInput, StatusBadge, TableCell } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'
import type { RiskAlert, RiskLevel } from '../types'
import { shanghaiDateKey } from '../lib/dateTime'

export function RisksPage() {
  const [searchParams] = useSearchParams()
  const risks = useAppStore((state) => state.risks)
  const projects = useAppStore((state) => state.projects)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const addRisk = useAppStore((state) => state.addRisk)
  const updateRisk = useAppStore((state) => state.updateRisk)
  const { showToast } = useToast()
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('')
  const [status, setStatus] = useState('')
  const [selected, setSelected] = useState<RiskAlert | null>(null)
  const [showNew, setShowNew] = useState(!!searchParams.get('project'))
  const [form, setForm] = useState({
    projectId: searchParams.get('project') ?? projects[0]?.id ?? '',
    type: '财务异常',
    level: '中' as RiskLevel,
    description: '',
    owner: currentUser.name,
    occurredAt: shanghaiDateKey(),
  })
  const filtered = useMemo(() => risks.filter((risk) => (!query || `${risk.projectName}${risk.description}${risk.type}`.includes(query)) && (!level || risk.level === level) && (!status || risk.status === status)), [risks, query, level, status])

  const create = async () => {
    if (!form.description.trim()) return showToast('请填写风险描述', 'error')
    const project = projects.find((item) => item.id === form.projectId) ?? projects[0]
    if (!project) return showToast('请先创建或选择项目', 'error')
    // The project list hydrates asynchronously from MySQL. The browser may render
    // the first option while the form still contains its initial empty ID, so the
    // authoritative project UUID must come from the resolved project object.
    const risk = await addRisk({ ...form, projectId: project.id, projectName: project.name, status: '待确认' })
    setShowNew(false)
    setSelected(risk)
    setForm((value) => ({ ...value, description: '' }))
    showToast('风险事件已创建，并同步到工作台和项目详情')
  }

  const changeStatus = async (next: RiskAlert['status']) => {
    if (!selected) return
    try {
      const updated = await updateRisk(selected.id, { status: next })
      setSelected(updated)
      showToast(next === '处理中' ? '已开始处置' : next === '误报' ? '已标记为误报' : '风险已关闭')
    } catch (error) {
      showToast(`更新风险失败：${(error as Error).message}`, 'error')
    }
  }

  const stats = [
    ['待处置风险', risks.filter((risk) => !['已关闭', '误报'].includes(risk.status)).length, 'text-amber-600 bg-amber-50'],
    ['高风险事件', risks.filter((risk) => risk.level === '高' && risk.status !== '已关闭').length, 'text-rose-600 bg-rose-50'],
    ['处理中', risks.filter((risk) => risk.status === '处理中').length, 'text-blue-600 bg-blue-50'],
    ['已关闭', risks.filter((risk) => risk.status === '已关闭').length, 'text-emerald-600 bg-emerald-50'],
  ]

  return (
    <div>
      <PageHeader title="风险预警" description="统一记录工商、舆情、法律、财务、合规与协议到期风险，形成处置闭环。" actions={<Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4" />新增风险</Button>} />
      <div className="mb-5 grid grid-cols-4 gap-4">{stats.map(([label, value, color]) => <Card key={label as string} className="p-4"><div className="flex items-center justify-between"><p className="text-sm text-slate-500">{label}</p><span className={`grid h-8 w-8 place-items-center rounded-lg ${color}`}><ShieldAlert className="h-4 w-4" /></span></div><p className="mt-3 text-2xl font-semibold text-ink">{value}</p></Card>)}</div>
      <Card className="mb-4 p-4"><div className="flex gap-3"><SearchInput className="w-[320px]" placeholder="搜索项目、风险类型或描述…" value={query} onChange={(event) => setQuery(event.target.value)} /><select className="input w-32" value={level} onChange={(event) => setLevel(event.target.value)}><option value="">全部等级</option><option>高</option><option>中</option><option>低</option></select><select className="input w-36" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option>待确认</option><option>处理中</option><option>已关闭</option><option>误报</option></select></div></Card>
      <Card className="overflow-hidden">
        <DataTable headers={['关联项目', '风险类型', '风险等级', '风险描述', '处置状态', '负责人', '发生时间', '']}>{filtered.map((risk) => <tr key={risk.id} className="hover:bg-slate-50"><TableCell><button onClick={() => setSelected(risk)} className="font-medium text-slate-700 hover:text-brand-700">{risk.projectName}</button></TableCell><TableCell><Badge>{risk.type}</Badge></TableCell><TableCell><RiskBadge level={risk.level} /></TableCell><TableCell><p className="max-w-[340px] line-clamp-2 text-xs leading-5">{risk.description}</p></TableCell><TableCell><StatusBadge status={risk.status} /></TableCell><TableCell>{risk.owner}</TableCell><TableCell>{risk.occurredAt}</TableCell><TableCell><button onClick={() => setSelected(risk)} className="flex items-center text-xs text-brand-600">处置<ChevronRight className="h-3.5 w-3.5" /></button></TableCell></tr>)}</DataTable>
        <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-400">共 {filtered.length} 条风险记录</div>
      </Card>
      <Modal open={showNew} title="新增风险事件" onClose={() => setShowNew(false)} width="max-w-2xl" footer={<><Button variant="secondary" onClick={() => setShowNew(false)}>取消</Button><Button onClick={() => { void create() }}>创建风险</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          <label><span className="label">关联项目</span><select className="input" value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label><span className="label">风险类型</span><select className="input" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>{['舆情风险', '工商变更', '法律诉讼', '行政处罚', '财务异常', '协议到期', '关键人员变动', '资料缺失'].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span className="label">风险等级</span><select className="input" value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value as RiskLevel })}><option>低</option><option>中</option><option>高</option></select></label>
          <label><span className="label">发生日期</span><input className="input" value={form.occurredAt} onChange={(event) => setForm({ ...form, occurredAt: event.target.value })} /></label>
          <label className="col-span-2"><span className="label">风险描述 <b className="text-rose-500">*</b></span><textarea className="textarea min-h-24" placeholder="说明事件、影响范围与当前证据…" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        </div>
      </Modal>
      <Drawer open={!!selected} title="风险详情与处置" onClose={() => setSelected(null)} footer={selected && <><Button variant="secondary" onClick={() => { void changeStatus('误报') }}>标记误报</Button><Button onClick={() => { void changeStatus(selected.status === '待确认' ? '处理中' : '已关闭') }}>{selected.status === '待确认' ? '开始处置' : '关闭风险'}</Button></>}>
        {selected && <div className="space-y-5"><div className="rounded-xl bg-slate-50 p-4"><div className="flex items-center gap-2"><RiskBadge level={selected.level} /><Badge>{selected.type}</Badge><StatusBadge status={selected.status} /></div><h3 className="mt-4 font-semibold text-slate-800">{selected.projectName}</h3><p className="mt-3 text-sm leading-7 text-slate-600">{selected.description}</p></div><div className="grid grid-cols-2 gap-4 text-sm"><div><p className="text-xs text-slate-400">负责人</p><p className="mt-1 font-medium text-slate-700">{selected.owner}</p></div><div><p className="text-xs text-slate-400">发生日期</p><p className="mt-1 font-medium text-slate-700">{selected.occurredAt}</p></div></div><div className="rounded-xl border border-slate-200 p-4 text-xs leading-6 text-slate-500">当前仅展示已持久化的风险事实和处置状态。状态变更由服务端审计记录，未建立正式分析任务前不展示 AI 处置建议或模拟时间线。</div></div>}
      </Drawer>
    </div>
  )
}
