import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { AlertCircle, Bot, Boxes, Check, CheckCircle2, ChevronDown, ChevronRight, Copy, Download, File as FileIcon, FileText, MessageSquarePlus, Paperclip, Pencil, RefreshCw, Search, Send, Square, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore } from '../store/useAuthStore'
import { isAiPlatformAdminRole } from '../../server/src/contracts/adminRoleContract'
import { Button, Modal } from '../components/ui'
import {
  AiQuickActions,
  type AiQuickSkillSelection,
} from '../components/AiQuickActions'
import { AiArtifactCenter, type AiTask } from '../components/AiTaskCards'
import {
  AiTaskConversationLoading,
  AiTaskConversationMessage,
} from '../components/AiTaskConversationMessage'
import { AiQaCards, type ProjectQaAnswer } from '../components/AiQaCards'
import { AiErrorBoundary, copyAiErrorId, createAiErrorId } from '../components/AiErrorBoundary'
import { useToast } from '../components/Toast'
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, ApiError } from '../lib/api'
import {
  extractTextParts,
  isFormalAiTaskControlPart,
  isFormalAiTaskReceiptMessage,
  normalizeAgentMessages,
  safeStringify,
  toSafeText,
  type SafeAgentMessage,
  type SafeAgentPart,
} from '../lib/aiMessageSafety'
import {
  useJwAgent,
  type JwPendingInteraction,
} from '../hooks/useJwAgent'
import { formatShanghaiDateTime, shanghaiDateKey } from '../lib/dateTime'
import type { Project } from '../types'
import { aiBusinessErrorMessage } from '../lib/aiBusinessError'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const AI_UPLOAD_ACCEPT = '.pdf,.ppt,.pptx,.xlsx,.xls,.csv,.docx,.txt,.md,.markdown,.png,.jpg,.jpeg,.zip'
const AI_UPLOAD_EXTENSIONS = new Set(
  AI_UPLOAD_ACCEPT.split(',').map((extension) => extension.slice(1)),
)
const CHAT_BOTTOM_FOLLOW_THRESHOLD_PX = 96
const AI_TASK_LABEL_BY_TYPE: Record<string, string> = {
  compliance_statement: '合规性说明',
  investment_proposal: '投资提案',
  investment_recommendation_ppt: '投资建议书（PPT）',
  due_diligence_report: '尽调报告',
  project_qa: '项目 Q&A',
  custom_template_document: '上传模板文档',
}

export function isConversationNearBottom(
  scroll: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
) {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= CHAT_BOTTOM_FOLLOW_THRESHOLD_PX
}

type ConversationPptTaskResult = {
  matched: boolean
  needsTemplate: boolean
  reused?: boolean
  skillName: 'GordenSuperPPTSkill'
  message?: string
  task?: AiTask
}

// —— 模块级 toast 桥 ——
// OSS 下载等模块级函数需要弹提示，但它们拿不到 Chat 组件里的 useToast。
// Chat 挂载时把 showToast 注册到这里。
let __toast: ((msg: string, kind?: 'success' | 'error' | 'info') => void) | null = null
export function registerAiToast(fn: (msg: string, kind?: 'success' | 'error' | 'info') => void) { __toast = fn }
function toast(msg: string, kind: 'success' | 'error' | 'info' = 'info') { __toast?.(msg, kind) }

// 浏览器强制下载：blob -> <a download> 完整链路（appendChild + click + remove + revoke）
function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function safeDecodedFileName(url: string): string {
  const rawName = url.split('?')[0].split('/').pop() || '下载文件'
  try { return decodeURIComponent(rawName) } catch { return rawName }
}

function ProjectPicker({
  projects,
  value,
  onChange,
  disabled = false,
}: {
  projects: Project[]
  value: string
  onChange: (projectId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hasTyped, setHasTyped] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [popupLayout, setPopupLayout] = useState<{
    left: number
    top: number
    width: number
    maxHeight: number
    opensAbove: boolean
  } | null>(null)
  const selected = projects.find((project) => project.id === value)

  const filteredProjects = useMemo(() => {
    const keyword = hasTyped ? query.trim().toLocaleLowerCase() : ''
    const matches = projects.filter((project) => {
      if (!keyword) return true
      return [
        project.name,
        project.companyName,
        project.industry,
        project.round,
        project.stage,
        ...(project.tags ?? []),
      ].some((field) => String(field ?? '').toLocaleLowerCase().includes(keyword))
    })
    return [...matches].sort((a, b) => Number(b.id === value) - Number(a.id === value))
  }, [hasTyped, projects, query, value])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!pickerRef.current?.contains(target) && !popupRef.current?.contains(target)) {
        setOpen(false)
        setQuery('')
        setHasTyped(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  useEffect(() => {
    if (!open) {
      setPopupLayout(null)
      return
    }
    const updatePopupLayout = () => {
      const rect = pickerRef.current?.getBoundingClientRect()
      if (!rect) return
      const viewportPadding = 16
      const gap = 6
      const spaceBelow = window.innerHeight - rect.bottom - viewportPadding - gap
      const spaceAbove = rect.top - viewportPadding - gap
      const openBelow = spaceBelow >= 220 || spaceBelow >= spaceAbove
      const availableHeight = Math.max(120, openBelow ? spaceBelow : spaceAbove)
      const maxHeight = Math.min(480, availableHeight)
      setPopupLayout({
        left: rect.left,
        top: openBelow ? rect.bottom + gap : rect.top - gap,
        width: rect.width,
        maxHeight,
        opensAbove: !openBelow,
      })
    }
    updatePopupLayout()
    window.addEventListener('resize', updatePopupLayout)
    window.addEventListener('scroll', updatePopupLayout, true)
    return () => {
      window.removeEventListener('resize', updatePopupLayout)
      window.removeEventListener('scroll', updatePopupLayout, true)
    }
  }, [open])

  const selectProject = (projectId: string) => {
    onChange(projectId)
    setQuery('')
    setHasTyped(false)
    setOpen(false)
  }

  const openPicker = () => {
    if (disabled || projects.length === 0 || open) return
    setQuery(selected?.name ?? '')
    setHasTyped(false)
    setOpen(true)
  }

  return (
    <div ref={pickerRef} className="relative">
      <Search className="pointer-events-none absolute left-3 top-5 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        value={open ? query : selected?.name ?? ''}
        onFocus={(event) => {
          const inputElement = event.currentTarget
          openPicker()
          window.requestAnimationFrame(() => inputElement.select())
        }}
        onClick={openPicker}
        onChange={(event) => {
          setQuery(event.target.value)
          setHasTyped(true)
          if (!open) setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false)
            setQuery('')
            setHasTyped(false)
            event.currentTarget.blur()
          }
          if (event.key === 'Enter' && open && filteredProjects[0]) {
            event.preventDefault()
            selectProject(filteredProjects[0].id)
          }
        }}
        placeholder={projects.length ? '输入关键词搜索项目' : '暂无可用项目'}
        className="input pr-16 pl-9"
        role="combobox"
        aria-label="搜索并选择项目"
        aria-expanded={open}
        aria-controls="new-session-project-listbox"
        aria-autocomplete="list"
        disabled={disabled || projects.length === 0}
      />
      {open && query && (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuery('')
            setHasTyped(true)
          }}
          className="absolute right-8 top-5 z-10 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="清空项目搜索"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      <ChevronDown className={`pointer-events-none absolute right-3 top-5 z-10 h-4 w-4 -translate-y-1/2 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />

      {open && popupLayout && createPortal(
        <div
          ref={popupRef}
          className="fixed z-[70] flex overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"
          style={{
            left: popupLayout.left,
            top: popupLayout.top,
            width: popupLayout.width,
            maxHeight: popupLayout.maxHeight,
            flexDirection: 'column',
            transform: popupLayout.opensAbove ? 'translateY(-100%)' : undefined,
          }}
        >
          <div
            id="new-session-project-listbox"
            className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin"
            role="listbox"
            aria-label="项目列表"
          >
            {filteredProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="option"
                aria-selected={project.id === value}
                onClick={() => selectProject(project.id)}
                className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition ${project.id === value ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}
              >
                <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md text-xs font-semibold ${project.id === value ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500'}`}>
                  {(project.name || '项目').slice(0, 2)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{project.name}</span>
                    {project.id === value && <Check className="h-4 w-4 shrink-0 text-brand-600" />}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-400">
                    {[project.companyName, project.industry, project.stage].filter(Boolean).join(' · ') || '暂无项目标签'}
                  </span>
                </span>
              </button>
            ))}
            {!filteredProjects.length && <div className="px-3 py-8 text-center text-xs text-slate-400">没有找到匹配的项目</div>}
          </div>
          <div className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400">共 {filteredProjects.length} 个匹配项目 · 回车选择第一项</div>
        </div>,
        document.body,
      )}
    </div>
  )
}

// Markdown 渲染（标题/表格/列表/粗体/代码块）
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-7 text-slate-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="mb-2 mt-4 text-base font-bold text-slate-900 first:mt-0" {...p} />,
          h2: (p) => <h2 className="mb-2 mt-4 text-[15px] font-bold text-slate-900 first:mt-0" {...p} />,
          h3: (p) => <h3 className="mb-1.5 mt-3 text-sm font-semibold text-slate-800 first:mt-0" {...p} />,
          p: (p) => <p className="my-2 leading-7 first:mt-0 last:mb-0" {...p} />,
          ul: (p) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
          ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
          li: (p) => <li className="leading-6" {...p} />,
          strong: (p) => <strong className="font-semibold text-slate-900" {...p} />,
          a: ({ href, children, ...rest }) => {
            const url = String(href ?? '')
            // OSS / 明显是文件产物的链接：走强制下载（跨域 target=_blank 会变预览/被拦截）
            const isFile = /\.(pptx|ppt|pdf|docx|xlsx|xls|csv|zip|png|jpe?g)(\?|$)/i.test(url) || /aliyuncs\.com|\/oss\//i.test(url)
            if (isFile && /^https?:/i.test(url)) {
              const nm = safeDecodedFileName(url)
              return <a className="text-brand-600 underline hover:text-brand-700 cursor-pointer" onClick={(e) => { e.preventDefault(); void downloadRemoteUrl(url, nm) }} href={url} {...rest}>{children}</a>
            }
            return <a className="text-brand-600 underline hover:text-brand-700" href={href} target="_blank" rel="noreferrer" {...rest}>{children}</a>
          },
          blockquote: (p) => <blockquote className="my-2 border-l-2 border-brand-300 bg-brand-50/40 py-1 pl-3 text-slate-600" {...p} />,
          hr: () => <hr className="my-3 border-slate-200" />,
          code: ({ className, children, ...rest }) => {
            const inline = !className
            return inline
              ? <code className="rounded bg-slate-100 px-1 py-0.5 text-[13px] text-rose-600" {...rest}>{children}</code>
              : <code className={`block overflow-x-auto rounded-lg bg-slate-900 p-3 text-[13px] leading-6 text-slate-100 ${className ?? ''}`} {...rest}>{children}</code>
          },
          pre: (p) => <pre className="my-2 overflow-x-auto" {...p} />,
          table: (p) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-[13px]" {...p} /></div>,
          thead: (p) => <thead className="bg-slate-50" {...p} />,
          th: (p) => <th className="border border-slate-200 px-3 py-2 text-left font-semibold text-slate-700" {...p} />,
          td: (p) => <td className="border border-slate-200 px-3 py-2 align-top text-slate-600" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

const TOOL_LABELS: Record<string, string> = {
  search_project_docs: '📁 检索项目资料',
  start_ppt_generation: '📊 启动 PPT 生成',
  collect_intel: '📡 采集公司情报',
  bash: '💻 执行命令',
  read: '📄 读取文件',
  write: '✏️ 写入文件',
  edit: '✏️ 编辑文件',
  glob: '🔍 查找文件',
  grep: '🔎 搜索内容',
  task: '🧩 派生子任务',
}

