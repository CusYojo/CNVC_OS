import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

type Job = { id: string; candidateId: string; environment: string; status: string; attempt: number;
  error: { code: string; message: string } | null; createdAt: string; updatedAt: string; completedAt: string | null }
const labels: Record<string, string> = { queued: '等待独立发布进程', preparing: '正在准备候选版本', prepared: '候选版本已准备',
  activating: '正在切换并验证', succeeded: '发布成功', failed: '发布失败', rolled_back: '已验证回退' }

export function AiEvolutionCodeRelease(props: { candidateId: string; candidateHash: string; evaluationHash: string;
  status: string; busy: boolean; setBusy: (value: boolean) => void; onChanged: () => Promise<void> }) {
  const [targets, setTargets] = useState<{ id: string; label: string }[] | null>(null)
  const [target, setTarget] = useState(''), [approvalId, setApprovalId] = useState(''), [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const perform = async (action: () => Promise<void>) => { props.setBusy(true); setError(''); try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '发布操作失败') } finally { props.setBusy(false) } }
  const loadJob = async () => setJob(await api<Job | null>(`/ai/evolution/candidates/${props.candidateId}/release`))
  useEffect(() => { void loadJob().catch(() => undefined) }, [props.candidateId])
  const key = async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${props.candidateId}:${approvalId}:${target}`))
    return `release:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
  }
  return <div className="mt-3 rounded border border-slate-200 p-2">
    <p className="font-medium">正式发布</p>
    <p className="mt-1 text-slate-500">先固定目标环境并生成一次性批准，再将任务交给独立发布进程。发布进程会验证版本身份和健康状态，失败时按实际状态恢复。</p>
    {job ? <div className="mt-2">
      <p role="status">状态：{labels[job.status] ?? job.status}；尝试 {job.attempt} 次</p>
      {job.error && <p role="alert" className="text-rose-700">{job.error.message}</p>}
      {!['succeeded', 'failed', 'rolled_back'].includes(job.status) && <button disabled={props.busy} className="mt-2 rounded border px-2 py-1" onClick={() => void perform(loadJob)}>刷新发布状态</button>}
    </div> : props.status === 'approved' ? <>
      {targets === null && <button disabled={props.busy} className="mt-2 rounded border px-2 py-1" onClick={() => void perform(async () => {
        const value = await api<{ list: { id: string; label: string }[] }>(`/ai/evolution/candidates/${props.candidateId}/release-targets`)
        setTargets(value.list); setTarget(value.list[0]?.id ?? '')
      })}>选择发布环境</button>}
      {targets?.length === 0 && <p className="mt-2 text-slate-500">没有已授权的发布环境。</p>}
      {Boolean(targets?.length) && <div className="mt-2">
        <select aria-label="正式发布环境" disabled={props.busy || Boolean(approvalId)} value={target} className="max-w-full rounded border p-1"
          onChange={event => { setTarget(event.target.value); setApprovalId('') }}>{targets!.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        {!approvalId ? <button disabled={props.busy || !target} className="ml-2 rounded border px-2 py-1" onClick={() => void perform(async () => {
          const result = await api<{ approvalId: string }>(`/ai/evolution/candidates/${props.candidateId}/release-approval`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetEnvironment: target,
              candidateHash: props.candidateHash, evaluationHash: props.evaluationHash }) })
          setApprovalId(result.approvalId)
        })}>核对并批准</button> : <button disabled={props.busy} className="ml-2 rounded bg-brand-600 px-2 py-1 text-white" onClick={() => void perform(async () => {
          const value = await api<Job>(`/ai/evolution/candidates/${props.candidateId}/release`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': await key() },
            body: JSON.stringify({ approvalId, targetEnvironment: target }) })
          setJob(value); await props.onChanged()
        })}>确认提交发布任务</button>}
        {approvalId && <p className="mt-1 text-amber-700">批准已生成且一小时内有效。再次确认后才会进入发布队列。</p>}
      </div>}
    </> : <p className="mt-2 text-slate-500">候选状态为“{labels[props.status] ?? props.status}”。</p>}
    {error && <p role="alert" className="mt-2 text-rose-700">{error}</p>}
  </div>
}
