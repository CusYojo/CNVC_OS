import { AlertTriangle, ChevronLeft, ChevronRight, Filter, GitBranch, MoreHorizontal, Pencil, Pin, Plus, Star } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UnifiedProjectCreateModal } from '../components/UnifiedProjectCreateModal'
import { useToast } from '../components/Toast'
import { Button, Card, DataTable, Drawer, EmptyState, Modal, PageHeader, RiskBadge, SearchInput, StageBadge, TableCell } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'
import type { Project, ProjectClassification, ProjectStage, RiskLevel } from '../types'
import { formatShanghaiDateTime } from '../lib/dateTime'
import { canDirectlyDeleteProject } from '../../server/src/contracts/adminRoleContract'
import { fetchProjectList, type ProjectListCounts } from '../services/projectListApi'

const stages: ProjectStage[] = ['入库', '立项', '尽调计划制定', '尽调计划审核', '尽调', '内核', '投决', '打款', '已 Close', '线索', '初筛', '上会', '投后', '退出', '放弃']
const viewCopy: Record<ProjectClassification, { title: string; description: string }> = {
  pool: { title: '项目池', description: '已由专属项目转换或授权登记、等待完成入库初筛的项目。' },
  normal: { title: '普通项目', description: '已完成入库并进入正式投资流程的项目。' },
  key: { title: '重点项目', description: '由授权领导标记、需要重点推进和关注的项目。' },
}

