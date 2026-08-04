import { useAuthStore } from '../store/useAuthStore'
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Building2,
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Download,
  ExternalLink,
  FileStack,
  FileText,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Upload,
  Users,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, DataTable, FileUpload, Modal, ProgressBar, RiskBadge, StageBadge, StatusBadge, TableCell, Tabs } from '../components/ui'
import { apiPost, apiGet, ApiError } from '../lib/api'
import type { AISummary, Lead, Project, ProjectFile, RiskLevel } from '../types'

const tabItems = [
  { id: 'overview', label: '项目概览' },
  { id: 'intelligence', label: '公司情报' },
  { id: 'files', label: '资料库' },
  { id: 'summary', label: 'AI 摘要' },
  { id: 'materials', label: '上会材料' },
  { id: 'meetings', label: '会议纪要' },
  { id: 'workflow', label: '流程记录' },
  { id: 'risks', label: '风险' },
  { id: 'post', label: '投后' },
]

export function ProjectDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { showToast } = useToast()
  const projects = useAppStore((state) => state.projects)
  const deleteFile = useAppStore((state) => state.deleteFile)
  const hydrateFromServer = useAppStore((state) => state.hydrateFromServer)
  const files = useAppStore((state) => state.files)
  const summaries = useAppStore((state) => state.aiSummaries)
  const materials = useAppStore((state) => state.materialJobs)
  const meetings = useAppStore((state) => state.meetings)
  const workflows = useAppStore((state) => state.workflowLogs)
  const risks = useAppStore((state) => state.risks)
  const postUpdates = useAppStore((state) => state.postUpdates)
  const leads = useAppStore((state) => state.leads)
  const approvalRequests = useAppStore((state) => state.approvalRequests)
  const auditLogs = useAppStore((state) => state.auditLogs)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const addFile = useAppStore((state) => state.addFile)
  const finishFileParsing = useAppStore((state) => state.finishFileParsing)
  const saveSummary = useAppStore((state) => state.saveSummary)
  const updateProject = useAppStore((state) => state.updateProject)
  const project = projects.find((item) => item.id === id)
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') ?? 'overview')
  const [showUpload, setShowUpload] = useState(false)
  const [uploading, setUploading] = useState<{ name: string; progress: number; id?: string; done?: number; total?: number } | null>(null)
  const [generating, setGenerating] = useState(false)
  const [editingSummary, setEditingSummary] = useState<AISummary | null>(null)
  const [editingProject, setEditingProject] = useState<Project | null>(null)

  const projectFiles = files.filter((item) => item.projectId === id)
  const projectMaterials = materials.filter((item) => item.projectId === id)
  const projectMeetings = meetings.filter((item) => item.projectId === id)
  const projectWorkflows = workflows.filter((item) => item.projectId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const projectRisks = risks.filter((item) => item.projectId === id)
  const projectPosts = postUpdates.filter((item) => item.projectId === id)
  const projectApprovals = approvalRequests.filter((item) => item.projectId === id).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
  const listLeadMatch = leads.find((item) => item.companyName === project?.companyName || item.name === project?.name)
  // 列表 store.leads 精简了 founders/fundingRounds/companyNews/sources 等大字段,
  // 详情页需要完整情报 —— 匹配到后异步拉详情接口补全,拉到前用列表版(下面渲染都带兜底不会白屏)。
  const [fullIntel, setFullIntel] = useState<Lead | null>(null)
  const fetchLeadDetail = useAppStore((state) => state.fetchLeadDetail)
  useEffect(() => {
    if (listLeadMatch?.id) { void fetchLeadDetail(listLeadMatch.id).then((d) => { if (d) setFullIntel(d) }) }
    else setFullIntel(null)
  }, [listLeadMatch?.id, fetchLeadDetail])
  const companyIntelligence = fullIntel ?? listLeadMatch
  const summary = summaries.find((item) => item.projectId === id)
  const projectAudits = auditLogs.filter((item) => item.target.includes(project?.name ?? '')).slice(0, 5)

  const defaultSummary = useMemo<AISummary | null>(() => project ? {
    projectId: project.id,
    positioning: project.summary,
    highlights: [`项目处于${project.stage}阶段，已形成较清晰的产品定位`, `${project.industry}赛道仍具结构性成长机会`, '团队背景与目标场景具备较高匹配度'],
    risks: ['关键商业指标仍需通过客户访谈交叉验证', '融资后资金使用效率和下一轮里程碑需要明确', project.riskLevel === '高' ? '当前存在高等级风险事件，应优先完成处置' : '合规与财务资料完整度仍需提升'],
    questions: ['前十大客户收入占比、续费率与回款周期如何？', '核心壁垒能否用第三方数据或客户案例验证？', '未来 18 个月的经营里程碑及对应资金投入是什么？'],
    missing: ['最近两年审计财务报表', '前十大客户及合同明细', '核心知识产权清单'],
    confidence: Math.max(72, project.score - 4),
    sources: projectFiles.length ? projectFiles.map((file) => file.name).slice(0, 3) : ['项目基础信息（资料尚未上传）'],
    updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  } : null, [project, projectFiles])

  if (!project) {
    return <Card className="mx-auto mt-16 max-w-xl p-10 text-center"><AlertCircle className="mx-auto h-10 w-10 text-slate-300" /><h1 className="mt-4 text-lg font-semibold">项目不存在或已归档</h1><p className="mt-2 text-sm text-slate-500">请返回项目列表选择其他项目。</p><Button className="mt-5" onClick={() => navigate('/projects')}>返回项目列表</Button></Card>
  }

  // 单文件上传：返回结果状态，供批量汇总。不在此弹 toast（批量结束统一汇总）。
  const uploadOne = async (file: File, onProgress?: (pct: number) => void): Promise<'ok' | 'ingest-fail' | 'duplicate' | 'error'> => {
    // 读为 base64 → 真实上传到后端，后端提取正文、切块入库供 AI 检索
    // 进度反馈：读取阶段用 FileReader.onprogress 映射到 0-70%，上传阶段推到 90%，完成 100%。
    const dataBase64: string = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      // 30s 读取超时兜底：某些浏览器/损坏文件会让 FileReader 既不 onload 也不 onerror 而永久挂起，
      // 导致上传 Promise 永不 resolve → 进度条死在 0%、弹窗关不掉。超时强制 reject。
      const to = setTimeout(() => { try { reader.abort() } catch { /* ignore */ } reject(new Error('文件读取超时（30s）')) }, 30000)
      reader.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 70)) }
      reader.onload = () => { clearTimeout(to); onProgress?.(70); resolve(String(reader.result).split(',')[1] ?? '') }
      reader.onerror = () => { clearTimeout(to); reject(new Error('文件读取失败')) }
      reader.onabort = () => { clearTimeout(to); reject(new Error('文件读取被中断')) }
      reader.readAsDataURL(file)
    })
    onProgress?.(80)  // 开始上传
    // 上传传输期(可能几十秒)进度条从 80 缓慢爬到 95%,避免用户以为卡死。成功后跳 100%。
    let creep = 80
    const creepTimer = setInterval(() => { creep = Math.min(95, creep + 1); onProgress?.(creep) }, 1500)
    try {
      // 上传大文件经公网可能慢(几MB要几十秒)，用 5 分钟超时的独立 signal 覆盖 api 默认的 60s，
      // 避免大文件上传到一半被默认超时掐断("卡80%后闪退"的根因)。
      const upCtrl = new AbortController()
      const upTimer = setTimeout(() => upCtrl.abort(), 300000)
      let created: { id: string; parseStatus: string }, ingest: { ok: boolean; chunks?: number; chars?: number; error?: string }
      try {
        const resp = await apiPost<{ file: { id: string; parseStatus: string }; ingest: { ok: boolean; chunks?: number; chars?: number; error?: string } }>(
          '/projects/files/upload',
          { projectId: project.id, name: file.name, type: file.name.split('.').pop()?.toUpperCase() ?? 'FILE', category: '项目资料', uploader: currentUser.name, dataBase64 },
          { signal: upCtrl.signal },
        )
        created = resp.file; ingest = resp.ingest
      } finally {
        clearTimeout(upTimer)
      }
      // 把后端返回的真实文件记录并入 store，列表立即可见
      useAppStore.setState((state) => ({ files: [{ projectId: project.id, name: file.name, type: file.name.split('.').pop()?.toUpperCase() ?? 'FILE', category: '项目资料', size: '', uploader: currentUser.name, visibility: '项目成员', version: 1, uploadedAt: new Date().toISOString(), ...created } as never, ...state.files] }))
      clearInterval(creepTimer)
      onProgress?.(100)
      return ingest.ok ? 'ok' : 'ingest-fail'
    } catch (err) {
      clearInterval(creepTimer)
      // 409 查重：资料已在库中，视为已存在（不算失败）
      if (err instanceof ApiError && err.code === 'DUPLICATE') return 'duplicate'
      return 'error'
    }
  }

  // 批量并行上传：Promise.allSettled，单个失败不阻断，进度显示 N/M，结束汇总 toast
  const handleUploadFiles = async (files: File[]) => {
    if (!files.length) return
    const oversized = files.filter((f) => f.size > 100 * 1024 * 1024)
    const valid = files.filter((f) => f.size <= 100 * 1024 * 1024)
    if (oversized.length) showToast(`${oversized.length} 个文件超过 100MB 已跳过：${oversized.map((f) => f.name).join('、')}`, 'error')
    if (!valid.length) return
    const total = valid.length
    let done = 0
    setUploading({ name: valid.length === 1 ? valid[0].name : `批量上传 ${total} 个文件`, progress: 0, done: 0, total })
    let okCount = 0, ingestFail = 0, dupCount = 0, errCount = 0
    // 单文件：进度条跟随 uploadOne 的读取/上传阶段(0-100%)，不再死在 0%。
    // 多文件：进度条按 done/total 推进(单个文件的细粒度进度并入整体)。
    const single = total === 1
    try {
    await Promise.allSettled(valid.map(async (file) => {
      let r: 'ok' | 'ingest-fail' | 'duplicate' | 'error'
      try {
        r = await uploadOne(file, (pct) => {
          if (single) setUploading((state) => state ? { ...state, progress: pct } : state)
        })
      } catch { r = 'error' }
      if (r === 'ok') okCount++
      else if (r === 'ingest-fail') ingestFail++
      else if (r === 'duplicate') dupCount++
      else errCount++
      done++
      setUploading((state) => state ? { ...state, done, progress: single ? 100 : Math.round((done / total) * 100) } : state)
    }))
    // 汇总 toast
    const parts: string[] = []
    if (okCount) parts.push(`成功入库 ${okCount}`)
    if (dupCount) parts.push(`已存在 ${dupCount}`)
    if (ingestFail) parts.push(`上传成功但解析失败 ${ingestFail}`)
    if (errCount) parts.push(`失败 ${errCount}`)
    const tone: 'success' | 'error' | 'info' = errCount || ingestFail ? 'error' : (dupCount && !okCount ? 'info' : 'success')
    showToast(`上传完成（共 ${total} 个）：${parts.join('，')}`, tone === 'success' ? undefined : tone)
    } finally {
      // 无论成功/失败/卡住,一定复位上传态并关闭弹窗,避免进度条卡住+弹窗关不掉。
      setUploading(null)
      setShowUpload(false)
    }
  }

  const generateSummary = async () => {
    if (!project) return
    setGenerating(true)
    showToast('AI 评分已开始（7 维评分+竞品对标+同赛道分位，约 3-5 分钟），完成后自动显示')
    try {
      await apiPost(`/projects/${project.id}/score`, {})
      const deadline = Date.now() + 8 * 60 * 1000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 6000))
        const st = await apiGet<{ status: string; error?: string; scoring: unknown }>(`/projects/${project.id}/score`)
        if (st.status === 'done' && st.scoring) {
          await hydrateFromServer()
          showToast('项目评分已生成')
          return
        }
        if (st.status === 'failed') { showToast('AI 评分暂未完成，请稍后重新生成', 'info'); return }
      }
      showToast('评分仍在进行，稍后重新打开该项目查看', 'error')
    } catch (err) {
      showToast(`评分请求失败：${(err as Error).message}`, 'error')
    } finally {
      setGenerating(false)
    }
  }


  const renderOverview = () => (
    <div className="grid grid-cols-[1fr_300px] gap-5">
      <div className="space-y-5">
        <Card className="p-5">
          <div className="mb-5 flex items-center justify-between"><h2 className="font-semibold text-slate-800">项目概况</h2><button onClick={() => setEditingProject(project)} className="flex items-center gap-1 text-xs text-brand-600"><Pencil className="h-3.5 w-3.5" />编辑信息</button></div>
          <div className="grid grid-cols-3 gap-x-8 gap-y-5">
            {[['公司主体', project.companyName], ['所属行业', project.industry], ['融资轮次', project.round], ['计划融资', project.financing], ['投前估值', project.valuation], ['项目来源', project.source], ['项目负责人', project.owner], ['协作成员', project.collaborators.join('、') || '暂无'], ['创建时间', project.createdAt]].map(([label, value]) => <div key={label}><p className="text-xs text-slate-400">{label}</p><p className="mt-1.5 text-sm font-medium text-slate-700">{value}</p></div>)}
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 font-semibold text-slate-800">业务与投资信息</h2>
          <div className="space-y-5">
            {[['项目简介', project.summary], ['商业模式', project.businessModel], ['市场机会', project.market], ['核心团队', project.team]].map(([label, value]) => <div key={label}><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-2 text-sm leading-6 text-slate-700">{value}</p></div>)}
          </div>
        </Card>
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold text-slate-800">最近操作记录</h2><button onClick={() => navigate('/system')} className="text-xs text-brand-600">查看审计日志</button></div>
          <div className="space-y-4">{(projectAudits.length ? projectAudits : auditLogs.slice(0, 3)).map((log) => <div key={log.id} className="flex items-start gap-3"><span className="mt-1.5 h-2 w-2 rounded-full bg-brand-400" /><div><p className="text-sm text-slate-700"><strong className="font-medium">{log.user}</strong> · {log.action} <span className="text-slate-500">{log.target}</span></p><p className="mt-1 text-xs text-slate-400">{log.createdAt}</p></div></div>)}</div>
        </Card>
      </div>
      <div className="space-y-5">
        <Card className="p-5">
          <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-800">项目健康度</h2><span className="text-xl font-semibold text-brand-700">{project.progress}</span></div>
          <div className="mt-3"><ProgressBar value={project.progress} tone={project.riskLevel === '高' ? 'amber' : 'blue'} /></div>
          <div className="mt-4 space-y-3 text-xs">{[['资料完整度', `${Math.min(95, projectFiles.length * 18 + 42)}%`], ['流程完成度', `${project.progress}%`], ['待处理风险', `${projectRisks.filter((risk) => risk.status !== '已关闭').length} 条`]].map(([label, value]) => <div key={label} className="flex justify-between"><span className="text-slate-500">{label}</span><strong className="font-medium text-slate-700">{value}</strong></div>)}</div>
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">项目标签</h2>
          <div className="flex flex-wrap gap-2">{project.tags.map((tag) => <Badge key={tag} tone="blue">{tag}</Badge>)}<button onClick={() => setEditingProject(project)} className="rounded-md border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-400">+ 添加</button></div>
        </Card>
        <Card className="overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-4"><h2 className="text-sm font-semibold text-slate-800">快捷操作</h2></div>
          <div className="p-2">
            {[['发起 OA 审批', Users, () => navigate(`/workflow?project=${project.id}`)], ['上传项目资料', Upload, () => setShowUpload(true)], ['生成 AI 摘要', Sparkles, generateSummary], ['准备上会材料', FileStack, () => navigate(`/materials?project=${project.id}`)], ['新建项目会议', CalendarDays, () => navigate(`/meetings?project=${project.id}`)]].map(([label, Icon, action]) => {
              const IconComponent = Icon as typeof Upload
              return <button key={label as string} onClick={action as () => void} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-600 hover:bg-brand-50 hover:text-brand-700"><IconComponent className="h-4 w-4" />{label as string}</button>
            })}
          </div>
        </Card>
      </div>
    </div>
  )

  const renderIntelligence = () => companyIntelligence ? (
    <div className="grid grid-cols-[1fr_320px] gap-5">
      <div className="space-y-5">
        <Card className="p-5"><div className="flex items-center justify-between"><div><h2 className="font-semibold text-slate-800">公司注册与经营信息</h2><p className="mt-1 text-xs text-slate-400">公开来源与项目方材料分级展示，未核验字段不做推测填充</p></div><Badge tone={companyIntelligence.verificationStatus === '已核验' ? 'green' : 'amber'}>{companyIntelligence.verificationStatus}</Badge></div><div className="mt-5 grid grid-cols-2 gap-x-8">{[['公司主体', companyIntelligence.companyName], ['成立时间', companyIntelligence.foundedAt], ['注册资本', companyIntelligence.registeredCapital], ['法定代表人', companyIntelligence.legalRepresentative], ['统一社会信用代码', companyIntelligence.creditCode], ['登记状态', companyIntelligence.registrationStatus], ['公司类型', companyIntelligence.companyType], ['注册地址', companyIntelligence.registeredAddress]].map(([label, value]) => <div key={label} className="grid grid-cols-[110px_1fr] border-b border-slate-100 py-3 text-sm"><span className="text-slate-400">{label}</span><span className="text-slate-700">{value}</span></div>)}</div></Card>
        <Card className="p-5"><h2 className="font-semibold text-slate-800">核心团队与融资</h2><div className="mt-4 space-y-3">{(companyIntelligence.founders ?? []).map((founder) => <div key={founder.name} className="rounded-lg border border-slate-100 p-3"><div className="flex items-center gap-2"><strong className="text-sm text-slate-700">{founder.name}</strong><Badge>{founder.title}</Badge></div><p className="mt-2 text-xs leading-5 text-slate-500">{founder.background}</p></div>)}</div><div className="mt-5 space-y-3">{(companyIntelligence.fundingRounds ?? []).map((round) => <div key={`${round.round}-${round.date}`} className="rounded-lg bg-slate-50 p-4"><div className="flex items-center justify-between"><div><Badge tone="blue">{round.round}</Badge><span className="ml-2 text-xs text-slate-400">{round.date}</span></div><a href={round.sourceUrl ?? '#'} target={(round.sourceUrl ?? '').startsWith('http') ? '_blank' : undefined} rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-600">融资来源<ExternalLink className="h-3 w-3" /></a></div><p className="mt-3 text-sm text-slate-600">金额 {round.amount} · 估值 {round.valuation} · 投资方 {(round.investors ?? []).join('、')}</p></div>)}</div></Card>
        <Card className="p-5"><h2 className="font-semibold text-slate-800">公司动态</h2><div className="mt-4 space-y-4">{(companyIntelligence.companyNews ?? []).map((news) => <div key={`${news.date}-${news.title}`} className="grid grid-cols-[90px_1fr_120px] gap-3 border-b border-slate-100 pb-4 last:border-0 last:pb-0"><div><p className="text-sm font-medium">{news.date}</p><Badge>{news.type}</Badge></div><div><p className="text-sm font-medium text-slate-700">{news.title}</p><p className="mt-1 text-xs leading-5 text-slate-500">{news.summary}</p></div><a href={news.sourceUrl} target="_blank" rel="noreferrer" className="text-right text-xs text-brand-600">查看原文 ↗</a></div>)}</div></Card>
      </div>
      <div className="space-y-5">
        <Card className="p-5"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">数据完整度</h3><strong className="text-brand-700">{companyIntelligence.completeness}%</strong></div><div className="mt-3"><ProgressBar value={companyIntelligence.completeness} /></div><p className="mt-3 text-xs leading-5 text-slate-400">最后核验：{companyIntelligence.lastVerifiedAt}。完整度代表字段覆盖，不代表事实已独立验证。</p></Card>
        <Card className="p-5"><h3 className="text-sm font-semibold text-slate-800">来源证据</h3><div className="mt-3 space-y-3">{(companyIntelligence.sources ?? []).map((source) => <a key={source.id} href={source.url} target={(source.url ?? '').startsWith('http') ? '_blank' : undefined} rel="noreferrer" className="block rounded-lg border border-slate-100 p-3 hover:border-brand-200"><div className="flex items-center justify-between"><Badge tone={source.reliability === '高' ? 'green' : source.reliability === '中' ? 'amber' : 'slate'}>{source.category} · {source.reliability}</Badge><ExternalLink className="h-3.5 w-3.5 text-brand-500" /></div><p className="mt-2 text-sm font-medium text-slate-700">{source.title}</p><p className="mt-1 text-xs leading-5 text-slate-400">{source.excerpt}</p></a>)}</div></Card>
      </div>
    </div>
  ) : <Card className="p-12 text-center"><Building2 className="mx-auto h-9 w-9 text-slate-300" /><p className="mt-3 text-sm text-slate-500">该项目尚未关联公司情报。可从项目获取池补录或绑定主体。</p><Button className="mt-4" onClick={() => navigate('/sourcing')}>前往项目获取池</Button></Card>

  const handleDeleteFile = async (file: { id: string; name: string }) => {
    if (!window.confirm(`确认删除资料「${file.name}」？\n将同时从知识库(RAG)移除其内容，此操作不可恢复。`)) return
    try { await deleteFile(file.id); showToast(`已删除「${file.name}」`) }
    catch (e) { showToast(`删除失败：${(e as Error).message}`, 'error') }
  }

  const renderFiles = () => (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="font-semibold text-slate-800">项目资料库</h2><p className="mt-1 text-xs text-slate-400">文件解析完成后可被 AI 摘要、问答和材料生成引用</p></div><Button onClick={() => setShowUpload(true)}><Upload className="h-4 w-4" />上传资料</Button></div>
      {projectFiles.length ? <DataTable headers={['文件名称', '分类', '大小', '版本', '上传人', '解析状态', '上传时间', '']}>{projectFiles.map((file) => <tr key={file.id} className="hover:bg-slate-50"><TableCell><span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-blue-50 text-[10px] font-semibold text-blue-600">{file.type}</span><span className="font-medium text-slate-700">{file.name}</span></span></TableCell><TableCell>{file.category}</TableCell><TableCell>{file.size}</TableCell><TableCell>V{file.version}</TableCell><TableCell>{file.uploader}</TableCell><TableCell><StatusBadge status={file.parseStatus} /></TableCell><TableCell>{file.uploadedAt.slice(5)}</TableCell><TableCell><span className="flex items-center gap-1"><button aria-label={`下载${file.name}`} onClick={() => showToast(`${file.name} 已加入下载队列`)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><Download className="h-4 w-4" /></button><button aria-label={`删除${file.name}`} onClick={() => handleDeleteFile(file)} className="rounded-lg px-2 py-1 text-xs text-rose-600 hover:bg-rose-50">删除</button></span></TableCell></tr>)}</DataTable> : <div className="p-12 text-center"><FileText className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 text-sm font-medium text-slate-700">还没有项目资料</p><p className="mt-1 text-xs text-slate-400">上传 BP 后即可生成结构化项目卡片与 AI 摘要</p></div>}
    </Card>
  )

  const renderSummary = () => {
    const sc = project.scoring
    if (!sc) return <Card className="p-12 text-center"><Bot className="mx-auto h-9 w-9 text-brand-300" /><h3 className="mt-4 font-medium text-slate-700">尚未生成项目 AI 评分</h3><p className="mt-2 text-sm text-slate-400">与公有线索池同款：按 7 大维度严格打分，给出总分、各维度得分与原因、竞品对标与同赛道分位，并入库。</p><Button className="mt-5" loading={generating} onClick={generateSummary}><Sparkles className="h-4 w-4" />生成项目评分</Button></Card>
    const tone = sc.total >= 80 ? 'green' : sc.total >= 65 ? 'blue' : 'amber'
    const verifiedCompetitors = (sc.competitors ?? []).filter((item) => item.is_self || item.verificationStatus === 'evidence-backed')
    const hasVerifiedCompetitor = verifiedCompetitors.some((item) => !item.is_self)
    return (
      <div className="space-y-5">
        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-brand-600">一级市场评分（多维度加总）</p>
              <div className="mt-1 flex items-baseline gap-2"><span className="text-4xl font-bold text-brand-700">{sc.total}</span><span className="text-sm text-slate-400">/ 100</span><Badge tone={tone}>{sc.verdict}</Badge></div>
            </div>
            <div className="text-right text-xs text-slate-500">
              {sc.rank && <div>同赛道分位 <strong className="text-brand-700">{sc.rank.percentile}%</strong><div className="mt-0.5 text-[10px]">{sc.rank.industry} · 第 {sc.rank.position}/{sc.rank.peers_count}</div></div>}
              <Button className="mt-2" variant="secondary" loading={generating} onClick={generateSummary}><RefreshCw className="h-4 w-4" />重新评分</Button>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-700">{sc.overall_comment}</p>
        </Card>
        <div className="space-y-3">{sc.dimensions.map((dim) => <Card key={dim.key} className="p-4"><div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold text-slate-800">{dim.name}</span><span className="text-sm font-bold text-brand-700">{dim.score}<span className="text-xs font-normal text-slate-400"> / {dim.max}</span></span></div><ProgressBar value={Math.round((dim.score / dim.max) * 100)} /><div className="mt-2 space-y-1.5">{dim.items.map((it) => <div key={it.name} className="border-t border-slate-50 pt-1.5 text-xs"><span className="font-medium text-slate-600">{it.name}</span><span className="ml-1 text-slate-400">{it.score}/{it.max}</span><p className="mt-0.5 leading-5 text-slate-400">{it.reason}</p></div>)}</div></Card>)}</div>
        {hasVerifiedCompetitor && <Card className="p-4"><h4 className="mb-2 text-sm font-semibold text-slate-800">有证据的直接竞对 / 替代方案</h4><div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full text-xs"><thead><tr className="bg-slate-50 text-slate-500"><th className="p-2 text-left font-medium">公司</th><th className="p-2 text-left font-medium">可比依据</th><th className="p-2 text-left font-medium">技术路线</th><th className="p-2 text-left font-medium">产品/阶段</th><th className="p-2 text-left font-medium">证据来源</th></tr></thead><tbody>{verifiedCompetitors.map((c, ci) => <tr key={`${c.name}-${ci}`} className={`border-t border-slate-100 ${c.is_self ? 'bg-brand-50/50' : ''}`}><td className="p-2 align-top font-medium text-slate-700">{c.is_self && <span className="mr-1 rounded bg-brand-600 px-1 py-0.5 text-[9px] text-white">本项目</span>}{c.name}</td><td className="p-2 align-top leading-5 text-slate-500">{c.comparisonBasis || c.differentiation}</td><td className="p-2 align-top leading-5 text-slate-500">{c.tech}</td><td className="p-2 align-top leading-5 text-slate-500">{c.product}</td><td className="p-2 align-top leading-5 text-slate-500">{c.sourceUrl ? <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">{c.sourceRef || '查看来源'}</a> : c.sourceRef}</td></tr>)}</tbody></table></div></Card>}
      </div>
    )
  }

  const renderMaterials = () => <Card className="overflow-hidden"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="font-semibold text-slate-800">上会材料</h2><p className="mt-1 text-xs text-slate-400">每次生成形成独立版本并记录资料范围</p></div><Button onClick={() => navigate(`/materials?project=${project.id}`)}><Plus className="h-4 w-4" />生成材料</Button></div><DataTable headers={['材料名称', '模板', '版本', '状态', '生成人', '时间', '']}>{projectMaterials.map((job) => <tr key={job.id}><TableCell><span className="font-medium text-slate-700">{job.type}</span></TableCell><TableCell>{job.template}</TableCell><TableCell>{job.version}</TableCell><TableCell><StatusBadge status={job.status} /></TableCell><TableCell>{job.createdBy}</TableCell><TableCell>{job.createdAt.slice(5)}</TableCell><TableCell><Button size="sm" variant="secondary" onClick={() => job.outputUrl ? window.open(job.outputUrl, '_blank') : showToast('文件仍在生成中', 'info')}><Download className="h-3.5 w-3.5" />下载</Button></TableCell></tr>)}</DataTable>{!projectMaterials.length && <div className="p-10 text-center text-sm text-slate-400">暂无生成记录</div>}</Card>

  const renderMeetings = () => <div className="space-y-4">{projectMeetings.length ? projectMeetings.map((meeting) => <Card key={meeting.id} className="p-5"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><h3 className="font-semibold text-slate-800">{meeting.title}</h3><StatusBadge status={meeting.status} /></div><p className="mt-2 text-xs text-slate-400">{meeting.meetingTime} · {meeting.type} · {meeting.participants.join('、')}</p></div><button onClick={() => navigate(`/meetings?meeting=${meeting.id}`)} className="text-xs text-brand-600">查看完整纪要</button></div><p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-600">{meeting.summary}</p><div className="mt-4 flex items-center gap-5 text-xs text-slate-500"><span>{meeting.conclusions.length} 条关键结论</span><span>{meeting.todoCount} 项待办</span></div></Card>) : <Card className="p-12 text-center text-sm text-slate-400">暂无关联会议</Card>}<Button onClick={() => navigate(`/meetings?project=${project.id}`)}><Plus className="h-4 w-4" />新建会议</Button></div>

  const renderWorkflow = () => <div className="space-y-5"><Card className="p-5"><div className="flex items-center justify-between"><div><h2 className="font-semibold text-slate-800">OA 审批实例</h2><p className="mt-1 text-xs text-slate-400">项目阶段不可直接编辑，只由最终通过的 OA 同步</p></div><Button onClick={() => navigate(`/workflow?project=${project.id}`)}><Plus className="h-4 w-4" />发起 OA</Button></div><div className="mt-4 space-y-3">{projectApprovals.map((request) => <button key={request.id} onClick={() => navigate(`/workflow?project=${project.id}&request=${request.id}`)} className="grid w-full grid-cols-[1fr_160px_150px] items-center rounded-xl border border-slate-200 p-4 text-left hover:border-brand-200"><div><div className="flex items-center gap-2"><p className="font-medium text-slate-700">{request.title}</p><Badge tone={request.status === '已通过' ? 'green' : request.status === '审批中' ? 'blue' : request.status === '已退回' ? 'amber' : 'red'}>{request.status}</Badge></div><p className="mt-1 text-xs text-slate-400">{request.requestNo} · {request.submittedAt}</p></div><div className="flex items-center gap-1"><StageBadge stage={request.fromStage} /><span>→</span><StageBadge stage={request.targetStage} /></div><p className="text-right text-xs text-slate-500">{request.currentNodeName}</p></button>)}{!projectApprovals.length && <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-400">暂无 OA 审批实例</p>}</div></Card><Card className="p-6"><h2 className="mb-6 font-semibold text-slate-800">已生效阶段时间线</h2><div className="relative ml-2 border-l border-slate-200 pl-7">{projectWorkflows.map((log, index) => <div key={log.id} className="relative pb-8 last:pb-0"><span className={`absolute -left-[34px] top-0 grid h-3.5 w-3.5 place-items-center rounded-full ring-4 ring-white ${index === 0 ? 'bg-brand-600' : 'bg-slate-300'}`} /><div className="flex items-center gap-2"><StageBadge stage={log.fromStage} /><span className="text-slate-300">→</span><StageBadge stage={log.toStage} /><Badge tone="green">{log.source ?? '系统记录'}</Badge><span className="ml-auto text-xs text-slate-400">{log.createdAt}</span></div><p className="mt-2 text-sm text-slate-600">{log.comment}</p><p className="mt-1 text-xs text-slate-400">操作人：{log.operator}{log.requestNo ? ` · ${log.requestNo}` : ''}</p></div>)}</div></Card></div>

  const renderRisks = () => <div className="space-y-4">{projectRisks.length ? projectRisks.map((risk) => <Card key={risk.id} className="p-5"><div className="flex items-start justify-between"><div className="flex items-center gap-2"><RiskBadge level={risk.level} /><Badge>{risk.type}</Badge><StatusBadge status={risk.status} /></div><span className="text-xs text-slate-400">{risk.occurredAt}</span></div><p className="mt-4 text-sm leading-6 text-slate-700">{risk.description}</p><div className="mt-4 rounded-lg bg-brand-50 p-3"><p className="text-xs font-medium text-brand-700">AI 处置建议</p><p className="mt-1 text-xs leading-5 text-brand-700/80">{risk.suggestion}</p></div></Card>) : <Card className="p-12 text-center text-sm text-slate-400">暂无风险记录</Card>}<Button onClick={() => navigate(`/risks?project=${project.id}`)}><Plus className="h-4 w-4" />新增风险</Button></div>

  const renderPost = () => <div className="space-y-4">{project.stage !== '投后' && <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-700">当前项目尚未进入投后阶段。你仍可以提前归档经营资料和董事会文件。</div>}{projectPosts.map((update) => <Card key={update.id} className="p-5"><div className="flex items-center justify-between"><h3 className="font-semibold text-slate-800">{update.period} 经营更新</h3><span className="text-xs text-slate-400">{update.updatedAt}</span></div><div className="mt-5 grid grid-cols-3 gap-4">{[['营业收入', update.revenue], ['综合毛利率', update.grossMargin], ['经营现金流', update.cashFlow]].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-400">{label}</p><p className="mt-1 text-sm font-semibold text-slate-700">{value}</p></div>)}</div><p className="mt-4 text-sm text-slate-600">{update.milestone}</p></Card>)}{!projectPosts.length && <Card className="p-12 text-center text-sm text-slate-400">暂无投后更新记录</Card>}</div>

  const tabContent: Record<string, () => React.ReactNode> = { overview: renderOverview, intelligence: renderIntelligence, files: renderFiles, summary: renderSummary, materials: renderMaterials, meetings: renderMeetings, workflow: renderWorkflow, risks: renderRisks, post: renderPost }

  return (
    <div>
      <button onClick={() => navigate('/projects')} className="mb-4 flex items-center gap-1 text-xs text-slate-500 hover:text-brand-600"><ArrowLeft className="h-3.5 w-3.5" />返回项目列表</button>
      <Card className="mb-5 overflow-hidden">
        <div className="flex items-center gap-5 px-6 py-5">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-brand-50 text-sm font-semibold text-brand-700">{project.name.slice(0, 2)}</div>
          <div className="min-w-0 flex-1"><div className="flex items-center gap-3"><h1 className="text-xl font-semibold text-ink">{project.name}</h1><StageBadge stage={project.stage} /><RiskBadge level={project.riskLevel} /></div><p className="mt-1.5 text-sm text-slate-500">{project.companyName} · {project.industry} · {project.round}</p><p className="mt-1 text-[10px] text-slate-400">阶段来源：{project.stageSource ?? '历史数据'}{projectApprovals.some((item) => item.status === '审批中') ? ' · OA 审批中，当前阶段已锁定' : ''}</p></div>
          <div className="flex items-center gap-5 border-r border-slate-200 pr-5 text-xs"><div><p className="text-slate-400">负责人</p><p className="mt-1 font-medium text-slate-700">{project.owner}</p></div><div><p className="text-slate-400">最近更新</p><p className="mt-1 font-medium text-slate-700">{project.updatedAt.slice(5)}</p></div></div>
          <div className="flex items-center gap-2"><Button variant="secondary" onClick={() => setShowUpload(true)}><Upload className="h-4 w-4" />上传资料</Button><Button loading={generating} onClick={generateSummary}><Sparkles className="h-4 w-4" />生成摘要</Button></div>
        </div>
        <div className="px-4"><Tabs tabs={tabItems.map((tab) => ({ ...tab, count: tab.id === 'files' ? projectFiles.length : tab.id === 'materials' ? projectMaterials.length : tab.id === 'meetings' ? projectMeetings.length : tab.id === 'risks' ? projectRisks.length : undefined }))} value={activeTab} onChange={setActiveTab} /></div>
      </Card>
      {tabContent[activeTab]?.()}

      <Modal open={showUpload} onClose={() => { setUploading(null); setShowUpload(false) }} title="上传项目资料">
        <FileUpload onFiles={handleUploadFiles} multiple />
        {uploading && <div className="mt-4 rounded-xl border border-slate-200 p-4"><div className="flex items-center justify-between text-sm"><span className="font-medium text-slate-700">{uploading.name}</span><span className="text-brand-600">{uploading.total && uploading.total > 1 ? `${uploading.done ?? 0}/${uploading.total}` : `${uploading.progress}%`}</span></div><div className="mt-3"><ProgressBar value={uploading.progress} /></div><p className="mt-2 text-xs text-slate-400">{uploading.total && uploading.total > 1 ? `正在批量上传并解析…（${uploading.done ?? 0}/${uploading.total}）` : (uploading.progress < 100 ? '正在安全上传…' : '上传完成，正在提取文本并写入知识库…')}</p></div>}
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">上传即表示该资料允许在当前项目范围内被 AI 检索。敏感财务与协议文件可在上传后调整可见范围。</div>
      </Modal>

      <Modal open={!!editingProject} onClose={() => setEditingProject(null)} title="编辑项目档案" width="max-w-3xl" footer={<><Button variant="secondary" onClick={() => setEditingProject(null)}>取消</Button><Button onClick={() => { if (!editingProject) return; updateProject(editingProject.id, editingProject); setEditingProject(null); showToast('项目档案已更新，项目阶段未发生变化') }}>保存修改</Button></>}>
        {editingProject && <div className="grid grid-cols-2 gap-4">
          <label><span className="label">项目名称</span><input className="input" value={editingProject.name} onChange={(event) => setEditingProject({ ...editingProject, name: event.target.value })} /></label>
          <label><span className="label">公司主体</span><input className="input" value={editingProject.companyName} onChange={(event) => setEditingProject({ ...editingProject, companyName: event.target.value })} /></label>
          <label><span className="label">所属行业</span><input className="input" value={editingProject.industry} onChange={(event) => setEditingProject({ ...editingProject, industry: event.target.value })} /></label>
          <label><span className="label">融资轮次</span><input className="input" value={editingProject.round} onChange={(event) => setEditingProject({ ...editingProject, round: event.target.value })} /></label>
          <label><span className="label">计划融资</span><input className="input" value={editingProject.financing} onChange={(event) => setEditingProject({ ...editingProject, financing: event.target.value })} /></label>
          <label><span className="label">投前估值</span><input className="input" value={editingProject.valuation} onChange={(event) => setEditingProject({ ...editingProject, valuation: event.target.value })} /></label>
          <label><span className="label">风险等级</span><select className="input" value={editingProject.riskLevel} onChange={(event) => setEditingProject({ ...editingProject, riskLevel: event.target.value as RiskLevel })}><option>低</option><option>中</option><option>高</option></select></label>
          <label><span className="label">项目标签</span><input className="input" value={editingProject.tags.join('、')} onChange={(event) => setEditingProject({ ...editingProject, tags: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })} /></label>
          <label className="col-span-2"><span className="label">项目简介</span><textarea className="textarea min-h-24" value={editingProject.summary} onChange={(event) => setEditingProject({ ...editingProject, summary: event.target.value })} /></label>
          <p className="col-span-2 rounded-lg bg-blue-50 p-3 text-xs text-blue-700">项目阶段在此不可编辑；如需推进或终止，请从 OA 项目流程发起申请。</p>
        </div>}
      </Modal>
    </div>
  )
}
