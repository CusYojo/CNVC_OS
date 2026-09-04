import { useMemo, useState } from 'react'
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
import { aiBusinessErrorMessage } from '../lib/aiBusinessError'

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

export type AiQuickSkillName =
  | 'generate-investment-compliance-note'
  | 'draft-investment-proposal'
  | 'investment-committee-ppt'
  | 'draft-due-diligence-report'
  | 'draft-investment-qa'
  | 'generate-document-from-template'

export type AiQuickSkillSelection = {
  actionId: AiQuickActionId
  actionLabel: string
  skillName: AiQuickSkillName
  projectId: string
  projectName: string
  conversationId: string
  customTemplateId?: string
  customTemplateName?: string
  outputFormat: 'DOCX' | 'PPTX' | 'PDF'
}

type ActionConfig = {
  id: AiQuickActionId
  label: string
  description: string
  hidden?: boolean
  mode: 'task' | 'template'
  skillName: AiQuickSkillName
  outputFormat: 'DOCX' | 'PPTX'
  icon: typeof ShieldCheck
}

const ACTIONS: ActionConfig[] = [
  { id: 'compliance', label: '合规说明', description: '根据项目资料生成说明', mode: 'task', skillName: 'generate-investment-compliance-note', outputFormat: 'DOCX', icon: ShieldCheck },
  { id: 'proposal', label: '投资提案', description: '生成可编辑投资提案', mode: 'task', skillName: 'draft-investment-proposal', outputFormat: 'DOCX', icon: BriefcaseBusiness },
  { id: 'investment_ppt', label: '投资建议书', description: '生成投委会演示文稿', mode: 'task', skillName: 'investment-committee-ppt', outputFormat: 'PPTX', icon: Presentation },
  { id: 'due_diligence', label: '尽调报告', description: '整理尽调资料并生成报告', mode: 'task', skillName: 'draft-due-diligence-report', outputFormat: 'DOCX', icon: ClipboardCheck },
  { id: 'qa', label: '项目问答', description: '针对当前项目快速问答', mode: 'task', skillName: 'draft-investment-qa', outputFormat: 'DOCX', icon: HelpCircle },
  { id: 'custom_template', label: '上传模板', description: '按上传模板生成文档', hidden: true, mode: 'template', skillName: 'generate-document-from-template', outputFormat: 'DOCX', icon: Upload },
]

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
  selectedActionId,
  onSelectSkill,
}: {
  disabled: boolean
  projects: Project[]
  currentProjectId: string
  conversationId: string
  selectedActionId?: AiQuickActionId | null
  onSelectSkill: (selection: AiQuickSkillSelection) => void
}) {
  const [activeAction, setActiveAction] = useState<ActionConfig | null>(null)
  const [templateFile, setTemplateFile] = useState<File | null>(null)
  const [analyzingCustomTemplate, setAnalyzingCustomTemplate] = useState(false)
  const [analyzedTemplate, setAnalyzedTemplate] = useState<AnalyzedCustomTemplate | null>(null)
  const [templateError, setTemplateError] = useState('')
  const [templateProgress, setTemplateProgress] = useState<TemplateAnalysisProgress | null>(null)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId),
    [currentProjectId, projects],
  )

  const selectSkill = (action: ActionConfig, template?: AnalyzedCustomTemplate) => {
    if (disabled || !selectedProject) return
    onSelectSkill({
      actionId: action.id,
      actionLabel: action.id === 'custom_template' ? '按上传模板生成' : action.label,
      skillName: action.skillName,
      projectId: selectedProject.id,
      projectName: selectedProject.name,
      conversationId,
      customTemplateId: template?.id,
      customTemplateName: template?.originalFileName,
      outputFormat: template
        ? template.format === 'pptx' ? 'PPTX' : 'DOCX'
        : action.outputFormat,
    })
  }

  const openAction = (action: ActionConfig) => {
    if (disabled || !selectedProject) return
    if (action.mode === 'task') {
      selectSkill(action)
      return
    }
    setTemplateFile(null)
    setAnalyzedTemplate(null)
    setTemplateError('')
    setTemplateProgress(null)
    setActiveAction(action)
  }

  const analyzeTemplate = async () => {
    if (!templateFile || !selectedProject) return
    const project = selectedProject
    const file = templateFile
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (activeAction?.id !== 'custom_template' || analyzingCustomTemplate) return
    const supported = extension === 'docx' || extension === 'pptx'
    if (!supported) {
      setTemplateError('仅支持可编辑的 DOCX 和 PPTX 模板。')
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
    setAnalyzingCustomTemplate(true)
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
      setTemplateProgress(latestProgress)
    }
    publishProgress(latestProgress)
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
        purpose: 'custom_template_document',
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
        stage: '模板分析完成',
        progress: 100,
        updatedAt: new Date().toISOString(),
        elapsedSeconds: Math.max(
          0,
          Math.floor((Date.now() - Date.parse(current.startedAt)) / 1000),
        ),
      }))
      setAnalyzedTemplate(result)
    } catch (error) {
      const originalMessage = error instanceof ApiError
        ? error.baseMessage
        : (error as Error).message || '模板分析失败'
      const message = error instanceof ApiError
        && error.status === 500
        && /^HTTP 500$/i.test(originalMessage)
        ? error.withContext('模板转换连接被中断，请重新上传模板。')
        : error instanceof ApiError ? error.message : originalMessage
      publishProgress((current) => ({
        ...current,
        status: 'failed',
        stage: '模板分析失败',
        errorMessage: message,
        updatedAt: new Date().toISOString(),
      }))
      setTemplateError(aiBusinessErrorMessage(error))
    } finally {
      setAnalyzingCustomTemplate(false)
    }
  }

  const isTemplateUploadAction = activeAction?.id === 'custom_template'
  const activeActionAnalyzing = activeAction?.id === 'custom_template'
    ? analyzingCustomTemplate
    : false

  return (
    <>
      <div className="mb-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-500">
          <FileCheck2 className="h-3.5 w-3.5 text-brand-600" />
          常用工具
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {ACTIONS.filter((action) => !action.hidden).map((action) => {
            const Icon = action.icon
            const selected = action.id === selectedActionId || action.id === activeAction?.id
            const actionDisabled = disabled
              || !selectedProject
            return (
              <button
                key={action.id}
                type="button"
                disabled={actionDisabled}
                title={!selectedProject ? '当前会话未绑定可用项目' : action.description}
                onClick={() => openAction(action)}
                aria-pressed={selected}
                className={`group flex min-w-[142px] items-center gap-2 rounded-lg border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${selected
                  ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100'
                  : 'border-slate-200 bg-white hover:border-brand-200 hover:bg-brand-50/50'}`}
              >
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md text-brand-600 ${selected ? 'bg-white' : 'bg-brand-50 group-hover:bg-white'}`}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block whitespace-nowrap text-xs font-medium text-slate-700">{action.label}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <Modal
        open={isTemplateUploadAction}
        title="上传并分析模板"
        onClose={() => { if (!activeActionAnalyzing) setActiveAction(null) }}
        footer={(
          <>
            <Button
              variant="secondary"
              onClick={() => setActiveAction(null)}
              disabled={activeActionAnalyzing}
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
                    上传并分析
                  </Button>
                )
              : (
                  <Button
                    onClick={() => {
                      if (!activeAction || !analyzedTemplate) return
                      selectSkill(activeAction, analyzedTemplate)
                      setActiveAction(null)
                    }}
                    disabled={!selectedProject || !analyzedTemplate}
                  >
                    使用此模板
                  </Button>
                )}
          </>
        )}
        width="max-w-4xl"
      >
        {isTemplateUploadAction && (
              <div className="space-y-4">
                <label className="block">
                  <span className="label">项目（随当前会话固定）</span>
                  <div className="input flex items-center bg-slate-50 text-slate-600">
                    {selectedProject?.name ?? '未绑定项目'}
                  </div>
                </label>
                <label className="block">
                  <span className="label">
                    上传模板
                  </span>
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
                      setTemplateProgress(null)
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
                {activeActionAnalyzing && templateProgress && (
                  <div className="rounded-lg border border-brand-100 bg-brand-50 px-3 py-3">
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-brand-700">
                      <span className="min-w-0 truncate">{templateProgress.stage}</span>
                      <span className="shrink-0 font-mono font-medium">
                        {Math.max(0, Math.min(100, templateProgress.progress))}%
                      </span>
                    </div>
                    <ProgressBar value={templateProgress.progress} tone="blue" />
                    <p className="mt-2 text-xs text-brand-500">
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
                        文档
                      </p>
                      <p className="mt-1 text-xs text-emerald-700">
                        已识别 {analyzedTemplate.analysis.structures.length} 个页面/结构；
                        点击下方按钮继续
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
      </Modal>

    </>
  )
}