export function ProjectsPage({
  classification = 'normal', embedded = false, onCountsChange,
}: {
  classification?: ProjectClassification
  embedded?: boolean
  onCountsChange?: (counts: ProjectListCounts) => void
}) {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const projects = useAppStore((state) => state.projects)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const approvalRequests = useAppStore((state) => state.approvalRequests)
  const updateProject = useAppStore((state) => state.updateProject)
  const deleteProject = useAppStore((state) => state.deleteProject)
  const pinProject = useAppStore((state) => state.pinProject)
  const classifyProject = useAppStore((state) => state.classifyProject)
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
  const [rows, setRows] = useState<Project[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const latestRequest = useRef(0)
  const pageSize = 6

  const industries = Array.from(new Set(projects.map((item) => item.industry)))
  const owners = Array.from(new Set(projects.map((item) => item.owner)))
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const requestId = ++latestRequest.current
    setLoading(true)
    setLoadError('')
    void fetchProjectList({
      page, pageSize, scope: scope as 'mine' | 'all', classification, lifecycle: 'active',
      keyword: debouncedQuery, stage, industry, owner, risk: risk as RiskLevel | '',
    }).then((result) => {
      if (requestId !== latestRequest.current) return
      const nextTotalPages = Math.max(1, Math.ceil(result.total / pageSize))
      if (page > nextTotalPages) { setPage(nextTotalPages); return }
      setRows(result.list)
      setTotal(result.total)
      onCountsChange?.(result.counts)
      useAppStore.setState((state) => ({
        projects: [...result.list, ...state.projects.filter((item) => !result.list.some((row) => row.id === item.id))],
      }))
    }).catch((error: Error) => {
      if (requestId === latestRequest.current) setLoadError(error.message || '项目列表加载失败')
    }).finally(() => {
      if (requestId === latestRequest.current) setLoading(false)
    })
  }, [classification, debouncedQuery, industry, onCountsChange, owner, page, refreshKey, risk, scope, stage])

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
      setRefreshKey((value) => value + 1)
    } catch (error) {
      showToast(`保存失败：${(error as Error).message}`, 'error')
    } finally {
      setSavingEdit(false)
    }
  }

  const handlePin = async (project: Project) => {
    setMenuId(null)
    try { await pinProject(project.id, !project.pinned); showToast(project.pinned ? '已取消置顶' : '已置顶'); setRefreshKey((value) => value + 1) }
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
      await deleteProject(pendingDelete.id, pendingDelete.name)
      showToast(`已删除「${pendingDelete.name}」`)
      setPendingDelete(null)
      setRefreshKey((value) => value + 1)
    } catch (e) {
      showToast(`删除失败：${(e as Error).message}`, 'error')
    } finally {
      setDeletingProjectId(null)
    }
  }

  const changeClassification = async (project: Project, target: ProjectClassification) => {
    setMenuId(null)
    const action = project.classification === 'pool' ? '完成入库' : target === 'key' ? '升级为重点项目' : '调整为普通项目'
    const reason = window.prompt(`请填写“${action}”原因：`, project.classification === 'pool' ? '入库初筛完成' : '')
    if (!reason?.trim()) return
    try {
      await classifyProject(project.id, target, reason)
      showToast(`${project.name}：${action}成功`)
      setRefreshKey((value) => value + 1)
    } catch (error) {
      showToast(`${action}失败：${(error as Error).message}`, 'error')
    }
  }

  const canClassify = currentUser.permissionCodes?.includes('project.classify') ?? false
  const canDelete = canDirectlyDeleteProject(currentUser.role, currentUser.permissionCodes)
  const canPromote = (project: Project) => canClassify || project.ownerUserId === currentUser.id || ['owner', 'project_lead'].includes(project.participantRole ?? '')
  const currentCopy = viewCopy[classification]

  return (
    <div className="fde-project-list">
      {!embedded && <PageHeader
        title={currentCopy.title}
        description={currentCopy.description}
        actions={classification === 'pool' ? <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" />登记项目</Button> : undefined}
      />}

      <Card className="fde-toolbar mb-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {embedded && classification === 'pool' && <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" />登记项目</Button>}
          <SearchInput className="min-w-[220px] flex-1" placeholder="搜索项目名称或公司…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} />
          <select className="input w-32" value={scope} onChange={(event) => { setScope(event.target.value); setPage(1) }}><option value="mine">我的参与项目</option><option value="all">全部可访问项目</option></select>
          <select className="input w-32" value={stage} onChange={(event) => { setStage(event.target.value); setPage(1) }}><option value="">全部阶段</option>{stages.map((item) => <option key={item}>{item}</option>)}</select>
          <select className="input w-36" value={industry} onChange={(event) => { setIndustry(event.target.value); setPage(1) }}><option value="">全部行业</option>{industries.map((item) => <option key={item}>{item}</option>)}</select>
          <select className="input w-32" value={owner} onChange={(event) => { setOwner(event.target.value); setPage(1) }}><option value="">全部负责人</option>{owners.map((item) => <option key={item}>{item}</option>)}</select>
          <select className="input w-32" value={risk} onChange={(event) => { setRisk(event.target.value); setPage(1) }}><option value="">全部风险</option><option>低</option><option>中</option><option>高</option></select>
          <button onClick={clearFilters} className="ml-auto flex items-center gap-1.5 text-xs text-slate-500 hover:text-brand-600"><Filter className="h-3.5 w-3.5" />清空筛选</button>
        </div>
      </Card>

      <Card className="fde-project-table overflow-hidden">
        {loading && rows.length === 0 ? <EmptyState title="正在加载项目" description="正在查询最新项目数据…" /> : loadError ? <EmptyState title="项目列表加载失败" description={loadError} action={<Button onClick={() => setRefreshKey((value) => value + 1)}>重新加载</Button>} /> : rows.length === 0 ? <EmptyState title={`没有找到${currentCopy.title}`} description="调整搜索或筛选条件后重试。" action={classification === 'pool' ? <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4" />登记项目</Button> : undefined} /> : (
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
                    <div><StageBadge stage={project.stage} /><p className="mt-1 whitespace-nowrap text-xs text-slate-400">{approvalRequests.some((item) => item.projectId === project.id && item.status === '审批中') ? 'OA 审批中，阶段锁定' : project.stageSource === 'OA审批' ? '由 OA 审批同步' : '可发起下一阶段审批'}</p></div>
                  </TableCell>
                  <TableCell><span className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">{project.owner.slice(-2)}</span>{project.owner}</span></TableCell>
                  <TableCell><span className="block text-slate-700">{project.financing}</span><span className="mt-1 block text-xs text-slate-400">估值 {project.valuation}</span></TableCell>
                  <TableCell><RiskBadge level={project.riskLevel} /></TableCell>
                  <TableCell><span className="whitespace-nowrap text-xs">{formatShanghaiDateTime(project.updatedAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 transition">
                      {classification === 'normal' && canPromote(project) && <button aria-label={`将${project.name}转为重点项目`} title="转为重点项目" className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50" onClick={(event) => { event.stopPropagation(); void changeClassification(project, 'key') }}><Star className="h-4 w-4" />转重点</button>}
                      <button aria-label="发起OA审批" title="发起 OA 审批" className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-brand-600" onClick={(event) => { event.stopPropagation(); navigate(`/workflow?view=project&project=${project.id}`) }}><GitBranch className="h-4 w-4" /></button>
                      <button aria-label="编辑项目" className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-brand-600" onClick={(event) => { event.stopPropagation(); setEditing(project) }}><Pencil className="h-4 w-4" /></button>
                      <span className="relative inline-block"><button aria-label="更多操作" className="rounded-lg p-1.5 text-slate-400 hover:bg-white" onClick={(event) => { event.stopPropagation(); setMenuId(menuId === project.id ? null : project.id) }}><MoreHorizontal className="h-4 w-4" /></button>{menuId === project.id && <span className="absolute right-0 top-9 z-20 w-40 rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg" onClick={(event) => event.stopPropagation()}>{classification === 'pool' && (project.owner === currentUser.name || canClassify) && <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-brand-700 hover:bg-brand-50" onClick={() => { void changeClassification(project, 'normal') }}>完成入库</button>}{classification === 'normal' && canPromote(project) && <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-brand-700 hover:bg-brand-50" onClick={() => { void changeClassification(project, 'key') }}>升级为重点项目</button>}{classification === 'key' && canClassify && <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-600 hover:bg-slate-50" onClick={() => { void changeClassification(project, 'normal') }}>调整为普通项目</button>}<button className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-600 hover:bg-slate-50" onClick={() => handlePin(project)}>{project.pinned ? '取消置顶' : '置顶'}</button>{canDelete && <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-rose-600 hover:bg-rose-50" onClick={() => requestDelete(project)}>删除项目</button>}</span>}</span>
                    </div>
                  </TableCell>
                </tr>
              ))}
            </DataTable>
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
              <p className="text-xs text-slate-400">共 {total} 个项目 · 第 {page}/{totalPages} 页</p>
              <div className="flex items-center gap-1">
                <button aria-label="上一页" disabled={page === 1} onClick={() => setPage((value) => value - 1)} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-500 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
                {Array.from({ length: totalPages }).map((_, index) => <button key={index} onClick={() => setPage(index + 1)} className={`grid h-8 min-w-8 place-items-center rounded-lg text-xs ${page === index + 1 ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-500'}`}>{index + 1}</button>)}
                <button aria-label="下一页" disabled={page === totalPages} onClick={() => setPage((value) => value + 1)} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-500 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          </>
        )}
      </Card>
      <UnifiedProjectCreateModal open={showCreate} onClose={() => { setShowCreate(false); setRefreshKey((value) => value + 1) }} />
      <Modal
        open={!!pendingDelete}
        onClose={() => { if (!deletingProjectId) setPendingDelete(null) }}
        title="确认删除项目"
        footer={<><Button variant="secondary" disabled={!!deletingProjectId} onClick={() => setPendingDelete(null)}>取消</Button><Button variant="danger" loading={!!deletingProjectId} onClick={() => { void confirmDelete() }}>确认删除</Button></>}
      >
        <div className="flex gap-3 rounded-xl bg-rose-50 p-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-rose-600"><AlertTriangle className="h-5 w-5" /></span>
          <div>
            <p className="font-medium text-slate-900">删除「{pendingDelete?.name}」？</p>
            <p className="mt-1 text-sm leading-6 text-slate-600">项目将从所有成员的项目列表、任务和日历中移除，相关记录保留用于审计。</p>
          </div>
        </div>
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
