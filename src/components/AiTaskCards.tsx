import { useEffect, useState } from 'react'
import {
  Ban,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  LoaderCircle,
  Presentation,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react'
import { apiDelete, apiGet } from '../lib/api'
import { shouldHideAiTaskFailureDiagnostics } from '../lib/aiTaskPresentation'
import { authedFetch } from '../store/useAuthStore'
import { Button, ProgressBar } from './ui'
import { formatShanghaiDateTime } from '../lib/dateTime'

export type AiTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type AiTaskArtifact = {
  id: string
  taskId: string
  fileName: string
  format: string
  mimeType: string
  version: number
  editableLevel: string
  sourceCutoffDate?: string | null
  templateVersion: string
  qualityStatus: string
  metadata?: Record<string, unknown>
  createdAt?: string
  downloadUrl?: string
}

export type AiTaskSource = {
  id: string
  sourceName: string
  locator?: string | null
  verificationStatus: string
}

export type AiTask = {
  id: string
  clientOnly?: boolean
  projectId: string
  conversationId?: string | null
  type: string
  parameters: Record<string, unknown>
  templateVersion: string
  status: AiTaskStatus
  stage: string
  progress: number
  resultSummary?: string | null
  errorId?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  retryable?: boolean | null
  cancellationRequested?: boolean
  retryOfTaskId?: string | null
  createdAt: string
  updatedAt: string
  completedAt?: string | null
  usage?: {
    modelCalls: number
    usageCalls: number
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
    reasoningTokens: number
    totalTokens: number
    complete: boolean
  } | null
  artifacts: AiTaskArtifact[]
  sources: AiTaskSource[]
}

const TASK_LABELS: Record<string, string> = {
  compliance_statement: '合规性说明',
  investment_proposal: '投资提案',
  investment_recommendation_ppt: '投资建议书',
  due_diligence_report: '尽调报告',
  project_qa: '项目 Q&A',
  custom_template_document: '自定义模板文档',
}

function artifactQualityLabel(artifact: AiTaskArtifact) {
  const officeFormat = ['docx', 'pptx'].includes(artifact.format.toLowerCase())
  if (officeFormat && artifact.qualityStatus === 'passed' && artifact.metadata?.encodingClean !== true) {
    return '历史版本·未执行新编码检查'
  }
  return artifact.qualityStatus === 'passed' ? '质量检查通过' : artifact.qualityStatus
}

type InvestmentPptArtifactStage = 'image-deck' | 'editable' | ''

function investmentPptArtifactStage(artifact: AiTaskArtifact): InvestmentPptArtifactStage {
  const format = artifact.format.toLowerCase()
  if (format !== 'pptx') return ''
  const editableLevel = artifact.editableLevel.toLowerCase()
  const fileName = artifact.fileName.toLowerCase()
  // editableLevel 和文件名来自实际产物，比历史 metadata 标签更可靠。
  if (editableLevel === 'all' || editableLevel === 'text-and-structure') return 'editable'
  if (editableLevel === 'image' || fileName.includes('图片高保真版')) return 'image-deck'
  const stage = String(artifact.metadata?.artifactStage ?? '')
  if (stage === 'image-deck' || stage === 'editable') return stage
  // 历史投资建议书 PPTX 没有阶段字段时，按可编辑成品兼容处理。
  return 'editable'
}

function artifactStageLabel(artifact: AiTaskArtifact) {
  const label = artifact.metadata?.artifactLabel
  if (typeof label === 'string' && label.trim()) return label.trim()
  const stage = String(artifact.metadata?.artifactStage ?? '')
  if (stage === 'image-deck') return '图片高保真版'
  if (stage === 'editable') return '元素级可编辑版'
  return ''
}

function newestArtifactForStage(
  artifacts: AiTaskArtifact[],
  stage: Exclude<InvestmentPptArtifactStage, ''>,
) {
  return artifacts
    .filter((artifact) => (
      investmentPptArtifactStage(artifact) === stage
      && artifact.qualityStatus === 'passed'
    ))
    .sort((left, right) => {
      const createdDelta = Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? '')
      return Number.isFinite(createdDelta) && createdDelta !== 0
        ? createdDelta
        : right.version - left.version
    })[0]
}

