import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { AiEvolutionSkillPromotion } from './AiEvolutionSkillPromotion'

type Status = { candidateHash: string; binding: { bindingId: string; revision: number; matchesCandidate: boolean;
  canRollback: boolean; trialExpiresAt: string | null; expired: boolean } | null }
export function AiEvolutionSkillTrialStatus({ candidateId, candidateHash }: { candidateId: string; candidateHash: string }) {
  const [value, setValue] = useState<Status | null>(null), [error, setError] = useState('')
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false)
  const request = useRef<{ bindingId: string; revision: number; key: string } | null>(null)
  useEffect(() => {
    let active = true
    setValue(null); setError('')
    void api<Status>(`/ai/evolution/candidates/${candidateId}/skill-trial`).then(result => {
      if (!active) return
      if (result.candidateHash !== candidateHash) throw Error('试用状态与当前候选不一致')
      setValue(result)
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '读取试用状态失败') })
    return () => { active = false }
  }, [candidateId, candidateHash, revision])
  return <section className="mt-2 rounded border p-2">
    <button disabled={busy} className="text-brand-600" onClick={() => setRevision(current => current + 1)}>刷新试用状态</button>
    {error && <p role="alert" className="text-rose-700">{error}</p>}
    {value && <p>{!value.binding ? '尚无技能版本绑定' : !value.binding.matchesCandidate ? '当前绑定使用其他版本'
      : value.binding.expired ? '试用已到期，新任务将使用回退版本' : value.binding.trialExpiresAt ? `试用截止 ${new Date(value.binding.trialExpiresAt).toLocaleString()}` : '当前绑定使用此版本'}</p>}
    {value?.binding?.canRollback && <button disabled={busy} className="mt-2 rounded border px-2 py-1" onClick={async () => {
      const binding = value.binding!
      if (!request.current || request.current.bindingId !== binding.bindingId || request.current.revision !== binding.revision) {
        request.current = { bindingId: binding.bindingId, revision: binding.revision, key: crypto.randomUUID() }
      }
      setBusy(true); setError('')
      try {
        await api(`/ai/evolution/candidates/${candidateId}/skill-trial-rollback`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.current.key },
          body: JSON.stringify({ bindingId: binding.bindingId, expectedRevision: binding.revision }) })
        setRevision(current => current + 1)
      } catch (cause) { setError(cause instanceof Error ? cause.message : '回退失败') }
      finally { setBusy(false) }
    }}>恢复已登记的回退版本</button>}
    {value?.binding?.canRollback && value.binding.trialExpiresAt && !value.binding.expired && <AiEvolutionSkillPromotion
      key={`${value.binding.bindingId}:${value.binding.revision}`} candidateId={candidateId} candidateHash={candidateHash}
      bindingId={value.binding.bindingId} revision={value.binding.revision} busy={busy} setBusy={setBusy}
      onComplete={() => setRevision(current => current + 1)} />}
  </section>
}
