import { useRef, useState } from 'react'
import { api } from '../../lib/api'

type Plan = { target: { bindingId: string; expectedRevision: number; scope: { type: 'user' | 'project'; key: string } };
  candidateHash: string; evaluationHash: string }
export function AiEvolutionSkillPromotion(props: { candidateId: string; candidateHash: string; bindingId: string;
  revision: number; busy: boolean; setBusy: (busy: boolean) => void; onComplete: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null), [error, setError] = useState('')
  const attempt = useRef<{ key: string; approvalId?: string } | null>(null)
  const post = <T,>(suffix: string, body: unknown, key?: string) => api<T>(`/ai/evolution/candidates/${props.candidateId}/${suffix}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) })
  const perform = async (action: () => Promise<void>) => {
    props.setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : '正式生效操作失败') }
    finally { props.setBusy(false) }
  }
  return <div className="mt-2">
    {!plan && <button disabled={props.busy} className="rounded border px-2 py-1" onClick={() => void perform(async () => {
      const result = await post<Plan>('skill-promotion-plan', { bindingId: props.bindingId })
      if (result.candidateHash !== props.candidateHash || result.target.bindingId !== props.bindingId
        || result.target.expectedRevision !== props.revision) throw Error('绑定已变化，请刷新状态')
      setPlan(result)
    })}>查看正式生效方案</button>}
    {plan && <>
      <p className="break-all">确认范围：{plan.target.scope.type === 'user' ? '用户' : '项目'} {plan.target.scope.key}</p>
      <p>确认后此版本持续生效，保留旧版本供手动回退。</p>
      <button disabled={props.busy} className="mt-1 rounded border px-2 py-1" onClick={() => void perform(async () => {
        const request = attempt.current ??= { key: crypto.randomUUID() }
        request.approvalId ??= (await post<{ approvalId: string }>('skill-promotion-approval', plan)).approvalId
        await post('skill-promotion', { target: plan.target, approvalId: request.approvalId }, request.key)
        props.onComplete()
      })}>{attempt.current ? '重试正式生效' : '批准正式生效'}</button>
    </>}
    {error && <p role="alert" className="text-rose-700">{error}</p>}
  </div>
}
