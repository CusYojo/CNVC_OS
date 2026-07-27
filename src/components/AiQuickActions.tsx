import { useMemo, useState } from 'react'
import {
  BriefcaseBusiness,
  CheckCircle2,
  ClipboardCheck,
  FileCheck2,
  FileUp,
  HelpCircle,
  LoaderCircle,
  Presentation,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import { apiPost } from '../lib/api'
import type { Project } from '../types'
import { Button, Modal } from './ui'

export type AiDocumentActionId = 'compliance' | 'proposal' | 'investment_ppt' | 'due_diligence' | 'qa'
export type AiQuickActionId = AiDocumentActionId | 'custom_template'

type CustomTemplateAnalysis = {
  format: 'docx' | 'pptx'
  fileName: string
  formatProfile: {
    fonts: string[]
    primaryFont: string
    headingFont: string
    titleSizePt: number | null
    headingSizePt: number | null
    bodySizePt: number | null
    lineSpacing: string
    paragraphSpacing: string
    alignment: string[]
    pageSize: string
    margins: string
    orientation: string
    colors: string[]
    header: string
    footer: string
    hasPageNumbers: boolean
    tableCount: number
    imageCount: number
  }
  structures: Array<{
    order: number
    title: string
    level: number
    contentPurpose: string
    contentSummary: string
    contentRequirements: string[]
  }>
  summary: string
}

type AnalyzedCustomTemplate = {
  id: string
  projectId: string
  conversationId?: string | null
  originalFileName: string
  format: 'docx' | 'pptx'
  fileSize: number
  sha256: string
  analysis: CustomTemplateAnalysis
  analysisVersion?: string
  status: string
}

export type AiQuickTaskRequest = {
  actionId: AiQuickActionId
  actionLabel: string
  projectId: string
  projectName: string
  sourceCutoffDate: string
  audience?: string
  length?: string
  userInstructions?: string
  template?: string
  pageCount?: string
  language?: string
  diligenceScope?: string
  qaMode?: string
  questionDepth?: string
  customTemplateId?: string
  customTemplateName?: string
  outputFormat: 'DOCX' | 'PPTX' | 'PDF'
}

type ActionConfig = {
  id: AiQuickActionId
  label: string
  description: string
  mode: 'task' | 'template'
  icon: typeof ShieldCheck
}

const ACTIONS: ActionConfig[] = [
  { id: 'compliance', label: '合规性说明', description: '结合项目资料与联网公开证据生成合规初稿', mode: 'task', icon: ShieldCheck },
  { id: 'proposal', label: '投资提案', description: '按核心规范生成内部立项或投委会材料', mode: 'task', icon: BriefcaseBusiness },
  { id: 'investment_ppt', label: '投资建议书（PPT）', description: '生成公司模板投资建议书', mode: 'task', icon: Presentation },
  { id: 'due_diligence', label: '尽调报告', description: '结合项目资料与联网公开信息形成完整分析', mode: 'task', icon: ClipboardCheck },
  { id: 'qa', label: 'Q&A', description: '结合项目资料与联网公开信息生成投资委员会或尽调 Q&A，并输出 PDF', mode: 'task', icon: HelpCircle },
  { id: 'custom_template', label: '上传模板', description: '识别模板结构和内容要求', mode: 'template', icon: Upload },
]

const today = () => new Date().toISOString().slice(0, 10)
const MAX_TEMPLATE_BYTES = 25 * 1024 * 1024

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取模板失败'))
    reader.readAsDataURL(file)
  })
}

