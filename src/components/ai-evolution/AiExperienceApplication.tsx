import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

type Application = { id: string; taskId: string; checkStatus: string; snapshot: {
  loaded: { versionId: string; rule: string }[]; excluded: { reason: string }[]
}; checkResult: null | { checks: { versionId: string; verdict: string; explanation: string; excerpts: string[] }[] } }
const labels: Record<string, string> = { not_checked: '尚未检查遵守', PASS: '已检查：通过', FAIL: '已检查：未通过',
  BLOCKED: '检查受阻', NOT_RUN: '未执行检查', SKIPPED: '已跳过检查' }
const reasons: Record<string, string> = { disabled: '已停用', source_access_revoked: '来源权限失效', scope_mismatch: '作用范围不匹配',
  project_mismatch: '项目不匹配', task_type_mismatch: '任务类型不匹配', expired: '已过期', prompt_budget: '提示词预算不足', kind_mismatch: '类型不匹配' }

export function AiExperienceApplication({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false), [refresh, setRefresh] = useState(0)
  const [value, setValue] = useState<Application | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [feedbackType, setFeedbackType] = useState<'helpful' | 'incorrect' | 'regression' | 'suggestion'>('helpful')
  const [comment, setComment] = useState(''), [feedbackState, setFeedbackState] = useState<'idle' | 'saving' | 'saved'>('idle')
  useEffect(() => {
    let active = true
    setValue(null); setError('')
    if (!open) return () => { active = false }
    setLoading(true)
    void api<{ list: Application[] }>(`/ai/evolution/applications?taskId=${encodeURIComponent(taskId)}`).then(result => {
      if (!active) return
      if (result.list.length > 1 || result.list.some(row => row.taskId !== taskId)) throw Error('经验记录与当前任务不一致')
      setValue(result.list[0] ?? null)
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '读取经验记录失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [taskId, open, refresh])
  return <details className="mt-2 max-w-full rounded border border-slate-200 bg-white p-2 text-xs text-slate-600" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer">本次任务的经验记录</summary>
    {open && <div className="mt-2 space-y-2 break-words">
      <button className="text-brand-600 disabled:opacity-50" disabled={loading} onClick={() => setRefresh(n => n + 1)}>刷新经验记录</button>
      {loading && <p role="status">正在读取经验记录…</p>}
      {error && <p role="alert" className="text-rose-700">{error}</p>}
      {!loading && !error && !value && <p>本次任务没有经验应用记录。</p>}
      {!loading && !error && value && <>
        <p>已加载 {value.snapshot.loaded.length} 条经验 · {labels[value.checkStatus] ?? '检查状态未知'}</p>
        <p>加载记录不代表输出已经遵守；旧任务保留当时的版本。</p>
        {value.snapshot.loaded.map(rule => <div key={rule.versionId} className="border-t pt-2"><p className="whitespace-pre-wrap">{rule.rule}</p><p>版本：{rule.versionId}</p></div>)}
        {value.snapshot.excluded.map((item, index) => <p key={index}>未加载：{reasons[item.reason] ?? '不满足加载条件'}</p>)}
        {value.checkResult?.checks.map(check => <div key={check.versionId} className="border-t pt-2">
          <p>{labels[check.verdict] ?? '检查状态未知'} · 版本 {check.versionId}</p><p>{check.explanation}</p>
          {check.excerpts.map((excerpt, index) => <blockquote key={index} className="mt-1 whitespace-pre-wrap border-l-2 pl-2">{excerpt}</blockquote>)}
        </div>)}
        <div className="border-t pt-2">
          <p className="font-medium">提交本次应用反馈</p>
          <select aria-label="经验反馈类型" className="mt-2 rounded border border-slate-200 bg-white p-1" value={feedbackType}
            onChange={event => { setFeedbackType(event.target.value as typeof feedbackType); setFeedbackState('idle') }}>
            <option value="helpful">效果良好</option><option value="incorrect">结果不正确</option>
            <option value="regression">发现回归</option><option value="suggestion">改进建议</option>
          </select>
          <textarea aria-label="经验反馈说明" className="mt-2 min-h-16 w-full rounded border border-slate-200 p-2" maxLength={4000}
            value={comment} onChange={event => { setComment(event.target.value); setFeedbackState('idle') }} placeholder="说明实际效果或需要改进的地方" />
          <button className="mt-2 rounded bg-brand-600 px-2 py-1 text-white disabled:opacity-50"
            disabled={feedbackState === 'saving' || !comment.trim()} onClick={async () => {
              setFeedbackState('saving'); setError('')
              try {
                await api('/ai/evolution/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json',
                  'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ applicationId: value.id, feedbackType,
                    comment: comment.trim(), evidenceRefs: [{ type: 'task', id: taskId }] }) })
                setFeedbackState('saved'); setComment('')
              } catch (reason) { setFeedbackState('idle'); setError(reason instanceof Error ? reason.message : '提交反馈失败') }
            }}>{feedbackState === 'saving' ? '正在提交…' : feedbackState === 'saved' ? '反馈已提交' : '提交反馈'}</button>
        </div>
      </>}
    </div>}
  </details>
}