// 工具输入的一行摘要（借鉴 pi：优先展示 command/path/query 等关键字段）
function toolPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  try {
    const o = input as Record<string, unknown>
    for (const k of ['command', 'path', 'file_path', 'pattern', 'query', 'topic', 'projectId', 'title']) {
      if (o[k] != null && o[k] !== '') return toSafeText(o[k], 120)
    }
    const keys = Object.keys(o)
    return keys.length ? toSafeText(o[keys[0]], 120) : ''
  } catch {
    return '[工具输入暂不可预览]'
  }
}

// 把 Agent 工具 output 归一成可读文本（可能是字符串、对象或数组）
function outputToText(output: unknown): string {
  return toSafeText(output, 4000)
}

// Pi 式任务链步骤卡片：running（转圈）/ done（绿，可展开看输入输出）/ error（红，就地报错）
function ToolStep({ part }: { part: SafeAgentPart }) {
  const [expanded, setExpanded] = useState(false)
  const toolName = part.toolName || 'unknown'
  const label = TOOL_LABELS[toolName] ?? `🔧 ${toolName}`
  const running = part.state === 'input-streaming' || part.state === 'input-available' || part.state === 'call'
  const isError = part.state === 'output-error'
  const preview = toolPreview(part.input)
  // 折叠时不序列化可能很大的工具输出，避免每个流式 token 都重复做重活。
  const outputText = expanded && part.state === 'output-available' ? outputToText(part.output) : ''
  const border = isError ? 'border-rose-300' : running ? 'border-brand-200' : 'border-emerald-200'
  const bg = isError ? 'bg-rose-50/60' : running ? 'bg-brand-50/50' : 'bg-emerald-50/40'
  const labelColor = isError ? 'text-rose-700' : running ? 'text-brand-700' : 'text-emerald-700'
  const statusLabel = isError ? '失败' : running ? '运行中' : '完成'

  return (
    <div className={`my-1.5 overflow-hidden rounded-lg border ${border} ${bg} text-xs`}>
      <button
        type="button"
        aria-label={`工具步骤 ${label} ${statusLabel}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        {running
          ? <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-brand-300 border-t-brand-600" />
          : isError
            ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
            : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
        <span className={`shrink-0 font-medium ${labelColor}`}>{label}{running ? '…' : ''}</span>
        {preview && <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-400" title={preview}>{preview}</span>}
        <ChevronRight className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-black/5 px-3 py-2">
          {part.input != null && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-white/70 p-2 text-xs leading-5 text-slate-500">{safeStringify(part.input)}</pre>
          )}
          {isError
            ? <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-rose-50 p-2 text-xs leading-5 text-rose-600">{toSafeText(part.errorText, 4000) || '执行出错'}</pre>
            : part.state === 'output-available' && outputText.trim() !== '' && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-white/70 p-2 text-xs leading-5 text-slate-500">{outputText}</pre>
            )}
        </div>
      )}
    </div>
  )
}

// 渲染 Agent 会话消息的一个 part（文本 / 推理 / 工具调用 / 文件）
export function MessagePart({ part }: { part: SafeAgentPart }) {
  if (part.type === 'text') return <Markdown>{part.text ?? ''}</Markdown>
  if (part.type === 'reasoning') {
    return (
      <details className="my-1 text-xs text-slate-400">
        <summary className="cursor-pointer select-none">💭 思考过程</summary>
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-slate-200 pl-2">{part.text}</div>
      </details>
    )
  }
  if (part.type === 'file') {
    if (!part.url) return <span className="text-xs text-slate-400">附件（{part.mediaType}）</span>
    const url = part.url
    return (part.mediaType ?? '').startsWith('image/')
      ? <img src={url} alt={part.filename ?? '附件'} className="my-2 max-w-xs rounded-lg" />
      : <button type="button" onClick={() => void downloadRemoteUrl(url, part.filename ?? '下载附件')} className="inline-flex items-center gap-1 text-brand-600 underline hover:text-brand-700"><Download className="h-3.5 w-3.5" />{part.filename ?? '下载附件'}</button>
  }
  // 工具调用（dynamic-tool）：Pi 式任务链步骤卡片（running / done / error）
  if (part.type === 'dynamic-tool') return <ToolStep part={part} />
  return (
    <div className="my-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
      <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
      {part.text || `暂不支持的消息类型：${part.originalType || part.type || 'unknown'}`}
    </div>
  )
}

export function isUserVisibleMessagePart(part: SafeAgentPart) {
  // Shell commands are implementation details. Keep them in the conversation
  // state for task/progress inference, but never expose command text to users.
  return !isFormalAiTaskControlPart(part)
    && !(part.type === 'dynamic-tool' && (part.toolName === 'bash' || part.toolName === 'AskUserQuestion'))
}

function displayUserMessageText(message: SafeAgentMessage): string {
  return extractTextParts(message)
    .replace(/【当前项目】.*\n【projectId】.*\n【用户问题】/s, '')
    .replace(/【范围】全局知识库\n【用户问题】/s, '')
    .replace(/\n?【本轮指定技能】[^\n]*/g, '')
    .replace(/\n?【已上传文件】[\s\S]*$/, '')
    // Agent 协议当前没有独立的隐藏提示字段。任务防重复指令仍需发送给 Agent，
    // 但它属于内部控制信息，不能出现在面向用户的聊天气泡中。
    .replace(/\n?【(?:系统已执行|内部任务状态)】[\s\S]*$/, '')
}

function displayUserMessageSkills(message: SafeAgentMessage): string[] {
  const match = extractTextParts(message).match(/【本轮指定技能】([^\n]+)/)
  return match
    ? match[1].split('、').map((item) => item.replace(/（[^）]+）/g, '').trim()).filter(Boolean)
    : []
}

function safeAgentErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null && 'message' in error) {
      return toSafeText((error as { message?: unknown }).message, 1000)
    }
    return toSafeText(error, 1000)
  } catch {
    return 'AI 服务返回了无法识别的错误'
  }
}

function getSlashCommandQuery(value: string): string | null {
  const match = value.match(/(?:^|\s)\/([^\s]*)$/)
  return match ? match[1] : null
}

function MessageRow({ message }: { message: SafeAgentMessage }) {
  if (message.role === 'user') {
    const skills = displayUserMessageSkills(message)
    return (
      <div className="flex justify-end gap-3">
        <div className="flex max-w-[80%] flex-col items-end gap-1.5">
          {skills.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1" aria-label="本条消息使用的技能">
              {skills.map((skill) => (
                <span key={skill} className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                  <Boxes className="h-2.5 w-2.5" />使用工具 · {skill}
                </span>
              ))}
            </div>
          )}
          <div className="w-fit whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-2.5 text-sm leading-6 text-white">
            {displayUserMessageText(message)}
          </div>
        </div>
      </div>
    )
  }

  const visibleParts = message.parts.filter(isUserVisibleMessagePart)
  if (visibleParts.length === 0) return null

  return (
    <div className="flex gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Bot className="h-4 w-4" /></span>
      <div className="min-w-0 max-w-[88%] space-y-1">
        {visibleParts.map((part, index) => (
          <AiErrorBoundary
            key={`${message.id}-part-${index}`}
            level="part"
            title="该消息片段显示异常"
            resetKey={`${message.id}:${index}`}
          >
            <MessagePart part={part} />
          </AiErrorBoundary>
        ))}
      </div>
    </div>
  )
}

function AgentInteractionCard({
  interaction,
  onAnswer,
  onCancel,
}: {
  interaction: JwPendingInteraction
  onAnswer: (answers: Record<string, string | string[]>) => Promise<void>
  onCancel: () => Promise<void>
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setSelected({})
    setCustom({})
    setSubmitting(false)
    setError('')
  }, [interaction.id])

  const complete = interaction.questions.every((question) =>
    Boolean((custom[question.id] || '').trim() || (selected[question.id] || []).length))

  const resolvedAnswers = () => Object.fromEntries(interaction.questions.map((question) => {
    const customValue = (custom[question.id] || '').trim()
    const values = selected[question.id] || []
    return question.multiSelect
      ? [question.id, customValue ? [...values, customValue] : values]
      : [question.id, customValue || values[0] || '']
  })) as Record<string, string | string[]>

  const run = async (action: 'answer' | 'cancel') => {
    if (submitting || (action === 'answer' && !complete)) return
    setSubmitting(true)
    setError('')
    try {
      if (action === 'answer') await onAnswer(resolvedAnswers())
      else await onCancel()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : action === 'answer' ? '提交回答失败' : '取消交互失败')
    } finally { setSubmitting(false) }
  }

  return (
    <div className="ml-11 max-w-2xl rounded-xl border border-brand-200 bg-brand-50/50 p-4" aria-label="AI 交互问题">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-brand-800">
        <Bot className="h-4 w-4" />AI 需要你的选择
      </div>
      <div className="space-y-4">
        {interaction.questions.map((question) => (
          <fieldset key={question.id} disabled={submitting}>
            <legend className="text-sm font-medium text-slate-800">
              <span className="mr-2 rounded bg-white px-1.5 py-0.5 text-xs text-brand-600">{question.header}</span>
              {question.question}
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {question.options.map((option) => {
                const checked = (selected[question.id] || []).includes(option.label)
                return (
                  <label key={option.label} className={`cursor-pointer rounded-lg border p-2.5 ${checked ? 'border-brand-400 bg-white' : 'border-slate-200 bg-white/70'}`}>
                    <span className="flex items-start gap-2">
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={`interaction-${interaction.id}-${question.id}`}
                        checked={checked}
                        onChange={() => setSelected((current) => {
                          const values = current[question.id] || []
                          return {
                            ...current,
                            [question.id]: question.multiSelect
                              ? checked ? values.filter((value) => value !== option.label) : [...values, option.label]
                              : [option.label],
                          }
                        })}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block text-xs font-medium text-slate-700">{option.label}</span>
                        {option.description && <span className="mt-0.5 block text-xs leading-4 text-slate-500">{option.description}</span>}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
            <input
              value={custom[question.id] || ''}
              onChange={(event) => setCustom((current) => ({ ...current, [question.id]: event.target.value.slice(0, 500) }))}
              placeholder="其他回答（填写后优先采用）"
              className="input mt-2 h-9 bg-white text-xs"
            />
          </fieldset>
        ))}
      </div>
      {error && <p className="mt-3 text-xs text-rose-600">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => { void run('cancel') }} disabled={submitting}>取消并继续</Button>
        <Button onClick={() => { void run('answer') }} loading={submitting} disabled={!complete}>提交回答</Button>
      </div>
    </div>
  )
}

type ConversationTimelineItem =
  | {
      kind: 'message'
      key: string
      timestampMs: number
      stableOrder: number
      message: SafeAgentMessage
    }
  | {
      kind: 'task'
      key: string
      timestampMs: number
      stableOrder: number
      task: AiTask
    }
  | {
      kind: 'qa'
      key: string
      timestampMs: number
      stableOrder: number
      answer: ProjectQaAnswer
    }

function validTimelineTimestamp(value: string | undefined) {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function messageTimelineTimestamp(messages: SafeAgentMessage[], index: number) {
  const direct = validTimelineTimestamp(messages[index]?.timestamp)
  if (direct !== undefined) return direct

  let previousIndex = index - 1
  let previousTimestamp: number | undefined
  while (previousIndex >= 0 && previousTimestamp === undefined) {
    previousTimestamp = validTimelineTimestamp(messages[previousIndex]?.timestamp)
    if (previousTimestamp === undefined) previousIndex -= 1
  }
  let nextIndex = index + 1
  let nextTimestamp: number | undefined
  while (nextIndex < messages.length && nextTimestamp === undefined) {
    nextTimestamp = validTimelineTimestamp(messages[nextIndex]?.timestamp)
    if (nextTimestamp === undefined) nextIndex += 1
  }

  if (previousTimestamp !== undefined && nextTimestamp !== undefined) {
    const position = (index - previousIndex) / (nextIndex - previousIndex)
    return previousTimestamp + (nextTimestamp - previousTimestamp) * position
  }
  if (previousTimestamp !== undefined) return previousTimestamp + (index - previousIndex)
  if (nextTimestamp !== undefined) return nextTimestamp - (nextIndex - index)
  // 仅历史异常消息可能没有时间；保持其原始顺序并放在有服务端时间的事件之前。
  return index
}

function buildConversationTimeline(
  messages: SafeAgentMessage[],
  tasks: AiTask[],
  answers: ProjectQaAnswer[],
): ConversationTimelineItem[] {
  const taskIds = tasks.map((task) => task.id)
  const messageItems: ConversationTimelineItem[] = messages.flatMap((message, index) => (
    isFormalAiTaskReceiptMessage(message, taskIds)
      ? []
      : [{
          kind: 'message' as const,
          key: `message:${message.id}:${index}`,
          timestampMs: messageTimelineTimestamp(messages, index),
          stableOrder: index,
          message,
        }]
  ))
  const visibleUserPrompts = new Set(
    messages
      .filter((message) => message.role === 'user')
      .map((message) => displayUserMessageText(message).replace(/\s+/g, ' ').trim())
      .filter(Boolean),
  )
  const taskPromptItems: ConversationTimelineItem[] = tasks.flatMap((task, index) => {
    const prompt = typeof task.parameters.conversationPrompt === 'string'
      ? task.parameters.conversationPrompt.replace(/\s+/g, ' ').trim()
      : ''
    if (!prompt || visibleUserPrompts.has(prompt)) return []
    return [{
      kind: 'message' as const,
      key: `task-prompt:${task.id}`,
      timestampMs: (validTimelineTimestamp(task.createdAt) ?? Number.MAX_SAFE_INTEGER) - 1,
      stableOrder: messages.length + index * 2,
      message: {
        id: `task-prompt:${task.id}`,
        role: 'user' as const,
        parts: [{ type: 'text', text: prompt }],
        timestamp: task.createdAt,
        malformed: false,
      },
    }]
  })
  const taskItems: ConversationTimelineItem[] = tasks.map((task, index) => ({
    kind: 'task',
    key: `task:${task.id}`,
    timestampMs: validTimelineTimestamp(
      typeof task.parameters.clientTimelineStartedAt === 'string'
        ? task.parameters.clientTimelineStartedAt
        : task.createdAt,
    ) ?? Number.MAX_SAFE_INTEGER,
    stableOrder: messages.length + index * 2 + 1,
    task,
  }))
  const qaItems: ConversationTimelineItem[] = answers.map((answer, index) => ({
    kind: 'qa',
    key: `qa:${answer.id}`,
    timestampMs: validTimelineTimestamp(answer.createdAt) ?? Number.MAX_SAFE_INTEGER,
    stableOrder: messages.length + tasks.length * 2 + index,
    answer,
  }))
  return [...messageItems, ...taskPromptItems, ...taskItems, ...qaItems].sort((left, right) =>
    left.timestampMs - right.timestampMs || left.stableOrder - right.stableOrder)
}

function mergeAiTaskSnapshot(
  currentTasks: AiTask[],
  serverTasks: AiTask[],
  conversationId: string,
) {
  const claimedPreparationIds = new Set(
    serverTasks.flatMap((task) => {
      const preparationId = task.parameters.clientPreparationId
      return typeof preparationId === 'string' && preparationId ? [preparationId] : []
    }),
  )
  const clientTasks = currentTasks.filter((task) => {
    if (!task.clientOnly || task.conversationId !== conversationId) return false
    const preparationId = task.parameters.clientPreparationId
    return typeof preparationId !== 'string' || !claimedPreparationIds.has(preparationId)
  })
  const mergedServerTasks = serverTasks.map((task) => {
    const currentTask = currentTasks.find((item) => item.id === task.id)
    const currentPrompt = currentTask?.parameters.conversationPrompt
    if (
      typeof task.parameters.conversationPrompt !== 'string'
      && typeof currentPrompt === 'string'
      && currentPrompt.trim()
    ) {
      return {
        ...task,
        parameters: { ...task.parameters, conversationPrompt: currentPrompt },
      }
    }
    return task
  })
  return [...mergedServerTasks, ...clientTasks]
}

// ———————————— PPT 生成任务看板（长任务的阶段 + 计时 + 预期）————————————
// PPT 生成耗时数分钟，纯前端根据已发生的工具事件推断阶段并计时，让用户对等待有预期。
// 数据来源：agent.messages 里的 tool part（dynamic-tool），不接后端进度 API。
function pptStageFromParts(parts: SafeAgentPart[]): { active: boolean; stage: string } {
  let active = false
  let stage = '正在准备'
  for (const p of parts) {
    if (p?.type !== 'dynamic-tool') continue
    const name = String(p.toolName || '')
    const running = p.state === 'input-streaming' || p.state === 'input-available' || p.state === 'call'
    const input = (p.input && typeof p.input === 'object') ? safeStringify(p.input, 8000, 0) : ''
    const isPpt =
      name === 'start_ppt_generation' ||
      name === 'task' ||
      /ppt|gorden|slide|pptx/i.test(name) ||
      /ppt_task\.py|gorden|generate_gateway_slide_image|make_.*editable|pptx|slides?\//i.test(input)
    if (!isPpt) continue
    // 只要该轮里出现过 PPT 相关工具且最后一个 PPT 工具仍在跑，就算 active
    if (running) active = true
    // 阶段推断（尽量贴近 gorden 流水线）
    if (/discover/i.test(input)) stage = '正在规划大纲与检索资料'
    else if (/generate_gateway_slide_image|slide_image|出图|image-deck/i.test(input)) stage = '正在生成幻灯片图片（逐页出图）'
    else if (/editable|make_.*editable|b7_texts|逆向|pptx/i.test(input)) stage = '正在逆向为可编辑 pptx'
    else if (/activate_skill/i.test(name) || /activate_skill/i.test(input)) stage = '正在准备 PPT 生成规则'
    else if (name === 'start_ppt_generation') stage = '正在启动 PPT 生成'
    else stage = '正在生成 PPT'
  }
  return { active, stage }
}

function PptTaskBoard({ parts, busy }: { parts: SafeAgentPart[]; busy: boolean }) {
  const { active } = pptStageFromParts(parts)
  const show = busy && active
  const [start, setStart] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (show && start == null) setStart(Date.now())
    if (!show) setStart(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show])
  useEffect(() => {
    if (!show) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [show])
  if (!show) return null
  const elapsed = start ? Math.max(0, Math.floor((now - start) / 1000)) : 0
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')
  return (
    <div className="my-2 rounded-xl border border-brand-200 bg-brand-50/60 p-3 shadow-card">
      <div className="flex items-center gap-2">
        <span className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-300 border-t-brand-600" />
        <span className="text-sm font-semibold text-brand-800">PPT 生成任务进行中</span>
        <span className="ml-auto font-mono text-xs text-brand-600">已用时 {mm}:{ss}</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-brand-500">PPT 生成通常需要 3–8 分钟，取决于页数与图像网关负载，请耐心等待，期间可查看下方工具调用进度。</p>
    </div>
  )
}

// OSS/外链下载：跨域 URL 的 <a download> 会被浏览器忽略而变成导航（尤其 pptx 会当成预览打开），
// 故先 fetch 成 blob 再走强制下载，保证真的落盘。失败时兜底用原链接新标签打开。
async function downloadRemoteUrl(url: string, filename: string): Promise<void> {
  toast(`正在下载「${filename}」…`, 'info')
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    triggerBlobDownload(await res.blob(), filename)
    toast(`「${filename}」已开始下载`, 'success')
  } catch (e) {
    toast(`直接下载失败，已为你在新标签打开：${(e as Error).message}`, 'error')
    window.open(url, '_blank', 'noopener')
  }
}

function Chat() {
  const [searchParams] = useSearchParams()
  const projects = useAppStore((state) => state.projects)
  const files = useAppStore((state) => state.files)
  const { showToast } = useToast()
  const showAiDiagnostics = useAuthStore(state => isAiPlatformAdminRole(state.user?.role ?? ''))
  const LS_LAST_PROJECT = 'cybernaut-ai-last-project'
  const LS_LAST_CONV = 'cybernaut-ai-last-conv'
  // 项目优先级: URL ?project= > 上次选的(localStorage) > 空（等待 store 加载）
  const requestedProjectId = searchParams.get('project') ?? ''
  const initialProject = requestedProjectId || localStorage.getItem(LS_LAST_PROJECT) || ''
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [projectId, setProjectId] = useState(initialProject)
  const [input, setInput] = useState('')
  // 每个会话由 MySQL 会话主键和统一 Agent 会话标识关联，列表随账号跨设备同步。
  // rowId 用于改名/删除，agentId 是兼容历史数据的运行时会话标识。
  type ChatSession = {
    rowId: string
    agentId: string
    title: string
    scope: 'project' | 'global'
    projectId?: string | null
    projectName?: string | null
    modelId?: string | null
  }
  type AvailableModel = {
    id: string; modelKey: string; displayName: string; capabilityTags: string[];
    contextWindow: number | null; isDefault: boolean
  }
  type AvailableCapability = {
    id: string; kind: 'skill' | 'agent' | 'mcp' | 'plugin'; capabilityKey: string; name: string;
    description: string | null; packageVersion: string; toolNames: string[]
  }
  const LS_KEY = 'cybernaut-ai-sessions' // 仅用于一次性迁移旧的浏览器本地会话
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [convId, setConvId] = useState<string>('')
  const [renamingSessionId, setRenamingSessionId] = useState<string>('')
  const [renamingTitle, setRenamingTitle] = useState('')
  const initedRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldFollowConversationBottomRef = useRef(true)
  const [aiTasks, setAiTasks] = useState<AiTask[]>([])
  const [aiTasksLoading, setAiTasksLoading] = useState(false)
  const reportTaskUsage = useMemo(() => aiTasks.reduce((summary, task) => {
    summary.taskCount += 1
    if (task.status === 'pending' || task.status === 'running') summary.activeTaskCount += 1
    if (!task.usage) return summary
    summary.modelCalls += task.usage.modelCalls
    summary.usageCalls += task.usage.usageCalls
    summary.totalTokens += task.usage.totalTokens
    return summary
  }, { taskCount: 0, activeTaskCount: 0, modelCalls: 0, usageCalls: 0, totalTokens: 0 }), [aiTasks])
  const [qaAnswers, setQaAnswers] = useState<ProjectQaAnswer[]>([])
  const [qaAnswersLoading, setQaAnswersLoading] = useState(false)
  const [taskMutationId, setTaskMutationId] = useState<string | null>(null)
  const [selectedQuickSkill, setSelectedQuickSkill] = useState<AiQuickSkillSelection | null>(null)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newSessionProjectId, setNewSessionProjectId] = useState(initialProject)
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [availableCapabilities, setAvailableCapabilities] = useState<AvailableCapability[]>([])
  const [selectedCapabilityIds, setSelectedCapabilityIds] = useState<string[]>([])
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([])
  const [capabilityOpen, setCapabilityOpen] = useState(false)
  const [capabilitySearch, setCapabilitySearch] = useState('')
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [capabilitySaving, setCapabilitySaving] = useState(false)
  const [newSessionModelId, setNewSessionModelId] = useState('')
  const [creatingSession, setCreatingSession] = useState(false)

  const selectedProject = projects.find((project) => project.id === projectId) ?? projects[0]
  const currentSession = sessions.find((session) => session.agentId === convId)
  // 正式任务以会话绑定项目为准。会话加载完成后，头部、文件、快捷任务和
  // 产物区域必须使用同一个项目，不能继续展示 localStorage 中的旧选择。
  const currentProject = currentSession?.projectId
    ? projects.find((project) => project.id === currentSession.projectId)
    : currentSession
      ? undefined
      : selectedProject
  const newSessionProject = projects.find((project) => project.id === newSessionProjectId)
  const projectFiles = files.filter((file) => file.projectId === currentProject?.id)
  const currentConversationRowId = currentSession?.rowId ?? ''
  const currentConversationRowIdRef = useRef(currentConversationRowId)
  currentConversationRowIdRef.current = currentConversationRowId
  const hasActiveAiTask = aiTasks.some(
    (task) => !task.clientOnly && (task.status === 'pending' || task.status === 'running'),
  )
  const artifactRefreshKey = aiTasks
    .map((task) => `${task.id}:${task.status}:${task.updatedAt}:${(task.artifacts ?? []).map((artifact) => artifact.id).join(',')}`)
    .join('|')
  // 把 showToast 注册到模块级 toast 桥（供 downloadRemoteUrl 等模块函数弹提示）
  useEffect(() => { registerAiToast(showToast) }, [showToast])
  useEffect(() => {
    let active = true
    void apiGet<{ list: AvailableModel[] }>('/ai/model-settings/available').then(({ list }) => {
      if (!active) return
      setAvailableModels(list)
      setNewSessionModelId((current) => current || list.find((model) => model.isDefault)?.id || list[0]?.id || '')
    }).catch(() => { if (active) setAvailableModels([]) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    if (!currentConversationRowId) {
      setAvailableCapabilities([]); setSelectedCapabilityIds([])
      return () => { active = false }
    }
    void apiGet<{ available: AvailableCapability[]; selectedIds: string[] }>(`/ai/capabilities/conversations/${currentConversationRowId}`).then((result) => {
      if (!active) return
      setAvailableCapabilities(result.available)
      // 迁移前会话没有选择记录，界面以“全部已授权能力”呈现并保持兼容。
      setSelectedCapabilityIds(result.selectedIds.length ? result.selectedIds : result.available.map((item) => item.id))
    }).catch(() => { if (active) { setAvailableCapabilities([]); setSelectedCapabilityIds([]) } })
    return () => { active = false }
  }, [currentConversationRowId])

  const filteredCapabilities = useMemo(() => {
    const keyword = capabilitySearch.trim().toLocaleLowerCase()
    const skills = availableCapabilities.filter((item) => item.kind === 'skill')
    if (!keyword) return skills
    return skills.filter((item) => (
      `${item.name} ${item.capabilityKey} ${item.description || ''}`.toLocaleLowerCase().includes(keyword)
    ))
  }, [availableCapabilities, capabilitySearch])

  const activeSkills = useMemo(
    () => activeSkillIds
      .map((id) => availableCapabilities.find((item) => item.id === id && item.kind === 'skill'))
      .filter((item): item is AvailableCapability => Boolean(item)),
    [activeSkillIds, availableCapabilities],
  )
  const businessSkillName = (item: AvailableCapability) => ({
    'generate-investment-compliance-note': '合规说明',
    'draft-investment-proposal': '投资提案',
    'investment-committee-ppt': '投资建议书',
    'draft-due-diligence-report': '尽调报告',
    'draft-investment-qa': '项目问答',
    'generate-document-from-template': '上传模板',
  }[item.capabilityKey] ?? item.name)

  const slashCapabilities = useMemo(() => {
    const query = getSlashCommandQuery(input)?.trim().toLocaleLowerCase() ?? ''
    return availableCapabilities
      .filter((item) => item.kind === 'skill')
      .filter((item) => !query || `${item.name} ${item.capabilityKey} ${item.description || ''}`.toLocaleLowerCase().includes(query))
      .slice(0, 8)
  }, [availableCapabilities, input])

  async function saveConversationCapabilities(nextIds: string[]) {
    if (!currentConversationRowId) return false
    setCapabilitySaving(true)
    try {
      const result = await apiPut<{ available: AvailableCapability[]; selectedIds: string[] }>(
        `/ai/capabilities/conversations/${currentConversationRowId}`,
        { capabilityIds: nextIds },
      )
      setAvailableCapabilities(result.available)
      setSelectedCapabilityIds(result.selectedIds)
      return true
    } catch (error) {
      showToast((error as Error).message, 'error')
      return false
    } finally { setCapabilitySaving(false) }
  }

  const activateSkill = (item: AvailableCapability) => {
    setActiveSkillIds((ids) => ids.includes(item.id) ? ids : [...ids, item.id])
    if (!selectedCapabilityIds.includes(item.id)) {
      const nextIds = [...selectedCapabilityIds, item.id]
      setSelectedCapabilityIds(nextIds)
      void saveConversationCapabilities(nextIds)
    }
  }

  const toggleActiveSkill = (item: AvailableCapability) => {
    if (activeSkillIds.includes(item.id)) {
      setActiveSkillIds((ids) => ids.filter((id) => id !== item.id))
      return
    }
    activateSkill(item)
  }

  const selectSlashCapability = (item: AvailableCapability) => {
    activateSkill(item)
    setSlashMenuOpen(false)
    const match = input.match(/(?:^|\s)\/([^\s]*)$/)
    if (match && typeof match.index === 'number') {
      const prefix = input.slice(0, match.index)
      const separator = match[0].startsWith(' ') ? ' ' : ''
      setInput(`${prefix}${separator}`)
    }
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }

  useEffect(() => {
    if (!capabilityOpen && !slashMenuOpen) return
    const closeMenus = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && (
        target.closest('[data-ai-skill-menu="true"]')
        || target.closest('[data-ai-capability-trigger="true"]')
      )) return
      setCapabilityOpen(false)
      setSlashMenuOpen(false)
      setCapabilitySearch('')
    }
    document.addEventListener('mousedown', closeMenus)
    return () => document.removeEventListener('mousedown', closeMenus)
  }, [capabilityOpen, slashMenuOpen])
  // 记住当前项目(下次进来恢复)
  useEffect(() => { if (projectId) localStorage.setItem(LS_LAST_PROJECT, projectId) }, [projectId])
  // 记住当前会话(下次进来恢复)
  useEffect(() => { if (convId) localStorage.setItem(LS_LAST_CONV, convId) }, [convId])
  useEffect(() => {
    if (!currentSession) return
    const sessionProjectId = currentSession.projectId
    if (sessionProjectId) {
      setScope('project')
      setProjectId((current) => current === sessionProjectId
        ? current
        : sessionProjectId)
      return
    }
    setScope('global')
  }, [currentSession?.rowId, currentSession?.projectId])
  useEffect(() => {
    if (
      newSessionOpen
      && projects.length > 0
      && !projects.some((project) => project.id === newSessionProjectId)
    ) {
      setNewSessionProjectId(projects[0].id)
    }
  }, [newSessionOpen, newSessionProjectId, projects])
  // 正式业务任务与 chat_conversations 主键关联。切换或刷新会话时从服务端恢复，
  // 不依赖旧服务的瞬时消息状态。
  useEffect(() => {
    let active = true
    if (!currentConversationRowId) {
      setAiTasks([])
      setAiTasksLoading(false)
      return () => { active = false }
    }
    setAiTasks((items) => items.filter(
      (task) => task.clientOnly && task.conversationId === currentConversationRowId,
    ))
    setAiTasksLoading(true)
    apiGet<{ list: AiTask[] }>(`/ai/tasks?conversationId=${encodeURIComponent(currentConversationRowId)}`)
      .then((result) => {
        if (active) {
          setAiTasks((items) => mergeAiTaskSnapshot(
            items,
            result.list ?? [],
            currentConversationRowId,
          ))
        }
      })
      .catch((error) => {
        console.warn('AI task recovery is temporarily unavailable', error)
        if (active) showToast('文档任务进度正在恢复，请稍后查看', 'info')
      })
      .finally(() => {
        if (active) setAiTasksLoading(false)
      })
    return () => { active = false }
  }, [currentConversationRowId, showToast])

  // 项目 Q&A 由 Express 持久化在会话中。刷新、重新登录或跨设备打开时直接恢复，
  // 不依赖客户端瞬时内存，也不会把业务 Skill 降级成提示词标记。
  useEffect(() => {
    let active = true
    if (!currentConversationRowId) {
      setQaAnswers([])
      setQaAnswersLoading(false)
      return () => { active = false }
    }
    setQaAnswers([])
    setQaAnswersLoading(true)
    apiGet<{ list: ProjectQaAnswer[] }>(
      `/ai/qa?conversationId=${encodeURIComponent(currentConversationRowId)}`,
    )
      .then((result) => {
        if (active) setQaAnswers(result.list ?? [])
      })
      .catch((error) => {
        console.warn('Project Q&A recovery is temporarily unavailable', error)
        if (active) showToast('项目 Q&A 正在恢复，请稍后查看', 'info')
      })
      .finally(() => {
        if (active) setQaAnswersLoading(false)
      })
    return () => { active = false }
  }, [currentConversationRowId, showToast])

  // 仅在当前会话存在等待中/运行中任务时轮询；任务进入终态后自动停止。
  useEffect(() => {
    if (!currentConversationRowId || !hasActiveAiTask) return
    let active = true
    const poll = async () => {
      try {
        const result = await apiGet<{ list: AiTask[] }>(`/ai/tasks?conversationId=${encodeURIComponent(currentConversationRowId)}`)
        if (active) {
          setAiTasks((items) => mergeAiTaskSnapshot(
            items,
            result.list ?? [],
            currentConversationRowId,
          ))
        }
      } catch (error) {
        // 轮询失败不清空已有文档 Agent 消息，避免短暂网络波动造成结果消失。
        console.warn('AI task polling failed:', (error as Error).message)
      }
    }
    const timer = window.setInterval(() => { void poll() }, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [currentConversationRowId, hasActiveAiTask])

  // JW Runtime 与 API 同进程；消息、工具过程和会话状态统一写入 MySQL。
  const agent = useJwAgent(convId || undefined)
  // 运行时消息仍按安全结构归一化，后续渲染和
  // “生成结束”副作用都只读取安全结构，单条畸形消息不会再拖垮整个 AI 页面。
  const messages = useMemo(() => normalizeAgentMessages(agent.messages), [agent.messages])
  const conversationTimeline = useMemo(
    () => buildConversationTimeline(messages, aiTasks, qaAnswers),
    [messages, aiTasks, qaAnswers],
  )
  const agentErrorMessage = safeAgentErrorMessage(agent.error)
  const agentErrorRef = useRef({ message: '', errorId: '' })
  if (agentErrorMessage && agentErrorRef.current.message !== agentErrorMessage) {
    agentErrorRef.current = { message: agentErrorMessage, errorId: createAiErrorId() }
  }
  const agentError = (agentErrorMessage && agent.status === 'error') ? agentErrorRef.current : null
  useEffect(() => {
    if (!agentError) return
    console.error(`[${agentError.errorId}] JW Agent 返回错误`, agentError.message)
  }, [agentError])
  // 正在提交(submitted)或回答(streaming)算"忙"，显示停止按钮；connecting 是初次加载历史/建连，不算忙。
  const busy = agent.status === 'streaming' || agent.status === 'submitted'
  // React 状态更新前也可能连续触发键盘/点击事件，ref 作为同步锁杜绝重复提交。
  const submitLockRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const sending = busy || submitting
  const prevBusyRef = useRef(false)
  // 用户上传的文件（本轮待发）：path=沙箱相对路径(agent 可 read/bash 直读)，rag=是否已入项目知识库
  const [uploads, setUploads] = useState<{
    name: string
    path: string
    rag: boolean
    fileId?: string
  }[]>([])
  const [uploading, setUploading] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const uploadLockRef = useRef(false)
  const dragDepthRef = useRef(0)

  // 归一文件类型为 <=16 字符的短标签（优先扩展名，回退 MIME 主类型），适配 project_files.type varchar(16)
  const fileTypeLabel = (file: File): string => {
    const ext = (file.name.split('.').pop() || '').toUpperCase()
    if (ext && ext.length <= 8) return ext
    const mime = file.type || ''
    const sub = mime.split('/')[1] || mime.split('/')[0] || ''
    return sub.slice(0, 16) || 'FILE'
  }

  const fileToBase64 = (file: File) =>
    new Promise<string>((res, rej) => {
      const reader = new FileReader()
      reader.onload = () => res(String(reader.result))
      reader.onerror = rej
      reader.readAsDataURL(file)
    })

  // 选文件后：①落 agent 沙箱 uploads/(供直读) ②选了项目则同步入 RAG(供长期检索)
  // 并行上传：多选文件并发跑（fileToBase64 + 落沙箱 + 可选入 RAG），
  // 单个失败不影响其他，实时显示「上传中 N/M」，全部结束汇总成功/失败数。
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const uploadFiles = async (inputFiles: File[]) => {
    const unsupported = inputFiles.filter((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      return !AI_UPLOAD_EXTENSIONS.has(extension)
    })
    const list = inputFiles.filter((file) => !unsupported.includes(file))
    if (unsupported.length) {
      showToast(
        `暂不支持：${unsupported.slice(0, 3).map((file) => file.name).join('、')}${unsupported.length > 3 ? '…' : ''}`,
        'error',
      )
    }
    if (!list.length) return
    if (uploadLockRef.current) {
      showToast('已有文件正在上传，请等待完成后再添加', 'info')
      return
    }
    uploadLockRef.current = true
    setUploading(true)
    let done = 0
    setUploadProgress({ done: 0, total: list.length })

    try {
      const uploadOne = async (file: File): Promise<{
        name: string
        path: string
        rag: boolean
        fileId?: string
      }> => {
        const dataUrl = await fileToBase64(file)
        const ws = await apiPost<{ path: string; name: string }>('/workspace/file', {
          name: file.name, dataBase64: dataUrl, subdir: convId || undefined,
        })
        let rag = false
        let fileId: string | undefined
        // ZIP 作为会话附件供 Agent 直接读取；项目知识库暂不对压缩包做自动展开和正文入库。
        const shouldSyncToProjectKnowledge = !file.name.toLowerCase().endsWith('.zip')
        if (scope === 'project' && currentProject?.id && shouldSyncToProjectKnowledge) {
          try {
            // 上传大文件走公网可能慢，用 5 分钟超时覆盖默认 120s，避免大文件被掐断。
            const upCtrl = new AbortController()
            const upTimer = setTimeout(() => upCtrl.abort(), 300000)
            let resp: { file?: { id: string; parseStatus: string } }
            try {
              resp = await apiPost<{ file?: { id: string; parseStatus: string } }>('/projects/files/upload', {
                // ⚠️ project_files.type 是 varchar(16)：pptx/xlsx/docx 的浏览器 MIME 长达 60+ 字符会触发
                // PG 22001「value too long」导致入库 500 失败。这里归一为短扩展名标签（PPTX/PDF/XLSX…）。
                projectId: currentProject.id, name: file.name, type: fileTypeLabel(file),
                uploader: useAuthStore.getState().user?.name ?? 'AI 助手上传', dataBase64: dataUrl,
              }, { signal: upCtrl.signal })
            } finally { clearTimeout(upTimer) }
            rag = true
            fileId = resp?.file?.id
            // 【需求:助手上传马上同步到资料库】把入库的文件并入全局 store.files，
            // 资料库页(ProjectDetailPage 读同一 store)立即可见，无需刷新。
            if (resp?.file) {
              const pid = currentProject.id
              useAppStore.setState((state) => ({
                files: [{
                  projectId: pid, name: file.name, type: fileTypeLabel(file), category: '项目资料',
                  size: '', uploader: useAuthStore.getState().user?.name ?? 'AI 助手上传',
                  visibility: '项目成员', version: 1, uploadedAt: new Date().toISOString(), ...resp.file,
                } as never, ...state.files.filter((f) => !(f as { id?: string }).id || (f as { id?: string }).id !== resp.file!.id)],
              }))
            }
          } catch (err) {
            // 入 RAG 失败不阻断：文件已落沙箱可用；409=已存在视为已入库
            if (err instanceof ApiError && err.status === 409) {
              rag = true
              fileId = (files.find((item) =>
                item.projectId === currentProject.id && item.name === file.name) as { id?: string } | undefined)?.id
            }
            else showToast(`「${file.name}」入库失败（文件已可用于本轮对话）：${(err as Error).message}`, 'error')
          }
        }
        return { name: ws.name, path: ws.path, rag, fileId }
      }

      const results = await Promise.allSettled(
        list.map((file) =>
          uploadOne(file).finally(() => { done += 1; setUploadProgress({ done, total: list.length }) }),
        ),
      )

      const ok: { name: string; path: string; rag: boolean; fileId?: string }[] = []
      const failed: string[] = []
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') ok.push(result.value)
        else failed.push(list[index].name)
      })
      if (ok.length) setUploads((prev) => [...prev, ...ok])
      if (failed.length === 0) showToast(`已上传 ${ok.length} 个文件`, 'success')
      else if (ok.length === 0) showToast(`上传失败：${failed.length} 个文件全部失败`, 'error')
      else showToast(`上传完成：成功 ${ok.length} 个，失败 ${failed.length} 个（${failed.slice(0, 3).join('、')}${failed.length > 3 ? '…' : ''}）`, 'error')
    } finally {
      setUploadProgress(null)
      setUploading(false)
      uploadLockRef.current = false
    }
  }

  const onPickFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(event.target.files ?? [])
    event.target.value = ''
    void uploadFiles(list)
  }

  const isFileDrag = (event: React.DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes('Files')

  const onDragEnterFiles = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    setDraggingFiles(true)
  }

  const onDragOverFiles = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeaveFiles = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDraggingFiles(false)
  }

  const onDropFiles = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDraggingFiles(false)
    void uploadFiles(Array.from(event.dataTransfer.files))
  }

  const removeUpload = (path: string) => setUploads((prev) => prev.filter((u) => u.path !== path))

  const onConversationScroll = (event: React.UIEvent<HTMLDivElement>) => {
    shouldFollowConversationBottomRef.current = isConversationNearBottom(event.currentTarget)
  }

  useEffect(() => {
    // 每个会话独立从最新消息开始；上一会话的手动上滑状态不能带到新会话。
    shouldFollowConversationBottomRef.current = true
  }, [convId])

  useEffect(() => {
    const conversation = scrollRef.current
    if (!conversation || !shouldFollowConversationBottomRef.current) return
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' })
  }, [messages, aiTasks.length, qaAnswers.length])

  // agent 从"忙"变"闲"（跑完一轮）后刷新正式任务快照
  useEffect(() => {
    if (prevBusyRef.current && !busy) {
      // 快捷 Skill 由对话中的 create_ai_task 创建任务；本轮结束后立即恢复
      // 当前会话任务快照，确保文档 Agent 执行消息无需刷新即可出现并进入轮询。
      if (currentConversationRowId) {
        void apiGet<{ list: AiTask[] }>(
          `/ai/tasks?conversationId=${encodeURIComponent(currentConversationRowId)}`,
        ).then((result) => {
          setAiTasks((items) => mergeAiTaskSnapshot(
            items,
            result.list ?? [],
            currentConversationRowId,
          ))
        }).catch((error) => {
          console.warn('AI task refresh after Agent turn failed:', (error as Error).message)
        })
      }
    }
    prevBusyRef.current = busy
  }, [busy, currentConversationRowId])

  const send = async (
    question = input,
    contextOverride?: { projectId: string; projectName: string },
  ): Promise<boolean> => {
    const quickSkill = contextOverride ? null : selectedQuickSkill
    const clean = question.trim() || (quickSkill
      ? quickSkill.actionId === 'custom_template'
        ? '请根据已上传模板生成文档。'
        : `请生成${quickSkill.actionLabel}。`
      : '')
    if (!clean && uploads.length === 0) return false
    if (busy || uploading || submitLockRef.current) return false
    if (quickSkill) {
      if (!UUID_PATTERN.test(quickSkill.projectId) || quickSkill.projectId !== currentSession?.projectId) {
        showToast('快捷工具与当前会话项目不一致，请重新选择', 'error')
        return false
      }
      const unavailableUploads = uploads.filter((upload) => !upload.fileId)
      if (unavailableUploads.length) {
        showToast(
          `以下本轮附件尚未进入项目资料库，无法完整提交给文档 Skill：${unavailableUploads.map((upload) => upload.name).join('、')}`,
          'error',
        )
        return false
      }
    }
    submitLockRef.current = true
    setSubmitting(true)
    setInput('')
    setCapabilityOpen(false)
    setSlashMenuOpen(false)
    const requestedSkills = [
      ...(quickSkill ? [`${quickSkill.actionLabel}（${quickSkill.skillName}）`] : []),
      ...activeSkills.map((item) => `${item.name}（${item.capabilityKey}）`),
    ]
    const skillCtx = requestedSkills.length
      ? `\n【本轮指定技能】${requestedSkills.join('、')}`
      : ''
    // 把本轮上传文件的可审计路径和入库状态随消息带给 Agent；正式文档
    // 快捷 Skill 另以结构化 fileId 绑定，服务端会校验文件属于当前项目。
    const fileCtx = uploads.length
      ? `\n【已上传文件】\n`
        + uploads.map((u) => `- ${u.path}${u.rag ? '（已入项目知识库，可通过项目资料工具检索）' : '（仅会话工作区）'}`).join('\n')
      : ''
    // 把项目上下文随消息带给 agent（agent 的 search_project_docs 工具会用到）
    const sessionProject = currentSession?.projectId
      ? projects.find((project) => project.id === currentSession.projectId)
      : undefined
    // 普通问答始终使用会话创建时保存的项目，避免项目选择框与会话状态
    // 短暂不同步时把其他项目资料混进当前上下文。
    const effectiveScope = contextOverride
      ? 'project'
      : currentSession
        ? (currentSession.projectId ? 'project' : 'global')
        : scope
    const effectiveProject = contextOverride ?? (
      currentSession?.projectId
        ? {
            projectId: currentSession.projectId,
            projectName: currentSession.projectName ?? sessionProject?.name ?? '',
          }
        : currentProject
          ? { projectId: currentProject.id, projectName: currentProject.name }
          : undefined
    )
    const ctx = effectiveScope === 'global'
      ? `【范围】全局知识库\n【用户问题】${clean}${skillCtx}${fileCtx}`
      : `【当前项目】${effectiveProject?.projectName ?? ''}\n【projectId】${effectiveProject?.projectId ?? ''}\n【用户问题】${clean}${skillCtx}${fileCtx}`
    try {
      let formalPptTaskDispatched = false
      if (
        !quickSkill
        && effectiveScope === 'project'
        && effectiveProject?.projectId
        && UUID_PATTERN.test(effectiveProject.projectId)
        && UUID_PATTERN.test(currentConversationRowId)
      ) {
        const forceInvestmentPpt = false
        try {
          const generationMessage = `${clean
            || (forceInvestmentPpt
              ? '请根据本轮上传文件与当前项目资料生成投资建议书 PPT。'
              : '附件已上传，请读取并等待用户后续要求。')}${skillCtx}`
          const recentMessages = messages.slice(-8).map((message) => ({
            role: message.role,
            content: extractTextParts(message).slice(0, 4_000),
          })).filter((message) => message.content.trim())
          const dispatch = await apiPost<ConversationPptTaskResult>(
            '/ai/tasks/from-conversation',
            {
              projectId: effectiveProject.projectId,
              conversationId: currentConversationRowId,
              message: generationMessage,
              recentMessages,
              force: forceInvestmentPpt,
              attachmentFileIds: uploads
                .map((upload) => upload.fileId)
                .filter((fileId): fileId is string => Boolean(fileId)),
              attachmentFileNames: uploads.map((upload) => upload.name),
              sourceCutoffDate: shanghaiDateKey(),
              idempotencyKey: `chat-ppt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
            },
          )
          if (dispatch.task) {
            // 老任务可能创建于 conversationPrompt 上线前；复用任务时也先把
            // 本轮要求挂到当前快照，避免跳过通用 Agent 后用户刚发送的内容
            // 在页面上无声消失。新任务会由服务端参数持久化，刷新后仍可恢复。
            const taskWithConversationPrompt: AiTask = {
              ...dispatch.task,
              parameters: {
                ...dispatch.task.parameters,
                conversationPrompt: generationMessage.replace(/\s+/g, ' ').trim().slice(0, 1_000),
              },
            }
            setAiTasks((items) => [
              taskWithConversationPrompt,
              ...items.filter((item) => item.id !== taskWithConversationPrompt.id),
            ])
            showToast(
              dispatch.reused
                ? '当前会话已有投资建议书任务，已定位到执行消息'
                : '已根据当前对话和项目资料启动投资建议书 PPT 任务',
              'success',
            )
            formalPptTaskDispatched = true
          }
        } catch (error) {
          console.warn('Conversation PPT intent dispatch failed:', (error as Error).message)
          // 强制投资建议书意图必须成功创建持久任务，避免只产生一次性文本回复。
          if (forceInvestmentPpt) {
            throw new Error(`投资建议书任务创建失败：${(error as Error).message}`)
          }
          // 普通对话中的非强制意图识别失败时，仍保留通用问答能力。
        }
      }
      if (!formalPptTaskDispatched) {
        await agent.sendMessage(ctx, {
          skillName: quickSkill?.skillName,
          attachmentFileIds: uploads
            .map((upload) => upload.fileId)
            .filter((fileId): fileId is string => Boolean(fileId)),
          attachmentFileNames: uploads.map((upload) => upload.name),
          customTemplateId: quickSkill?.customTemplateId,
          customTemplateName: quickSkill?.customTemplateName,
          outputFormat: quickSkill?.outputFormat,
        })
      }
      setUploads([])
      if (quickSkill) setSelectedQuickSkill(null)
      return true
    } catch (err) {
      showToast(aiBusinessErrorMessage(err), 'error')
      // 用户可能已开始输入下一条草稿，失败恢复时不能覆盖新内容。
      setInput((draft) => draft.trim() ? draft : clean)
      return false
    } finally {
      submitLockRef.current = false
      setSubmitting(false)
    }
  }

  const activateSession = (session: ChatSession) => {
    setConvId(session.agentId)
    if (session.projectId) {
      setScope('project')
      setProjectId(session.projectId)
    } else {
      setScope('global')
    }
    setInput('')
    setActiveSkillIds([])
    setCapabilityOpen(false)
    setSlashMenuOpen(false)
    setSlashHighlight(0)
    setCapabilitySearch('')
    setSelectedQuickSkill(null)
    setAiTasks([])
    setQaAnswers([])
  }

  // 新建一个服务端会话并选中
  const createSession = async (
    title = '新会话',
    contextOverride?: { scope: 'project' | 'global'; projectId?: string | null; projectName?: string | null },
  ): Promise<ChatSession | null> => {
    try {
      const context = contextOverride ?? (
        scope === 'project'
          ? {
              scope: 'project' as const,
              projectId: currentProject?.id ?? null,
              projectName: currentProject?.name ?? null,
            }
          : {
              scope: 'global' as const,
              projectId: null,
              projectName: null,
            }
      )
      // 过滤掉旧格式或非法 ID（如 p-1001），避免向 MySQL UUID 字段提交无效值
      const safeProjectId = context.projectId && UUID_PATTERN.test(context.projectId)
        ? context.projectId
        : null
      const row = await apiPost<{
        id: string
        agentId?: string
        title: string
        scope?: string
        projectId?: string | null
        projectName?: string | null
      }>('/conversations', {
        title,
        scope: safeProjectId ? context.scope : 'global',
        projectId: safeProjectId,
        projectName: safeProjectId ? context.projectName : null,
        modelId: newSessionModelId || null,
      })
      const s: ChatSession = {
        rowId: row.id,
        agentId: row.agentId || row.id,
        title: row.title,
        scope: row.scope === 'global' ? 'global' : context.scope,
        projectId: row.projectId ?? context.projectId ?? null,
        projectName: row.projectName ?? context.projectName ?? null,
        modelId: newSessionModelId || null,
      }
      setSessions((prev) => [s, ...prev])
      activateSession(s)
      return s
    } catch (err) {
      showToast(`新建会话失败：${(err as Error).message}`, 'error')
      return null
    }
  }

  // 首次加载：从服务端拉会话列表；并把旧的 localStorage 会话一次性迁移到 MySQL。
  useEffect(() => {
    if (initedRef.current) return
    initedRef.current = true
    void (async () => {
      try {
        const { list } = await apiGet<{
          list: {
            id: string
            agentId?: string
            title: string
            scope?: string
            projectId?: string | null
            projectName?: string | null
            modelId?: string | null
          }[]
        }>('/conversations')
        let mapped: ChatSession[] = (list ?? []).map((r) => ({
          rowId: r.id,
          agentId: r.agentId || r.id,
          title: r.title,
          scope: r.scope === 'global' || !r.projectId ? 'global' : 'project',
          projectId: r.projectId ?? null,
          projectName: r.projectName ?? null,
          modelId: r.modelId ?? null,
        }))
        try {
          const legacy: { id: string; title?: string }[] = JSON.parse(localStorage.getItem(LS_KEY) || '[]')
          const have = new Set(mapped.map((m) => m.agentId))
          for (const s of legacy) {
            if (!s?.id || have.has(s.id)) continue
            const row = await apiPost<{
              id: string
              agentId?: string
              title: string
              scope?: string
              projectId?: string | null
              projectName?: string | null
              modelId?: string | null
            }>('/conversations', { title: s.title || '新会话', agentId: s.id })
            mapped = [{
              rowId: row.id,
              agentId: row.agentId || s.id,
              title: row.title,
              scope: row.scope === 'global' || !row.projectId ? 'global' : 'project',
              projectId: row.projectId ?? null,
              projectName: row.projectName ?? null,
              modelId: row.modelId ?? null,
            }, ...mapped]
          }
          localStorage.removeItem(LS_KEY)
        } catch { /* ignore legacy migration errors */ }
        setSessions(mapped)
        if (mapped.length) {
          // 从项目页进入 AI 时，必须优先进入同项目会话，不能恢复其他项目的
          // 上次会话后仍把头部显示成 URL 项目。若该项目还没有会话，则要求
          // 用户创建项目会话，避免第一条快捷任务落到旧项目。
          const requestedSession = requestedProjectId
            ? mapped.find((session) => session.projectId === requestedProjectId)
            : undefined
          if (requestedProjectId && !requestedSession) {
            setNewSessionProjectId(requestedProjectId)
            setNewSessionOpen(true)
            return
          }
          // 恢复目标项目会话；无显式项目时恢复上次会话，若不存在则用最近一条。
          const lastConv = localStorage.getItem(LS_LAST_CONV)
          const restored = requestedSession?.agentId
            ?? (lastConv && mapped.some((m) => m.agentId === lastConv)
              ? lastConv
              : mapped[0].agentId)
          const restoredSession = mapped.find((session) => session.agentId === restored)
            ?? mapped[0]
          activateSession(restoredSession)
        } else {
          const preferredProject = projects.find((project) => project.id === initialProject) ?? projects[0]
          setNewSessionProjectId(preferredProject?.id ?? '')
          setNewSessionOpen(true)
        }
      } catch (err) {
        showToast(`会话列表加载失败：${(err as Error).message}`, 'error')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 首轮对话「结束」后,调 LLM 把这轮总结成一句话标题,替换掉「新会话」(类似 ChatGPT/Claude)
  // 触发条件: agent 从忙→闲(prevBusyRef) 且当前会话还叫「新会话」且已有首条用户+助手消息
  const titledRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    // 只在一轮回答刚结束(busy: true→false)时判定
    if (busy) return
    const cur = sessions.find((s) => s.agentId === convId)
    if (!cur || cur.title !== '新会话') return
    if (titledRef.current.has(convId)) return  // 本会话已总结过,避免重复调 LLM
    const firstUser = messages.find((message) => message.role === 'user')
    const firstAssistant = messages.find((message) => message.role === 'assistant')
    if (!firstUser || !firstAssistant) return
    // 提取用户真实问题：project scope 下消息被注入了上下文
    // 【当前项目】xx\n【projectId】xx\n【用户问题】真实问题  或  【范围】全局知识库\n【用户问题】真实问题
    // 旧正则 /【[^】]*】[^\n]*\n?/g 会把「【用户问题】真实问题」整行一起删掉 → userText 变空 → 标题永不更新。
    // 正确做法：优先取【用户问题】后面的内容；无则剥掉上下文标签行后取剩余。
    // 标题只使用用户真正输入的内容，不能把内部任务分发回执带进会话标题。
    const rawUserText = displayUserMessageText(firstUser)
    const qMatch = rawUserText.match(/【用户问题】([\s\S]*)$/)
    const userText = (qMatch
      ? qMatch[1]
      : rawUserText.replace(/【(当前项目|projectId|范围)】[^\n]*\n?/g, '')
    ).trim()
    const assistantText = extractTextParts(firstAssistant).trim()
    if (!userText) return
    titledRef.current.add(convId)
    // 乐观先用用户问题前 18 字占位,LLM 总结回来再覆盖
    const placeholder = userText.slice(0, 18)
    setSessions((prev) => prev.map((sx) => (sx.agentId === convId ? { ...sx, title: placeholder } : sx)))
    apiPost<{ title: string }>(`/conversations/${cur.rowId}/summarize-title`, { userText, assistantText })
      .then((r) => {
        if (r?.title) setSessions((prev) => prev.map((sx) => (sx.agentId === convId ? { ...sx, title: r.title } : sx)))
      })
      .catch(() => { /* 失败保留占位标题 */ })
  }, [busy, messages, convId, sessions])

  const openNewSessionDialog = () => {
    const preferredProject = (
      currentSession?.projectId
        ? projects.find((project) => project.id === currentSession.projectId)
        : currentProject
    ) ?? projects[0]
    setNewSessionProjectId(preferredProject?.id ?? '')
    setNewSessionModelId((current) => current || availableModels.find((model) => model.isDefault)?.id || availableModels[0]?.id || '')
    setNewSessionOpen(true)
  }

  const confirmNewSession = async () => {
    if (!newSessionProject || creatingSession) return
    setCreatingSession(true)
    try {
      const created = await createSession('新会话', {
        scope: 'project',
        projectId: newSessionProject.id,
        projectName: newSessionProject.name,
      })
      if (created) setNewSessionOpen(false)
    } finally {
      setCreatingSession(false)
    }
  }

  const renameSession = async (rowId: string) => {
    const title = renamingTitle.trim()
    if (!title) {
      showToast('会话名称不能为空', 'error')
      return
    }
    try {
      const updated = await apiPatch<{ title: string }>(`/conversations/${rowId}`, { title })
      setSessions((items) => items.map((item) => item.rowId === rowId ? { ...item, title: updated.title } : item))
      setRenamingSessionId('')
      setRenamingTitle('')
    } catch (error) {
      showToast(`会话改名失败：${(error as Error).message}`, 'error')
    }
  }

  const deleteSession = async (rowId: string, agentId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await apiDelete(`/conversations/${rowId}`)
      const next = sessions.filter((s) => s.rowId !== rowId)
      setSessions(next)
      if (agentId === convId) {
        if (next.length) activateSession(next[0])
        else openNewSessionDialog()
      }
    } catch (error) {
      showToast(`删除会话失败：${(error as Error).message}`, 'error')
    }
  }

  // 停止当前会话正在进行的回答。
  const stop = async () => {
    if (!convId) return
    try { await agent.abort() }
    catch (err) { showToast(`停止失败：${(err as Error).message}`, 'error') }
  }

  const cancelAiTask = async (task: AiTask) => {
    if (taskMutationId) return
    setTaskMutationId(task.id)
    try {
      const updated = await apiPost<AiTask>(`/ai/tasks/${task.id}/cancel`)
      setAiTasks((items) => items.map((item) => item.id === updated.id ? updated : item))
      showToast('取消请求已提交', 'success')
    } catch (error) {
      console.warn('AI task cancellation did not complete', error)
      showToast('取消操作暂未完成，请稍后再试', 'info')
    } finally {
      setTaskMutationId(null)
    }
  }

  const retryAiTask = async (task: AiTask) => {
    if (taskMutationId) return
    setTaskMutationId(task.id)
    try {
      const retried = await apiPost<AiTask>(`/ai/tasks/${task.id}/retry`, {
        idempotencyKey: `retry-${task.id}-${Date.now().toString(36)}`,
      })
      setAiTasks((items) => [retried, ...items.filter((item) => item.id !== retried.id)])
      const label = AI_TASK_LABEL_BY_TYPE[task.type] ?? '文档'
      const visibleRequest = `请继续生成${label}。`
      if (currentProject?.id && currentConversationRowId === task.conversationId) {
        const runtimeMessage = `【当前项目】${currentProject.name}\n【projectId】${currentProject.id}\n【用户问题】${visibleRequest}\n【系统已执行】已根据原任务 ${task.id} 创建续跑任务 ${retried.id}。不要再次创建任务；请调用 get_ai_task_status 查询新任务，并用普通对话说明已继续执行。`
        await agent.sendMessage(runtimeMessage).catch((error) => {
          console.warn('AI task continuation message was not sent, task remains active', error)
        })
      }
      showToast('已按原参数继续生成，执行过程将在对话中更新', 'success')
    } catch (error) {
      console.warn('AI task continuation was not created', error)
      showToast('继续生成操作暂未开始，请稍后再试', 'info')
    } finally {
      setTaskMutationId(null)
    }
  }

  return (
    <div className="fde-ai-page -m-6 flex h-[calc(100vh-64px)] min-h-[720px] overflow-hidden bg-white">
      <aside className="flex w-[250px] shrink-0 flex-col border-r border-slate-200 bg-slate-50/60">
        <div className="p-4">
          <Button className="w-full" onClick={openNewSessionDialog} disabled={projects.length === 0}>
            <MessageSquarePlus className="h-4 w-4" />新建会话
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-3">
          <p className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">会话历史</p>
          {sessions.length === 0 && <p className="px-2 py-2 text-xs text-slate-400">暂无会话</p>}
          {sessions.map((s) => (
            <div
              key={s.rowId}
              onClick={() => activateSession(s)}
              className={`group mb-1 flex cursor-pointer items-center justify-between rounded-lg px-3 py-2.5 ${s.agentId === convId ? 'bg-white shadow-sm ring-1 ring-brand-200' : 'hover:bg-white/60'}`}
            >
              {renamingSessionId === s.rowId ? (
                <input
                  value={renamingTitle}
                  onChange={(event) => setRenamingTitle(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); void renameSession(s.rowId) }
                    if (event.key === 'Escape') { setRenamingSessionId(''); setRenamingTitle('') }
                  }}
                  maxLength={40}
                  autoFocus
                  aria-label="会话名称"
                  className="min-w-0 flex-1 rounded border border-brand-300 bg-white px-1.5 py-0.5 text-xs outline-none"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">{s.title || '新会话'}</span>
              )}
              <div className="ml-2 flex shrink-0 items-center gap-1 text-slate-300 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                {renamingSessionId === s.rowId ? (
                  <button onClick={(event) => { event.stopPropagation(); void renameSession(s.rowId) }} className="hover:text-brand-600" aria-label="保存会话名称">✓</button>
                ) : (
                  <button
                    onClick={(event) => {
                      event.stopPropagation()
                      setRenamingSessionId(s.rowId)
                      setRenamingTitle(s.title || '新会话')
                    }}
                    className="hover:text-brand-600"
                    aria-label="重命名会话"
                  ><Pencil className="h-3 w-3" /></button>
                )}
                <button onClick={(e) => { void deleteSession(s.rowId, s.agentId, e) }} className="hover:text-rose-500" aria-label="删除会话">×</button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-3">
          <div className="input flex h-9 w-36 items-center bg-slate-50 text-xs text-slate-600" aria-label="知识范围">
            {scope === 'project' ? '当前项目' : '全局知识库'}
          </div>
          {scope === 'project' && (
            <div
              className="input flex h-auto min-h-9 min-w-0 flex-1 items-center bg-slate-50 py-2 text-xs text-slate-600"
              aria-label="当前项目"
            >
              <span className="whitespace-normal break-words leading-5">
                {currentSession?.projectName ?? currentProject?.name ?? '未绑定项目'}
              </span>
            </div>
          )}
          {showAiDiagnostics && (agent.runtime || reportTaskUsage.taskCount > 0) && (
            <div
              className="ml-auto rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500"
              aria-label="模型用量与上下文压缩状态"
              title={agent.runtime?.contextCompaction.lastError || undefined}
            >
              {agent.runtime && (
                <>
                  {agent.runtime.usage
                    ? `对话 ${agent.runtime.usage.totalTokens.toLocaleString()} Token`
                    : '对话 Token 待生成'}
                  <span className="px-1 text-slate-300">·</span>
                  {agent.runtime.contextCompaction.state === 'compacting'
                    ? '上下文压缩中'
                    : agent.runtime.contextCompaction.state === 'failed'
                      ? '上下文压缩失败'
                      : `已压缩 ${agent.runtime.contextCompaction.count} 次`}
                  {agent.runtime.totalCostUsd !== null && (
                    <><span className="px-1 text-slate-300">·</span>${agent.runtime.totalCostUsd.toFixed(4)}</>
                  )}
                </>
              )}
              {agent.runtime && reportTaskUsage.taskCount > 0 && (
                <span className="px-1 text-slate-300">·</span>
              )}
              {reportTaskUsage.taskCount > 0 && (
                <span title={`模型调用 ${reportTaskUsage.modelCalls} 次，收到用量 ${reportTaskUsage.usageCalls} 次`}>
                  {reportTaskUsage.usageCalls > 0 && reportTaskUsage.totalTokens > 0
                    ? `报告 ${reportTaskUsage.totalTokens.toLocaleString()} Token${reportTaskUsage.usageCalls < reportTaskUsage.modelCalls ? '（部分）' : ''}`
                    : reportTaskUsage.activeTaskCount > 0
                      ? '报告 Token 统计中'
                      : '报告 Token 无统计记录'}
                </span>
              )}
            </div>
          )}
        </div>

        <AiErrorBoundary level="section" title="消息区域显示异常" resetKey={convId}>
          <div
            ref={scrollRef}
            className="flex-1 space-y-6 overflow-y-auto px-6 py-6"
            onScroll={onConversationScroll}
          >
            {conversationTimeline.length === 0
              && !qaAnswersLoading
              && !aiTasksLoading
              && (
              <div className="flex gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Bot className="h-4 w-4" /></span><div className="min-w-0 max-w-[88%] text-sm leading-7 text-slate-600">你好，我是赛智伯乐投资中台 AI 投研助手。我能检索项目资料、分析风险与亮点、处理文件/数据、采集公开情报、生成投委会 PPT。选好项目后直接提问即可。</div></div>
            )}
            {conversationTimeline.map((item) => {
              if (item.kind === 'message') {
                return (
                  <AiErrorBoundary
                    key={item.key}
                    level="message"
                    title="该条消息显示异常"
                    resetKey={item.message.id}
                  >
                    <MessageRow message={item.message} />
                  </AiErrorBoundary>
                )
              }
              if (item.kind === 'qa') {
                return (
                  <AiErrorBoundary
                    key={item.key}
                    level="section"
                    title="项目 Q&A 显示异常"
                    resetKey={item.answer.id}
                  >
                    <AiQaCards answers={[item.answer]} />
                  </AiErrorBoundary>
                )
              }
              return (
                <AiErrorBoundary
                  key={item.key}
                  level="message"
                  title="文档 Agent 消息显示异常"
                  resetKey={`${item.task.id}:${item.task.updatedAt}`}
                >
                  <AiTaskConversationMessage
                    task={item.task}
                    mutating={taskMutationId === item.task.id}
                    onCancel={cancelAiTask}
                    onRetry={retryAiTask}
                    onNotify={showToast}
                  />
                </AiErrorBoundary>
              )
            })}
            {agent.interaction && (
              <AgentInteractionCard
                interaction={agent.interaction}
                onAnswer={(answers) => agent.respondInteraction(agent.interaction!.id, 'answer', answers)}
                onCancel={() => agent.respondInteraction(agent.interaction!.id, 'cancel')}
              />
            )}
            {qaAnswersLoading && (
              <AiErrorBoundary
                level="section"
                title="项目 Q&A 显示异常"
                resetKey={`${currentConversationRowId}:qa-loading`}
              >
                <AiQaCards answers={[]} loading />
              </AiErrorBoundary>
            )}
            {aiTasksLoading && (
              <AiErrorBoundary
                level="message"
                title="文档 Agent 消息显示异常"
                resetKey={`${currentConversationRowId}:task-loading`}
              >
                <AiTaskConversationLoading />
              </AiErrorBoundary>
            )}
            {busy && (() => {
              // 只读取归一化后的最后一条消息；parts 缺失或非数组时已经降级为安全数组。
              const last = messages[messages.length - 1]
              const parts = last?.role === 'assistant' ? last.parts : []
              return <PptTaskBoard parts={parts} busy={busy} />
            })()}
            {busy && !agent.interaction && messages[messages.length - 1]?.role === 'user' && (
              <div className="flex gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Bot className="h-4 w-4" /></span><span className="inline-block h-4 w-1 animate-pulse bg-brand-500" /></div>
            )}
          </div>
        </AiErrorBoundary>

        <div className="border-t border-slate-200 px-6 py-4">
          <AiErrorBoundary level="section" title="快捷任务区域显示异常" resetKey={String(sending)}>
            <AiQuickActions
              disabled={scope !== 'project' || !currentSession?.projectId}
              projects={projects}
              currentProjectId={scope === 'project' ? currentSession?.projectId ?? '' : ''}
              conversationId={currentConversationRowId}
              selectedActionId={selectedQuickSkill?.actionId}
              onSelectSkill={(selection) => {
                setSelectedQuickSkill(selection)
                window.requestAnimationFrame(() => inputRef.current?.focus())
              }}
            />
          </AiErrorBoundary>
          <div
            className={`relative rounded-xl border p-2 transition-colors ${
              draggingFiles
                ? 'border-brand-400 bg-brand-50/60 ring-2 ring-brand-100'
                : 'border-slate-200'
            }`}
            onDragEnter={onDragEnterFiles}
            onDragOver={onDragOverFiles}
            onDragLeave={onDragLeaveFiles}
            onDrop={onDropFiles}
          >
            {draggingFiles && (
              <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl border-2 border-dashed border-brand-400 bg-white/90">
                <div className="flex items-center gap-2 text-sm font-medium text-brand-700">
                  <FileIcon className="h-4 w-4" />
                  松开以上传文件
                </div>
              </div>
            )}
            {uploadProgress && uploadProgress.total > 0 && (
              <div className="mb-1 flex items-center gap-2 px-1 text-xs text-brand-600">
                <RefreshCw className="h-3 w-3 animate-spin" />
                上传中 {uploadProgress.done}/{uploadProgress.total}…
              </div>
            )}
            {uploads.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1.5 px-1">
                {uploads.map((u) => (
                  <span key={u.path} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">
                    <FileText className="h-3 w-3" />{u.name}{u.rag && <span className="text-emerald-600">·已入库</span>}
                    <button onClick={() => removeUpload(u.path)} className="ml-0.5 text-slate-400 hover:text-rose-500" aria-label="移除">×</button>
                  </span>
                ))}
              </div>
            )}
            {selectedQuickSkill && (
              <div className="mb-1 flex flex-wrap gap-1.5 px-1" aria-label="本轮快捷工具">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-300 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700">
                  <Boxes className="h-3 w-3" />
                  {selectedQuickSkill.actionLabel}
                  {selectedQuickSkill.customTemplateName && (
                    <span className="max-w-44 truncate text-brand-500" title={selectedQuickSkill.customTemplateName}>
                      · {selectedQuickSkill.customTemplateName}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedQuickSkill(null)}
                    className="ml-0.5 rounded-full text-brand-400 hover:bg-brand-100 hover:text-brand-700"
                    aria-label={`取消快捷工具 ${selectedQuickSkill.actionLabel}`}
                  >×</button>
                </span>
              </div>
            )}
            {activeSkills.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1.5 px-1" aria-label="当前会话已启用工具">
                {activeSkills.map((item) => (
                  <span key={item.id} className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700">
                    <Boxes className="h-3 w-3" />
                    {businessSkillName(item)}
                    <button
                      type="button"
                      onClick={() => setActiveSkillIds((ids) => ids.filter((id) => id !== item.id))}
                      className="ml-0.5 rounded-full text-brand-400 hover:bg-brand-100 hover:text-brand-700"
                      aria-label={`移除工具 ${businessSkillName(item)}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {capabilityOpen && (
              <div data-ai-skill-menu="true" className="absolute inset-x-2 bottom-[calc(100%+8px)] z-30 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
                <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5">
                  <Search className="h-4 w-4 shrink-0 text-slate-400" />
                  <input
                    autoFocus
                    value={capabilitySearch}
                    onChange={(event) => setCapabilitySearch(event.target.value)}
                    placeholder="搜索可用工具"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
                  />
                  <button
                    type="button"
                    onClick={() => { setCapabilityOpen(false); setCapabilitySearch('') }}
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    aria-label="关闭技能列表"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="max-h-72 overflow-y-auto p-1.5">
                  {filteredCapabilities.map((item) => {
                    const selected = activeSkillIds.includes(item.id)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => toggleActiveSkill(item)}
                        className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition ${selected ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                      >
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${selected ? 'bg-brand-500' : 'bg-slate-300'}`} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-slate-800">{businessSkillName(item)}</span>
                            {showAiDiagnostics && <span className="font-mono text-xs text-slate-400">/{item.capabilityKey}</span>}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-slate-500">{item.description || '暂无技能说明'}</span>
                        </span>
                        {selected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />}
                      </button>
                    )
                  })}
                  {filteredCapabilities.length === 0 && <div className="px-3 py-8 text-center text-xs text-slate-400">没有找到匹配的技能</div>}
                </div>
                <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-400">
                  <span>已选 {activeSkillIds.length} 个工具</span>
                  {capabilitySaving && <span>正在保存…</span>}
                </div>
              </div>
            )}
            {slashMenuOpen && slashCapabilities.length > 0 && (
              <div data-ai-skill-menu="true" className="absolute inset-x-2 bottom-[calc(100%+8px)] z-30 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs text-slate-400">
                  <span>可用工具</span>
                  <span>↑↓ 选择 · Enter 使用 · Esc 关闭</span>
                </div>
                <div className="max-h-64 overflow-y-auto p-1.5">
                  {slashCapabilities.map((item, index) => {
                    const selected = activeSkillIds.includes(item.id)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectSlashCapability(item)}
                        className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition ${index === slashHighlight ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                      >
                        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${selected ? 'bg-brand-500' : 'bg-slate-300'}`} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-slate-800">{businessSkillName(item)}</span>
                            {selected && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
                          </span>
                          {showAiDiagnostics && <span className="mt-0.5 block truncate font-mono text-xs text-slate-400">/{item.capabilityKey}</span>}
                          {item.description && <span className="mt-0.5 block truncate text-xs text-slate-500">{item.description}</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                const value = e.target.value
                setInput(value)
                const hasSlashCommand = getSlashCommandQuery(value) !== null
                setSlashMenuOpen(hasSlashCommand)
                if (hasSlashCommand) setCapabilityOpen(false)
                setSlashHighlight(0)
              }}
              onKeyDown={(e) => {
                // 中文输入法选词确认也会产生 Enter；组合态绝不能触发发送。
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
                if (slashMenuOpen && slashCapabilities.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSlashHighlight((index) => (index + 1) % slashCapabilities.length)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSlashHighlight((index) => (index - 1 + slashCapabilities.length) % slashCapabilities.length)
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setSlashMenuOpen(false)
                    return
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    selectSlashCapability(slashCapabilities[slashHighlight])
                    return
                  }
                }
                // Enter 发送；Shift+Enter 保留多行输入能力。
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              aria-keyshortcuts="Enter Shift+Enter"
              rows={2}
              className="w-full resize-none border-0 px-2 py-1 text-sm leading-6 outline-none placeholder:text-slate-400"
              placeholder={selectedQuickSkill
                ? '补充项目数据或写作要求（可选）'
                : scope === 'project'
                ? currentProject
                  ? `向 AI 询问 ${currentProject.name}…`
                  : '请先选择项目，再向 AI 提问…'
                : '向 AI 询问机构知识库…'}
            />
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onPickFiles} accept={AI_UPLOAD_ACCEPT} />
            <div className="flex items-center justify-between px-1"><div className="flex min-w-0 items-center gap-2 text-xs text-slate-400"><button onClick={() => fileInputRef.current?.click()} disabled={uploading} title="上传文件" className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-brand-600 disabled:opacity-50">{uploading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}</button><button data-ai-capability-trigger="true" type="button" onClick={() => { setCapabilitySearch(''); setSlashMenuOpen(false); setCapabilityOpen((open) => !open) }} disabled={!currentConversationRowId || !availableCapabilities.some((item) => item.kind === 'skill') || busy} title="选择当前会话持续使用的工具" aria-expanded={capabilityOpen} className={`inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 hover:bg-slate-100 disabled:opacity-40 ${activeSkillIds.length ? 'bg-brand-50 text-brand-700' : 'text-slate-400 hover:text-brand-600'}`}><Boxes className="h-3.5 w-3.5" /><span>工具{activeSkillIds.length ? ` ${activeSkillIds.length}` : ''}</span></button><CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" /><span className="truncate">Enter 发送 · Shift + Enter 换行</span></div>{busy
              ? <button aria-label="停止" title="停止生成" onClick={stop} className="grid h-8 w-8 place-items-center rounded-lg bg-rose-500 text-white hover:bg-rose-600"><Square className="h-3.5 w-3.5" /></button>
              : <button aria-label="发送" title="发送（Enter）" disabled={sending || uploading || (!selectedQuickSkill && !input.trim() && uploads.length === 0)} onClick={() => { void send() }} className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white disabled:cursor-not-allowed disabled:bg-slate-200"><Send className="h-4 w-4" /></button>}</div>
          </div>
          {agentError && (
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-600">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{aiBusinessErrorMessage(agentError.message)}</span>
              {showAiDiagnostics && <details className="shrink-0"><summary className="cursor-pointer">查看详情</summary><p className="mt-2 max-w-md break-words font-mono text-xs">{agentError.message} · {agentError.errorId}</p></details>}
              {showAiDiagnostics && <button
                type="button"
                title="复制错误编号"
                aria-label="复制错误编号"
                onClick={() => { void copyAiErrorId(agentError.errorId) }}
                className="rounded p-1 text-rose-400 hover:bg-rose-100 hover:text-rose-600"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>}
            </div>
          )}
        </div>
      </div>

      <aside className="hidden w-[300px] shrink-0 flex-col border-l border-slate-200 bg-slate-50/60 xl:flex">
        <div className="border-b border-slate-200 p-3">
          <div className="rounded-lg bg-brand-50 p-3"><p className="text-sm font-medium text-brand-800">{scope === 'project' ? currentProject?.name : '全局知识库'}</p><p className="mt-1 text-xs text-brand-600">{scope === 'project' ? `${projectFiles.length} 份项目资料可检索` : '机构知识库可检索'}</p></div>
        </div>
        <AiErrorBoundary level="section" title="正式交付物区域显示异常" resetKey={`${projectId}:${artifactRefreshKey}`}>
          <AiArtifactCenter
            projectId={scope === 'project' ? currentProject?.id : undefined}
            refreshKey={artifactRefreshKey}
            onNotify={showToast}
            onDeleted={(artifactId) => {
              setAiTasks((tasks) => tasks.map((task) => ({
                ...task,
                artifacts: task.artifacts.filter((artifact) => artifact.id !== artifactId),
              })))
            }}
          />
        </AiErrorBoundary>
      </aside>
      <Modal
        open={newSessionOpen}
        title="新建会话"
        onClose={() => { if (!creatingSession) setNewSessionOpen(false) }}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setNewSessionOpen(false)} disabled={creatingSession}>
              {projects.length === 0 ? '关闭' : '取消'}
            </Button>
            <Button
              onClick={() => { void confirmNewSession() }}
              loading={creatingSession}
              disabled={!newSessionProject}
            >
              创建会话
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <p className="text-xs leading-5 text-slate-500">
            请选择该会话所属项目。创建后项目不可更改，后续问答、快捷任务和交付物均使用该项目资料。
          </p>
          <div className="block">
            <span className="label">项目</span>
            <ProjectPicker
              projects={projects}
              value={newSessionProjectId}
              onChange={setNewSessionProjectId}
              disabled={creatingSession}
            />
            {projects.length === 0 && <p role="status" className="mt-2 text-xs text-amber-700">当前账号暂无可用项目，暂时不能创建项目会话。</p>}
            <span className="mt-1 block text-xs text-slate-400">可按项目名称、公司名称、行业或阶段搜索。</span>
          </div>
          <label className="block">
            <span className="label">模型</span>
            <select
              className="input"
              value={newSessionModelId}
              onChange={(event) => setNewSessionModelId(event.target.value)}
              disabled={creatingSession}
            >
              {!availableModels.length && <option value="">系统默认模型（环境回退）</option>}
              {availableModels.map((model) => (
                <option key={model.id} value={model.id}>{model.displayName}{model.isDefault ? '（默认）' : ''}</option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-slate-400">仅显示管理员已启用且当前账号有权使用的模型。</span>
          </label>
        </div>
      </Modal>
    </div>
  )
}

export function AIAssistantPage() {
  return <Chat />
}
