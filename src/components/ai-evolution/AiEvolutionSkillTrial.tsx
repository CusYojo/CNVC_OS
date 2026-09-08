import { useRef, useState } from 'react'
import { api } from '../../lib/api'

type Plan = { target: { versionId: string; fallbackVersionId: string; capabilityId: string; expectedRevision: number;
  scope: { type: 'user' | 'project'; key: string }; trialExpiresAt: string }; candidateHash: string; evaluationHash: string }
type Binding = { bindingId: string; versionId: string; revision: number }
export function AiEvolutionSkillTrial(props: { candidateId: string; candidateHash: string; versionId: string; fallbackVersionId: string }) {
  const [minutes, setMinutes] = useState('60'), [plan, setPlan] = useState<Plan | null>(null)
  const [binding, setBinding] = useState<Binding | null>(null), [rolledBack, setRolledBack] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const attempt = useRef<{ approvalId?: string; key: string } | null>(null)
  const rollbackKey = useRef<string | null>(null)
  const post = <T,>(suffix: string, body: unknown, key?: string) => api<T>(`/ai/evolution/candidates/${props.candidateId}/${suffix}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) })
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : '试用操作失败') }
    finally { setBusy(false) }
  }
  return <section className="mt-2 rounded border p-2">
    {!binding && <>
      <label>试用分钟数 <input aria-label="试用分钟数" className="w-24 rounded border px-1" type="number" min="1" max="43200" value={minutes} disabled={busy || !!attempt.current}
        onChange={event => { setMinutes(event.target.value); setPlan(null) }} /></label>
      <button disabled={busy || !!attempt.current} className="ml-2 rounded border px-2 py-1 disabled:opacity-50" onClick={() => void perform(async () => {
        setPlan(null)
        const durationSeconds = Number(minutes) * 60
        if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 60) throw Error('请输入有效的试用分钟数')
        const result = await post<Plan>('skill-trial-plan', { versionId: props.versionId, fallbackVersionId: props.fallbackVersionId, durationSeconds })
        if (result.candidateHash !== props.candidateHash || result.target.versionId !== props.versionId || result.target.fallbackVersionId !== props.fallbackVersionId) throw Error('试用预览与当前候选不一致')
        setPlan(result)
      })}>预览试用</button>
      {plan && <>
        <p className="mt-2 break-all">范围：{plan.target.scope.type === 'user' ? '用户' : '项目'} {plan.target.scope.key}</p>
        <p>到期时间：{new Date(plan.target.trialExpiresAt).toLocaleString()}</p>
        <button disabled={busy} className="mt-2 rounded border px-2 py-1 disabled:opacity-50" onClick={() => void perform(async () => {
          const request = attempt.current ??= { key: crypto.randomUUID() }
          if (!request.approvalId) request.approvalId = (await post<{ approvalId: string }>('skill-trial-approval', {
            target: plan.target, candidateHash: plan.candidateHash, evaluationHash: plan.evaluationHash })).approvalId
          setBinding(await post<Binding>('skill-trial', { target: plan.target, approvalId: request.approvalId }, request.key))
        })}>{attempt.current ? '重试启动试用' : '批准并启动试用'}</button>
      </>}
    </>}
    {binding && <>
      <p role="status">{rolledBack ? '已恢复回退版本' : '试用绑定已更新'}</p>
      {!rolledBack && <button disabled={busy} className="mt-2 rounded border px-2 py-1 disabled:opacity-50" onClick={() => void perform(async () => {
        const result = await post<Binding>('skill-trial-rollback', { bindingId: binding.bindingId, expectedRevision: binding.revision }, rollbackKey.current ??= crypto.randomUUID())
        setBinding(result); setRolledBack(true)
      })}>恢复回退版本</button>}
    </>}
    {busy && <p role="status">正在处理…</p>}
    {error && <p role="alert" className="mt-2 text-rose-700">{error}</p>}
  </section>
}
