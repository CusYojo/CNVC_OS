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
} from 'lucide-react'
import { apiGet } from '../lib/api'
import { authedFetch } from '../store/useAuthStore'
import { Button, ProgressBar } from './ui'

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
  errorMessage?: string | null
  retryOfTaskId?: string | null
  createdAt: string
  updatedAt: string
  completedAt?: string | null
  artifacts: AiTaskArtifact[]
  sources: AiTaskSource[]
}

const TASK_LABELS: Record<string, string> = {
  compliance_statement: '合规性说明',
  investment_proposal: '投资提案',
  investment_recommendation_ppt: '投资建议书（PPT）',
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

function ProtectedImagePreview({
  artifact,
}: {
  artifact: AiTaskArtifact
}) {
  const [imageUrl, setImageUrl] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    let objectUrl = ''
    authedFetch(artifact.downloadUrl || `/api/ai/artifacts/${artifact.id}/download`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        objectUrl = URL.createObjectURL(await response.blob())
        if (active) setImageUrl(objectUrl)
      })
      .catch((previewError) => {
        if (!active) return
        console.warn('PPT preview failed', previewError)
        setFailed(true)
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [artifact.downloadUrl, artifact.id])

  if (failed) return <p className="mt-3 text-xs text-slate-400">预览暂不可用，可直接下载 PPTX。</p>
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
      {imageUrl
        ? <img src={imageUrl} alt="投资建议书封面预览" className="aspect-video w-full object-contain" />
        : <div className="flex aspect-video items-center justify-center text-xs text-slate-400"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />加载 PPT 预览…</div>}
    </div>
  )
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
  const imageArtifact = task.artifacts?.find((artifact) => artifact.format.toLowerCase() === 'png')
  const templateLabel = task.type === 'custom_template_document'
    ? '已分析上传模板'
    : '公司标准模板'
  const sourceLabel = sourceCount > 0
    ? `引用来源：${sourceCount} 条`
    : task.status === 'failed'
      ? '未形成最终引用清单'
      : '资料读取与引用整理中'
  const genericFailureMessage = '文档尚未完成，系统已保留本次生成参数，可继续生成。'
  const failureMessage = task.type === 'due_diligence_report'
    && task.progress <= 35
    && (!task.errorMessage || task.errorMessage === genericFailureMessage)
    ? '尽调正文生成或质量检查未完成，因此未生成文件。系统已保留参数，可点击“继续生成”。'
    : task.errorMessage || '文档尚未完成，系统已保留本次生成参数，可点击“继续生成”。'
  const failureStage = task.stage && task.stage !== '文档尚未完成'
    ? task.stage
    : task.type === 'due_diligence_report' && task.progress <= 35
      ? '结构化正文生成或质量检查'
      : ''

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
            <span className="max-w-48 truncate text-[10px] text-slate-400" title={templateLabel}>{templateLabel}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
            <span>{sourceLabel}</span>
            <span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span>
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

      {task.status === 'failed' && (
        <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p>{failureMessage}</p>
          {failureStage && <p className="mt-1 text-[10px] text-amber-700">停止阶段：{failureStage}</p>}
          {task.errorId && <p className="mt-1 font-mono text-[10px] text-amber-700">错误编号：{task.errorId}</p>}
        </div>
      )}

      {task.status === 'succeeded' && task.artifacts?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {task.artifacts
            .filter((artifact) => {
              const format = artifact.format.toLowerCase()
              if (task.type === 'project_qa') return format === 'docx'
              if (task.type === 'investment_proposal') return format === 'docx'
              return ['docx', 'pptx', 'pdf'].includes(format)
            })
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
                下载 {artifact.format.toUpperCase()} · V{artifact.version}
                {['docx', 'pptx'].includes(artifact.format.toLowerCase())
                  && artifact.metadata?.encodingClean !== true
                  && '（历史未校验）'}
              </Button>
            ))}
        </div>
      )}

      {task.status === 'succeeded' && imageArtifact && (
        <ProtectedImagePreview artifact={imageArtifact} />
      )}

      {(isActive || task.status === 'failed') && (
        <div className="mt-3 flex justify-end">
          {isActive && (
            <Button size="sm" variant="danger" loading={mutating} onClick={() => { void onCancel(task) }}>
              <Square className="h-3 w-3" />取消任务
            </Button>
          )}
          {task.status === 'failed' && (
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
}: {
  projectId?: string
  refreshKey?: string | number
  onNotify?: (message: string, kind: 'success' | 'error' | 'info') => void
}) {
  const [artifacts, setArtifacts] = useState<AiTaskArtifact[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
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
            当前为未入库的演示项目，无法生成或读取正式交付物。
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
                {artifact.format.toUpperCase()} · V{artifact.version} · {artifactQualityLabel(artifact)} · 公司标准模板
              </span>
            </span>
            <button
              type="button"
              disabled={!!downloadingId}
              onClick={() => { void download(artifact) }}
              title="鉴权下载"
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-slate-300 hover:bg-brand-50 hover:text-brand-600 disabled:opacity-50"
            >
              {downloadingId === artifact.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
