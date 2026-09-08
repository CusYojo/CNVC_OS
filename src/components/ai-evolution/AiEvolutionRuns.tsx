import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import type { EvolutionRun } from '../../../server/src/contracts/aiEvolutionContract'
import { AiEvolutionEvents } from './AiEvolutionEvents'
import { AiEvolutionSkillComparison } from './AiEvolutionSkillComparison'

const labels = { queued: '等待执行', preparing: '准备环境', executing: '开发中', evaluating: '验证中', succeeded: '候选已生成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断' }
export function AiEvolutionRuns({ proposalId, kind }: { proposalId: string; kind: 'code' | 'skill' }) {
  const [runs, setRuns] = useState<EvolutionRun[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [stale, setStale] = useState(false)
  useEffect(() => {
    let disposed = false, pending = false
    setRuns([]); setError(''); setStale(false)
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const result = await api<{ list: EvolutionRun[] }>(`/ai/evolution/proposals/${proposalId}/runs`)
        if (!disposed) {
          setRuns((previous) => result.list.map((run) => {
            const known = previous.find((item) => item.id === run.id)
            if (known && new Date(known.updatedAt).getTime() > new Date(run.updatedAt).getTime()) return known
            return known?.cancelRequestedAt && !run.cancelRequestedAt ? { ...run, cancelRequestedAt: known.cancelRequestedAt } : run
          }))
          setError('')
          setStale(false)
        }
      } catch (error) { if (!disposed) {
        // Keep the last observed progress for transient outages, but remove inaccessible records.
        if (!(error instanceof ApiError) || (error.status !== 0 && error.status < 500)) setRuns([])
        setStale(true); setError(error instanceof Error ? error.message : '读取进度失败')
      } }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [proposalId])
  return <div className="mt-3 text-xs leading-5">
    {error && <p role="alert" className="text-rose-700">{error}</p>}
    {stale && runs.length > 0 && <p role="status" className="text-amber-700">连接中断，以下为最后确认的进度；恢复连接后自动刷新。</p>}
    {runs.map((run) => <div key={run.id} className="mt-2 rounded bg-slate-50 p-2">
      <p>{run.cancelRequestedAt && !['cancelled', 'failed', 'interrupted', 'succeeded'].includes(run.status) ? '正在取消，等待环境停止确认' : labels[run.status]}</p>
      <p className="text-slate-500">累计 {run.usage.elapsedSeconds} 秒 / {run.budget.maxDurationSeconds} 秒；Token {run.usage.modelTokens ?? '待核对'} / {run.budget.maxModelTokens}</p>
      {run.error && <p className="break-words text-rose-700">{run.error.message}（{run.error.code}）</p>}
      <AiEvolutionEvents runId={run.id} />
      {kind === 'skill' && ['evaluating', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)
        && <AiEvolutionSkillComparison runId={run.id} />}
      {run.status === 'interrupted' && !run.cancelRequestedAt && <div className="mt-2">
        <p className="text-slate-500">重新从冻结源码尝试，沿用原任务的剩余预算和执行配置。</p>
        <button disabled={Boolean(busy) || stale} className="mt-1 rounded border px-2 disabled:opacity-50" onClick={async () => {
          setBusy(run.id); setError('')
          try {
            const updated = await api<EvolutionRun>(`/ai/evolution/runs/${run.id}/resume`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedAttempt: run.attempt }),
            })
            setRuns((rows) => rows.map((row) => row.id === updated.id ? updated : row))
          } catch (cause) { setError(cause instanceof Error ? cause.message : '继续请求失败') }
          finally { setBusy('') }
        }}>{busy === run.id ? '正在请求…' : '继续中断任务'}</button>
      </div>}
      {['queued', 'preparing', 'executing', 'evaluating'].includes(run.status) && !run.cancelRequestedAt && <button disabled={Boolean(busy) || stale} className="mt-1 rounded border px-2 disabled:opacity-50" onClick={async () => {
        setBusy(run.id); setError('')
        try {
          const updated = await api<EvolutionRun>(`/ai/evolution/runs/${run.id}/cancel`, { method: 'POST' })
          setRuns((rows) => rows.map((row) => row.id === updated.id ? updated : row))
        } catch (error) { setError(error instanceof Error ? error.message : '取消请求失败') }
        finally { setBusy('') }
      }}>{busy === run.id ? '正在请求…' : '取消执行'}</button>}
    </div>)}
  </div>
}