export function buildAiQuickTaskPrompt(request: AiQuickTaskRequest): string {
  const common = [
    `【快捷任务】${request.actionLabel}`,
    `【资料截止日】${request.sourceCutoffDate}`,
    `【输出格式】${request.outputFormat}`,
  ]
  if (request.actionId === 'compliance') {
    return [
      ...common,
      ...(request.userInstructions?.trim() ? [`【用户补充输入】${request.userInstructions.trim()}`] : []),
      '请先检索工商、官网、团队、产品、融资、诉讼处罚、行业政策及通用基金监管公开信息，再与当前项目资料共同建立逐章证据。',
      '联网公开信息只作为待核验线索并保留网址、发布日期与访问日期；基金合伙协议、返投台账、关联关系声明及交易方案等非公开材料不得由网络信息替代。',
      '正文严格遵循合规性说明核心规范，不增加执行摘要、风险提示、资料缺口、免责声明或引用资料等正文板块。',
    ].join('\n')
  }
  if (request.actionId === 'proposal') {
    return [
      ...common,
      `【目标受众】${request.audience || '内部立项'}`,
      `【篇幅】${request.length || '标准版'}`,
      ...(request.userInstructions?.trim() ? [`【用户补充输入】${request.userInstructions.trim()}`] : []),
      '请读取投资提案核心规范及 docs/投资提案 模板共性，按标准 17 节结构、投委会书面语、原生财务/交易表格和黑白公文版式生成投资提案。',
      '正文固定覆盖基本情况简介、交易条件、公司业务计划、项目亮点总结、风险提示与对策及条件式结论；不得按单份模板差异扩章。',
      '按“我的明确输入、项目结构化数据、截止日前授权证据、审慎分析”的优先级取值；请分开呈现资料记载、分析判断、待核验和资料缺口，不得复制模板项目事实。',
    ].join('\n')
  }
  if (request.actionId === 'investment_ppt') {
    return [
      ...common,
      `【模板】${request.template || '公司标准模板'}`,
      `【建议页数】${request.pageCount || '12-15页'}`,
      '请生成投资建议书 PPTX。优先使用可编辑文字、表格、基础图表和形状；复杂装饰与背景可图片化。',
      '内容应覆盖项目概览、投资结论、行业市场、产品技术、商业模式、客户经营、团队、竞争、财务估值、风险、尽调缺口和投资建议。',
    ].join('\n')
  }
  if (request.actionId === 'qa') {
    return [
      ...common,
      `【Q&A 类型】${request.qaMode || '投资委员会 Q&A'}`,
      `【问题深度】${request.questionDepth || '标准版'}`,
      ...(request.userInstructions?.trim() ? [`【用户补充输入】${request.userInstructions.trim()}`] : []),
      '先读取当前项目资料，再联网补充公司、产品、团队、市场、竞争、客户、融资和合规等公开信息。',
      '15 类仅作为内部选题池，优先生成能够形成实质答复且影响投资判断的问题；未公开事项写明具体核验边界，不得输出占位式无资料答复。',
      '最终只输出 PDF；正文不显示来源编号、引用资料、Reviewer 审阅结果或系统审计信息。',
    ].join('\n')
  }
  if (request.actionId === 'custom_template') {
    return [
      `【快捷任务】${request.actionLabel}`,
      '请按照已识别的模板规则，严格复用字体、字号、行距、排版、结构顺序及各结构内容要求。',
      '先读取当前项目资料，再联网补充工商、团队、产品、市场、客户、融资、资质和风险等公开信息。',
      '模板仅用于版式和结构分析；标题、章节标题和全部正文必须根据当前项目重新生成，不得保留模板示例正文、原项目名称或原文档标题。',
      '生成结果不得出现“资料缺口”状态、标题或占位文案；公开渠道未披露的事项仅可形成简洁的待核验边界。',
    ].join('\n')
  }
  return [
    ...common,
    `【尽调范围】${request.diligenceScope || '商业尽调'}`,
    '请先联网检索并补充工商、团队、产品、市场、客户、融资、资质和风险信息，再生成尽调报告初稿。',
    '正文覆盖主体、团队、产品、市场、商业模式、财务、客户、竞争、法律合规、风险和后续核验事项；不得逐节输出资料缺口占位文案。',
    '文末不生成免责声明和引用资料；来源仅保存在系统审计记录中。',
    '关键结论必须关联来源，并明确区分“已核验事实”“企业自述”“AI 推断”和“待核验”。',
  ].join('\n')
}

