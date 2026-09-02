import { CheckCircle2, Clock3, History, RotateCcw, ShieldCheck, X, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost } from '../lib/api'
import { formatShanghaiDateTime } from '../lib/dateTime'

export type ConfigurationRevisionTarget = {
  basePath: '/ai/model-settings' | '/ai/capabilities' | '/integrations/im'
  resourceType: string
  resourceId: string
  resourceLabel: string
  currentVersion: number
  confirmImpact?: boolean
}

type Revision = {
  id: string
  operation: 'create' | 'update' | 'delete' | 'rollback'
  sourceVersion: number
  snapshotSha256: string
  snapshotAvailable: boolean
  createdBy: string | null
  createdAt: string
}

const operationLabel: Record<Revision['operation'], string> = {
  create: '创建前',
  update: '修改前',
  delete: '删除前',
  rollback: '上次回滚前',
}

function revisionPath(target: ConfigurationRevisionTarget) {
  return `${target.basePath}/history/${encodeURIComponent(target.resourceType)}/${encodeURIComponent(target.resourceId)}`
}

export function ConfigurationRevisionPanel(props: {
  target: ConfigurationRevisionTarget
  onClose: () => void
  onRolledBack: () => Promise<void> | void
}) {
  const { target, onClose, onRolledBack } = props
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await apiGet<{ revisions: Revision[] }>(revisionPath(target))
      setRevisions(result.revisions)
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message })
    } finally {
      setLoading(false)
    }
  }, [target])

  useEffect(() => { void load() }, [load])

  async function rollback(revision: Revision) {
    const impact = target.confirmImpact
      ? '此操作可能影响启用中的 IM 绑定或待投递任务。'
      : ''
    if (!window.confirm(`${impact}确认将“${target.resourceLabel}”恢复到 v${revision.sourceVersion} 变更前的状态？`)) return
    setBusy(revision.id)
    setNotice(null)
    try {
      await apiPost(`${revisionPath(target)}/${revision.id}/rollback`, {
        expectedVersion: target.currentVersion,
        ...(target.confirmImpact ? { confirmImpact: true } : {}),
      })
      setNotice({ tone: 'ok', text: '配置已恢复；回滚动作本身也已形成可再次恢复的审计版本。' })
      await onRolledBack()
      onClose()
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message })
    } finally {
      setBusy('')
    }
  }

  return <div className="fixed inset-0 z-[60] flex justify-end bg-slate-950/30" role="dialog" aria-modal="true" aria-label={`${target.resourceLabel} 配置历史`}>
    <div className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl">
      <div className="flex items-start justify-between border-b border-slate-100 p-5">
        <div><div className="flex items-center gap-2"><History className="h-4 w-4 text-brand-600" /><h2 className="font-semibold text-slate-800">配置历史</h2></div><p className="mt-1 text-xs text-slate-500">{target.resourceLabel} · 当前 v{target.currentVersion}</p></div>
        <button aria-label="关闭配置历史" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" onClick={onClose}><X className="h-4 w-4" /></button>
      </div>
      <div className="border-b border-blue-100 bg-blue-50 px-5 py-3 text-xs leading-5 text-blue-800"><ShieldCheck className="mr-1 inline h-3.5 w-3.5" />配置历史仅供授权管理员查看。</div>
      {notice && <div className={`m-5 mb-0 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${notice.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>{notice.tone === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}{notice.text}</div>}
      <div className="flex-1 space-y-3 overflow-y-auto p-5">
        {loading && <p className="py-12 text-center text-sm text-slate-400">正在读取审计版本…</p>}
        {!loading && !revisions.length && <p className="py-12 text-center text-sm text-slate-400">尚无配置变更历史。</p>}
        {revisions.map((revision) => <div key={revision.id} className="rounded-xl border border-slate-200 p-4">
          <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium text-slate-700">{operationLabel[revision.operation]}</p><p className="mt-1 flex items-center gap-1 text-xs text-slate-400"><Clock3 className="h-3 w-3" />{formatShanghaiDateTime(revision.createdAt)} · {revision.createdBy ? '管理员操作' : '原操作者已停用'}</p></div><button disabled={busy !== '' || (!revision.snapshotAvailable && revision.operation !== 'create')} className="inline-flex h-8 items-center gap-1 rounded-lg border border-brand-200 px-3 text-xs text-brand-600 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => void rollback(revision)}><RotateCcw className="h-3.5 w-3.5" />{revision.operation === 'create' ? '撤销创建（停用）' : revision.snapshotAvailable ? '恢复此版本' : '快照不可用'}</button></div>
        </div>)}
      </div>
    </div>
  </div>
}
