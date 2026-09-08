import { useState } from 'react'
import type { EvolutionProposal, EvolutionSpec } from '../../../server/src/contracts/aiEvolutionContract'

export function AiEvolutionProposalEditor({ proposal, disabled, save }: { proposal: EvolutionProposal; disabled: boolean;
  save: (proposal: EvolutionProposal, spec: EvolutionSpec) => Promise<void> }) {
  const [open, setOpen] = useState(false), [title, setTitle] = useState(proposal.spec.title)
  const [objective, setObjective] = useState(proposal.spec.objective)
  const [criteria, setCriteria] = useState(proposal.spec.acceptanceCriteria.join('\n'))
  const [error, setError] = useState(''), [saving, setSaving] = useState(false)
  if (!open) return <button disabled={disabled} className="rounded border px-2 py-1 text-xs disabled:opacity-50" onClick={() => setOpen(true)}>修改提案</button>
  return <div className="mt-3 rounded border border-slate-200 p-2 text-xs">
    <label className="block">标题<input className="mt-1 w-full rounded border p-1.5" maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label className="mt-2 block">目标行为<textarea className="mt-1 min-h-20 w-full rounded border p-1.5" maxLength={8000} value={objective} onChange={event => setObjective(event.target.value)} /></label>
    <label className="mt-2 block">验收条件（每行一条）<textarea className="mt-1 min-h-20 w-full rounded border p-1.5" value={criteria} onChange={event => setCriteria(event.target.value)} /></label>
    {error && <p role="alert" className="mt-2 text-rose-700">{error}</p>}
    <div className="mt-2 flex gap-2"><button disabled={saving} className="rounded bg-brand-600 px-2 py-1 text-white disabled:opacity-50" onClick={async () => {
      const acceptanceCriteria = criteria.split('\n').map(value => value.trim()).filter(Boolean)
      if (!title.trim() || !objective.trim() || !acceptanceCriteria.length) { setError('标题、目标和至少一条验收条件不能为空'); return }
      setSaving(true); setError('')
      try { await save(proposal, { ...proposal.spec, title: title.trim(), objective: objective.trim(), acceptanceCriteria }); setOpen(false) }
      catch (cause) { setError(cause instanceof Error ? cause.message : '修改失败') } finally { setSaving(false) }
    }}>{saving ? '正在保存…' : '保存修改'}</button><button disabled={saving} className="rounded border px-2 py-1" onClick={() => setOpen(false)}>取消</button></div>
  </div>
}
