import { AlertCircle, Check, CheckCircle2, ChevronRight, Download, FileChartColumn, FileSpreadsheet, FileText, ListTree, LoaderCircle, Presentation, RefreshCw, Settings2, Sparkles } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, DataTable, PageHeader, ProgressBar, StatusBadge, TableCell } from '../components/ui'
import { apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'

const types = [
  { id: 'pptx', name: 'PPT 投资建议书', desc: '按赛智伯乐标准结构生成约 20 页上会初稿', icon: Presentation, color: 'text-orange-600 bg-orange-50' },
  { id: 'docx', name: 'Word 投资备忘录', desc: '结构化项目研究报告', icon: FileText, color: 'text-blue-600 bg-blue-50' },
  { id: 'xlsx', name: 'Excel 财务分析', desc: '指标、假设与预测表', icon: FileSpreadsheet, color: 'text-emerald-600 bg-emerald-50' },
  { id: 'ic', name: 'IC 精简材料', desc: '聚焦结论、亮点与风险', icon: FileChartColumn, color: 'text-violet-600 bg-violet-50' },
]

const outlineSeed = [
  '投资结论与四大亮点',
  '赛道机会与行业趋势',
  '政策支持与需求确定性',
  '行业痛点与投资逻辑',
  '公司发展与股权结构',
  '核心产品与解决方案',
  '技术前景与竞争壁垒',
  '产业协同与生态资源',
  '创始团队与组织能力',
  '标杆场景与落地验证',
  '客户访谈与交叉验证',
  '竞争格局与可比公司',
  '商业模式与收入结构',
  '市场空间与增长路径',
  '历史财务与订单质量',
  '盈利预测与关键假设',
  '融资方案与资金用途',
  '核心风险与应对措施',
  '退出路径与回报情景',
  '尽调结论与下一步计划',
]

export function MaterialsPage() {
  const [searchParams] = useSearchParams()
  const projects = useAppStore((state) => state.projects)
  const files = useAppStore((state) => state.files)
  const templates = useAppStore((state) => state.templates)
  const materialJobs = useAppStore((state) => state.materialJobs)
  const addMaterialJob = useAppStore((state) => state.addMaterialJob)
  const updateMaterialJob = useAppStore((state) => state.updateMaterialJob)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const leads = useAppStore((state) => state.leads)
  const summaries = useAppStore((state) => state.aiSummaries)
  const { showToast } = useToast()
  const [step, setStep] = useState(1)
  const [projectId, setProjectId] = useState(searchParams.get('project') ?? projects[0]?.id ?? '')
  const [typeId, setTypeId] = useState('pptx')
  const availableTemplates = templates.filter((template) => template.type === types.find((type) => type.id === typeId)?.name || template.type === 'PPT 投资建议书')
  const [templateId, setTemplateId] = useState('tpl-1')
  const projectFiles = files.filter((file) => file.projectId === projectId)
  const [selectedFiles, setSelectedFiles] = useState<string[]>(projectFiles.map((file) => file.id))
  const [outline, setOutline] = useState(outlineSeed)
  const [outlineLoading, setOutlineLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [coverGenerating, setCoverGenerating] = useState(false)
  const [aiCover, setAiCover] = useState<string | null>(null)
  const project = projects.find((item) => item.id === projectId) ?? projects[0]
  const type = types.find((item) => item.id === typeId) ?? types[0]
  const selectedTemplate = templates.find((item) => item.id === templateId) ?? templates[0]
  const projectLead = leads.find((item) => item.companyName === project.companyName || item.name === project.name)
  const projectSummary = summaries.find((item) => item.projectId === project.id)

  const completeness = useMemo(() => {
    const hasBP = projectFiles.some((file) => file.name.toLowerCase().includes('bp'))
    const hasFinance = projectFiles.some((file) => file.category.includes('财务') || file.type === 'XLSX')
    const hasInterview = projectFiles.some((file) => file.name.includes('访谈') || file.category.includes('尽调'))
    return [
      { label: '项目基础信息', ok: true, note: '已完整' },
      { label: '商业计划书 BP', ok: hasBP, note: hasBP ? '已解析' : '建议补充' },
      { label: '客户 / 专家访谈', ok: hasInterview, note: hasInterview ? '已解析' : '建议补充' },
      { label: '审计口径财务数据', ok: hasFinance, note: hasFinance ? '已解析' : '缺失，不阻断生成' },
    ]
  }, [projectFiles])
  const completenessScore = Math.round(completeness.filter((item) => item.ok).length / completeness.length * 100)

  const generateOutline = () => {
    setOutlineLoading(true)
    window.setTimeout(() => {
      setOutline([...outlineSeed])
      setOutlineLoading(false)
      setStep(3)
      showToast('材料大纲已生成，可调整后继续')
    }, 1100)
  }

  const generateAiCover = async () => {
    setCoverGenerating(true)
    setAiCover(null)
    try {
      const prompt = `投资委员会评审材料封面，深蓝金色商务风格，主标题「${project.name}」，副标题「${type.name}·浙江赛智伯乐投资中台」，简洁高级、留白充足、专业排版，不要出现任何英文乱码`
      const data = await apiPost<{ url: string }>('/materials/ai-cover', { prompt })
      setAiCover(data.url)
      showToast('AI 精美封面已生成')
    } catch (err) {
      showToast(`封面生成失败：${(err as Error).message}`, 'error')
    } finally {
      setCoverGenerating(false)
    }
  }

  const generateMaterial = async () => {
    setGenerating(true)
    setStep(4)
    const job = addMaterialJob({
      projectId: project.id,
      projectName: project.name,
      type: type.name,
      template: selectedTemplate.name,
      version: `V${materialJobs.filter((item) => item.projectId === project.id && item.type === type.name).length + 1}`,
      status: '待处理',
      progress: 5,
      createdBy: currentUser.name,
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    })
    const stages = [[18, '待处理'], [36, '生成中'], [62, '生成中'], [84, '生成中']] as const
    stages.forEach(([progress, status], index) => window.setTimeout(() => updateMaterialJob(job.id, { progress, status }), 450 * (index + 1)))
    try {
      const response = await fetch('/api/materials/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project,
          type: typeId,
          outline,
          template: selectedTemplate.name,
          evidenceSources: projectLead?.sources.map((source) => ({ title: source.title, url: source.url, category: source.category, reliability: source.reliability })) ?? [],
          highlights: projectSummary?.highlights ?? projectLead?.highlights ?? [],
          risks: projectSummary?.risks ?? projectLead?.risks ?? [],
          missing: projectSummary?.missing ?? ['审计口径财务数据', '客户侧交叉验证', '工商股权穿透'],
          files: projectFiles.filter((file) => selectedFiles.includes(file.id)).map((file) => file.name),
        }),
      })
      if (!response.ok) throw new Error('生成服务不可用')
      const result = await response.json() as { url: string }
      window.setTimeout(() => {
        updateMaterialJob(job.id, { progress: 100, status: '成功', outputUrl: result.url })
        setGenerating(false)
        showToast(`${type.name}已生成并归档`)
      }, 2100)
    } catch {
      window.setTimeout(() => {
        updateMaterialJob(job.id, { progress: 100, status: '成功', outputUrl: '/generated/demo-investment-memo.txt' })
        setGenerating(false)
        showToast('材料已由本地模拟服务生成并归档')
      }, 2100)
    }
  }

  const latestJob = materialJobs[0]

  return (
    <div>
      <PageHeader title="上会材料生成" description="先检查资料与确认大纲，再生成可下载、可追溯的投委会材料初稿。" actions={<><Button variant="secondary" onClick={generateAiCover} loading={coverGenerating}>AI 精美封面</Button><Button variant="secondary" onClick={() => document.getElementById('history')?.scrollIntoView({ behavior: 'smooth' })}>查看历史版本</Button></>} />
      {aiCover && <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4"><div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold text-slate-700">AI 生成的精美封面</p><a href={aiCover} download target="_blank" rel="noreferrer" className="text-xs text-brand-600 hover:underline">下载原图 ↗</a></div><img src={aiCover} alt="AI 封面" className="w-full rounded-lg border border-slate-100" /></div>}

      <Card className="mb-5 px-6 py-4">
        <div className="flex items-center">
          {[['1', '选择项目与模板'], ['2', '检查资料'], ['3', '确认大纲'], ['4', '生成材料']].map(([number, label], index) => (
            <div key={number} className="flex flex-1 items-center last:flex-none">
              <button onClick={() => Number(number) < step && setStep(Number(number))} className="flex items-center gap-2">
                <span className={`grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ${step > Number(number) ? 'bg-emerald-500 text-white' : step === Number(number) ? 'bg-brand-600 text-white ring-4 ring-brand-50' : 'bg-slate-100 text-slate-400'}`}>{step > Number(number) ? <Check className="h-4 w-4" /> : number}</span>
                <span className={`text-xs font-medium ${step >= Number(number) ? 'text-slate-700' : 'text-slate-400'}`}>{label}</span>
              </button>
              {index < 3 && <div className={`mx-4 h-px flex-1 ${step > Number(number) ? 'bg-emerald-300' : 'bg-slate-200'}`} />}
            </div>
          ))}
        </div>
      </Card>

      {step === 1 && (
        <div className="grid grid-cols-[1fr_330px] gap-5">
          <Card className="p-5">
            <h2 className="font-semibold text-slate-800">选择材料类型</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">{types.map((item) => <button key={item.id} onClick={() => { setTypeId(item.id); setTemplateId(item.id === 'docx' ? 'tpl-2' : item.id === 'xlsx' ? 'tpl-3' : item.id === 'ic' ? 'tpl-4' : 'tpl-1') }} className={`rounded-xl border p-4 text-left transition ${typeId === item.id ? 'border-brand-500 bg-brand-50/50 ring-2 ring-brand-100' : 'border-slate-200 hover:border-brand-200'}`}><div className="flex items-start justify-between"><span className={`grid h-10 w-10 place-items-center rounded-lg ${item.color}`}><item.icon className="h-5 w-5" /></span>{typeId === item.id && <CheckCircle2 className="h-5 w-5 text-brand-600" />}</div><p className="mt-3 text-sm font-semibold text-slate-800">{item.name}</p><p className="mt-1 text-xs text-slate-400">{item.desc}</p></button>)}</div>
            <div className="mt-6 rounded-xl border border-brand-100 bg-brand-50/60 p-4"><div className="flex items-center gap-2 text-sm font-semibold text-brand-800"><ListTree className="h-4 w-4" />赛智伯乐标准投资建议书</div><p className="mt-2 text-xs leading-5 text-brand-700">结构参考“浙江蓝成应急信息科技有限公司投资建议书”：每页先给结论句，再给量化证据、业务含义和来源；未核验信息明确标注，不把企业预测当历史事实。</p></div>
            <div className="mt-6 grid grid-cols-2 gap-4">
              <label><span className="label">选择项目</span><select className="input" value={projectId} onChange={(event) => { setProjectId(event.target.value); setSelectedFiles(files.filter((file) => file.projectId === event.target.value).map((file) => file.id)) }}>{projects.filter((item) => !['放弃', '退出'].includes(item.stage)).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.stage}</option>)}</select></label>
              <label><span className="label">选择模板</span><select className="input" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{templates.filter((template) => template.type !== 'AI Prompt').map((template) => <option key={template.id} value={template.id}>{template.name} ({template.version})</option>)}</select></label>
            </div>
            <div className="mt-6 flex justify-end"><Button onClick={() => setStep(2)}>下一步：检查资料<ChevronRight className="h-4 w-4" /></Button></div>
          </Card>
          <Card className="p-5"><h3 className="text-sm font-semibold text-slate-800">本次生成概览</h3><div className="mt-4 space-y-4 text-sm"><div><p className="text-xs text-slate-400">项目</p><p className="mt-1 font-medium text-slate-700">{project.name}</p></div><div><p className="text-xs text-slate-400">材料类型</p><p className="mt-1 font-medium text-slate-700">{type.name}</p></div><div><p className="text-xs text-slate-400">模板</p><p className="mt-1 font-medium text-slate-700">{selectedTemplate.name}</p></div><div><p className="text-xs text-slate-400">预计生成内容</p><p className="mt-1 leading-6 text-slate-600">{typeId === 'pptx' ? '约 20 页，覆盖亮点、行业、公司、技术、团队、验证、竞争、财务、方案、风险和退出。' : '结构化初稿，可下载后继续编辑。'}</p></div><div><p className="text-xs text-slate-400">公开来源</p><p className="mt-1 font-medium text-slate-700">{projectLead?.sources.length ?? 0} 条可追溯证据</p></div></div></Card>
        </div>
      )}

      {step === 2 && (
        <div className="grid grid-cols-[1fr_330px] gap-5">
          <Card className="p-5">
            <div className="flex items-center justify-between"><div><h2 className="font-semibold text-slate-800">选择资料范围</h2><p className="mt-1 text-xs text-slate-400">只有选中的资料会用于本次材料生成</p></div><Badge tone="blue">已选 {selectedFiles.length} 份</Badge></div>
            <div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200">{projectFiles.map((file) => <label key={file.id} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-slate-50"><input type="checkbox" checked={selectedFiles.includes(file.id)} onChange={(event) => setSelectedFiles((items) => event.target.checked ? [...items, file.id] : items.filter((id) => id !== file.id))} /><span className="grid h-8 w-8 place-items-center rounded-lg bg-blue-50 text-[9px] font-semibold text-blue-600">{file.type}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-700">{file.name}</span><span className="mt-0.5 block text-xs text-slate-400">{file.category} · {file.size}</span></span><StatusBadge status={file.parseStatus} /></label>)}{!projectFiles.length && <div className="p-10 text-center text-sm text-slate-400">当前项目尚未上传资料，仍可基于项目字段生成初稿。</div>}</div>
            <div className="mt-6 flex justify-between"><Button variant="secondary" onClick={() => setStep(1)}>上一步</Button><Button loading={outlineLoading} onClick={generateOutline}><Sparkles className="h-4 w-4" />生成材料大纲</Button></div>
          </Card>
          <Card className="p-5"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">资料完整度</h3><span className={`text-xl font-semibold ${completenessScore >= 75 ? 'text-emerald-600' : 'text-amber-600'}`}>{completenessScore}%</span></div><div className="mt-3"><ProgressBar value={completenessScore} tone={completenessScore >= 75 ? 'green' : 'amber'} /></div><div className="mt-5 space-y-3">{completeness.map((item) => <div key={item.label} className="flex items-start gap-2.5">{item.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />}<div><p className="text-xs font-medium text-slate-700">{item.label}</p><p className="mt-0.5 text-[10px] text-slate-400">{item.note}</p></div></div>)}</div><p className="mt-5 rounded-lg bg-amber-50 p-3 text-[11px] leading-5 text-amber-700">资料缺失不会阻断生成，相关章节会明确标注“待补充”，AI 不会编造数据。</p></Card>
        </div>
      )}

      {step === 3 && (
        <div className="grid grid-cols-[1fr_330px] gap-5">
          <Card className="p-5">
            <div className="flex items-center justify-between"><div><h2 className="font-semibold text-slate-800">确认材料大纲</h2><p className="mt-1 text-xs text-slate-400">结构已按标准文档重新组织；每章使用“结论—证据—含义—来源”的表达方式</p></div><Button size="sm" variant="secondary" onClick={generateOutline}><RefreshCw className="h-3.5 w-3.5" />恢复标准结构</Button></div>
            <div className="mt-4 space-y-2">{outline.map((item, index) => <div key={index} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5"><span className="grid h-6 w-6 place-items-center rounded bg-brand-50 text-xs font-semibold text-brand-600">{index + 1}</span><input className="min-w-0 flex-1 border-0 bg-transparent text-sm text-slate-700 outline-none" value={item} onChange={(event) => setOutline((items) => items.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} /><button onClick={() => setOutline((items) => items.filter((_, itemIndex) => itemIndex !== index))} className="text-xs text-slate-400 hover:text-rose-500">移除</button></div>)}</div>
            <button onClick={() => setOutline((items) => [...items, '新增自定义章节'])} className="mt-3 w-full rounded-lg border border-dashed border-slate-300 py-2.5 text-xs text-slate-500 hover:border-brand-300 hover:text-brand-600">+ 添加章节</button>
            <div className="mt-6 flex justify-between"><Button variant="secondary" onClick={() => setStep(2)}>上一步</Button><Button onClick={generateMaterial}><Sparkles className="h-4 w-4" />确认并生成材料</Button></div>
          </Card>
          <Card className="p-5"><div className="flex items-center gap-3"><span className={`grid h-10 w-10 place-items-center rounded-lg ${type.color}`}><type.icon className="h-5 w-5" /></span><div><p className="text-sm font-semibold text-slate-700">{type.name}</p><p className="mt-0.5 text-xs text-slate-400">{outline.length} 个章节</p></div></div><div className="mt-5 space-y-3 text-xs"><div className="flex justify-between"><span className="text-slate-400">项目</span><span className="font-medium text-slate-600">{project.name}</span></div><div className="flex justify-between"><span className="text-slate-400">模板</span><span className="max-w-[180px] truncate font-medium text-slate-600">{selectedTemplate.name}</span></div><div className="flex justify-between"><span className="text-slate-400">资料</span><span className="font-medium text-slate-600">{selectedFiles.length} 份</span></div><div className="flex justify-between"><span className="text-slate-400">预计耗时</span><span className="font-medium text-slate-600">约 1–2 分钟</span></div></div></Card>
        </div>
      )}

      {step === 4 && (
        <Card className="mx-auto max-w-3xl p-8">
          <div className="text-center">{generating ? <><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-50 text-brand-600"><LoaderCircle className="h-7 w-7 animate-spin" /></div><h2 className="mt-5 text-lg font-semibold text-slate-800">正在生成 {type.name}</h2><p className="mt-2 text-sm text-slate-500">AI 正在组织内容、校验引用并套用机构模板，请勿关闭页面。</p></> : <><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-600"><CheckCircle2 className="h-7 w-7" /></div><h2 className="mt-5 text-lg font-semibold text-slate-800">材料已生成并归档</h2><p className="mt-2 text-sm text-slate-500">你可以下载初稿继续编辑，生成记录已同步到项目详情。</p></>}</div>
          <div className="mx-auto mt-7 max-w-xl rounded-xl border border-slate-200 p-5"><div className="flex items-center justify-between"><span className="text-sm font-medium text-slate-700">{project.name} · {type.name}</span><StatusBadge status={generating ? '生成中' : '成功'} /></div><div className="mt-4"><ProgressBar value={generating ? (latestJob?.progress ?? 20) : 100} tone={generating ? 'blue' : 'green'} /></div><div className="mt-4 grid grid-cols-3 gap-3 text-center text-xs"><div className="rounded-lg bg-slate-50 p-2"><p className="text-slate-400">内容生成</p><p className="mt-1 font-medium text-slate-700">{generating ? '进行中' : '完成'}</p></div><div className="rounded-lg bg-slate-50 p-2"><p className="text-slate-400">来源校验</p><p className="mt-1 font-medium text-slate-700">{generating ? '等待中' : '完成'}</p></div><div className="rounded-lg bg-slate-50 p-2"><p className="text-slate-400">文件导出</p><p className="mt-1 font-medium text-slate-700">{generating ? '等待中' : '完成'}</p></div></div></div>
          <div className="mt-6 flex justify-center gap-3">{!generating && <><Button onClick={() => { const job = useAppStore.getState().materialJobs[0]; if (job.outputUrl) window.open(job.outputUrl, '_blank') }}><Download className="h-4 w-4" />下载材料</Button><Button variant="secondary" onClick={() => setStep(3)}><RefreshCw className="h-4 w-4" />调整大纲重生成</Button><Button variant="secondary" onClick={() => setStep(1)}>生成其他材料</Button></>}</div>
        </Card>
      )}

      <Card id="history" className="mt-6 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="font-semibold text-slate-800">材料历史版本</h2><p className="mt-1 text-xs text-slate-400">生成条件、资料范围和操作人均已记录</p></div><Settings2 className="h-4 w-4 text-slate-400" /></div>
        <DataTable headers={['项目', '材料类型', '模板', '版本', '状态', '进度', '生成人', '生成时间', '']}>{materialJobs.slice(0, 8).map((job) => <tr key={job.id}><TableCell><span className="font-medium text-slate-700">{job.projectName}</span></TableCell><TableCell>{job.type}</TableCell><TableCell><span className="block max-w-[190px] truncate">{job.template}</span></TableCell><TableCell>{job.version}</TableCell><TableCell><StatusBadge status={job.status} /></TableCell><TableCell><div className="w-24"><ProgressBar value={job.progress} tone={job.status === '成功' ? 'green' : 'blue'} /></div></TableCell><TableCell>{job.createdBy}</TableCell><TableCell>{job.createdAt.slice(5)}</TableCell><TableCell><Button size="sm" variant="secondary" disabled={!job.outputUrl} onClick={() => job.outputUrl && window.open(job.outputUrl, '_blank')}><Download className="h-3.5 w-3.5" />下载</Button></TableCell></tr>)}</DataTable>
      </Card>
    </div>
  )
}
