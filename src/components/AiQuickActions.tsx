import { useMemo, useRef, useState } from 'react'
import {
  BriefcaseBusiness,
  CheckCircle2,
  ClipboardCheck,
  FileCheck2,
  FileUp,
  HelpCircle,
  Presentation,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import { apiGet, apiPost, ApiError } from '../lib/api'
import { uid } from '../lib/uid'
import type { Project } from '../types'
import { Button, Modal, ProgressBar } from './ui'

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

type TemplateAnalysisProgress = {
  id: string
  fileName: string
  status: 'running' | 'succeeded' | 'failed'
  stage: string
  progress: number
  startedAt: string
  updatedAt: string
  elapsedSeconds: number
  errorMessage?: string
  result?: AnalyzedCustomTemplate
}

type TemplateAnalysisAccepted = {
  progressId: string
  status: 'running'
  stage: string
  progress: number
}

export type AiQuickTaskPreparationProgress = {
  id: string
  actionId: 'investment_ppt'
  actionLabel: string
  projectId: string
  projectName: string
  conversationId: string
  fileName: string
  status: 'running' | 'failed'
  stage: string
  progress: number
  startedAt: string
  updatedAt: string
  elapsedSeconds: number
  errorMessage?: string
}

export type AiQuickTaskRequest = {
  actionId: AiQuickActionId
  actionLabel: string
  projectId: string
  projectName: string
  conversationId: string
  sourceCutoffDate: string
  audience?: string
  length?: string
  userInstructions?: string
  language?: string
  structureMode?: string
  diligenceScope?: string
  qaMode?: string
  questionDepth?: string
  customTemplateId?: string
  customTemplateName?: string
  preparationId?: string
  preparationStartedAt?: string
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
  { id: 'compliance', label: '合规性说明', description: '基于当前项目资料库生成合规初稿', mode: 'task', icon: ShieldCheck },
  { id: 'proposal', label: '投资提案', description: '按核心规范生成内部立项或投委会材料', mode: 'task', icon: BriefcaseBusiness },
  { id: 'investment_ppt', label: '投资建议书（PPT）', description: '按上传的 PDF 或 PPTX 模板生成投资建议书', mode: 'template', icon: Presentation },
  { id: 'due_diligence', label: '尽调报告', description: '资深投资经理生成当前项目内部尽调报告', mode: 'task', icon: ClipboardCheck },
  { id: 'qa', label: 'Q&A', description: '资深投资经理生成当前项目投资问答 DOCX', mode: 'task', icon: HelpCircle },
  { id: 'custom_template', label: '上传模板', description: '识别模板结构和内容要求', mode: 'template', icon: Upload },
]

const today = () => new Date().toISOString().slice(0, 10)
const MAX_TEMPLATE_BYTES = 25 * 1024 * 1024

function readFileAsDataUrl(
  file: File,
  onProgress?: (progress: number) => void,
) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round(event.loaded / event.total * 8))
      }
    }
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取模板失败'))
    reader.readAsDataURL(file)
  })
}

