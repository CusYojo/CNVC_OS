import { useState } from 'react'
import type { EvolutionProposal, EvolutionSpec } from '../../../server/src/contracts/aiEvolutionContract'

export function AiEvolutionProposalEditor({ proposal, disabled, save }: { proposal: EvolutionProposal; disabled: boolean;
  save: (proposal: EvolutionProposal, spec: EvolutionSpec) => Promise<void> }) {
  const [open, setOpen] = useState(false), [title, setTitle] = useState(proposal.spec.title)
  const [objective, setObjective] = useState(proposal.spec.objective)
  const [criteria, setCriteria] = useState(proposal.spec.acceptanceCriteria.join('\n'))
  const target = proposal.spec.target
  const [rule, setRule] = useState(target.type === 'experience' ? target.rule : '')
  const [taskTypes, setTaskTypes] = useState(target.type === 'experience' ? target.taskTypes.join('\n') : '')
  const [exceptions, setExceptions] = useState(target.type === 'experience' ? target.exceptions.join('\n') : '')
  const [expiresAt, setExpiresAt] = useState(target.type === 'experience' ? target.expiresAt ?? '' : '')
  const [sampleIds, setSampleIds] = useState(target.type === 'skill' ? target.sampleIds.join('\n') : '')
  const [allowedPaths, setAllowedPaths] = useState(target.type === 'code' ? target.allowedPaths.join('\n') : '')
  const [databaseChange, setDatabaseChange] = useState(target.type === 'code' && target.databaseChange)
  const [permissionChange, setPermissionChange] = useState(target.type === 'code' && target.permissionChange)
  const [error, setError] = useState(''), [saving, setSaving] = useState(false)
  if (!open) return <button disabled={disabled} className="rounded border px-2 py-1 text-xs disabled:opacity-50" onClick={() => setOpen(true)}>修改提案</button>
  return <div className="mt-3 rounded border border-slate-200 p-2 text-xs">
    <label className="block">标题<input className="mt-1 w-full rounded border p-1.5" maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label className="mt-2 block">目标行为<textarea className="mt-1 min-h-20 w-full rounded border p-1.5" maxLength={8000} value={objective} onChange={event => setObjective(event.target.value)} /></label>
    <label className="mt-2 block">验收条件（每行一条）<textarea className="mt-1 min-h-20 w-full rounded border p-1.5" value={criteria} onChange={event => setCriteria(event.target.value)} /></label>
    {target.type === 'experience' && <>
      <label className="mt-2 block">经验规则<textarea className="mt-1 min-h-20 w-full rounded border p-1.5" maxLength={8000} value={rule} onChange={event => setRule(event.target.value)} /></label>
      <label className="mt-2 block">适用任务类型（每行一项）<textarea className="mt-1 min-h-16 w-full rounded border p-1.5" value={taskTypes} onChange={event => setTaskTypes(event.target.value)} /></label>
      <label className="mt-2 block">例外条件（每行一项）<textarea className="mt-1 min-h-16 w-full rounded border p-1.5" value={exceptions} onChange={event => setExceptions(event.target.value)} /></label>
      <label className="mt-2 block">有效期（ISO 时间，留空表示长期）<input className="mt-1 w-full rounded border p-1.5" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label>
    </>}
    {target.type === 'skill' && <label className="mt-2 block">测试样本 ID（每行一项）<textarea className="mt-1 min-h-20 w-full rounded border p-1.5" value={sampleIds} onChange={event => setSampleIds(event.target.value)} /></label>}
    {target.type === 'code' && <>
      <label className="mt-2 block">允许修改路径（每行一项）<textarea className="mt-1 min-h-20 w-full rounded border p-1.5" value={allowedPaths} onChange={event => setAllowedPaths(event.target.value)} /></label>
      <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={databaseChange} onChange={event => setDatabaseChange(event.target.checked)} />涉及数据库变更</label>
      <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={permissionChange} onChange={event => setPermissionChange(event.target.checked)} />涉及权限变更</label>
      <p className="mt-2 text-slate-500">仓库与基线只能通过重新整理提案变更，避免把编辑表单当作仓库授权入口。</p>
    </>}
    {error && <p role="alert" className="mt-2 text-rose-700">{error}</p>}
    <div className="mt-2 flex gap-2"><button disabled={saving} className="rounded bg-brand-600 px-2 py-1 text-white disabled:opacity-50" onClick={async () => {
      const acceptanceCriteria = criteria.split('\n').map(value => value.trim()).filter(Boolean)
      if (!title.trim() || !objective.trim() || !acceptanceCriteria.length) { setError('标题、目标和至少一条验收条件不能为空'); return }
      const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean)
      let nextTarget: EvolutionSpec['target'] = target
      if (target.type === 'experience') {
        if (!rule.trim() || !lines(taskTypes).length) { setError('经验规则和至少一种适用任务类型不能为空'); return }
        if (expiresAt.trim() && !Number.isFinite(Date.parse(expiresAt.trim()))) { setError('有效期必须是有效的 ISO 时间'); return }
        nextTarget = { ...target, rule: rule.trim(), taskTypes: lines(taskTypes), exceptions: lines(exceptions),
          ...(expiresAt.trim() ? { expiresAt: new Date(expiresAt.trim()).toISOString() } : { expiresAt: undefined }) }
      } else if (target.type === 'skill') {
        if (!lines(sampleIds).length) { setError('至少选择一个测试样本'); return }
        nextTarget = { ...target, sampleIds: lines(sampleIds) }
      } else {
        if (!lines(allowedPaths).length) { setError('至少填写一个允许修改路径'); return }
        nextTarget = { ...target, allowedPaths: lines(allowedPaths), databaseChange, permissionChange }
      }
      setSaving(true); setError('')
      try { await save(proposal, { ...proposal.spec, title: title.trim(), objective: objective.trim(), acceptanceCriteria, target: nextTarget }); setOpen(false) }
      catch (cause) { setError(cause instanceof Error ? cause.message : '修改失败') } finally { setSaving(false) }
    }}>{saving ? '正在保存…' : '保存修改'}</button><button disabled={saving} className="rounded border px-2 py-1" onClick={() => setOpen(false)}>取消</button></div>
  </div>
}
