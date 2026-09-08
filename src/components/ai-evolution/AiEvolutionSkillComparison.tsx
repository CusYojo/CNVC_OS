import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { EvolutionSkillComparisonPreview } from '../../../server/src/contracts/aiEvolutionEvaluationContract'

type ComparisonTarget = { candidateId: string; sourceHash: string; runId?: never }
  | { runId: string; candidateId?: never; sourceHash?: never }
type ComparisonResult = EvolutionSkillComparisonPreview & { checkpointHash?: string }

export function AiEvolutionSkillComparison({ candidateId, sourceHash, runId }: ComparisonTarget) {
  const [opened, setOpened] = useState(false)
  const [value, setValue] = useState<ComparisonResult | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setValue(null); setError('')
    if (opened) void api<ComparisonResult>(runId ? `/ai/evolution/runs/${runId}/skill-comparison` : `/ai/evolution/candidates/${candidateId}/skill-comparison`)
      .then(result => {
        if (!active) return
        if (runId ? !/^[a-f0-9]{64}$/.test(result.checkpointHash ?? '') : result.sourceHash !== sourceHash) throw Error('对比报告与当前任务不一致')
        setValue(result)
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '读取对比报告失败') })
    return () => { active = false }
  }, [candidateId, sourceHash, runId, opened, revision])
  return <details className="mt-2 min-w-0 rounded border border-slate-200 p-2" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary className="cursor-pointer">{runId ? '查看本次技能评测报告' : '新旧技能产物对比'}</summary>
    {opened && <>
      <button className="mt-2 text-brand-600" onClick={() => setRevision(current => current + 1)}>刷新对比</button>
      {error ? <p role="alert" className="mt-2 text-rose-700">{error}</p> : !value ? <p className="mt-2">正在读取对比报告…</p> : <>
        <p className="mt-2 break-words">指标：{value.metric.name}；{value.metric.direction === 'higher' ? '越高越好' : '越低越好'}，最低改善值 {value.metric.minimumImprovement}。</p>
        <p className="break-all text-slate-500">固定模型：{value.runtime.modelVersion}；样本数：{value.samples.length}。产物生成不等于正式生效。</p>
        {value.samples.map(sample => <details key={sample.id} className="mt-2 border-t border-slate-100 pt-2">
          <summary className="cursor-pointer break-all">样本 {sample.id}</summary>
          {sample.sides.map(side => <section key={side.side} className="mt-2 min-w-0 rounded bg-slate-50 p-2">
            <p className="font-medium">{side.side === 'baseline' ? '原技能' : '候选技能'}：{side.score}</p>
            <p className="break-all text-slate-500">版本 {side.skillHash.slice(0, 16)}</p>
            {side.checks.map(check => <details key={check.id}><summary className="cursor-pointer">{check.id}：{check.verdict}</summary><p className="whitespace-pre-wrap break-words">{check.evidence}</p></details>)}
            <ul className="mt-2 space-y-1">{side.downloads.map((file, position) => <li key={`${file.index}-${position}`} className="break-all">
              <a className="text-brand-600 underline" href={runId
                ? `/api/ai/evolution/runs/${runId}/skill-artifacts/${file.index}?checkpointHash=${value.checkpointHash}`
                : `/api/ai/evolution/candidates/${candidateId}/artifacts/${file.index}`} download>{file.label}</a>
              <span className="ml-1 text-slate-500">{file.bytes.toLocaleString()} 字节</span>
            </li>)}</ul>
          </section>)}
        </details>)}
      </>}
    </>}
  </details>
}
