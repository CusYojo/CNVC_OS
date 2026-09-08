import { useState } from 'react'
import { api } from '../../lib/api'

type Plan = { candidateId: string; candidateHash: string; oldBaseCommit: string; baseCommit: string; targetEnvironment: string; required: boolean }
export function AiEvolutionReevaluation(props: { candidateId: string; candidateHash: string; busy: boolean;
  setBusy: (busy: boolean) => void; onCreated?: () => void }) {
  const [targets, setTargets] = useState<{ id: string; label: string }[] | null>(null)
  const [target, setTarget] = useState(''), [plan, setPlan] = useState<Plan | null>(null)
  const [error, setError] = useState(''), [created, setCreated] = useState('')
  const perform = async (action: () => Promise<void>) => {
    props.setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : '重新评估操作失败') }
    finally { props.setBusy(false) }
  }
  const post = <T,>(suffix: string, body: unknown, key?: string) => api<T>(`/ai/evolution/candidates/${props.candidateId}/${suffix}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) })
  return <div className="mt-3 rounded border border-slate-200 p-2">
    <p className="font-medium">基线变化后重新评估</p>
    <p className="mt-1 text-slate-500">保留原需求和验收条件，基于最新提交创建提案，再从提案中启动执行。</p>
    {targets === null && <button disabled={props.busy} className="mt-2 rounded border px-2 py-1" onClick={() => void perform(async () => {
      const result = await api<{ list: { id: string; label: string }[] }>(`/ai/evolution/candidates/${props.candidateId}/release-targets`)
      setTargets(result.list); setTarget(result.list[0]?.id ?? '')
    })}>选择目标环境</button>}
    {targets?.length === 0 && <p className="mt-2 text-slate-500">没有已授权的目标环境。</p>}
    {Boolean(targets?.length) && !created && <>
      <select aria-label="重新评估目标环境" disabled={props.busy} value={target} className="mt-2 max-w-full rounded border p-1" onChange={event => { setTarget(event.target.value); setPlan(null); setError('') }}>
        {targets!.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <button disabled={props.busy || !target} className="ml-2 mt-2 rounded border px-2 py-1" onClick={() => void perform(async () => {
        setPlan(null)
        const result = await post<Plan>('reevaluation-plan', { targetEnvironment: target })
        if (result.candidateId !== props.candidateId || result.candidateHash !== props.candidateHash || result.targetEnvironment !== target) throw Error('候选或环境已变化，请刷新候选')
        setPlan(result)
      })}>检查基线</button>
    </>}
    {plan && !created && <div className="mt-2">
      <p className="break-all">原提交：{plan.oldBaseCommit}</p><p className="break-all">当前提交：{plan.baseCommit}</p>
      {plan.required ? <button disabled={props.busy} className="mt-2 rounded border px-2 py-1" onClick={() => void perform(async () => {
        const binding = JSON.stringify([props.candidateId, plan.candidateHash, plan.targetEnvironment, plan.baseCommit])
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(binding))
        const key = `reevaluation:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
        const result = await post<{ proposal: { id: string } }>('reevaluation', {
          candidateHash: plan.candidateHash, targetEnvironment: plan.targetEnvironment, baseCommit: plan.baseCommit,
        }, key)
        setCreated(result.proposal.id); props.onCreated?.()
      })}>创建重新评估提案</button> : <p>基线未变化，可继续原候选流程。</p>}
    </div>}
    {created && <p role="status" className="mt-2 text-emerald-700">重新评估提案已创建。请在提案列表中查看并启动执行。</p>}
    {error && <p role="alert" className="mt-2 text-rose-700">{error}</p>}
  </div>
}
