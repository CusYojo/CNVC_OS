import { useState } from 'react'
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Download,
  FileText,
  LoaderCircle,
  RotateCcw,
  Square,
  XCircle,
} from 'lucide-react'
import { authedFetch, useAuthStore } from '../store/useAuthStore'
import { formatShanghaiDateTime } from '../lib/dateTime'
import type { AiTask, AiTaskArtifact } from './AiTaskCards'
import { isAiPlatformAdminRole } from '../../server/src/contracts/adminRoleContract'
import { aiBusinessErrorMessage } from '../lib/aiBusinessError'

const TASK_LABELS: Record<string, string> = {
  compliance_statement: '合规说明',
  investment_proposal: '投资提案',
  investment_recommendation_ppt: '投资建议书',
  due_diligence_report: '尽调报告',
  project_qa: '项目问答',
  custom_template_document: '上传模板文档',
}

const TASK_SKILLS: Record<string, string> = {
  compliance_statement: 'generate-investment-compliance-note',
  investment_proposal: 'draft-investment-proposal',
  investment_recommendation_ppt: 'investment-committee-ppt',
  due_diligence_report: 'draft-due-diligence-report',
  project_qa: 'draft-investment-qa',
  custom_template_document: 'generate-document-from-template',
}

const STATUS_LABELS: Record<AiTask['status'], string> = {
  pending: '等待执行',
  running: '生成中',
  succeeded: '已完成',
  failed: '生成未完成',
  cancelled: '已取消',
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
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

function downloadableArtifacts(task: AiTask) {
  return (task.artifacts ?? [])
    .filter((artifact) => (
      artifact.qualityStatus === 'passed'
      && ['docx', 'pptx', 'pdf'].includes(artifact.format.toLowerCase())
    ))
    .sort((left, right) => right.version - left.version)
}

function usageLabel(task: AiTask) {
  if (!task.usage) return ''
  if (task.usage.usageCalls > 0 && task.usage.totalTokens > 0) {
    return `${task.usage.totalTokens.toLocaleString()} Token${task.usage.complete ? '' : '（部分）'}`
  }
  return task.status === 'pending' || task.status === 'running' ? 'Token 统计中' : ''
}

export function AiTaskConversationMessage({
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
  const showDiagnostics = useAuthStore(state => isAiPlatformAdminRole(state.user?.role ?? ''))
  const active = task.status === 'pending' || task.status === 'running'
  const artifacts = downloadableArtifacts(task)
  const taskLabel = TASK_LABELS[task.type] ?? '正式文档'
  const configuredSkillName = typeof task.parameters.skillName === 'string'
    ? task.parameters.skillName.trim()
    : ''
  const skillName = configuredSkillName || TASK_SKILLS[task.type] || task.templateVersion
  const sources = task.sources?.length ?? 0
  const tokenUsage = usageLabel(task)
  const events = (task.events ?? []).filter((event, index, all) => (
    event.stage.trim()
    && all.findIndex((candidate) => candidate.stage.trim() === event.stage.trim()) === index
  ))
  const study = artifacts
    .map((artifact) => artifact.metadata?.projectKnowledgeStudy)
    .find((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
  const sourceDocumentCount = Number(study?.sourceDocumentCount ?? 0)
  const requiredSourceDocumentCount = Number(study?.requiredSourceDocumentCount ?? 0)
  const includedChunkCount = Number(study?.includedChunkCount ?? 0)
  const sourceChunkCount = Number(study?.sourceChunkCount ?? 0)
  const completeSourceCoverage = study?.completeSourceChunkCoverage === true

  const download = async (artifact: AiTaskArtifact) => {
    if (downloadingId) return
    setDownloadingId(artifact.id)
    onNotify?.(`正在下载「${artifact.fileName}」…`, 'info')
    try {
      const response = await authedFetch(artifact.downloadUrl || `/api/ai/artifacts/${artifact.id}/download`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      triggerDownload(await response.blob(), artifact.fileName)
      onNotify?.(`「${artifact.fileName}」已开始下载`, 'success')
    } catch (error) {
      console.warn('AI artifact download did not start', error)
      onNotify?.('文件下载暂未开始，请稍后重试', 'info')
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <div className="flex gap-3" aria-label={`${taskLabel} Agent 执行消息`}>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
        <Bot className="h-4 w-4" />
      </span>
      <div className="min-w-0 max-w-[88%] space-y-2 text-sm leading-6 text-slate-700">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-800">{taskLabel}</span>
          <span className="inline-flex items-center gap-1 text-xs text-slate-500">
            {active && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-brand-500" />}
            {task.status === 'succeeded' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
            {task.status === 'failed' && <AlertCircle className="h-3.5 w-3.5 text-amber-600" />}
            {task.status === 'cancelled' && <XCircle className="h-3.5 w-3.5 text-slate-500" />}
            {STATUS_LABELS[task.status]}
          </span>
        </div>

        {showDiagnostics && <p className="text-xs text-brand-700">执行能力 · {skillName}</p>}

        <div className="space-y-1">
          {events.length > 0 ? (
            <ol className="space-y-1" aria-label="文档 Agent 实际执行阶段">
              {events.map((event, index) => {
                const current = index === events.length - 1 && active
                return (
                  <li key={event.id} className="flex items-start gap-2">
                    {current
                      ? <LoaderCircle className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin text-brand-500" />
                      : <CheckCircle2 className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-500" />}
                    <span>{event.stage}</span>
                  </li>
                )
              })}
            </ol>
          ) : task.stage ? <p>{task.stage}</p> : null}
          {sources > 0 && <p className="text-xs text-slate-500">已登记引用来源：{sources} 条</p>}
          {requiredSourceDocumentCount > 0 && (
            <p className="text-xs text-slate-500">
              项目资料研读：{sourceDocumentCount}/{requiredSourceDocumentCount} 份
              {sourceChunkCount > 0 && ` · 片段 ${includedChunkCount}/${sourceChunkCount}`}
              {completeSourceCoverage && ' · 全部可用片段已覆盖'}
            </p>
          )}
          {showDiagnostics && tokenUsage && <p className="text-xs text-slate-500">报告用量：{tokenUsage}</p>}
          <p className="text-xs text-slate-400">开始于 {formatShanghaiDateTime(task.createdAt)}</p>
        </div>

        {task.status === 'failed' && (
          <div className="text-sm text-amber-800">
            <p>{showDiagnostics ? task.errorMessage || '本轮生成未形成正式文档。' : aiBusinessErrorMessage(task.errorMessage)}</p>
            {showDiagnostics && task.errorId && <p className="font-mono text-xs text-amber-700">错误编号：{task.errorId}</p>}
          </div>
        )}

        {task.status === 'cancelled' && (
          <p className="text-slate-500">本次生成已取消，已完成的后台记录仍保留用于审计。</p>
        )}

        {artifacts.length > 0 && (
          <div className="space-y-2 pt-1">
            {artifacts.map((artifact) => (
              <div key={artifact.id} className="flex flex-wrap items-center gap-2">
                <FileText className="h-4 w-4 text-brand-600" />
                <span className="max-w-md truncate text-sm font-medium text-slate-700" title={artifact.fileName}>
                  {artifact.fileName}
                </span>
                <button
                  type="button"
                  disabled={Boolean(downloadingId)}
                  onClick={() => { void download(artifact) }}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-brand-300 hover:text-brand-700 disabled:opacity-50"
                >
                  {downloadingId === artifact.id
                    ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    : <Download className="h-3.5 w-3.5" />}
                  下载 {artifact.format.toUpperCase()} · V{artifact.version}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {active && (
            <button
              type="button"
              disabled={mutating || task.cancellationRequested}
              onClick={() => { void onCancel(task) }}
              className="inline-flex items-center gap-1 text-xs font-medium text-rose-600 hover:text-rose-700 disabled:opacity-50"
            >
              <Square className="h-3 w-3" />
              {task.cancellationRequested ? '正在取消…' : '停止生成'}
            </button>
          )}
          {task.status === 'failed' && task.retryable !== false && (
            <button
              type="button"
              disabled={mutating}
              onClick={() => { void onRetry(task) }}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />继续执行
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function AiTaskConversationLoading() {
  return (
    <div className="flex gap-3 text-sm text-slate-500">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
        <Bot className="h-4 w-4" />
      </span>
      <span className="inline-flex items-center gap-2 py-1">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />正在恢复文档 Agent 执行记录…
      </span>
    </div>
  )
}
