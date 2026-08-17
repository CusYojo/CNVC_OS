import { ChevronLeft, ChevronRight, Filter, GitBranch, MoreHorizontal, Pencil, Pin, Plus } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ProjectModal } from '../components/ProjectModal'
import { useToast } from '../components/Toast'
import { Button, Card, DataTable, Drawer, EmptyState, Modal, PageHeader, RiskBadge, SearchInput, StageBadge, TableCell } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'
import type { Project, ProjectStage, RiskLevel } from '../types'
import { formatShanghaiDateTime } from '../lib/dateTime'

const stages: ProjectStage[] = ['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出', '放弃']

export function ProjectsPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const projects = useAppStore((state) => state.projects)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const approvalRequests = useAppStore((state) => state.approvalRequests)
  const updateProject = useAppStore((state) => state.updateProject)
  const deleteProject = useAppStore((state) => state.deleteProject)
  const pinProject = useAppStore((state) => state.pinProject)
  const [query, setQuery] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [scope, setScope] = useState('mine')
  const [stage, setStage] = useState('')
  const [industry, setIndustry] = useState('')
  const [owner, setOwner] = useState('')
  const [risk, setRisk] = useState('')
  const [page, setPage] = useState(1)
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null)
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null)
  const pageSize = 6

  const industries = Array.from(new Set(projects.map((item) => item.industry)))
  const owners = Array.from(new Set(projects.map((item) => item.owner)))
  const filtered = useMemo(() => projects
    .filter((project) => scope === 'all' || project.owner === currentUser.name)
    .filter((project) => !query || `${project.name}${project.companyName}`.toLowerCase().includes(query.toLowerCase()))
    .filter((project) => !stage || project.stage === stage)
    .filter((project) => !industry || project.industry === industry)
    .filter((project) => !owner || project.owner === owner)
    .filter((project) => !risk || project.riskLevel === risk)
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt)), [projects, scope, currentUser.name, query, stage, industry, owner, risk])
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize)

  const clearFilters = () => {
    setQuery(''); setScope('mine'); setStage(''); setIndustry(''); setOwner(''); setRisk(''); setPage(1)
  }

  const saveEdit = async () => {
    if (!editing || savingEdit) return
    setSavingEdit(true)
    try {
      await updateProject(editing.id, {
        name: editing.name,
        companyName: editing.companyName,
        industry: editing.industry,
        round: editing.round,
        financing: editing.financing,
        valuation: editing.valuation,
        riskLevel: editing.riskLevel,
        summary: editing.summary,
      })
      showToast('项目信息已保存')
      setEditing(null)
    } catch (error) {
      showToast(`保存失败：${(error as Error).message}`, 'error')
    } finally {
      setSavingEdit(false)
    }
  }

  const handlePin = async (project: Project) => {
    setMenuId(null)
    try { await pinProject(project.id, !project.pinned); showToast(project.pinned ? '已取消置顶' : '已置顶') }
    catch (e) { showToast(`操作失败：${(e as Error).message}`, 'error') }
  }
  const requestDelete = (project: Project) => {
    setMenuId(null)
    setPendingDelete(project)
  }
  const confirmDelete = async () => {
    if (!pendingDelete || deletingProjectId) return
    setDeletingProjectId(pendingDelete.id)
    try {
      await deleteProject(pendingDelete.id)
      showToast(`已删除「${pendingDelete.name}」及其知识库`)
      setPendingDelete(null)
    } catch (e) {
      showToast(`删除失败：${(e as Error).message}`, 'error')
    } finally {
      setDeletingProjectId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="我的专属项目"
        description="管理本人领取或创建的项目；项目阶段由 OA 审批结果驱动。"
        actions={<Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" />新建项目</Button>}
      />

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput className="min-w-[220px] flex-1" placeholder="搜索项目名称或公司…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} />
          <select className="input w-32" value={scope} onChange={(event) => { setScope(event.target.value); setPage(1) }}><option value="mine">我的专属项目</option><option value="all">全部项目</option></select>
          <select className="input w-32" value={stage} onChange={(event) => { setStage(event.target.value); setPage(1) }}><option value="">全部阶段</option>{stages.map((item) => <option key={item}>{item}</option>)}</select>
          <select className="input w-36" value={industry} onChange={(event) => { setIndustry(event.target.value); setPage(1) }}><option value="">全部行业</option>{industries.map((item) => <option key={item}>{item}</option>)}</select>
          <select className="input w-32" value={owner} onChange={(event) => { setOwner(event.target.value); setPage(1) }}><option value="">全部负责人</option>{owners.map((item) => <option key={item}>{item}</option>)}</select>
          <select className="input w-32" value={risk} onChange={(event) => { setRisk(event.target.value); setPage(1) }}><option value="">全部风险</option><option>低</option><option>中</option><option>高</option></select>
          <button onClick={clearFilters} className="ml-auto flex items-center gap-1.5 text-xs text-slate-500 hover:text-brand-600"><Filter className="h-3.5 w-3.5" />清空筛选</button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {rows.length === 0 ? <EmptyState title="没有找到项目" description="调整搜索或筛选条件，也可以直接创建一个新项目。" action={<Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" />创建项目</Button>} /> : (
          <>
            <DataTable headers={['项目 / 公司', '行业与轮次', '项目阶段', '负责人', '融资 / 估值', '风险', '最近更新', '']}>
              {rows.map((project) => (
                <tr key={project.id} className="group cursor-pointer hover:bg-slate-50/80">
                  <TableCell className="min-w-[230px]">
                    <button onClick={() => navigate(`/projects/${project.id}`)} className="flex items-center gap-3 text-left">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-xs font-semibold text-brand-700">{project.name.slice(0, 2)}</span>
                      <span className="min-w-0"><span className="flex items-center gap-1.5 font-medium text-slate-800 group-hover:text-brand-700">{project.pinned && <Pin aria-label="已置顶" className="h-3.5 w-3.5 shrink-0 fill-brand-500 text-brand-500" />}{project.name}</span><span className="mt-0.5 block max-w-[180px] truncate text-xs text-slate-400">{project.companyName}</span></span>
                    </button>
                  </TableCell>
                  <TableCell><span className="block text-slate-700">{project.industry}</span><span className="mt-1 block text-xs text-slate-400">{project.round}</span></TableCell>
                  <TableCell>
                    <div><StageBadge stage={project.stage} /><p className="mt-1 whitespace-nowrap text-[10px] text-slate-400">{approvalRequests.some((item) => item.projectId === project.id && item.status === '审批中') ? 'OA 审批中，阶段锁定' : project.stageSource === 'OA审批' ? '由 OA 审批同步' : '可发起下一阶段审批'}</p></div>
                  </TableCell>
                  <TableCell><span className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-slate-100 text-[10px] font-medium text-slate-600">{project.owner.slice(-2)}</span>{project.owner}</span></TableCell>
                  <TableCell><span className="block text-slate-700">{project.financing}</span><span className="mt-1 block text-xs text-slate-400">估值 {project.valuation}</span></TableCell>
                  <TableCell><RiskBadge level={project.riskLevel} /></TableCell>
                  <TableCell><span className="whitespace-nowrap text-xs">{formatShanghaiDateTime(project.updatedAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                      <button aria-label="发起OA审批" title="发起 OA 审批" className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-brand-600" onClick={(event) => { event.stopPropagation(); navigate(`/workflow?project=${project.id}`) }}><GitBranch className="h-4 w-4" /></button>
                      <button aria-label="编辑项目" className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-brand-600" onClick={(event) => { event.stopPropagation(); setEditing(project) }}><Pencil className="h-4 w-4" /></button>
                      <span className="relative inline-block"><button aria-label="更多操作" className="rounded-lg p-1.5 text-slate-400 hover:bg-white" onClick={(event) => { event.stopPropagation(); setMenuId(menuId === project.id ? null : project.id) }}><MoreHorizontal className="h-4 w-4" /></button>{menuId === project.id && <span className="absolute right-0 top-9 z-20 w-32 rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg" onClick={(event) => event.stopPropagation()}><button className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-600 hover:bg-slate-50" onClick={() => handlePin(project)}>{project.pinned ? '取消置顶' : '置顶'}</button><button className="flex w-full items-center gap-2 px-3 py-2 text-left text-rose-600 hover:bg-rose-50" onClick={() => requestDelete(project)}>删除项目</button></span>}</span>
                    </div>
                  </TableCell>
                </tr>
              ))}
            </DataTable>
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
              <p className="text-xs text-slate-400">共 {filtered.length} 个项目 · 第 {page}/{totalPages} 页</p>
              <div className="flex items-center gap-1">
                <button aria-label="上一页" disabled={page === 1} onClick={() => setPage((value) => value - 1)} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-500 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
                {Array.from({ length: totalPages }).map((_, index) => <button key={index} onClick={() => setPage(index + 1)} className={`grid h-8 min-w-8 place-items-center rounded-lg text-xs ${page === index + 1 ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-500'}`}>{index + 1}</button>)}
                <button aria-label="下一页" disabled={page === totalPages} onClick={() => setPage((value) => value + 1)} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-500 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          </>
        )}
      </Card>
      <ProjectModal open={showCreate} onClose={() => setShowCreate(false)} />
      <Modal
        open={!!pendingDelete}
        onClose={() => { if (!deletingProjectId) setPendingDelete(null) }}
        title="确认删除项目"
        footer={<><Button variant="secondary" disabled={!!deletingProjectId} onClick={() => setPendingDelete(null)}>取消</Button><Button variant="danger" loading={!!deletingProjectId} onClick={() => { void confirmDelete() }}>确认删除</Button></>}
      >
        <p className="text-sm leading-6 text-slate-600">确认删除项目「{pendingDelete?.name}」？项目知识库、文件版本和关联记录将按数据库删除规则一并处理，此操作不可恢复。</p>
      </Modal>
      <Drawer open={!!editing} onClose={() => setEditing(null)} title="编辑项目信息" footer={<><Button variant="secondary" onClick={() => setEditing(null)}>取消</Button><Button loading={savingEdit} onClick={() => { void saveEdit() }}>保存修改</Button></>}>
        {editing && <div className="space-y-4">
          <label><span className="label">项目名称</span><input className="input" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
          <label><span className="label">公司名称</span><input className="input" value={editing.companyName ?? ''} onChange={(event) => setEditing({ ...editing, companyName: event.target.value })} /></label>
          <div className="grid grid-cols-2 gap-4"><label><span className="label">所属行业</span><input className="input" value={editing.industry ?? ''} onChange={(event) => setEditing({ ...editing, industry: event.target.value })} /></label><label><span className="label">融资轮次</span><input className="input" value={editing.round ?? ''} onChange={(event) => setEditing({ ...editing, round: event.target.value })} /></label></div>
          <div className="grid grid-cols-2 gap-4"><label><span className="label">计划融资</span><input className="input" value={editing.financing ?? ''} onChange={(event) => setEditing({ ...editing, financing: event.target.value })} /></label><label><span className="label">估值</span><input className="input" value={editing.valuation ?? ''} onChange={(event) => setEditing({ ...editing, valuation: event.target.value })} /></label></div>
          <label><span className="label">风险等级</span><select className="input" value={editing.riskLevel} onChange={(event) => setEditing({ ...editing, riskLevel: event.target.value as RiskLevel })}><option>低</option><option>中</option><option>高</option></select></label>
          <label><span className="label">项目简介</span><textarea className="textarea min-h-28" value={editing.summary ?? ''} onChange={(event) => setEditing({ ...editing, summary: event.target.value })} /></label>
        </div>}
      </Drawer>
    </div>
  )
}
