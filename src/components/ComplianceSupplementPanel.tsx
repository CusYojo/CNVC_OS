import { useState } from 'react'
import type { ComplianceSupplementChoice, ComplianceSupplementSnapshot } from '../../server/src/contracts/complianceSupplementContract'

export function ComplianceSupplementPanel({ snapshot, submitting, onSubmit }: {
  snapshot: ComplianceSupplementSnapshot
  submitting: boolean
  onSubmit: (choice: ComplianceSupplementChoice) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [acceptedSnapshot, setAcceptedSnapshot] = useState<string | null>(null)
  const [error, setError] = useState('')
  const submit = async (action: ComplianceSupplementChoice['action']) => {
    setError('')
    try {
      await onSubmit({ action, snapshotId: snapshot.snapshotId, ...(action === 'supplement' ? { supplementText: text } : {}) })
    } catch {
      setError('操作未完成，请刷新缺口清单后重试。')
    }
  }
  const blocked = snapshot.blockingIssues.length > 0
  return <section className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4" aria-label="合规资料补充与继续确认">
    <h4 className="font-medium text-slate-900">生成前需要确认的信息</h4>
    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
      {snapshot.missingItems.map(item => <li key={item}>{item}</li>)}
    </ul>
    {blocked && <div role="alert" className="text-sm text-red-700">
      <p>存在以下冲突，不能直接继续生成，请补充说明或更正材料：</p>
      <ul className="list-disc pl-5">{snapshot.blockingIssues.map(item => <li key={item}>{item}</li>)}</ul>
    </div>}
    <label className="block text-sm text-slate-700">补充信息（材料文件请在项目资料中上传）
      <textarea value={text} onChange={event => setText(event.target.value)} maxLength={2000} disabled={submitting}
        className="mt-1 w-full rounded border border-slate-300 bg-white p-2" rows={3} />
    </label>
    <label className="flex items-start gap-2 text-sm text-slate-700">
      <input type="checkbox" checked={acceptedSnapshot === snapshot.snapshotId} disabled={submitting || blocked}
        onChange={event => setAcceptedSnapshot(event.target.checked ? snapshot.snapshotId : null)} />
      我已了解上述缺口，同意按现有资料生成，并在文档中保留待核验事项和限制条件。
    </label>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={submitting || !text.trim()} onClick={() => { void submit('supplement') }}
        className="rounded border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50">补充后重新核验并生成</button>
      <button type="button" disabled={submitting || blocked || !snapshot.missingItems.length || acceptedSnapshot !== snapshot.snapshotId}
        onClick={() => { void submit('continue_with_gaps') }}
        className="rounded bg-slate-800 px-3 py-2 text-sm text-white disabled:opacity-50">按现有资料继续生成</button>
    </div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </section>
}
