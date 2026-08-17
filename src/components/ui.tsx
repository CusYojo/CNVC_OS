import { LoaderCircle, Search, UploadCloud, X } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import type { JobStatus, RiskLevel } from '../types'

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  loading,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
}) {
  const variants = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 border-brand-600 shadow-sm shadow-brand-500/10',
    secondary: 'bg-white text-slate-700 hover:bg-slate-50 border-slate-200',
    ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 border-transparent',
    danger: 'bg-white text-rose-600 hover:bg-rose-50 border-rose-200',
  }
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm'} ${variants[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <LoaderCircle className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
}

export function Card({ children, className = '', id }: { children: ReactNode; className?: string; id?: string }) {
  return <section id={id} className={`rounded-xl border border-slate-200/90 bg-white shadow-card ${className}`}>{children}</section>
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'slate' | 'cyan' }) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700 ring-blue-100',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    amber: 'bg-amber-50 text-amber-700 ring-amber-100',
    red: 'bg-rose-50 text-rose-700 ring-rose-100',
    purple: 'bg-violet-50 text-violet-700 ring-violet-100',
    slate: 'bg-slate-100 text-slate-600 ring-slate-200',
    cyan: 'bg-cyan-50 text-cyan-700 ring-cyan-100',
  }
  return <span className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>{children}</span>
}

const stageTone: Record<string, Parameters<typeof Badge>[0]['tone']> = {
  线索: 'slate', 初筛: 'cyan', 立项: 'blue', 尽调: 'purple', 上会: 'amber', 投决: 'red', 投后: 'green', 退出: 'slate', 放弃: 'slate',
}

export function StageBadge({ stage }: { stage: string }) {
  return <Badge tone={stageTone[stage] ?? 'slate'}>{stage}</Badge>
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  return <Badge tone={level === '高' ? 'red' : level === '中' ? 'amber' : 'green'}>{level}风险</Badge>
}

export function StatusBadge({ status }: { status: JobStatus | string }) {
  const tone = status === '成功' || status === '已完成' || status === '已关闭' || status === '启用'
    ? 'green'
    : status === '失败' || status === '已逾期' || status === '禁用'
      ? 'red'
      : status === '生成中' || status === '解析中' || status === '进行中' || status === '处理中'
        ? 'blue'
        : 'slate'
  return <Badge tone={tone}>{status}</Badge>
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex min-h-14 items-center justify-between">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Modal({ open, title, children, onClose, width = 'max-w-xl', footer }: { open: boolean; title: string; children: ReactNode; onClose: () => void; width?: string; footer?: ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-6 backdrop-blur-[2px]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`max-h-[88vh] w-full ${width} overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl`}>
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <button aria-label="关闭" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        <div className="max-h-[calc(88vh-132px)] overflow-y-auto px-6 py-5 scrollbar-thin">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4">{footer}</div>}
      </div>
    </div>
  )
}

export function Drawer({ open, title, children, onClose, width = 'w-[560px]', footer }: { open: boolean; title: string; children: ReactNode; onClose: () => void; width?: string; footer?: ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/25 backdrop-blur-[1px]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className={`absolute right-0 top-0 flex h-full ${width} flex-col bg-white shadow-2xl`}>
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <button aria-label="关闭" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-6 py-4">{footer}</div>}
      </aside>
    </div>
  )
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string; count?: number }[]; value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex items-center gap-1 border-b border-slate-200">
      {tabs.map((tab) => (
        <button key={tab.id} onClick={() => onChange(tab.id)} className={`relative px-4 py-3 text-sm font-medium transition ${value === tab.id ? 'text-brand-700' : 'text-slate-500 hover:text-slate-800'}`}>
          {tab.label}{tab.count !== undefined && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{tab.count}</span>}
          {value === tab.id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
        </button>
      ))}
    </div>
  )
}

export function SearchInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input className="input pl-9" {...props} />
    </div>
  )
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-brand-50 text-brand-600"><Search className="h-5 w-5" /></div>
      <h3 className="font-medium text-slate-800">{title}</h3>
      <p className="mt-1 max-w-sm text-sm leading-6 text-slate-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5">
      {Array.from({ length: rows }).map((_, index) => <div key={index} className="skeleton h-12 rounded-lg" />)}
    </div>
  )
}

export function FileUpload({ onFile, onFiles, multiple, accept = '.pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.txt,.md,.markdown,.mp3,.wav' }: { onFile?: (file: File) => void; onFiles?: (files: File[]) => void; multiple?: boolean; accept?: string }) {
  const allowMultiple = multiple ?? !!onFiles
  return (
    <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-brand-200 bg-brand-50/40 px-6 text-center transition hover:border-brand-400 hover:bg-brand-50">
      <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-white text-brand-600 shadow-sm"><UploadCloud className="h-5 w-5" /></div>
      <p className="text-sm font-medium text-slate-700">点击选择{allowMultiple ? '一个或多个文件' : '文件'}，或拖放到这里</p>
      <p className="mt-1 text-xs text-slate-500">支持 PDF、PPT、Word、Excel、TXT、Markdown 与音频，单文件不超过 100MB{allowMultiple ? '（可多选批量上传）' : ''}</p>
      <input
        type="file"
        accept={accept}
        multiple={allowMultiple}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length) {
            if (onFiles) onFiles(files)
            else if (onFile) onFile(files[0])
          }
          event.currentTarget.value = ''
        }}
      />
    </label>
  )
}

export function ProgressBar({ value, tone = 'blue' }: { value: number; tone?: 'blue' | 'green' | 'amber' }) {
  const color = tone === 'green' ? 'bg-emerald-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-brand-600'
  return <div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
}

export function DataTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead><tr className="border-b border-slate-200 bg-slate-50/80">{headers.map((header, index) => <th key={`${header}-${index}`} className="whitespace-nowrap px-4 py-3 text-xs font-semibold text-slate-500">{header}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  )
}

export function TableCell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-3.5 align-middle text-sm text-slate-600 ${className}`}>{children}</td>
}