export function AiQuickActions({
  disabled,
  projects,
  currentProjectId,
  conversationId,
  onRunTask,
}: {
  disabled: boolean
  projects: Project[]
  currentProjectId: string
  conversationId: string
  onRunTask: (request: AiQuickTaskRequest) => Promise<boolean>
}) {
  const [activeAction, setActiveAction] = useState<ActionConfig | null>(null)
  const [sourceCutoffDate, setSourceCutoffDate] = useState(today)
  const [audience, setAudience] = useState('内部立项')
  const [length, setLength] = useState('标准版')
  const [proposalInstructions, setProposalInstructions] = useState('')
  const [template, setTemplate] = useState('公司标准模板')
  const [pageCount, setPageCount] = useState('12-15页')
  const [language, setLanguage] = useState('中文')
  const [diligenceScope, setDiligenceScope] = useState('商业尽调')
  const [qaMode, setQaMode] = useState('投资委员会 Q&A')
  const [questionDepth, setQuestionDepth] = useState('标准版')
  const [submitting, setSubmitting] = useState(false)
  const [templateFile, setTemplateFile] = useState<File | null>(null)
  const [analyzingTemplate, setAnalyzingTemplate] = useState(false)
  const [analyzedTemplate, setAnalyzedTemplate] = useState<AnalyzedCustomTemplate | null>(null)
  const [templateError, setTemplateError] = useState('')

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId),
    [currentProjectId, projects],
  )

  const openAction = (action: ActionConfig) => {
    if (disabled || !selectedProject) return
    if (action.id === 'custom_template') {
      setTemplateFile(null)
      setAnalyzedTemplate(null)
      setTemplateError('')
    }
    setActiveAction(action)
  }

  const submit = async () => {
    if (!activeAction || !selectedProject || submitting) return
    if (activeAction.id === 'custom_template' && !analyzedTemplate) return
    setSubmitting(true)
    try {
      const ok = await onRunTask({
        actionId: activeAction.id,
        actionLabel: activeAction.id === 'custom_template'
          ? '按上传模板生成'
          : activeAction.label,
        projectId: selectedProject.id,
        projectName: selectedProject.name,
        sourceCutoffDate,
        audience,
        length,
        userInstructions: proposalInstructions.trim(),
        template,
        pageCount,
        language,
        diligenceScope,
        qaMode,
        questionDepth,
        customTemplateId: analyzedTemplate?.id,
        customTemplateName: analyzedTemplate?.originalFileName,
        outputFormat: activeAction.id === 'custom_template'
          ? analyzedTemplate?.format === 'pptx' ? 'PPTX' : 'DOCX'
          : activeAction.id === 'investment_ppt'
          ? 'PPTX'
          : activeAction.id === 'qa'
            ? 'PDF'
            : 'DOCX',
      })
      if (ok) setActiveAction(null)
    } finally {
      setSubmitting(false)
    }
  }

  const analyzeTemplate = async () => {
    if (!templateFile || !selectedProject || analyzingTemplate) return
    const extension = templateFile.name.split('.').pop()?.toLowerCase()
    if (extension !== 'docx' && extension !== 'pptx') {
      setTemplateError('仅支持可编辑的 DOCX 和 PPTX 模板。')
      return
    }
    if (templateFile.size > MAX_TEMPLATE_BYTES) {
      setTemplateError('模板文件不能超过 25MB。')
      return
    }
    setAnalyzingTemplate(true)
    setTemplateError('')
    setAnalyzedTemplate(null)
    try {
      const dataBase64 = await readFileAsDataUrl(templateFile)
      const result = await apiPost<AnalyzedCustomTemplate>('/ai/templates/analyze', {
        projectId: selectedProject.id,
        conversationId,
        name: templateFile.name,
        dataBase64,
      })
      setAnalyzedTemplate(result)
    } catch (error) {
      setTemplateError((error as Error).message || '模板分析失败')
    } finally {
      setAnalyzingTemplate(false)
    }
  }

  return (
    <>
      <div className="mb-3">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-slate-500">
          <FileCheck2 className="h-3.5 w-3.5 text-brand-600" />
          快捷任务
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {ACTIONS.map((action) => {
            const Icon = action.icon
            return (
              <button
                key={action.id}
                type="button"
                disabled={disabled || !selectedProject}
                title={!selectedProject ? '当前会话未绑定可用项目' : action.description}
                onClick={() => openAction(action)}
                className="group flex min-w-[142px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-brand-200 hover:bg-brand-50/50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand-50 text-brand-600 group-hover:bg-white">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block whitespace-nowrap text-[11px] font-medium text-slate-700">{action.label}</span>
                  <span className="block truncate text-[9px] text-slate-400">
                    {action.mode === 'template' ? '识别结构与内容' : '确认参数后执行'}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <Modal
        open={!!activeAction}
        title={activeAction?.id === 'custom_template' ? '上传并分析模板' : activeAction ? `生成${activeAction.label}` : '快捷任务'}
        onClose={() => { if (!submitting && !analyzingTemplate) setActiveAction(null) }}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setActiveAction(null)} disabled={submitting || analyzingTemplate}>取消</Button>
            {activeAction?.id === 'custom_template' && !analyzedTemplate
              ? (
                  <Button
                    onClick={() => { void analyzeTemplate() }}
                    loading={analyzingTemplate}
                    disabled={!selectedProject || !templateFile}
                  >
                    上传并分析
                  </Button>
                )
              : (
                  <Button
                    onClick={() => { void submit() }}
                    loading={submitting}
                    disabled={!selectedProject || (activeAction?.id === 'custom_template' && !analyzedTemplate)}
                  >
                    {activeAction?.id === 'custom_template' ? '根据模板生成文档' : '开始生成'}
                  </Button>
                )}
          </>
        )}
        width={activeAction?.id === 'custom_template' ? 'max-w-4xl' : undefined}
      >
        {activeAction?.id === 'custom_template'
          ? (
              <div className="space-y-4">
                <label className="block">
                  <span className="label">项目（随当前会话固定）</span>
                  <div className="input flex items-center bg-slate-50 text-slate-600">
                    {selectedProject?.name ?? '未绑定项目'}
                  </div>
                </label>
                <label className="block">
                  <span className="label">资料截止日</span>
                  <input className="input" type="date" value={sourceCutoffDate} max={today()} onChange={(event) => setSourceCutoffDate(event.target.value)} />
                </label>
                <label className="block">
                  <span className="label">上传模板</span>
                  <input
                    type="file"
                    accept=".docx,.pptx"
                    className="hidden"
                    id="ai-custom-template-file"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null
                      setTemplateFile(file)
                      setAnalyzedTemplate(null)
                      setTemplateError('')
                    }}
                  />
                  <label
                    htmlFor="ai-custom-template-file"
                    className="mt-1 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 hover:border-brand-300 hover:bg-brand-50/30"
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white text-brand-600 shadow-sm">
                      <FileUp className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-700">
                        {templateFile?.name ?? '选择 DOCX 或 PPTX 模板'}
                      </span>
                      <span className="mt-1 block text-xs text-slate-400">
                        最大 25MB；模板只用于版式、结构和内容规则分析，不进入项目知识库
                      </span>
                    </span>
                  </label>
                </label>
                {analyzingTemplate && (
                  <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-700">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    正在识别模板结构和各部分内容要求…
                  </div>
                )}
                {templateError && (
                  <div className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-600">
                    {templateError}
                  </div>
                )}
                {analyzedTemplate && (
                  <div className="space-y-4">
                    <div className="flex items-start gap-3 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-3">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-emerald-800">模板识别完成，可以根据该模板生成文档</p>
                        <p className="mt-1 text-xs text-emerald-700">结构和各部分内容要求已保存</p>
                      </div>
                    </div>
                    <section className="rounded-xl border border-slate-200 p-4">
                      <h3 className="text-sm font-semibold text-slate-800">1. 文档构成</h3>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {analyzedTemplate.analysis.structures.map((structure) => (
                          <span key={`${structure.order}-${structure.title}`} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                            {structure.order}. {structure.title}
                          </span>
                        ))}
                      </div>
                    </section>
                    <section className="rounded-xl border border-slate-200 p-4">
                      <h3 className="text-sm font-semibold text-slate-800">2. 各结构内容</h3>
                      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                        {analyzedTemplate.analysis.structures.map((structure) => (
                          <details key={`${structure.order}-${structure.title}`} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                            <summary className="cursor-pointer text-xs font-medium text-slate-700">
                              {structure.order}. {structure.title}
                            </summary>
                            <div className="mt-2 space-y-2 text-xs leading-5 text-slate-600">
                              <p><span className="text-slate-400">结构作用：</span>{structure.contentPurpose}</p>
                              <p><span className="text-slate-400">模板内容：</span>{structure.contentSummary}</p>
                              <ul className="list-disc pl-5">
                                {structure.contentRequirements.map((requirement) => <li key={requirement}>{requirement}</li>)}
                              </ul>
                            </div>
                          </details>
                        ))}
                      </div>
                    </section>
                  </div>
                )}
              </div>
            )
          : (
        <div className="space-y-4">
          <label className="block">
            <span className="label">项目（随当前会话固定）</span>
            <div className="input flex items-center bg-slate-50 text-slate-600" aria-label="当前会话项目">
              {selectedProject?.name ?? '未绑定项目'}
            </div>
          </label>
          <label className="block">
            <span className="label">资料截止日</span>
            <input className="input" type="date" value={sourceCutoffDate} max={today()} onChange={(event) => setSourceCutoffDate(event.target.value)} />
          </label>
          {(activeAction?.id === 'proposal' || activeAction?.id === 'compliance' || activeAction?.id === 'qa') && (
            <>
              {activeAction.id === 'proposal' && (
                <div className="grid grid-cols-2 gap-4">
                  <label><span className="label">目标受众</span><select className="input" value={audience} onChange={(event) => setAudience(event.target.value)}><option>内部立项</option><option>基金内部汇报</option><option>合作方沟通</option></select></label>
                  <label><span className="label">篇幅</span><select className="input" value={length} onChange={(event) => setLength(event.target.value)}><option>精简版</option><option>标准版</option><option>详细版</option></select></label>
                </div>
              )}
              <label className="block">
                <span className="label">补充项目数据或写作要求（可选）</span>
                <textarea
                  className="input min-h-24 resize-y"
                  value={proposalInstructions}
                  maxLength={2000}
                  placeholder={activeAction.id === 'qa'
                    ? '例如：需要重点回答的争议、用户已确认的数据、指定比较对象或需核验的关键假设。'
                    : '例如：本轮拟投资金额、投资主体、基金名称及需重点说明的交易安排；与项目资料冲突时系统会标记为待核验。'}
                  onChange={(event) => setProposalInstructions(event.target.value)}
                />
                <span className="mt-1 block text-right text-[10px] text-slate-400">{proposalInstructions.length}/2000</span>
              </label>
            </>
          )}
          {activeAction?.id === 'investment_ppt' && (
            <div className="grid grid-cols-3 gap-4">
              <label><span className="label">模板</span><select className="input" value={template} onChange={(event) => setTemplate(event.target.value)}><option>公司标准模板</option></select></label>
              <label><span className="label">建议页数</span><select className="input" value={pageCount} onChange={(event) => setPageCount(event.target.value)}><option>8-10页</option><option>12-15页</option><option>18-20页</option></select></label>
              <label><span className="label">语言</span><select className="input" value={language} onChange={(event) => setLanguage(event.target.value)}><option>中文</option></select></label>
            </div>
          )}
          {activeAction?.id === 'due_diligence' && (
            <label className="block"><span className="label">尽调范围</span><select className="input" value={diligenceScope} onChange={(event) => setDiligenceScope(event.target.value)}><option>商业尽调</option></select></label>
          )}
          {activeAction?.id === 'qa' && (
            <div className="grid grid-cols-2 gap-4">
              <label>
                <span className="label">Q&amp;A 类型</span>
                <select className="input" value={qaMode} onChange={(event) => setQaMode(event.target.value)}>
                  <option>投资委员会 Q&amp;A</option>
                  <option>尽调 Q&amp;A</option>
                </select>
              </label>
              <label>
                <span className="label">问题深度</span>
                <select className="input" value={questionDepth} onChange={(event) => setQuestionDepth(event.target.value)}>
                  <option>标准版</option>
                  <option>深度版</option>
                </select>
              </label>
            </div>
          )}
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            输出格式：<strong className="text-slate-700">{activeAction?.id === 'investment_ppt' ? 'PPTX' : activeAction?.id === 'qa' ? 'DOCX + PDF' : 'DOCX'}</strong>
          </div>
        </div>
            )}
      </Modal>

    </>
  )
}
