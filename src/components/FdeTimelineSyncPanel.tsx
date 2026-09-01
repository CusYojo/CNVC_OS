import { useEffect, useRef, useState } from 'react'
import { apiGet, apiPost } from '../lib/api'
import { Button, Modal } from './ui'
import { useToast } from './Toast'
import type { TimelinePreview } from '../../server/src/contracts/fdeTimelineTaskContract'
import { agentReceiptSchema, agentResolutionSchema } from '../../server/src/contracts/fdeProjectAgentContract'
import { useAuthStore } from '../store/useAuthStore'
import { clearTimelineRecovery, readTimelineRecovery, saveTimelineRecovery, timelineRecoveryKey } from '../lib/fdeTimelineRecovery'

const labels = { add: '新增', update: '更新', retire: '收起', restore: '恢复', keep: '保留' }
export function FdeTimelineSyncPanel({ projectId, onChanged }: { projectId: string; onChanged: () => Promise<void> }) {
  const { showToast } = useToast()
  const [preview, setPreview] = useState<TimelinePreview | null>(null)
  const [requestId, setRequestId] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [recoveryError, setRecoveryError] = useState('')
  const userId = useAuthStore(state => state.user?.id ?? '')
  const recoveryKey = timelineRecoveryKey(userId, projectId), alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const restore = () => {
      try { const id = readTimelineRecovery(localStorage, recoveryKey); setRequestId(id ?? ''); setUncertain(Boolean(id)); setRecoveryError('') }
      catch (cause) { setRecoveryError((cause as Error).message) }
    }
    restore(); window.addEventListener('storage', restore)
    return () => { alive.current = false; window.removeEventListener('storage', restore) }
  }, [recoveryKey])
  const base = `/projects/${projectId}/fde-tasks`
  const refreshAfterSave = async () => {
    clearTimelineRecovery(localStorage, recoveryKey, requestId)
    if (!alive.current) return
    setUncertain(false); setPreview(null); setRequestId(''); showToast('流程行动已对账；请核对待联动事项及领导时间。独立任务和受保护期限保持不变')
    await onChanged().catch(() => showToast('操作已保存，但页面刷新失败，请刷新核对。', 'error'))
  }
  const open = async () => {
    setBusy(true)
    try { const next = await apiGet<TimelinePreview>(`${base}/timeline-preview`); if (alive.current) { setPreview(next); setRequestId(crypto.randomUUID()) } }
    catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }
  const submit = async () => {
    if (!preview) return
    setBusy(true)
    let saved = false
    try {
      saveTimelineRecovery(localStorage, recoveryKey, requestId)
      saved = true
      const receipt = agentReceiptSchema.parse(await apiPost(`${base}/sync-timeline`, { clientRequestId: requestId, fingerprint: preview.fingerprint }))
      if (receipt.kind !== 'timeline') throw new Error('回执类型不匹配，请核对原请求')
      await refreshAfterSave()
    }
    catch (cause) { if (alive.current) { if (saved) setUncertain(true); else setRecoveryError((cause as Error).message); showToast(`${(cause as Error).message}${saved ? '；请核对原请求结果后再重新预览。' : '；未发送请求。'}`, 'error') } }
    finally { if (alive.current) setBusy(false) }
  }
  const resolve = async () => {
    setBusy(true)
    try {
      const result = agentResolutionSchema.parse(await apiPost(`/projects/${projectId}/project-agent/resolve-command`, { clientRequestId: requestId }))
      if (result.state === 'committed') {
        if (result.receipt.kind !== 'timeline') throw new Error('回执类型不匹配，请保留现场核对')
        await refreshAfterSave()
      } else { clearTimelineRecovery(localStorage, recoveryKey, requestId); if (alive.current) { setUncertain(false); setPreview(null); setRequestId(''); showToast('原请求未提交且已封闭，可重新预览差异') } }
    } catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }
  return <>
    <Button variant="secondary" disabled={busy || uncertain || Boolean(recoveryError)} onClick={() => { void open() }}>同步流程行动</Button>
    {recoveryError && <p role="alert" className="mt-2 text-sm text-red-600">{recoveryError}</p>}
    {uncertain && !preview && <div role="status" className="mt-2 text-sm">有一笔流程行动同步需要核对。<Button variant="secondary" loading={busy} onClick={() => { void resolve() }}>核对原请求结果</Button></div>}
    <Modal open={Boolean(preview)} title="从时间线更新流程行动" onClose={() => { if (!busy && !uncertain) setPreview(null) }} footer={uncertain ? <Button loading={busy} onClick={() => { void resolve() }}>核对原请求结果</Button> : <><Button variant="secondary" disabled={busy} onClick={() => setPreview(null)}>取消</Button><Button loading={busy} disabled={!preview?.canSync || Boolean(preview?.issues.length) || Boolean(recoveryError)} onClick={() => { void submit() }}>确认同步</Button></>}>
      {preview && <div className="space-y-3">
        <p className="text-sm">{preview.stage} · 节点日期 {preview.date}</p>
        {uncertain && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm">提交结果待核对。请勿新建另一次操作；先核对原请求。</p>}
        {preview.issues.map(issue => <p key={issue} className="text-sm text-red-600">{issue}</p>)}
        {!preview.changes.length && <p className="text-sm text-slate-500">当前节点无独立流程行动。</p>}
        {preview.changes.map(item => <section key={`${item.stage}:${item.key}`} className="rounded-lg border border-slate-200 p-3 text-sm">
          <p className="font-medium">{labels[item.action]} · {item.title}</p><p className="mt-1 text-xs text-slate-500">{item.ownerName} · {item.action === 'keep' ? `有效期限 ${item.previousDate ?? item.dueDate} ${item.previousTime ?? item.dueTime ?? ''}（不修改）` : `${item.previousDate ? `${item.previousDate} ${item.previousTime ?? ''} → ` : ''}${item.dueDate} ${item.dueTime ?? ''}`}</p><p className="mt-1 text-xs">{item.reason}</p>
        </section>)}
      </div>}
    </Modal>
  </>
}
