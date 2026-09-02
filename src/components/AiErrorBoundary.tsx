import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, Copy, RefreshCw } from 'lucide-react'
import { uid } from '../lib/uid'
import { useAuthStore } from '../store/useAuthStore'
import { isAiPlatformAdminRole } from '../../server/src/contracts/adminRoleContract'

type BoundaryLevel = 'route' | 'section' | 'message' | 'part'

type Props = {
  children: ReactNode
  level?: BoundaryLevel
  resetKey?: string | number
  title?: string
  onReset?: () => void
}

type State = {
  error: Error | null
  errorId: string
}

export function createAiErrorId(): string {
  return `AI-${uid().replace(/-/g, '').slice(0, 8).toUpperCase()}`
}

export async function copyAiErrorId(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch { /* fallback below */ }

  const field = document.createElement('textarea')
  field.value = text
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  try { document.execCommand('copy') } finally { field.remove() }
}

export class AiErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorId: '' }

  static getDerivedStateFromError(error: Error): State {
    return { error, errorId: createAiErrorId() }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 暂不上传原始消息/工具参数，避免项目资料进入普通错误日志。
    console.error(`[${this.state.errorId}] AI 界面渲染异常`, {
      name: error.name,
      message: error.message,
      componentStack: info.componentStack,
    })
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null, errorId: '' })
    }
  }

  private reset = () => {
    this.setState({ error: null, errorId: '' })
    this.props.onReset?.()
  }

  render() {
    if (!this.state.error) return this.props.children

    const level = this.props.level ?? 'section'
    const title = this.props.title ?? (level === 'route' ? 'AI 助手暂时无法显示' : '这部分内容显示异常')
    const compact = level === 'message' || level === 'part'
    const showDiagnostics = isAiPlatformAdminRole(useAuthStore.getState().user?.role ?? '')

    return (
      <div className={
        compact
          ? 'my-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800'
          : level === 'route'
            ? 'grid min-h-[calc(100vh-64px)] place-items-center bg-slate-50 p-6'
            : 'grid min-h-40 flex-1 place-items-center rounded-xl border border-amber-200 bg-amber-50/70 p-6'
      }>
        <div className={compact ? 'flex items-center gap-2' : 'max-w-lg text-center'}>
          <AlertTriangle className={compact ? 'h-4 w-4 shrink-0' : 'mx-auto h-8 w-8 text-amber-500'} />
          <div className={compact ? 'min-w-0 flex-1' : ''}>
            <p className={compact ? 'font-medium' : 'mt-3 font-semibold text-slate-800'}>{title}</p>
            {!compact && (
              <p className="mt-2 text-sm leading-6 text-slate-600">
                已阻止异常扩散到整个页面。会话记录仍保存在服务端，可刷新后重新加载。
              </p>
            )}
            {showDiagnostics && <p className={compact ? 'mt-0.5 text-xs text-amber-700' : 'mt-3 font-mono text-xs text-slate-500'}>错误编号：{this.state.errorId}</p>}
          </div>
          <div className={compact ? 'flex shrink-0 items-center gap-1' : 'mt-4 flex justify-center gap-2'}>
            {showDiagnostics && <button
              type="button"
              onClick={() => { void copyAiErrorId(this.state.errorId) }}
              title="复制错误编号"
              className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
            >
              <Copy className="h-3 w-3" />{compact ? '' : '复制编号'}
            </button>}
            <button
              type="button"
              onClick={this.reset}
              className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
            >
              <RefreshCw className="h-3 w-3" />{compact ? '' : '重试显示'}
            </button>
            {level === 'route' && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-xs text-white hover:bg-brand-700"
              >
                刷新页面
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
