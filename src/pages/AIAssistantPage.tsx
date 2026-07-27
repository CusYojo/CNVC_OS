import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertCircle, Bot, CheckCircle2, ChevronRight, Copy, Download, File as FileIcon, FileText, MessageSquarePlus, Paperclip, RefreshCw, Send, Square, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FlueProvider, useFlueAgent } from '@flue/react'
import { createFlueClient } from '@flue/sdk'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore, authedFetch } from '../store/useAuthStore'
import { Button, Modal } from '../components/ui'
import {
  AiQuickActions,
  type AiQuickTaskRequest,
} from '../components/AiQuickActions'
import { AiArtifactCenter, AiTaskCards, type AiTask } from '../components/AiTaskCards'
import { AiQaCards, type ProjectQaAnswer } from '../components/AiQaCards'
import { AiErrorBoundary, copyAiErrorId, createAiErrorId } from '../components/AiErrorBoundary'
import { useToast } from '../components/Toast'
import { apiGet, apiPost, apiDelete, ApiError } from '../lib/api'
import {
  extractTextParts,
  normalizeFlueMessages,
  safeStringify,
  toSafeText,
  type SafeFlueMessage,
  type SafeFluePart,
} from '../lib/aiMessageSafety'

// —— Flue 官方 SDK 客户端 ——
// baseUrl 走 nginx /flue-api 反代到 flue :8790（同源）。
// 自定义 fetch 每次请求注入当前 JWT（token 过期后跟随重新登录自动更新，避免静态 token 失效）。
const flueClient = createFlueClient({
  baseUrl: '/ai/api',
  fetch: (input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = useAuthStore.getState().token
    const headers = new Headers(init.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return fetch(input, { ...init, headers })
  },
})

const AI_TASK_TYPE_BY_ACTION: Record<AiQuickTaskRequest['actionId'], string> = {
  compliance: 'compliance_statement',
  proposal: 'investment_proposal',
  investment_ppt: 'investment_recommendation_ppt',
  due_diligence: 'due_diligence_report',
  qa: 'project_qa',
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// —— 模块级 toast 桥 ——
// downloadWorkspaceFile / OSS 下载等模块级函数与深层组件（WsNode）都需要弹提示，
// 但它们拿不到 Chat 组件里的 useToast。Chat 挂载时把 showToast 注册到这里。
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

// Markdown 渲染（标题/表格/列表/粗体/代码块）
function Markdown({ children }: { children: string }) {
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

// 把工具 output 归一成可读文本（flue 的 output 可能是字符串/对象/数组）
function outputToText(output: unknown): string {
  return toSafeText(output, 4000)
}

// Pi 式任务链步骤卡片：running（转圈）/ done（绿，可展开看输入输出）/ error（红，就地报错）
function ToolStep({ part }: { part: SafeFluePart }) {
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

  return (
    <div className={`my-1.5 overflow-hidden rounded-lg border ${border} ${bg} text-xs`}>
      <button onClick={() => setExpanded((v) => !v)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left">
        {running
          ? <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-brand-300 border-t-brand-600" />
          : isError
            ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
            : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
        <span className={`shrink-0 font-medium ${labelColor}`}>{label}{running ? '…' : ''}</span>
        {preview && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400" title={preview}>{preview}</span>}
        <ChevronRight className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-black/5 px-3 py-2">
          {part.input != null && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-white/70 p-2 text-[11px] leading-5 text-slate-500">{safeStringify(part.input)}</pre>
          )}
          {isError
            ? <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-rose-50 p-2 text-[11px] leading-5 text-rose-600">{toSafeText(part.errorText, 4000) || '执行出错'}</pre>
            : part.state === 'output-available' && outputText.trim() !== '' && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-white/70 p-2 text-[11px] leading-5 text-slate-500">{outputText}</pre>
            )}
        </div>
      )}
    </div>
  )
}

// 渲染 flue 会话消息的一个 part（文本 / 推理 / 工具调用 / 文件）
function MessagePart({ part }: { part: SafeFluePart }) {
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

function displayUserMessageText(message: SafeFlueMessage): string {
  return extractTextParts(message)
    .replace(/【当前项目】.*\n【projectId】.*\n【用户问题】/s, '')
    .replace(/【范围】全局知识库\n【用户问题】/s, '')
    .replace(/\n?【已上传文件】[\s\S]*$/, '')
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

function MessageRow({ message }: { message: SafeFlueMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end gap-3">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-2.5 text-sm leading-6 text-white">
          {displayUserMessageText(message)}
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Bot className="h-4 w-4" /></span>
      <div className="min-w-0 max-w-[88%] space-y-1">
        {message.parts.map((part, index) => (
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

// ———————————— PPT 生成任务看板（长任务的阶段 + 计时 + 预期）————————————
// PPT 生成耗时数分钟，纯前端根据已发生的工具事件推断阶段并计时，让用户对等待有预期。
// 数据来源：agent.messages 里的 tool part（dynamic-tool），不接后端进度 API。
function pptStageFromParts(parts: SafeFluePart[]): { active: boolean; stage: string } {
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
    else if (/activate_skill/i.test(name) || /activate_skill/i.test(input)) stage = '正在加载 PPT 生成技能'
    else if (name === 'start_ppt_generation') stage = '正在启动 PPT 生成'
    else stage = '正在生成 PPT'
  }
  return { active, stage }
}

function PptTaskBoard({ parts, busy }: { parts: SafeFluePart[]; busy: boolean }) {
  const { active, stage } = pptStageFromParts(parts)
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
      <p className="mt-1.5 text-xs text-brand-700">阶段：{stage}</p>
      <p className="mt-1 text-[11px] leading-5 text-brand-500">PPT 生成通常需要 3–8 分钟，取决于页数与图像网关负载，请耐心等待，期间可查看下方工具调用进度。</p>
    </div>
  )
}

// ———————————— AI 生成产物 + 内联预览（免 OSS 中转）————————————
type WsArtifact = { name: string; path: string; type: 'file'; size: number; mtime: number; ext: string }
type WsFile = { path: string; name: string }

function fmtSize(n: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtTime(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// 工作区下载：/api/workspace/file 在 JWT 网关之后，普通 <a download> 不带 Authorization 头会 401。
// 统一走 authedFetch 取字节→blob→程序化下载，所有文件类型都可靠下载。
async function downloadWorkspaceFile(file: WsFile): Promise<void> {
  toast(`正在下载「${file.name}」…`, 'info')
  let res: Response
  try {
    res = await authedFetch(`/api/workspace/file?path=${encodeURIComponent(file.path)}&download=1`)
  } catch (e) {
    toast(`下载失败：网络错误（${(e as Error).message}）`, 'error')
    throw e
  }
  if (!res.ok) {
    const msg = res.status === 401 ? '登录已过期，请刷新页面重新登录后再下载' : `下载失败：服务端返回 HTTP ${res.status}`
    toast(msg, 'error')
    throw new Error(`HTTP ${res.status}`)
  }
  const blob = await res.blob()
  triggerBlobDownload(blob, file.name)
  toast(`「${file.name}」已开始下载`, 'success')
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

function WorkspacePanel({ refreshKey, onRefresh, onOpen }: { refreshKey: number; onRefresh: () => void; onOpen: (f: WsFile) => void }) {
  const [artifacts, setArtifacts] = useState<WsArtifact[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    apiGet<{ entries: WsArtifact[]; truncated?: boolean }>('/workspace/artifacts')
      .then((r) => {
        if (!active) return
        setArtifacts(r.entries)
        setTruncated(Boolean(r.truncated))
        setError(null)
      })
      .catch((e) => {
        if (!active) return
        setError((e as Error).message)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refreshKey])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">AI 生成产物</p>
          <p className="mt-0.5 text-[10px] text-slate-400">点击预览，或直接下载</p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          title="刷新产物"
          className="rounded p-1 text-slate-300 hover:bg-white hover:text-brand-600 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {error && <p className="px-3 py-2 text-[11px] text-rose-500">{error}</p>}
        {!artifacts && !error && <p className="px-2 py-3 text-[11px] text-slate-400">正在加载产物…</p>}
        {artifacts?.map((artifact) => {
          const parent = artifact.path.split('/').slice(0, -1).join('/')
          return (
            <div
              key={artifact.path}
              role="button"
              tabIndex={0}
              onClick={() => onOpen({ path: artifact.path, name: artifact.name })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpen({ path: artifact.path, name: artifact.name })
                }
              }}
              className="group flex cursor-pointer items-center gap-2 rounded-lg border border-transparent bg-white/70 px-2.5 py-2 outline-none hover:border-brand-100 hover:bg-white focus:border-brand-300"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
                <FileIcon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-slate-700" title={artifact.name}>{artifact.name}</span>
                <span className="mt-0.5 block truncate text-[10px] text-slate-400" title={parent}>
                  {[artifact.ext.replace('.', '').toUpperCase(), fmtSize(artifact.size), fmtTime(artifact.mtime), parent].filter(Boolean).join(' · ')}
                </span>
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void downloadWorkspaceFile({ path: artifact.path, name: artifact.name }).catch(() => {})
                }}
                title="下载"
                className="grid h-7 w-7 shrink-0 place-items-center rounded text-slate-300 hover:bg-brand-50 hover:text-brand-600"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
        {artifacts && artifacts.length === 0 && !error && (
          <div className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center">
            <FileIcon className="mx-auto h-6 w-6 text-slate-300" />
            <p className="mt-2 text-[11px] text-slate-400">暂无生成产物</p>
            <p className="mt-1 text-[10px] text-slate-300">AI 完成文件生成后会自动出现在这里</p>
          </div>
        )}
        {truncated && <p className="px-2 pt-1 text-[10px] text-slate-400">仅展示最近 200 个产物</p>}
      </div>
    </div>
  )
}

// 内联预览（Canvas）：用 authedFetch 带 JWT 取文件字节，按 MIME 渲染图片/PDF/HTML/文本/Markdown，免 OSS。
function FilePreview({ file, onClose }: { file: WsFile; onClose: () => void }) {
  const [kind, setKind] = useState<'image' | 'pdf' | 'html' | 'md' | 'text' | 'other'>('other')
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let objUrl: string | null = null
    setUrl(null); setText(null); setError(null); setKind('other')
    const ext = (file.name.split('.').pop() ?? '').toLowerCase()
    void (async () => {
      try {
        const res = await authedFetch(`/api/workspace/file?path=${encodeURIComponent(file.path)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const ct = (res.headers.get('Content-Type') ?? '').toLowerCase()
        if (ct.startsWith('image/')) { objUrl = URL.createObjectURL(await res.blob()); setKind('image'); setUrl(objUrl) }
        else if (ct.includes('pdf')) { objUrl = URL.createObjectURL(await res.blob()); setKind('pdf'); setUrl(objUrl) }
        else if (ct.includes('html')) { setKind('html'); setText(await res.text()) }
        else if (ext === 'md' || ct.includes('markdown')) { setKind('md'); setText(await res.text()) }
        else if (ct.startsWith('text/') || ct.includes('json') || ct.includes('csv') || ct.includes('xml')) { setKind('text'); setText(await res.text()) }
        else { objUrl = URL.createObjectURL(await res.blob()); setKind('other'); setUrl(objUrl) }
      } catch (e) { setError((e as Error).message) }
    })()
    return () => { if (objUrl) URL.revokeObjectURL(objUrl) }
  }, [file.path, file.name])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div className="flex h-full max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5">
          <FileIcon className="h-4 w-4 shrink-0 text-slate-400" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700" title={file.path}>{file.name}</span>
          <button onClick={() => { void downloadWorkspaceFile(file).catch((e) => setError(`下载失败：${(e as Error).message}`)) }} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-brand-600" title="下载"><Download className="h-4 w-4" /></button>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-rose-500" title="关闭"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-slate-50">
          {error && <div className="grid h-full place-items-center p-6 text-sm text-rose-500">加载失败：{error}</div>}
          {!error && kind === 'image' && url && <div className="grid min-h-full place-items-center p-4"><img src={url} alt={file.name} className="max-h-full max-w-full object-contain" /></div>}
          {!error && kind === 'pdf' && url && <iframe src={url} title={file.name} className="h-full w-full border-0" />}
          {!error && kind === 'html' && text != null && <iframe srcDoc={text} sandbox="allow-scripts" title={file.name} className="h-full w-full border-0 bg-white" />}
          {!error && kind === 'md' && text != null && <div className="mx-auto max-w-3xl p-6"><Markdown>{text}</Markdown></div>}
          {!error && kind === 'text' && text != null && <pre className="whitespace-pre-wrap break-all p-4 text-[13px] leading-6 text-slate-700">{text}</pre>}
          {!error && kind === 'other' && <div className="grid h-full place-items-center p-6 text-center text-sm text-slate-500"><div><FileIcon className="mx-auto mb-2 h-8 w-8 text-slate-300" />该类型暂不支持内联预览<br /><span className="text-xs text-slate-400">点右上角下载查看</span></div></div>}
        </div>
      </div>
    </div>
  )
}

function Chat() {
  const [searchParams] = useSearchParams()
  const projects = useAppStore((state) => state.projects)
  const files = useAppStore((state) => state.files)
  const { showToast } = useToast()
  const LS_LAST_PROJECT = 'cybernaut-ai-last-project'
  const LS_LAST_CONV = 'cybernaut-ai-last-conv'
  // 项目优先级: URL ?project= > 上次选的(localStorage) > 空（等待 store 加载）
  const initialProject = searchParams.get('project') ?? localStorage.getItem(LS_LAST_PROJECT) ?? ''
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [projectId, setProjectId] = useState(initialProject)
  const [input, setInput] = useState('')
  // 每个"会话"= 一个 flue agent 实例(agentId)。列表存服务端(/api/conversations)，跟账号跨设备同步。
  // rowId = chat_conversations 主键(改名/删除用)，agentId = flue agent id(加载会话内容用)。
  type ChatSession = {
    rowId: string
    agentId: string
    title: string
    scope: 'project' | 'global'
    projectId?: string | null
    projectName?: string | null
  }
  const LS_KEY = 'cybernaut-ai-sessions' // 仅用于一次性迁移旧的浏览器本地会话
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [convId, setConvId] = useState<string>('')
  const initedRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [aiTasks, setAiTasks] = useState<AiTask[]>([])
  const [aiTasksLoading, setAiTasksLoading] = useState(false)
  const [qaAnswers, setQaAnswers] = useState<ProjectQaAnswer[]>([])
  const [qaAnswersLoading, setQaAnswersLoading] = useState(false)
  const [taskMutationId, setTaskMutationId] = useState<string | null>(null)
  const quickTaskLockRef = useRef(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newSessionProjectId, setNewSessionProjectId] = useState(initialProject)
  const [creatingSession, setCreatingSession] = useState(false)

  const currentProject = projects.find((project) => project.id === projectId) ?? projects[0]
  const newSessionProject = projects.find((project) => project.id === newSessionProjectId)
  const projectFiles = files.filter((file) => file.projectId === currentProject?.id)
  const currentSession = sessions.find((session) => session.agentId === convId)
  const currentConversationRowId = currentSession?.rowId ?? ''
  const hasActiveAiTask = aiTasks.some((task) => task.status === 'pending' || task.status === 'running')
  const artifactRefreshKey = aiTasks
    .filter((task) => task.status === 'succeeded')
    .map((task) => `${task.id}:${task.updatedAt}:${task.artifacts?.length ?? 0}`)
    .join('|')
  // 把 showToast 注册到模块级 toast 桥（供 downloadWorkspaceFile / downloadRemoteUrl 等模块函数弹提示）
  useEffect(() => { registerAiToast(showToast) }, [showToast])
  // 记住当前项目(下次进来恢复)
  useEffect(() => { if (projectId) localStorage.setItem(LS_LAST_PROJECT, projectId) }, [projectId])
  // 记住当前会话(下次进来恢复)
  useEffect(() => { if (convId) localStorage.setItem(LS_LAST_CONV, convId) }, [convId])
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
  // 不依赖 Flue 的瞬时消息状态。
  useEffect(() => {
    let active = true
    if (!currentConversationRowId) {
      setAiTasks([])
      setAiTasksLoading(false)
      return () => { active = false }
    }
    setAiTasks([])
    setAiTasksLoading(true)
    apiGet<{ list: AiTask[] }>(`/ai/tasks?conversationId=${encodeURIComponent(currentConversationRowId)}`)
      .then((result) => {
        if (active) setAiTasks(result.list ?? [])
      })
      .catch((error) => {
        if (active) showToast(`AI 任务恢复失败：${(error as Error).message}`, 'error')
      })
      .finally(() => {
        if (active) setAiTasksLoading(false)
      })
    return () => { active = false }
  }, [currentConversationRowId, showToast])

  // 项目 Q&A 由 Express 持久化在会话中。刷新、重新登录或跨设备打开时直接恢复，
  // 不依赖 Flue 客户端内存，也不会把业务 Skill 降级成提示词标记。
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
        if (active) showToast(`项目 Q&A 恢复失败：${(error as Error).message}`, 'error')
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
        if (active) setAiTasks(result.list ?? [])
      } catch (error) {
        // 轮询失败不清空已有任务卡，避免短暂网络波动造成结果消失。
        console.warn('AI task polling failed:', (error as Error).message)
      }
    }
    const timer = window.setInterval(() => { void poll() }, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [currentConversationRowId, hasActiveAiTask])

  // —— 核心：flue 官方 agent hook，流式/工具可见/记忆全内建 ——
  const agent = useFlueAgent({ name: 'assistant', id: convId || undefined, live: 'long-poll' })
  // Flue 是独立运行时，消息不能假设始终符合 SDK 静态类型。先归一化，后续渲染和
  // “生成结束”副作用都只读取安全结构，单条畸形消息不会再拖垮整个 AI 页面。
  const messages = useMemo(() => normalizeFlueMessages(agent.messages), [agent.messages])
  const agentErrorMessage = safeAgentErrorMessage(agent.error)
  const agentErrorRef = useRef({ message: '', errorId: '' })
  if (agentErrorMessage && agentErrorRef.current.message !== agentErrorMessage) {
    agentErrorRef.current = { message: agentErrorMessage, errorId: createAiErrorId() }
  }
  const agentError = (agentErrorMessage && agent.status === 'error') ? agentErrorRef.current : null
  useEffect(() => {
    if (!agentError) return
    console.error(`[${agentError.errorId}] Flue Agent 返回错误`, agentError.message)
  }, [agentError])
  // 正在提交(submitted)或回答(streaming)算"忙"，显示停止按钮；connecting 是初次加载历史/建连，不算忙。
  const busy = agent.status === 'streaming' || agent.status === 'submitted'
  // React 状态更新前也可能连续触发键盘/点击事件，ref 作为同步锁杜绝重复提交。
  const submitLockRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const sending = busy || submitting
  // 工作区面板：refreshKey 触发重拉；preview 为当前内联预览的文件
  const [wsRefresh, setWsRefresh] = useState(0)
  const [preview, setPreview] = useState<WsFile | null>(null)
  const prevBusyRef = useRef(false)
  // 用户上传的文件（本轮待发）：path=沙箱相对路径(agent 可 read/bash 直读)，rag=是否已入项目知识库
  const [uploads, setUploads] = useState<{ name: string; path: string; rag: boolean }[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!list.length) return
    setUploading(true)
    let done = 0
    setUploadProgress({ done: 0, total: list.length })

    const uploadOne = async (file: File): Promise<{ name: string; path: string; rag: boolean }> => {
      const dataUrl = await fileToBase64(file)
      const ws = await apiPost<{ path: string; name: string }>('/workspace/file', {
        name: file.name, dataBase64: dataUrl, subdir: convId || undefined,
      })
      let rag = false
      if (scope === 'project' && currentProject?.id) {
        try {
          // 上传大文件走公网可能慢，用 5 分钟超时覆盖默认 60s，避免大文件被掐断。
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
          if (err instanceof ApiError && err.status === 409) rag = true
          else showToast(`「${file.name}」入库失败（文件已可用于本轮对话）：${(err as Error).message}`, 'error')
        }
      }
      return { name: ws.name, path: ws.path, rag }
    }

    const results = await Promise.allSettled(
      list.map((file) =>
        uploadOne(file).finally(() => { done += 1; setUploadProgress({ done, total: list.length }) }),
      ),
    )

    const ok: { name: string; path: string; rag: boolean }[] = []
    const failed: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') ok.push(r.value)
      else failed.push(list[i].name)
    })
    if (ok.length) setUploads((prev) => [...prev, ...ok])
    if (failed.length === 0) showToast(`已上传 ${ok.length} 个文件`, 'success')
    else if (ok.length === 0) showToast(`上传失败：${failed.length} 个文件全部失败`, 'error')
    else showToast(`上传完成：成功 ${ok.length} 个，失败 ${failed.length} 个（${failed.slice(0, 3).join('、')}${failed.length > 3 ? '…' : ''}）`, 'error')

    setUploadProgress(null)
    setUploading(false)
  }

  const removeUpload = (path: string) => setUploads((prev) => prev.filter((u) => u.path !== path))

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, aiTasks.length, qaAnswers.length])

  // agent 从"忙"变"闲"（跑完一轮）后刷新工作区，让新生成的文件自动出现
  useEffect(() => {
    if (prevBusyRef.current && !busy) setWsRefresh((k) => k + 1)
    prevBusyRef.current = busy
  }, [busy])

  const send = async (
    question = input,
    contextOverride?: { projectId: string; projectName: string },
  ): Promise<boolean> => {
    const clean = question.trim()
    if (!clean && uploads.length === 0) return false
    if (busy || submitLockRef.current) return false
    submitLockRef.current = true
    setSubmitting(true)
    setInput('')
    // 把本轮上传的文件路径随消息带给 agent（落在其工作目录，可直接 read/bash 读；PDF/Excel 用对应技能）
    const fileCtx = uploads.length
      ? `\n【已上传文件】(在你的工作目录，可用 read/bash 直接读；PDF 用 pdf 技能、Excel/CSV 用 spreadsheet 技能)\n`
        + uploads.map((u) => `- ${u.path}${u.rag ? '（已入项目知识库，也可用 search_docs 检索）' : ''}`).join('\n')
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
      ? `【范围】全局知识库\n【用户问题】${clean}${fileCtx}`
      : `【当前项目】${effectiveProject?.projectName ?? ''}\n【projectId】${effectiveProject?.projectId ?? ''}\n【用户问题】${clean}${fileCtx}`
    try {
      await agent.sendMessage(ctx)
      setUploads([])
      return true
    } catch (err) {
      showToast(`发送失败：${(err as Error).message}`, 'error')
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
      // 过滤掉 mock ID（如 p-1001），避免 PostgreSQL UUID 类型错误
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
        scope: context.scope,
        projectId: safeProjectId,
        projectName: safeProjectId ? context.projectName : null,
      })
      const s: ChatSession = {
        rowId: row.id,
        agentId: row.agentId || row.id,
        title: row.title,
        scope: row.scope === 'global' ? 'global' : context.scope,
        projectId: row.projectId ?? context.projectId ?? null,
        projectName: row.projectName ?? context.projectName ?? null,
      }
      setSessions((prev) => [s, ...prev])
      activateSession(s)
      return s
    } catch (err) {
      showToast(`新建会话失败：${(err as Error).message}`, 'error')
      return null
    }
  }

  // 首次加载：从服务端拉会话列表；并把旧的 localStorage 会话一次性迁移到服务端(保留其 flue 会话内容)
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
          }[]
        }>('/conversations')
        let mapped: ChatSession[] = (list ?? []).map((r) => ({
          rowId: r.id,
          agentId: r.agentId || r.id,
          title: r.title,
          scope: r.scope === 'global' || !r.projectId ? 'global' : 'project',
          projectId: r.projectId ?? null,
          projectName: r.projectName ?? null,
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
            }>('/conversations', { title: s.title || '新会话', agentId: s.id })
            mapped = [{
              rowId: row.id,
              agentId: row.agentId || s.id,
              title: row.title,
              scope: row.scope === 'global' || !row.projectId ? 'global' : 'project',
              projectId: row.projectId ?? null,
              projectName: row.projectName ?? null,
            }, ...mapped]
          }
          localStorage.removeItem(LS_KEY)
        } catch { /* ignore legacy migration errors */ }
        setSessions(mapped)
        if (mapped.length) {
          // 恢复上次选中的会话(若仍存在),否则用最近的一条
          const lastConv = localStorage.getItem(LS_LAST_CONV)
          const restored = lastConv && mapped.some((m) => m.agentId === lastConv) ? lastConv : mapped[0].agentId
          const restoredSession = mapped.find((session) => session.agentId === restored) ?? mapped[0]
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
    const rawUserText = extractTextParts(firstUser)
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

  const deleteSession = async (rowId: string, agentId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    apiDelete(`/conversations/${rowId}`).catch(() => {})
    const next = sessions.filter((s) => s.rowId !== rowId)
    setSessions(next)
    if (agentId === convId) {
      if (next.length) activateSession(next[0])
      else openNewSessionDialog()
    }
  }

  // 停止当前会话正在进行的回答（flue 官方 abort 端点；useFlueAgent 自身没有 stop）
  const stop = async () => {
    if (!convId) return
    try { await flueClient.agents.abort('assistant', convId) }
    catch (err) { showToast(`停止失败：${(err as Error).message}`, 'error') }
  }

  const runQuickTask = async (request: AiQuickTaskRequest): Promise<boolean> => {
    if (sending || quickTaskLockRef.current) return false
    if (!UUID_PATTERN.test(request.projectId)) {
      showToast(`“${request.projectName}”是未入库的演示项目，不能提交正式 AI 任务。请先创建或选择已入库项目。`, 'error')
      return false
    }
    quickTaskLockRef.current = true
    const parameters: Record<string, unknown> = {
      sourceCutoffDate: request.sourceCutoffDate,
      outputFormat: request.outputFormat,
    }
    if (request.actionId === 'proposal') {
      parameters.audience = request.audience || '内部立项'
      parameters.length = request.length || '标准版'
      if (request.userInstructions?.trim()) {
        parameters.userInstructions = request.userInstructions.trim()
      }
    } else if (request.actionId === 'investment_ppt') {
      parameters.template = request.template || '公司标准模板'
      parameters.pageCount = request.pageCount || '12-15页'
      parameters.language = request.language || '中文'
    } else if (request.actionId === 'due_diligence') {
      parameters.diligenceScope = request.diligenceScope || '商业尽调'
    } else if (request.actionId === 'qa') {
      parameters.qaMode = request.qaMode || '投资委员会 Q&A'
      parameters.questionDepth = request.questionDepth || '标准版'
    }
    try {
      if (!currentSession?.projectId || currentSession.projectId !== request.projectId) {
        showToast('当前项目随会话固定，请重新打开快捷任务后再试', 'error')
        return false
      }
      const task = await apiPost<AiTask>('/ai/tasks', {
        type: AI_TASK_TYPE_BY_ACTION[request.actionId],
        projectId: request.projectId,
        // 任务关联 chat_conversations 的 UUID 主键，而不是 Flue agentId。
        conversationId: currentSession.rowId,
        parameters,
        idempotencyKey: `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
      })
      setAiTasks((items) => [task, ...items.filter((item) => item.id !== task.id)])
      showToast(`${request.actionLabel}任务已创建，可在消息区查看进度`, 'success')
      return true
    } catch (error) {
      showToast(`${request.actionLabel}任务创建失败：${(error as Error).message}`, 'error')
      return false
    } finally {
      quickTaskLockRef.current = false
    }
  }

  const cancelAiTask = async (task: AiTask) => {
    if (taskMutationId) return
    setTaskMutationId(task.id)
    try {
      const updated = await apiPost<AiTask>(`/ai/tasks/${task.id}/cancel`)
      setAiTasks((items) => items.map((item) => item.id === updated.id ? updated : item))
      showToast('取消请求已提交', 'success')
    } catch (error) {
      showToast(`取消任务失败：${(error as Error).message}`, 'error')
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
      showToast('已按原参数创建重试任务，原失败记录将保留', 'success')
    } catch (error) {
      showToast(`重试任务创建失败：${(error as Error).message}`, 'error')
    } finally {
      setTaskMutationId(null)
    }
  }

  return (
    <div className="-m-6 flex h-[calc(100vh-64px)] min-h-[720px] overflow-hidden bg-white">
      <aside className="flex w-[250px] shrink-0 flex-col border-r border-slate-200 bg-slate-50/60">
        <div className="p-4">
          <Button className="w-full" onClick={openNewSessionDialog} disabled={projects.length === 0}>
            <MessageSquarePlus className="h-4 w-4" />新建会话
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-3">
          <p className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">会话历史</p>
          {sessions.length === 0 && <p className="px-2 py-2 text-[11px] text-slate-400">暂无会话</p>}
          {sessions.map((s) => (
            <div
              key={s.rowId}
              onClick={() => activateSession(s)}
              className={`group mb-1 flex cursor-pointer items-center justify-between rounded-lg px-3 py-2.5 ${s.agentId === convId ? 'bg-white shadow-sm ring-1 ring-brand-200' : 'hover:bg-white/60'}`}
            >
              <span className="truncate text-xs font-medium text-slate-700">{s.title || '新会话'}</span>
              <button onClick={(e) => deleteSession(s.rowId, s.agentId, e)} className="ml-2 shrink-0 text-slate-300 opacity-0 group-hover:opacity-100 hover:text-rose-500" aria-label="删除">×</button>
            </div>
          ))}
          <p className="px-2 pt-3 text-[10px] leading-4 text-slate-400">点"新建会话"开始新对话；同一会话内 AI 记住上下文，刷新不丢。</p>
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
                {currentProject?.name ?? currentSession?.projectName ?? '未绑定项目'}
              </span>
            </div>
          )}
        </div>

        <AiErrorBoundary level="section" title="消息区域显示异常" resetKey={convId}>
          <div ref={scrollRef} className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
            {messages.length === 0 && qaAnswers.length === 0 && !qaAnswersLoading && (
              <div className="flex gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Bot className="h-4 w-4" /></span><div className="min-w-0 max-w-[88%] text-sm leading-7 text-slate-600">你好，我是赛智伯乐投资中台 AI 投研助手。我能检索项目资料、分析风险与亮点、处理文件/数据、采集公开情报、生成投委会 PPT。选好项目后直接提问即可。</div></div>
            )}
            {messages.map((message, messageIndex) => (
              <AiErrorBoundary
                key={`${message.id}-${messageIndex}`}
                level="message"
                title="该条消息显示异常"
                resetKey={message.id}
              >
                <MessageRow message={message} />
              </AiErrorBoundary>
            ))}
            <AiErrorBoundary
              level="section"
              title="项目 Q&A 显示异常"
              resetKey={`${currentConversationRowId}:${qaAnswers.length}`}
            >
              <AiQaCards answers={qaAnswers} loading={qaAnswersLoading} />
            </AiErrorBoundary>
            <AiErrorBoundary
              level="section"
              title="AI 业务任务卡显示异常"
              resetKey={`${currentConversationRowId}:${aiTasks.length}`}
            >
              <AiTaskCards
                tasks={aiTasks}
                loading={aiTasksLoading}
                mutatingTaskId={taskMutationId}
                onCancel={cancelAiTask}
                onRetry={retryAiTask}
                onNotify={showToast}
              />
            </AiErrorBoundary>
            {busy && (() => {
              // 只读取归一化后的最后一条消息；parts 缺失或非数组时已经降级为安全数组。
              const last = messages[messages.length - 1]
              const parts = last?.role === 'assistant' ? last.parts : []
              return <PptTaskBoard parts={parts} busy={busy} />
            })()}
            {busy && messages[messages.length - 1]?.role === 'user' && (
              <div className="flex gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Bot className="h-4 w-4" /></span><span className="inline-block h-4 w-1 animate-pulse bg-brand-500" /></div>
            )}
          </div>
        </AiErrorBoundary>

        <div className="border-t border-slate-200 px-6 py-4">
          <AiErrorBoundary level="section" title="快捷任务区域显示异常" resetKey={String(sending)}>
            <AiQuickActions
              disabled={sending || scope !== 'project' || !currentSession?.projectId}
              projects={projects}
              currentProjectId={scope === 'project' ? currentSession?.projectId ?? '' : ''}
              onRunTask={runQuickTask}
            />
          </AiErrorBoundary>
          <div className="rounded-xl border border-slate-200 p-2">
            {uploadProgress && uploadProgress.total > 0 && (
              <div className="mb-1 flex items-center gap-2 px-1 text-[11px] text-brand-600">
                <RefreshCw className="h-3 w-3 animate-spin" />
                上传中 {uploadProgress.done}/{uploadProgress.total}…
              </div>
            )}
            {uploads.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1.5 px-1">
                {uploads.map((u) => (
                  <span key={u.path} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-600">
                    <FileText className="h-3 w-3" />{u.name}{u.rag && <span className="text-emerald-600">·已入库</span>}
                    <button onClick={() => removeUpload(u.path)} className="ml-0.5 text-slate-400 hover:text-rose-500" aria-label="移除">×</button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // 中文输入法选词确认也会产生 Enter；组合态绝不能触发发送。
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
                // Enter 发送；Shift+Enter 保留多行输入能力。
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              aria-keyshortcuts="Enter Shift+Enter"
              rows={2}
              className="w-full resize-none border-0 px-2 py-1 text-sm leading-6 outline-none placeholder:text-slate-400"
              placeholder={`向 AI 询问 ${scope === 'project' ? currentProject?.name : '机构知识库'}…`}
            />
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onPickFiles} accept=".pdf,.xlsx,.xls,.csv,.docx,.txt,.md,.png,.jpg,.jpeg" />
            <div className="flex items-center justify-between px-1"><div className="flex min-w-0 items-center gap-2 text-[10px] text-slate-400"><button onClick={() => fileInputRef.current?.click()} disabled={uploading} title="上传文件（PDF/Excel/CSV 等，agent 可直接读）" className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-brand-600 disabled:opacity-50">{uploading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}</button><CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" /><span className="truncate">Enter 发送 · Shift + Enter 换行</span></div>{busy
              ? <button aria-label="停止" title="停止生成" onClick={stop} className="grid h-8 w-8 place-items-center rounded-lg bg-rose-500 text-white hover:bg-rose-600"><Square className="h-3.5 w-3.5" /></button>
              : <button aria-label="发送" title="发送（Enter）" disabled={sending || (!input.trim() && uploads.length === 0)} onClick={() => { void send() }} className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white disabled:cursor-not-allowed disabled:bg-slate-200"><Send className="h-4 w-4" /></button>}</div>
          </div>
          {agentError && (
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-[11px] text-rose-600">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{agentError.message}</span>
              <span className="shrink-0 font-mono text-rose-400">{agentError.errorId}</span>
              <button
                type="button"
                title="复制错误编号"
                aria-label="复制错误编号"
                onClick={() => { void copyAiErrorId(agentError.errorId) }}
                className="rounded p-1 text-rose-400 hover:bg-rose-100 hover:text-rose-600"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      <aside className="hidden w-[300px] shrink-0 flex-col border-l border-slate-200 bg-slate-50/60 xl:flex">
        <div className="border-b border-slate-200 p-3">
          <div className="rounded-lg bg-brand-50 p-3"><p className="text-sm font-medium text-brand-800">{scope === 'project' ? currentProject?.name : '全局知识库'}</p><p className="mt-1 text-[11px] text-brand-600">{scope === 'project' ? `${projectFiles.length} 份项目资料可检索` : '机构知识库可检索'}</p></div>
        </div>
        <AiErrorBoundary level="section" title="正式交付物区域显示异常" resetKey={`${projectId}:${artifactRefreshKey}`}>
          <AiArtifactCenter
            projectId={scope === 'project' ? currentProject?.id : undefined}
            refreshKey={artifactRefreshKey}
            onNotify={showToast}
          />
        </AiErrorBoundary>
        <details className="min-h-0 flex-1 overflow-y-auto">
          <summary className="cursor-pointer border-b border-slate-200 px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 hover:bg-white/60 hover:text-slate-600">
            历史兼容产物（只读）
          </summary>
          <div className="min-h-[260px]">
            <AiErrorBoundary level="section" title="历史产物区域显示异常" resetKey={wsRefresh}>
              <WorkspacePanel refreshKey={wsRefresh} onRefresh={() => setWsRefresh((k) => k + 1)} onOpen={setPreview} />
            </AiErrorBoundary>
          </div>
        </details>
      </aside>
      {preview && (
        <AiErrorBoundary level="part" title="文件预览显示异常" resetKey={preview.path}>
          <FilePreview file={preview} onClose={() => setPreview(null)} />
        </AiErrorBoundary>
      )}
      <Modal
        open={newSessionOpen}
        title="新建会话"
        onClose={() => { if (!creatingSession && sessions.length > 0) setNewSessionOpen(false) }}
        footer={(
          <>
            {sessions.length > 0 && (
              <Button variant="secondary" onClick={() => setNewSessionOpen(false)} disabled={creatingSession}>
                取消
              </Button>
            )}
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
          <label className="block">
            <span className="label">项目</span>
            <select
              className="input"
              value={newSessionProjectId}
              onChange={(event) => setNewSessionProjectId(event.target.value)}
              disabled={creatingSession}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
        </div>
      </Modal>
    </div>
  )
}

export function AIAssistantPage() {
  return (
    <FlueProvider client={flueClient}>
      <Chat />
    </FlueProvider>
  )
}