export function AiQuickActions({
  disabled,
  projects,
  currentProjectId,
  conversationId,
  onRunTask,
  onPreparationProgress,
}: {
  disabled: boolean
  projects: Project[]
  currentProjectId: string
  conversationId: string
  onRunTask: (request: AiQuickTaskRequest) => Promise<boolean>
  onPreparationProgress?: (progress: AiQuickTaskPreparationProgress) => void
}) {
  const [activeAction, setActiveAction] = useState<ActionConfig | null>(null)
  const [sourceCutoffDate, setSourceCutoffDate] = useState(today)
  const [audience, setAudience] = useState('内部立项')
  const [length, setLength] = useState('标准版')
  const [proposalInstructions, setProposalInstructions] = useState('')
  const [language, setLanguage] = useState('中文')
  const [diligenceScope, setDiligenceScope] = useState('商业尽调')
  const [qaMode, setQaMode] = useState('投资委员会 Q&A')
  const [questionDepth, setQuestionDepth] = useState('标准版')
  const submitLocksRef = useRef(new Set<AiQuickActionId>())
  const [submittingActionIds, setSubmittingActionIds] = useState<AiQuickActionId[]>([])
  const [templateFile, setTemplateFile] = useState<File | null>(null)
  const [analyzingCustomTemplate, setAnalyzingCustomTemplate] = useState(false)
  const [analyzingInvestmentPpt, setAnalyzingInvestmentPpt] = useState(false)
  const [analyzedTemplate, setAnalyzedTemplate] = useState<AnalyzedCustomTemplate | null>(null)
  const [templateError, setTemplateError] = useState('')
  const [templateProgress, setTemplateProgress] = useState<TemplateAnalysisProgress | null>(null)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId),
    [currentProjectId, projects],
  )

  const openAction = (action: ActionConfig) => {
    if (
      disabled
      || !selectedProject
      || submitLocksRef.current.has(action.id)
      || (action.id === 'investment_ppt' && analyzingInvestmentPpt)
    ) return
    if (action.id === 'custom_template' || action.id === 'investment_ppt') {
      setTemplateFile(null)
      setAnalyzedTemplate(null)
      setTemplateError('')
      setTemplateProgress(null)
    }
    setActiveAction(action)
  }

  const submit = async (
    templateOverride?: AnalyzedCustomTemplate,
    actionOverride?: ActionConfig | null,
    projectOverride?: Project,
    preparationId?: string,
    preparationStartedAt?: string,
  ) => {
    const action = actionOverride ?? activeAction
    const project = projectOverride ?? selectedProject
    if (!action || !project || submitLocksRef.current.has(action.id)) return false
    const taskTemplate = templateOverride ?? analyzedTemplate
    if (
      (action.id === 'custom_template' || action.id === 'investment_ppt')
      && !taskTemplate
    ) return false
    submitLocksRef.current.add(action.id)
    setSubmittingActionIds((items) => items.includes(action.id) ? items : [...items, action.id])
    try {
      const ok = await onRunTask({
        actionId: action.id,
        actionLabel: action.id === 'custom_template'
          ? '按上传模板生成'
          : action.label,
        projectId: project.id,
        projectName: project.name,
        conversationId,
        sourceCutoffDate,
        audience,
        length,
        userInstructions: proposalInstructions.trim(),
        language,
        structureMode: action.id === 'investment_ppt' ? 'strict-template' : undefined,
        diligenceScope,
        qaMode,
        questionDepth,
        customTemplateId: taskTemplate?.id,
        customTemplateName: taskTemplate?.originalFileName,
        preparationId,
        preparationStartedAt,
        outputFormat: action.id === 'custom_template'
          ? taskTemplate?.format === 'pptx' ? 'PPTX' : 'DOCX'
          : action.id === 'investment_ppt'
          ? 'PPTX'
          : 'DOCX',
      })
      if (ok) {
        setActiveAction((current) => current?.id === action.id ? null : current)
      }
      return ok
    } finally {
      submitLocksRef.current.delete(action.id)
      setSubmittingActionIds((items) => items.filter((id) => id !== action.id))
    }
  }

  const analyzeTemplate = async () => {
    if (!templateFile || !selectedProject) return
    const action = activeAction
    const project = selectedProject
    const file = templateFile
    const extension = file.name.split('.').pop()?.toLowerCase()
    const isInvestmentPpt = action?.id === 'investment_ppt'
    if (
      (isInvestmentPpt && analyzingInvestmentPpt)
      || (!isInvestmentPpt && analyzingCustomTemplate)
    ) return
    const supported = isInvestmentPpt
      ? extension === 'pdf' || extension === 'pptx'
      : extension === 'docx' || extension === 'pptx'
    if (!supported) {
      setTemplateError(isInvestmentPpt
        ? '投资建议书模板仅支持 PDF 或 PPTX。'
        : '仅支持可编辑的 DOCX 和 PPTX 模板。')
      return
    }
    if (file.size > MAX_TEMPLATE_BYTES) {
      setTemplateError('模板文件不能超过 25MB。')
      return
    }
    // 公网 HTTP 不是安全上下文，不能直接调用 crypto.randomUUID()。
    // uid() 在 HTTPS/localhost 使用原生 UUID，在 HTTP 环境自动降级。
    const progressId = uid()
    const startedAt = new Date().toISOString()
    if (isInvestmentPpt) setAnalyzingInvestmentPpt(true)
    else setAnalyzingCustomTemplate(true)
    setTemplateError('')
    setAnalyzedTemplate(null)
    let latestProgress: TemplateAnalysisProgress = {
      id: progressId,
      fileName: file.name,
      status: 'running',
      stage: '正在读取本地模板文件',
      progress: 2,
      startedAt,
      updatedAt: startedAt,
      elapsedSeconds: 0,
    }
    const publishProgress = (
      next: TemplateAnalysisProgress | ((current: TemplateAnalysisProgress) => TemplateAnalysisProgress),
    ) => {
      latestProgress = typeof next === 'function' ? next(latestProgress) : next
      if (isInvestmentPpt) {
        try {
          onPreparationProgress?.({
            id: latestProgress.id,
            actionId: 'investment_ppt',
            actionLabel: action?.label ?? '投资建议书（PPT）',
            projectId: project.id,
            projectName: project.name,
            conversationId,
            fileName: latestProgress.fileName,
            status: latestProgress.status === 'failed' ? 'failed' : 'running',
            stage: latestProgress.stage,
            // 模板读取与预检是整个 PPT 生成流程的前置阶段，占总进度前 10%。
            progress: Math.max(1, Math.min(10, Math.ceil(latestProgress.progress / 10))),
            startedAt: latestProgress.startedAt,
            updatedAt: latestProgress.updatedAt,
            elapsedSeconds: latestProgress.elapsedSeconds,
            errorMessage: latestProgress.errorMessage,
          })
        } catch (progressError) {
          // 会话任务卡渲染异常不能阻塞模板上传，也不能让按钮永久保持加载状态。
          console.warn('模板分析进度未能同步到会话任务卡', progressError)
        }
      } else {
        setTemplateProgress(latestProgress)
      }
    }
    publishProgress(latestProgress)
    // 投资建议书会自动衔接生成任务；点击开始后立即回到会话，由任务卡统一承载进度。
    if (isInvestmentPpt) setActiveAction(null)
    const waitForTemplateAnalysis = async () => {
      const deadline = Date.now() + 40 * 60_000
      const progressRegistrationDeadline = Date.now() + 10_000
      let transientFailures = 0
      while (Date.now() < deadline) {
        let progress: TemplateAnalysisProgress
        try {
          progress = await apiGet<TemplateAnalysisProgress>(
            `/ai/templates/analyze-progress/${progressId}`,
          )
          transientFailures = 0
        } catch (error) {
          const isRegistering = error instanceof ApiError
            && error.status === 404
            && Date.now() < progressRegistrationDeadline
          if (!isRegistering) {
            transientFailures += 1
            if (transientFailures >= 5) throw error
            console.warn('模板分析进度暂时不可用，将自动重试', error)
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1_200))
          continue
        }
        publishProgress((current) => ({
          ...progress,
          progress: Math.max(current.progress, progress.progress),
        }))
        if (progress.status === 'failed') {
          throw new Error(progress.errorMessage || '模板分析失败')
        }
        if (progress.status === 'succeeded') {
          if (!progress.result) {
            throw new Error('模板分析已完成，但服务端未返回分析结果')
          }
          return progress.result
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1_200))
      }
      throw new Error('模板分析超过 40 分钟仍未完成，请稍后重试')
    }
    try {
      const dataBase64 = await readFileAsDataUrl(file, (progress) => {
        publishProgress((current) => ({
          ...current,
          stage: '正在读取本地模板文件',
          progress: Math.max(current.progress, progress),
          updatedAt: new Date().toISOString(),
          elapsedSeconds: Math.max(
            0,
            Math.floor((Date.now() - Date.parse(current.startedAt)) / 1000),
          ),
        }))
      })
      publishProgress((current) => ({
        ...current,
        stage: '模板已读取，正在上传到分析服务',
        progress: Math.max(current.progress, 9),
        updatedAt: new Date().toISOString(),
      }))
      const accepted = await apiPost<
        TemplateAnalysisAccepted | AnalyzedCustomTemplate
      >('/ai/templates/analyze', {
        projectId: project.id,
        conversationId,
        name: file.name,
        dataBase64,
        progressId,
        purpose: isInvestmentPpt
          ? 'investment_recommendation_ppt'
          : 'custom_template_document',
      }, {
        signal: AbortSignal.timeout(5 * 60_000),
      })
      // 旧版服务端仍可能直接返回模板；新版在 202 后通过进度接口交付结果。
      const result = 'analysis' in accepted
        ? accepted
        : await waitForTemplateAnalysis()
      publishProgress((current) => ({
        ...current,
        status: 'succeeded',
        stage: isInvestmentPpt
          ? '模板分析完成，正在创建生成任务'
          : '模板分析完成',
        progress: 100,
        updatedAt: new Date().toISOString(),
        elapsedSeconds: Math.max(
          0,
          Math.floor((Date.now() - Date.parse(current.startedAt)) / 1000),
        ),
      }))
      if (!isInvestmentPpt) setAnalyzedTemplate(result)
      if (isInvestmentPpt) {
        const taskCreated = await submit(result, action, project, progressId, startedAt)
        if (!taskCreated) {
          const message = '模板分析已经完成，但生成任务暂未创建，请重新点击快捷任务。'
          publishProgress((current) => ({
            ...current,
            status: 'failed',
            stage: '生成任务暂未创建',
            errorMessage: message,
            updatedAt: new Date().toISOString(),
          }))
        }
      }
    } catch (error) {
      const originalMessage = (error as Error).message || '模板分析失败'
      const message = error instanceof ApiError
        && error.status === 500
        && /^HTTP 500$/i.test(originalMessage)
        ? '模板转换连接被中断，请重新上传模板。'
        : originalMessage
      publishProgress((current) => ({
        ...current,
        status: 'failed',
        stage: '模板分析失败',
        errorMessage: message,
        updatedAt: new Date().toISOString(),
      }))
      if (!isInvestmentPpt) setTemplateError(message)
    } finally {
      if (isInvestmentPpt) setAnalyzingInvestmentPpt(false)
      else setAnalyzingCustomTemplate(false)
    }
  }

  const isInvestmentTemplateAction = activeAction?.id === 'investment_ppt'
  const isTemplateUploadAction = activeAction?.id === 'custom_template'
    || isInvestmentTemplateAction
  const activeActionSubmitting = !!activeAction
    && submittingActionIds.includes(activeAction.id)
  const activeActionAnalyzing = isInvestmentTemplateAction
    ? analyzingInvestmentPpt
    : activeAction?.id === 'custom_template'
      ? analyzingCustomTemplate
      : false

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
            const actionDisabled = disabled
              || !selectedProject
              || submittingActionIds.includes(action.id)
              || (action.id === 'investment_ppt' && analyzingInvestmentPpt)
            return (
              <button
                key={action.id}
                type="button"
                disabled={actionDisabled}
                title={
                  action.id === 'investment_ppt' && analyzingInvestmentPpt
                    ? '模板正在后台分析，请在会话任务卡查看进度'
                    : !selectedProject
                      ? '当前会话未绑定可用项目'
                      : action.description
                }
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
        onClose={() => { if (!activeActionSubmitting && !activeActionAnalyzing) setActiveAction(null) }}
        footer={(
          <>
            <Button
              variant="secondary"
              onClick={() => setActiveAction(null)}
              disabled={activeActionSubmitting || activeActionAnalyzing}
            >
              取消
            </Button>
            {isTemplateUploadAction && !analyzedTemplate
              ? (
                  <Button
                    onClick={() => { void analyzeTemplate() }}
                    loading={activeActionAnalyzing}
                    disabled={!selectedProject || !templateFile}
                  >
                    {isInvestmentTemplateAction ? '上传、分析并开始生成' : '上传并分析'}
                  </Button>
                )
              : (
                  <Button
                    onClick={() => { void submit() }}
                    loading={activeActionSubmitting}
                    disabled={!selectedProject || (isTemplateUploadAction && !analyzedTemplate)}
                  >
                    {activeAction?.id === 'custom_template'
                      ? '根据模板生成文档'
                      : isInvestmentTemplateAction
                        ? '根据模板生成 PPT'
                        : '开始生成'}
                  </Button>
                )}
          </>
        )}
        width={isTemplateUploadAction ? 'max-w-4xl' : undefined}
      >
        {isTemplateUploadAction
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
                  <span className="label">
                    {isInvestmentTemplateAction ? '上传投资建议书模板' : '上传模板'}
                  </span>
                  <input
                    type="file"
                    accept={isInvestmentTemplateAction ? '.pdf,.pptx' : '.docx,.pptx'}
                    className="hidden"
                    id={isInvestmentTemplateAction
                      ? 'ai-investment-ppt-template-file'
                      : 'ai-custom-template-file'}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null
                      setTemplateFile(file)
                      setAnalyzedTemplate(null)
                      setTemplateError('')
                      setTemplateProgress(null)
                    }}
                  />
                  <label
                    htmlFor={isInvestmentTemplateAction
                      ? 'ai-investment-ppt-template-file'
                      : 'ai-custom-template-file'}
                    className="mt-1 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 hover:border-brand-300 hover:bg-brand-50/30"
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white text-brand-600 shadow-sm">
                      <FileUp className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-700">
                        {templateFile?.name ?? (
                          isInvestmentTemplateAction
                            ? '选择 PDF 或 PPTX 模板'
                            : '选择 DOCX 或 PPTX 模板'
                        )}
                      </span>
                      <span className="mt-1 block text-xs text-slate-400">
                        {isInvestmentTemplateAction
                          ? '最大 25MB；PPTX 直接分析，PDF 先转换为可编辑 PPTX 并通过交接检查'
                          : '最大 25MB；模板只用于版式、结构和内容规则分析，不进入项目知识库'}
                      </span>
                    </span>
                  </label>
                </label>
                {isInvestmentTemplateAction && (
                  <div className="grid grid-cols-2 gap-4">
                    <label>
                      <span className="label">结构模式</span>
                      <div className="input flex items-center bg-slate-50 text-slate-600">
                        严格沿用上传模板
                      </div>
                    </label>
                    <label>
                      <span className="label">语言</span>
                      <select className="input" value={language} onChange={(event) => setLanguage(event.target.value)}>
                        <option>中文</option>
                      </select>
                    </label>
                  </div>
                )}
                {activeActionAnalyzing && templateProgress && (
                  <div className="rounded-lg border border-brand-100 bg-brand-50 px-3 py-3">
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-brand-700">
                      <span className="min-w-0 truncate">{templateProgress.stage}</span>
                      <span className="shrink-0 font-mono font-medium">
                        {Math.max(0, Math.min(100, templateProgress.progress))}%
                      </span>
                    </div>
                    <ProgressBar value={templateProgress.progress} tone="blue" />
                    <p className="mt-2 text-[10px] text-brand-500">
                      已用时 {templateProgress.elapsedSeconds} 秒；PDF 严格水印检查可能需要数分钟，可继续等待当前进度自动更新。
                    </p>
                  </div>
                )}
                {templateError && (
                  <div className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-600">
                    {templateError}
                  </div>
                )}
                {analyzedTemplate && (
                  <div className="flex items-start gap-3 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-3">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-emerald-800">
                        模板识别完成，可以严格依据该模板生成
                        {isInvestmentTemplateAction ? '投资建议书' : '文档'}
                      </p>
                      <p className="mt-1 text-xs text-emerald-700">
                        已识别 {analyzedTemplate.analysis.structures.length} 个页面/结构；
                        点击下方按钮继续
                      </p>
                    </div>
                  </div>
                )}
                {isInvestmentTemplateAction && (
                  <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
                    输出格式：<strong className="text-slate-700">PPTX</strong>。
                    页面尺寸、母版、版式、字体、字号、行距、页面顺序和内容槽位以上传模板为准。
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
                <span className="label">
                  {activeAction.id === 'qa'
                    ? '重点问题或检索要求（可选）'
                    : '补充项目数据或写作要求（可选）'}
                </span>
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
          {activeAction?.id === 'due_diligence' && (
            <label className="block"><span className="label">分析范围</span><select className="input" value={diligenceScope} onChange={(event) => setDiligenceScope(event.target.value)}><option value="商业尽调">早期项目线索分析</option></select></label>
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
            输出格式：<strong className="text-slate-700">{activeAction?.id === 'investment_ppt' ? 'PPTX' : 'DOCX'}</strong>
          </div>
        </div>
            )}
      </Modal>

    </>
  )
}
