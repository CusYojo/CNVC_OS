import { useState } from 'react'
import type { EvolutionProposal } from '../../../server/src/contracts/aiEvolutionContract'

export function AiEvolutionQuestions({ proposal, save }: {
  proposal: EvolutionProposal; save: (proposal: EvolutionProposal, answers: Record<string, string>) => Promise<void>
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(proposal.spec.questions.map((q) => [q.id, q.answer || ''])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const editable = ['draft', 'needs_input', 'ready'].includes(proposal.status)
  if (!proposal.spec.questions.length) return null
  return <form className="mt-3 space-y-3" aria-label="补充提案信息" onSubmit={async (event) => {
    event.preventDefault()
    if (busy || !editable) return
    setBusy(true); setError('')
    try { await save(proposal, answers) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '答案保存失败') }
    finally { setBusy(false) }
  }}>
    {proposal.spec.questions.map((q) => <fieldset key={q.id} disabled={!editable || busy} className="min-w-0 rounded border border-slate-200 p-2">
      <legend className="px-1 text-xs font-medium">{q.question}</legend>
      <select aria-label={`${q.question}：选择答案`} value={q.options.includes(answers[q.id]) ? answers[q.id] : ''}
        className="w-full min-w-0 rounded border border-slate-300 bg-white p-2 text-xs"
        onChange={(event) => setAnswers((previous) => ({ ...previous, [q.id]: event.target.value }))}>
        <option value="">请选择，或在下方填写</option>
        {q.options.map((option, index) => <option key={index} value={option}>{option}</option>)}
      </select>
      <textarea aria-label={`${q.question}：答案`} maxLength={2000} rows={2} required
        className="mt-2 w-full min-w-0 rounded border border-slate-300 p-2 text-xs" value={answers[q.id] || ''}
        onChange={(event) => setAnswers((previous) => ({ ...previous, [q.id]: event.target.value }))} />
    </fieldset>)}
    {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
    {editable && <button type="submit" disabled={busy || proposal.spec.questions.some((q) => !answers[q.id]?.trim())}
      className="rounded border border-brand-600 px-3 py-1.5 text-xs text-brand-600 disabled:opacity-50">{busy ? '正在保存…' : '保存答案'}</button>}
  </form>
}
