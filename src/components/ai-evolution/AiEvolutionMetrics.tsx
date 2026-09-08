import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

type Metric = { key: string; label: string; numerator: number | null; denominator: number | null; value: number | null;
  sampleSize: number; notEvaluated: number; unavailableReason?: string }
type Snapshot = { observedFrom: string; observedTo: string; windowDays: number; truncated: boolean; metrics: Metric[] }

export function AiEvolutionMetrics() {
  const [open, setOpen] = useState(false), [windowDays, setWindowDays] = useState(30)
  const [value, setValue] = useState<Snapshot | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (!open) return () => { active = false }
    setError('')
    void api<Snapshot>(`/ai/evolution/metrics?windowDays=${windowDays}`).then(result => { if (active) setValue(result) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '读取指标失败') })
    return () => { active = false }
  }, [open, windowDays])
  return <details className="mb-3 rounded border border-slate-200 bg-white p-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">效果观察</summary>
    {open && <div className="mt-2 space-y-2 text-xs">
      <label>观察期 <select className="ml-1 rounded border p-1" value={windowDays} onChange={event => setWindowDays(Number(event.target.value))}>
        <option value={7}>近 7 天</option><option value={30}>近 30 天</option><option value={90}>近 90 天</option>
      </select></label>
      {error && <p role="alert" className="text-rose-700">{error}</p>}
      {value?.truncated && <p className="text-amber-700">样本超过查询上限，当前结果不作为完整统计。</p>}
      {value?.metrics.map(metric => <div key={metric.key} className="border-t pt-2">
        <p className="font-medium">{metric.label}：{metric.value === null ? '证据不足' : `${(metric.value * 100).toFixed(1)}%`}</p>
        {metric.denominator === null ? <p>{metric.unavailableReason}</p> : <p>分子 {metric.numerator} / 分母 {metric.denominator}；样本量 {metric.sampleSize}；未评估 {metric.notEvaluated}</p>}
      </div>)}
    </div>}
  </details>
}
