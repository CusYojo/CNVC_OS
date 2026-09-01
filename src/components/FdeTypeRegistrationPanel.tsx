import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { typeRegistrationCommand } from '../../server/src/contracts/fdeTypeRegistrationContract'
import { api, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { forgetRegistrationPending, readRegistrationPending, registrationMarker, rememberRegistrationPending, typeRegistrationPendingKey, validateRegistrationReceipt, validateRegistrationRecovery, type TypeRegistrationPending } from '../lib/fdeTypeRegistrationRecovery'
import { beginRegistrationRecheck, editRegistrationDraft, emptyRegistrationDraft, initialRegistrationDraft, invalidateRegistrationDraft, readRegistrationRecheck, settleRegistrationRecheck, type RegistrationDraft, type RegistrationDraftState } from '../lib/fdeTypeRegistrationDraft'
import { Button, Card, Modal } from './ui'

export function FdeTypeRegistrationPanel({ compact = false }: { compact?: boolean }) {
  const uid = useAuthStore(s => s.user?.id ?? ''), previousUid = useRef(uid), [changedAccount, setChangedAccount] = useState(false)
  useEffect(() => { if (previousUid.current !== uid) { previousUid.current = uid; setChangedAccount(true) } }, [uid])
  return <>{changedAccount && <p role="status" className="mb-2 text-sm text-amber-700">登录账号已变化，原账号未提交的登记草稿已清理；请重新核对当前账号。</p>}<AccountRegistration key={uid} uid={uid} compact={compact} /></>
}
function AccountRegistration({ uid, compact }: { uid: string; compact: boolean }) {
  const [view, setView] = useState(() => initialRegistrationDraft(uid)), viewRef = useRef(view)
  const [pending, setPending] = useState<TypeRegistrationPending | null>(null), [ready, setReady] = useState(false), [busy, setBusy] = useState(false)
  const [commandError, setError] = useState(''), [storageError, setStorageError] = useState(''), [result, setResult] = useState<string | null>(null)
  const alive = useRef(true), writing = useRef(false), recheckQueued = useRef(false), key = typeRegistrationPendingKey(uid)
  const current = () => alive.current && (useAuthStore.getState().user?.id ?? '') === uid
  const { options, draft: { open, selected, name, targetDate, cycleDays, reason, ack } } = view
  const policy = options?.policies.find(p => p.policyId === selected), error = view.error || commandError
  const blocked = busy || !ready || view.phase !== 'ready' || Boolean(pending || storageError)
  const applyView = (next: RegistrationDraftState) => { viewRef.current = next; setView(next) }
  const editDraft = (patch: Partial<RegistrationDraft>) => { if (current() && !writing.current) applyView(editRegistrationDraft(viewRef.current, patch)) }
  const loadPending = () => { try { setPending(readRegistrationPending(localStorage, key)); setReady(true); setStorageError('') } catch { setStorageError('登记恢复标识不可读，已阻止新写入；请保留现场。'); setReady(false) } }
  async function recheck() {
    if (!current()) return
    loadPending()
    const next = beginRegistrationRecheck(viewRef.current)
    applyView(next) // Synchronous ref guard closes the focus-to-render submission gap.
    if (writing.current) { recheckQueued.current = true; return }
    setError('')
    try {
      const result = await readRegistrationRecheck(uid, path => api(path, { method: 'GET', cache: 'no-store' }))
      if (current()) { const settled = settleRegistrationRecheck(viewRef.current, next.generation, result); applyView(settled); if (settled.error) setResult(null) }
    } catch (e) {
      if (current()) { const settled = settleRegistrationRecheck(viewRef.current, next.generation, { error: (e as Error).message }); applyView(settled); if (settled.error) setResult(null) }
    }
  }
  useEffect(() => {
    alive.current = true; void recheck()
    const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) loadPending() }
    const focus = () => { void recheck() }
    window.addEventListener('storage', storage); window.addEventListener('focus', focus)
    return () => { alive.current = false; viewRef.current = invalidateRegistrationDraft(viewRef.current); window.removeEventListener('storage', storage); window.removeEventListener('focus', focus) }
  }, [])
  function finish(marker: TypeRegistrationPending, projectId: string | null) {
    if (!current()) return
    forgetRegistrationPending(localStorage, key, marker); setPending(null); setResult(projectId)
    applyView({ ...viewRef.current, draft: emptyRegistrationDraft() }); void recheck()
  }
  function finishWrite() {
    writing.current = false
    if (current()) { setBusy(false); if (recheckQueued.current) { recheckQueued.current = false; void recheck() } }
  }
  async function submit() {
    const snapshot = viewRef.current, draft = snapshot.draft, selectedPolicy = snapshot.options?.policies.find(p => p.policyId === draft.selected)
    if (!current() || blocked || snapshot.phase !== 'ready' || writing.current || !selectedPolicy || !draft.ack) return
    let command
    try { command = typeRegistrationCommand.parse({ commandId: crypto.randomUUID(), policyId: selectedPolicy.policyId, versionId: selectedPolicy.versionId, expectedPolicyVersion: selectedPolicy.policyVersion, expectedSha256: selectedPolicy.sha256, name: draft.name, targetDate: draft.targetDate, cycleDays: draft.cycleDays, reason: draft.reason }) }
    catch { setError('请完整填写项目名称、模板允许周期、目标日期和至少五字的登记理由。'); return }
    const marker = registrationMarker(command)
    try { rememberRegistrationPending(localStorage, key, marker); setPending(marker) } catch (e) { setStorageError((e as Error).message); return }
    writing.current = true; setBusy(true); setError(''); setResult(null)
    try { const receipt = validateRegistrationReceipt(await apiPost('/fde-type-registration/commands', command), marker); finish(marker, receipt.projectId) }
    catch (e) { if (current()) setError(`${(e as Error).message}；请核对原请求，不要重复登记。`) }
    finally { finishWrite() }
  }
  async function recover() {
    if (!current() || !pending || writing.current || viewRef.current.phase !== 'ready') return
    const marker = pending; writing.current = true; setBusy(true)
    try { const response = validateRegistrationRecovery(await apiPost('/fde-type-registration/commands/recover', { commandId: marker.commandId }), marker); finish(marker, response.receipt?.projectId ?? null); if (current()) setError(response.state === 'not_committed' ? '原登记未提交，旧请求已封闭；请重新选择当前模板。' : '') }
    catch (e) { if (current()) setError((e as Error).message) }
    finally { finishWrite() }
  }
  return <Card className={compact ? 'fde-registration-entry space-y-3' : 'mb-4 space-y-3 p-4'}>
    <div className="flex flex-wrap items-center justify-between gap-3">{!compact && <h2 className="text-sm font-semibold">非投资项目受控登记</h2>}<Button variant="secondary" disabled={blocked || !options?.policies.length} onClick={() => { editDraft({ open: true }); setResult(null) }}>登记非投资项目</Button></div>
    {view.phase === 'checking' && <p role="status" className="text-xs text-slate-500">正在重新核对当前账号、登记权限与精确模板版本，表单暂时锁定；核对一致后恢复未提交草稿…</p>}
    {view.phase === 'ready' && options && !options.policies.length && <p className="text-xs text-slate-500">暂无对当前账号开放的已批准登记模板；需先明确规则并完成独立审核、发布及启用。</p>}
    {(error || storageError) && <p role="alert" className="text-sm text-red-700">{storageError || error}</p>}
    {view.phase === 'blocked' && <Button variant="secondary" disabled={busy} onClick={() => void recheck()}>重新核对登记权限与规则</Button>}
    {pending && <div className="flex flex-wrap gap-3 text-sm"><span>有一笔登记尚待核对，新登记已暂停。</span><Button disabled={busy || view.phase !== 'ready'} onClick={() => void recover()}>核对原登记结果</Button></div>}
    {result && view.phase === 'ready' && <p role="status" className="text-sm text-emerald-700">已找回登记结果。<Link className="underline" to={`/projects/${result}?tab=workflow`}>进入项目，配置职责并编制计划</Link></p>}
    <Modal open={open && view.phase === 'ready'} onClose={() => { if (!busy) editDraft({ open: false }) }} title="登记非投资项目" footer={<><Button variant="secondary" disabled={busy} onClick={() => editDraft({ open: false })}>取消</Button><Button disabled={blocked || !policy || !ack} onClick={() => void submit()}>确认登记</Button></>}>
      <div className="space-y-4">{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <label className="block text-sm">已批准模板<select className="input mt-1 w-full" disabled={blocked} value={selected} onChange={e => editDraft({ selected: e.target.value, cycleDays: 0, ack: false })}><option value="">请选择已批准模板</option>{options?.policies.map(p => <option key={p.policyId} value={p.policyId}>{p.name}</option>)}</select></label>
        {policy && <p className="text-xs leading-6 text-slate-600">登记人担任项目负责人；进入{policy.configuration.registration?.classification === 'key' ? '重点' : '普通'}项目。停用后继续绑定版本。规则依据：{policy.configuration.registration?.ruleReference}</p>}
        <label className="block text-sm">项目名称<input className="input mt-1 w-full" disabled={blocked} value={name} onChange={e => editDraft({ name: e.target.value, ack: false })} maxLength={128} /></label>
        <label className="block text-sm">计划周期<select className="input mt-1 w-full" disabled={blocked} value={cycleDays} onChange={e => editDraft({ cycleDays: Number(e.target.value), ack: false })}><option value={0}>请选择周期</option>{policy?.configuration.cycleDays.map(d => <option key={d} value={d}>{d} 天</option>)}</select></label>
        <label className="block text-sm">目标日期<input type="date" className="input mt-1 w-full" disabled={blocked} value={targetDate} onChange={e => editDraft({ targetDate: e.target.value, ack: false })} /></label>
        <label className="block text-sm">登记理由<textarea className="input mt-1 min-h-20 w-full" disabled={blocked} value={reason} onChange={e => editDraft({ reason: e.target.value, ack: false })} /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={ack} disabled={blocked} onChange={e => editDraft({ ack: e.target.checked })} />确认上述精确版本及登记规则。登记后仍须配置真实职责、提交计划并独立审批，不直接生成执行任务。</label>
      </div>
    </Modal>
  </Card>
}
