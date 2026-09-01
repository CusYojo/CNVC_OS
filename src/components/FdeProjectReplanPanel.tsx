import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { Button, Card, Modal } from './ui'
import { approvalCenterReturnPath } from '../../server/src/contracts/fdeApprovalCenterContract'
import { projectReplanAction, projectReplanSubmit, type ReplanDashboard, type ReplanImpact, type ReplanPreview } from '../../server/src/contracts/fdeProjectReplanContract'
import { clearReplanPending, readReplanPending, replanRecoveryKey, saveReplanPending, validateReplanReceipt, validateReplanResolution, type ReplanPending } from '../lib/fdeProjectReplanRecovery'

function Impact({ value }: { value: ReplanImpact }) {
  return <div className="mt-3 space-y-3 text-sm"><p>整体目标日：{value.previousTargetDate ?? '未确定'} → {value.targetDate}</p>
    {value.blockers.length > 0 && <ul role="alert" className="list-disc space-y-1 rounded bg-amber-50 p-4 pl-8 text-amber-900">{value.blockers.map((b, i) => <li key={`${b.code}:${i}`}>{b.message}</li>)}</ul>}
    {(['stages', 'tasks', 'leaders'] as const).map(kind => <details key={kind} open={kind === 'stages'}><summary className="cursor-pointer font-medium">{{ stages: '节点影响', tasks: '任务影响', leaders: '领导需求影响' }[kind]}（{value[kind].length}）</summary><div className="mt-2 max-h-64 space-y-2 overflow-auto">{value[kind].map(change => <div key={change.id} className="rounded border border-slate-200 p-2"><p>{change.label} · {change.before ?? '-'} → {change.after ?? '-'} · {change.action === 'move' ? '随批准生效' : '保留'}</p><p className="mt-1 text-xs text-slate-500">{change.reason}</p></div>)}</div></details>)}
  </div>
}
export function FdeProjectReplanPanel({ projectId, onChanged }: { projectId: string; onChanged?: () => Promise<void> }) {
  const userId = useAuthStore(s => s.user?.id ?? '')
  return userId ? <ReplanWorkspace key={`${userId}:${projectId}`} projectId={projectId} userId={userId} onChanged={onChanged} /> : null
}
function ReplanWorkspace({ projectId, userId, onChanged }: { projectId: string; userId: string; onChanged?: () => Promise<void> }) {
  const endpoint = `/projects/${projectId}/project-replans`, key = replanRecoveryKey(userId, projectId)
  const [params] = useSearchParams(), selected = params.get('replan')
  const [data, setData] = useState<ReplanDashboard | null>(null), [preview, setPreview] = useState<ReplanPreview | null>(null)
  const [targetDate, setTargetDate] = useState(''), [reason, setReason] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [pending, setPending] = useState<ReplanPending | null>(null), [storageError, setStorageError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0)
  const [action, setAction] = useState<{ id: string; version: number; action: 'approve' | 'reject' | 'withdraw' } | null>(null)
  const alive = useRef(true), working = useRef(false), generation = useRef(0)
  const current = useCallback(() => alive.current && useAuthStore.getState().user?.id === userId, [userId])
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generation.current } }, [])
  const readPending = useCallback(() => {
    try { setPending(readReplanPending(localStorage, key)); setStorageError('') }
    catch { setStorageError('本地恢复标识损坏或不可读，已停止新操作。请保留现场，不要盲目重发。') }
  }, [key])
  useEffect(() => { readPending(); const storage = (e: StorageEvent) => { if (!e.key || e.key === key) readPending() }; window.addEventListener('storage', storage); return () => window.removeEventListener('storage', storage) }, [key, readPending])
  useEffect(() => {
    const token = ++generation.current; setData(null); setPreview(null); setAction(null)
    apiGet<ReplanDashboard>(endpoint).then(value => { if (current() && token === generation.current) { setData(value); setError('') } }).catch(e => { if (current() && token === generation.current) setError((e as Error).message) })
    return () => { ++generation.current }
  }, [endpoint, refresh, current])
  useEffect(() => {
    const focus = () => { setData(null); setPreview(null); setAction(null); setRefresh(v => v + 1); readPending() }
    const updated = (e: Event) => { if ((e as CustomEvent).detail === projectId) focus() }
    window.addEventListener('focus', focus); window.addEventListener('fde-timeline-updated', updated)
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('fde-timeline-updated', updated) }
  }, [projectId, readPending])
  useEffect(() => { if (selected && data?.requests.some(r => r.id === selected)) document.getElementById(`project-replan-${selected}`)?.scrollIntoView({ block: 'center' }) }, [selected, data])
  const blocked = busy || Boolean(pending || storageError)
  async function run(operation: () => Promise<void>) {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setNotice('')
    try { await operation() }
    catch (e) { if (current()) { setError((e as Error).message); setData(null); setPreview(null); setAction(null) } }
    finally { working.current = false; if (current()) { setBusy(false); readPending() } }
  }
  async function refreshed(message: string) {
    if (!current()) return
    setNotice(message); setPreview(null); setAction(null); setReason(''); setRefresh(v => v + 1)
    window.dispatchEvent(new CustomEvent('fde-timeline-updated', { detail: projectId }))
    try { await onChanged?.() } catch { if (current()) setError('操作已保存，但项目摘要刷新失败，请刷新核对') }
  }
  async function submit() {
    if (blocked || !preview?.canSubmit || preview.targetDate !== targetDate) return
    await run(async () => {
      const marker: ReplanPending = { kind: 'submit', commandId: crypto.randomUUID() }
      const body = projectReplanSubmit.parse({ clientRequestId: marker.commandId, targetDate, reason, fingerprint: preview!.fingerprint })
      saveReplanPending(localStorage, key, marker); setPending(marker)
      validateReplanReceipt(await apiPost(endpoint, body), marker)
      clearReplanPending(localStorage, key, marker); await refreshed('整体重排已提交独立审批，日期尚未生效。')
    })
  }
  async function act() {
    if (blocked || !action) return
    await run(async () => {
      const marker: ReplanPending = { kind: 'action', commandId: crypto.randomUUID(), requestId: action!.id, expectedVersion: action!.version }
      const body = projectReplanAction.parse({ clientRequestId: marker.commandId, expectedVersion: marker.expectedVersion, action: action!.action, reason })
      saveReplanPending(localStorage, key, marker); setPending(marker)
      validateReplanReceipt(await apiPost(`${endpoint}/${marker.requestId}/action`, body), marker)
      clearReplanPending(localStorage, key, marker); await refreshed('处理结果已保存，请核对当前审批和有效日期。')
    })
  }
  return <Card className="min-w-0 border-[#dfe6e4] p-5" aria-label="项目整体重排">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">项目整体重排</h2><Button variant="secondary" disabled={busy} onClick={() => setRefresh(v => v + 1)}>刷新整体计划</Button></div>
    {params.has('center') && <Link className="mt-2 block text-sm text-[#315f68]" to={approvalCenterReturnPath(params.get('center'))}>返回审批列表</Link>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}{notice && <p role="status" className="mt-3 text-sm text-[#315f68]">{notice}</p>}
    {storageError && <p role="alert" className="mt-3 text-sm text-red-700">{storageError}</p>}
    {pending && <div role="status" className="mt-3 rounded bg-amber-50 p-3 text-sm">有一笔操作结果待核对。<Button variant="secondary" disabled={busy || Boolean(storageError)} onClick={() => void run(async () => { const result = validateReplanResolution(await apiPost(`/projects/${projectId}/project-agent/resolve-command`, { clientRequestId: pending.commandId }), pending); clearReplanPending(localStorage, key, pending); await refreshed(result.state === 'committed' ? '已找到原操作，请查看审批记录。' : '原请求未提交且已封闭，可重新确认后提交。') })}>核对上次操作</Button></div>}
    {!data && !error && <p className="mt-3 text-sm text-slate-500">正在读取当前权限和整体计划…</p>}
    {data && <><p className="mt-3 text-sm">当前目标日：{data.targetDate ?? '未配置'}</p>{data.policyIssue && <p className="mt-2 text-sm text-amber-800">{data.policyIssue}</p>}
      <form className="mt-3 space-y-3" onSubmit={e => { e.preventDefault(); void run(async () => { const token = generation.current; const value = await apiPost<ReplanPreview>(`${endpoint}/preview`, { targetDate }); if (current() && token === generation.current) setPreview(value) }) }}>
        <label className="block text-sm">拟调整的项目目标日<input type="date" className="input mt-1 block" required value={targetDate} disabled={busy} onChange={e => { setTargetDate(e.target.value); setPreview(null) }} /></label><Button type="submit" variant="secondary" disabled={blocked || !targetDate}>预览影响与阻塞</Button>
      </form>
      {preview && <><Impact value={preview} /><label className="mt-3 block text-sm">整体调整原因<textarea className="input mt-1 w-full" minLength={6} maxLength={1000} value={reason} disabled={blocked} onChange={e => setReason(e.target.value)} /></label><Button disabled={blocked || !preview.canSubmit || reason.trim().length < 6} onClick={() => void submit()}>提交整体重排审批</Button></>}
      <div className="mt-5 space-y-3">{data.requests.map(row => <article key={row.id} id={`project-replan-${row.id}`} tabIndex={-1} className={`rounded-lg border p-3 ${selected === row.id ? 'border-[#315f68] ring-2 ring-[#a8c5c3]' : 'border-slate-200'}`}>
        <h3 className="text-sm font-medium">整体方案 V{row.revision} · {row.status} · {row.currentNodeName}</h3><p className="mt-2 break-words text-sm">申请原因：{row.reason}</p><Impact value={row.impact} />
        <div className="mt-3 flex flex-wrap gap-2">{(['approve', 'reject', 'withdraw'] as const).filter(a => a === 'withdraw' ? row.canWithdraw : row.canAct).map(a => <Button key={a} variant="secondary" disabled={blocked} onClick={() => { setReason(''); setAction({ id: row.id, version: row.version, action: a }) }}>{a === 'approve' ? '同意整体方案' : a === 'reject' ? '拒绝整体方案' : '撤回申请'}</Button>)}</div>
        <details className="mt-3 text-xs"><summary>审批记录</summary>{row.history.map((h, i) => <p key={i} className="mt-2 break-words">{h.actor} · {h.action} · {new Date(h.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}：{h.reason}</p>)}</details>
      </article>)}</div></>}
    <Modal open={Boolean(action)} title="办理整体重排" onClose={() => { if (!busy) setAction(null) }}><p className="mb-3 text-sm">批准前重新核验当前权限、计划版本和时间冲突。只有最后一个独立审批节点通过才生效。</p><label className="block text-sm">办理意见<textarea className="input mt-1 w-full" minLength={6} maxLength={1000} value={reason} disabled={blocked} onChange={e => setReason(e.target.value)} /></label><Button disabled={blocked || reason.trim().length < 6} onClick={() => void act()}>确认办理</Button></Modal>
  </Card>
}