function artifactDownloadLabel(task: AiTask, artifact: AiTaskArtifact) {
  if (task.type === 'investment_recommendation_ppt' && artifact.metadata?.directSkillAgent === true) {
    return `下载 ${artifact.format.toUpperCase()} · V${artifact.version}`
  }
  if (task.type === 'investment_recommendation_ppt') {
    const normalizedStage = investmentPptArtifactStage(artifact)
    if (normalizedStage === 'image-deck') return '下载图片高保真版'
    if (normalizedStage === 'editable') return '下载元素级可编辑版'
  }
  const stageLabel = artifactStageLabel(artifact)
  if (task.type === 'investment_recommendation_ppt' && stageLabel) {
    return `下载${stageLabel}`
  }
  return `下载 ${artifact.format.toUpperCase()} · V${artifact.version}`
}

const STATUS_META: Record<AiTaskStatus, {
  label: string
  className: string
  icon: typeof Clock3
}> = {
  pending: { label: '等待执行', className: 'bg-slate-100 text-slate-600', icon: Clock3 },
  running: { label: '生成中', className: 'bg-brand-50 text-brand-700', icon: LoaderCircle },
  succeeded: { label: '已完成', className: 'bg-emerald-50 text-emerald-700', icon: CheckCircle2 },
  failed: { label: '文档未完成', className: 'bg-amber-50 text-amber-700', icon: Clock3 },
  cancelled: { label: '已取消', className: 'bg-amber-50 text-amber-700', icon: Ban },
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function TaskCard({
  task,
  mutating,
  onCancel,
  onRetry,
  onNotify,
}: {
  task: AiTask
  mutating: boolean
  onCancel: (task: AiTask) => Promise<void>
  onRetry: (task: AiTask) => Promise<void>
  onNotify?: (message: string, kind: 'success' | 'error' | 'info') => void
}) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const meta = STATUS_META[task.status] ?? STATUS_META.pending
  const StatusIcon = meta.icon
  const isActive = task.status === 'pending' || task.status === 'running'
  const sourceCount = task.sources?.length ?? 0
  const uploadedTemplateName = typeof task.parameters.customTemplateName === 'string'
    ? task.parameters.customTemplateName
    : ''
  const templateLabel = task.type === 'custom_template_document'
      ? uploadedTemplateName
      ? `上传模板：${uploadedTemplateName}`
      : '已分析上传模板'
    : '业务标准模板'
  const sourceLabel = sourceCount > 0
    ? `引用来源：${sourceCount} 条`
    : task.status === 'failed'
      ? '未形成最终引用清单'
      : '资料读取与引用整理中'
  const usageLabel = task.usage
    ? task.usage.usageCalls > 0
      ? `报告 Token：${task.usage.totalTokens.toLocaleString()}${task.usage.complete ? '' : '（部分统计）'}`
      : `报告 Token：上游未返回用量（${task.usage.modelCalls} 次调用）`
    : isActive
      ? '报告 Token：统计中'
      : task.status === 'succeeded'
        ? '报告 Token：无统计记录'
        : '报告 Token：未产生用量'
  const usageTitle = task.usage
    ? [
        `模型调用 ${task.usage.modelCalls} 次，收到用量 ${task.usage.usageCalls} 次`,
        `输入 ${task.usage.inputTokens.toLocaleString()}`,
        `输出 ${task.usage.outputTokens.toLocaleString()}`,
        task.usage.cacheCreationInputTokens
          ? `缓存写入 ${task.usage.cacheCreationInputTokens.toLocaleString()}`
          : '',
        task.usage.cacheReadInputTokens
          ? `缓存读取 ${task.usage.cacheReadInputTokens.toLocaleString()}`
          : '',
        task.usage.reasoningTokens
          ? `其中推理 ${task.usage.reasoningTokens.toLocaleString()}`
          : '',
      ].filter(Boolean).join(' · ')
    : ''
  const templatePreparationFailed = task.status === 'failed'
    && task.parameters._templatePreparationPending === true
  const hideFailureDiagnostics = shouldHideAiTaskFailureDiagnostics(task)
  const genericFailureMessage = '文档尚未完成，系统已保留本次生成参数，可继续生成。'
  const failureMessage = templatePreparationFailed
    ? task.errorMessage || '模板分析未完成，请重新上传模板。'
    : task.type === 'due_diligence_report'
    && task.progress <= 35
    && (!task.errorMessage || task.errorMessage === genericFailureMessage)
    ? '尽调 Skill Agent 尚未完成生成与验收，因此未生成文件。系统已保留参数，可点击“继续生成”。'
    : task.errorMessage || '文档尚未完成，系统已保留本次生成参数，可点击“继续生成”。'
  const failureStage = task.stage && task.stage !== '文档尚未完成'
    ? task.stage
    : task.type === 'due_diligence_report' && task.progress <= 35
      ? '直接 Skill Agent 生成或验收'
      : ''
  const candidateArtifacts = (task.artifacts ?? []).filter((artifact) => {
    const format = artifact.format.toLowerCase()
    if (task.type === 'project_qa') return format === 'docx'
    if (task.type === 'investment_proposal') return format === 'docx'
    if (task.type === 'due_diligence_report') return format === 'docx'
    return ['docx', 'pptx', 'pdf'].includes(format)
  })
  const isDirectInvestmentPpt = task.type === 'investment_recommendation_ppt'
    && candidateArtifacts.some((artifact) => artifact.metadata?.directSkillAgent === true)
  const downloadableArtifacts = isDirectInvestmentPpt
    ? candidateArtifacts
        .filter((artifact) => artifact.format.toLowerCase() === 'pptx' && artifact.qualityStatus === 'passed')
        .sort((left, right) => right.version - left.version)
        .slice(0, 1)
    : task.type === 'investment_recommendation_ppt'
      ? [
        newestArtifactForStage(candidateArtifacts, 'image-deck'),
        task.status === 'succeeded'
          ? newestArtifactForStage(candidateArtifacts, 'editable')
          : undefined,
        ].filter((artifact): artifact is AiTaskArtifact => Boolean(artifact))
      : candidateArtifacts
  const hasImageDeck = downloadableArtifacts.some(
    (artifact) => investmentPptArtifactStage(artifact) === 'image-deck',
  )
  const hasEditableDeck = downloadableArtifacts.some(
    (artifact) => investmentPptArtifactStage(artifact) === 'editable',
  )

  const download = async (artifact: AiTaskArtifact) => {
    if (downloadingId) return
    setDownloadingId(artifact.id)
    onNotify?.(`正在下载「${artifact.fileName}」…`, 'info')
    try {
      const response = await authedFetch(artifact.downloadUrl || `/api/ai/artifacts/${artifact.id}/download`)
      if (!response.ok) throw new Error(`服务端返回 HTTP ${response.status}`)
      triggerDownload(await response.blob(), artifact.fileName)
      onNotify?.(`「${artifact.fileName}」已开始下载`, 'success')
    } catch (downloadError) {
      console.warn('AI artifact download did not start', downloadError)
      onNotify?.('文档下载暂未开始，请稍后重试', 'info')
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <article className={`rounded-xl border bg-white p-4 shadow-sm ${task.status === 'failed' ? 'border-amber-200' : 'border-slate-200'}`}>
      <div className="flex items-start gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${task.type === 'investment_recommendation_ppt' ? 'bg-orange-50 text-orange-600' : 'bg-brand-50 text-brand-600'}`}>
          {task.type === 'investment_recommendation_ppt' ? <Presentation className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-800">{TASK_LABELS[task.type] ?? 'AI 业务任务'}</h3>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.className}`}>
              <StatusIcon className={`h-3 w-3 ${task.status === 'running' ? 'animate-spin' : ''}`} />
              {meta.label}
            </span>
            {templateLabel && (
              <span className="max-w-48 truncate text-[10px] text-slate-400" title={templateLabel}>{templateLabel}</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
            <span>{sourceLabel}</span>
            {usageLabel && <span title={usageTitle}>{usageLabel}</span>}
            <span>{formatShanghaiDateTime(task.createdAt)}</span>
          </div>
        </div>
      </div>

      {(isActive || task.progress > 0) && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[10px] text-slate-500">
            <span>{isActive ? task.stage || '生成进度' : '完成进度'}</span>
            <span className="font-mono">{Math.max(0, Math.min(100, task.progress || 0))}%</span>
          </div>
          <ProgressBar value={task.progress || 0} tone={task.status === 'succeeded' ? 'green' : task.status === 'cancelled' ? 'amber' : 'blue'} />
        </div>
      )}

      {task.status === 'failed' && !hideFailureDiagnostics && (
        <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p>{failureMessage}</p>
          {task.retryable === false && (
            <p className="mt-1 text-[10px] font-medium text-amber-700">该错误不可直接重试，请修正资料、模板或参数后重新创建任务。</p>
          )}
          {failureStage && <p className="mt-1 text-[10px] text-amber-700">停止阶段：{failureStage}</p>}
          {task.errorId && <p className="mt-1 font-mono text-[10px] text-amber-700">错误编号：{task.errorId}</p>}
        </div>
      )}

      {task.type === 'investment_recommendation_ppt' && hasImageDeck && !hasEditableDeck && (
        <div className="mt-3 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-700">
          {task.status === 'failed'
            ? '图片高保真版已完成，可先下载查看。元素级可编辑版本轮未完成，可点击“继续生成”。'
            : '图片高保真版已完成，可先下载查看。元素级可编辑版仍在继续生成与校验。'}
        </div>
      )}

      {downloadableArtifacts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {downloadableArtifacts
            .map((artifact) => (
              <Button
                key={artifact.id}
                size="sm"
                variant="secondary"
                loading={downloadingId === artifact.id}
                disabled={!!downloadingId}
                onClick={() => { void download(artifact) }}
              >
                <Download className="h-3.5 w-3.5" />
                {artifactDownloadLabel(task, artifact)}
              </Button>
            ))}
        </div>
      )}

      {!task.clientOnly && (isActive || task.status === 'failed') && (
        <div className="mt-3 flex justify-end">
          {isActive && (
            <Button size="sm" variant="danger" loading={mutating} disabled={task.cancellationRequested} onClick={() => { void onCancel(task) }}>
              <Square className="h-3 w-3" />{task.cancellationRequested ? '取消中…' : '取消任务'}
            </Button>
          )}
          {task.status === 'failed' && !templatePreparationFailed && task.retryable !== false && (
            <Button size="sm" variant="secondary" loading={mutating} onClick={() => { void onRetry(task) }}>
              <RotateCcw className="h-3.5 w-3.5" />继续生成
            </Button>
          )}
        </div>
      )}
    </article>
  )
}

export function AiTaskCards({
  tasks,
  loading = false,
  mutatingTaskId,
  onCancel,
  onRetry,
  onNotify,
}: {
  tasks: AiTask[]
  loading?: boolean
  mutatingTaskId?: string | null
  onCancel: (task: AiTask) => Promise<void>
  onRetry: (task: AiTask) => Promise<void>
  onNotify?: (message: string, kind: 'success' | 'error' | 'info') => void
}) {
  if (!loading && tasks.length === 0) return null
  return (
    <section className="space-y-3" aria-label="AI 业务材料任务">
      {loading && tasks.length === 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />正在恢复该会话的 AI 任务…
        </div>
      )}
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          mutating={mutatingTaskId === task.id}
          onCancel={onCancel}
          onRetry={onRetry}
          onNotify={onNotify}
        />
      ))}
    </section>
  )
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function AiArtifactCenter({
  projectId,
  refreshKey,
  onNotify,
  onDeleted,
}: {
  projectId?: string
  refreshKey?: string | number
  onNotify?: (message: string, kind: 'success' | 'error' | 'info') => void
  onDeleted?: (artifactId: string) => void
}) {
  const [artifacts, setArtifacts] = useState<AiTaskArtifact[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const validProjectId = !!projectId && UUID_PATTERN.test(projectId)

  useEffect(() => {
    let active = true
    if (!validProjectId) {
      setArtifacts([])
      setError('')
      return () => { active = false }
    }
    setLoading(true)
    apiGet<{ list: AiTaskArtifact[] }>(`/ai/artifacts?projectId=${encodeURIComponent(projectId!)}`)
      .then((result) => {
        if (!active) return
        setArtifacts((result.list ?? []).filter((artifact) => ['docx', 'pptx', 'pdf'].includes(artifact.format.toLowerCase())))
        setError('')
      })
      .catch((fetchError) => {
        if (!active) return
        console.warn('AI artifact list is temporarily unavailable', fetchError)
        setError('正式交付物正在同步，请稍后查看')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [projectId, refreshKey, validProjectId])

  const download = async (artifact: AiTaskArtifact) => {
    if (downloadingId) return
    setDownloadingId(artifact.id)
    onNotify?.(`正在下载「${artifact.fileName}」…`, 'info')
    try {
      const response = await authedFetch(artifact.downloadUrl || `/api/ai/artifacts/${artifact.id}/download`)
      if (!response.ok) throw new Error(`服务端返回 HTTP ${response.status}`)
      triggerDownload(await response.blob(), artifact.fileName)
      onNotify?.(`「${artifact.fileName}」已开始下载`, 'success')
    } catch (downloadError) {
      console.warn('AI artifact download did not start', downloadError)
      onNotify?.('文档下载暂未开始，请稍后重试', 'info')
    } finally {
      setDownloadingId(null)
    }
  }

  const remove = async (artifact: AiTaskArtifact) => {
    if (deletingId || downloadingId) return
    if (!window.confirm(`确定删除正式交付物“${artifact.fileName}”吗？删除后将从交付物列表和任务记录中移除。`)) return
    setDeletingId(artifact.id)
    try {
      await apiDelete(`/ai/artifacts/${artifact.id}`)
      setArtifacts((items) => items?.filter((item) => item.id !== artifact.id) ?? [])
      onDeleted?.(artifact.id)
      onNotify?.(`正式交付物“${artifact.fileName}”已删除`, 'success')
    } catch (deleteError) {
      console.warn('AI artifact deletion failed', deleteError)
      onNotify?.('交付物删除失败，请稍后重试', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section className="border-b border-slate-200">
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">正式交付物</p>
          <p className="mt-0.5 text-[10px] text-slate-400">按用户与项目隔离 · 版本可追溯</p>
        </div>
        {loading && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-brand-500" />}
      </div>
      <div className="max-h-64 space-y-1 overflow-y-auto px-2 py-2">
        {!validProjectId && (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-[11px] leading-5 text-slate-400">
            当前项目尚未入库，无法生成或读取正式交付物。
          </p>
        )}
        {validProjectId && error && <p className="px-2 py-2 text-[11px] text-slate-400">{error}</p>}
        {validProjectId && artifacts === null && !error && <p className="px-2 py-3 text-[11px] text-slate-400">正在加载正式交付物…</p>}
        {validProjectId && artifacts?.length === 0 && !loading && !error && (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-[11px] text-slate-400">
            暂无通过质量检查的正式交付物
          </p>
        )}
        {artifacts?.map((artifact) => (
          <div key={artifact.id} className="flex items-center gap-2 rounded-lg border border-transparent bg-white/80 px-2.5 py-2 hover:border-brand-100">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
              {artifact.format.toLowerCase() === 'pptx' ? <Presentation className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-slate-700" title={artifact.fileName}>{artifact.fileName}</span>
              <span className="mt-0.5 block truncate text-[10px] text-slate-400">
                {artifact.format.toUpperCase()} · V{artifact.version} · {
                  artifactStageLabel(artifact)
                    ? `${artifactStageLabel(artifact)} · `
                    : ''
                }{artifactQualityLabel(artifact)} · {
                  typeof artifact.metadata?.customTemplateName === 'string'
                    ? `上传模板：${artifact.metadata.customTemplateName}`
                    : typeof artifact.metadata?.referenceTemplate === 'string'
                      && artifact.metadata.referenceTemplate
                      ? `模板：${artifact.metadata.referenceTemplate}`
                    : artifact.metadata?.generationSkill === 'create-reference-driven-editable-ppt'
                      ? '分阶段生成'
                      : '业务模板'
                }
              </span>
            </span>
            <button
              type="button"
              disabled={!!downloadingId || !!deletingId}
              onClick={() => { void download(artifact) }}
              title="鉴权下载"
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-slate-300 hover:bg-brand-50 hover:text-brand-600 disabled:opacity-50"
            >
              {downloadingId === artifact.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              disabled={!!downloadingId || !!deletingId}
              onClick={() => { void remove(artifact) }}
              title="删除交付物"
              aria-label={`删除交付物 ${artifact.fileName}`}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-slate-300 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
            >
              {deletingId === artifact.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
