import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, Modal } from './ui'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { FdeResponsibilityCurrentPolicy } from './FdeResponsibilityPolicyPanel'
import { responsibilityCommand, responsibilityStatusLabels } from '../../server/src/contracts/fdeResponsibilityContract'
import { responsibilityEvents } from '../../server/src/contracts/fdeResponsibilityPolicyContract'
import { responsibilityOverview, responsibilityList, responsibilityDetail, responsibilityEvidenceChoices, responsibilityActionLabels as actionNames, responsibilityAssignmentLabels, type ResponsibilityOverview, type ResponsibilityList, type ResponsibilityDetail, type ResponsibilityEvidenceChoices } from '../../server/src/contracts/fdeResponsibilityViewContract'
import { responsibilityRecoveryKey, readResponsibilityPending, rememberResponsibilityPending, forgetResponsibilityPending, responsibilityCommandPath, responsibilityWriteReceipt, responsibilityResolvedResult, responsibilityResultUnknown, type ResponsibilityPending } from '../lib/fdeResponsibilityRecovery'
import './fde-workspace.css'

const eventName = (code: string) => responsibilityEvents.find(event => event.code === code)?.label ?? code
const when = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const points = (value: number) => value > 0 ? `+${value}` : String(value)
const safePage = (value: string | null) => value && /^[1-9]\d{0,4}$/.test(value) ? Number(value) : 1

export function FdeResponsibilityPanel({ management = false }: { management?: boolean }) {
  const uid = useAuthStore(state => state.user?.id ?? '')
  return <ResponsibilityAccountPanel key={`${uid}:${management}`} uid={uid} management={management} />
}

function ResponsibilityAccountPanel({ uid, management }: { uid: string; management: boolean }) {
  const [params, setParams] = useSearchParams()
  const view = management ? 'managed' : params.get('view') === 'assignment' ? 'assignment' : params.get('view') === 'review' ? 'review' : 'mine'
  const selected = params.get('record'), page = safePage(params.get('respPage')), historyPage = safePage(params.get('historyPage'))
  const status = params.get('respStatus') ?? '', event = params.get('respEvent') ?? ''
  const [overview, setOverview] = useState<ResponsibilityOverview | null>(null), [list, setList] = useState<ResponsibilityList | null>(null), [detail, setDetail] = useState<ResponsibilityDetail | null>(null)
  const [error, setError] = useState(''), [detailError, setDetailError] = useState(''), [refresh, setRefresh] = useState(0)
  const [action, setAction] = useState<ResponsibilityPending['action'] | null>(null), [reason, setReason] = useState(''), [decision, setDecision] = useState('revoke'), [adjusted, setAdjusted] = useState('0')
  const [choices, setChoices] = useState<ResponsibilityEvidenceChoices | null>(null), [choiceError, setChoiceError] = useState(''), [choicePage, setChoicePage] = useState(1), [keyword, setKeyword] = useState(''), [search, setSearch] = useState('')
  const [evidence, setEvidence] = useState<Array<{ fileId: string; version: number; fileName: string }>>([])
  const [pending, setPending] = useState<ResponsibilityPending | null>(null), [ready, setReady] = useState(false), [storageError, setStorageError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const mounted = useRef(true), submitting = useRef(false), key = responsibilityRecoveryKey(uid)
  const dialog = useRef<HTMLDivElement | null>(null)
  const current = () => mounted.current && useAuthStore.getState().user?.id === uid
  const blocked = busy || !ready || Boolean(pending) || Boolean(storageError)
  const changeParams = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(values)) value === null ? next.delete(key) : next.set(key, value)
    setParams(next)
  }
  const readRecovery = () => {
    try { setPending(readResponsibilityPending(sessionStorage, key)); setStorageError(''); setReady(true) }
    catch { setReady(false); setStorageError('无法读取恢复标识，已阻止新提交。请恢复浏览器存储后重新读取，不要直接删除未确认请求。') }
  }
  useEffect(() => {
    mounted.current = true; readRecovery()
    const focus = () => { if (!submitting.current) { readRecovery(); setRefresh(value => value + 1) } }
    window.addEventListener('focus', focus)
    return () => { mounted.current = false; window.removeEventListener('focus', focus) }
  }, [])
  useEffect(() => {
    if (!selected) return
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [selected])
  useEffect(() => {
    let active = true; setList(null); setOverview(null); setError('')
    const query = new URLSearchParams({ view, page: String(page), pageSize: '20' })
    if (status) query.set('status', status)
    if (event) query.set('eventCode', event)
    void Promise.all([apiGet<unknown>('/responsibility/overview'), apiGet<unknown>(`/responsibility?${query}`)]).then(([a, b]) => {
      const capabilities = responsibilityOverview.parse(a), result = responsibilityList.parse(b)
      if (active && current()) { setOverview(capabilities); if ((!management || capabilities.management) && (view !== 'assignment' || capabilities.assignmentAccess)) setList(result); else setError('当前职责无权使用此入口，请从本人记录或复核待办进入。') }
    }).catch(cause => { if (active && current()) { setError((cause as Error).message); setDetail(null) } })
    return () => { active = false }
  }, [view, page, status, event, refresh])
  useEffect(() => {
    let active = true; setDetail(null); setDetailError(''); setAction(null); setReason(''); setEvidence([])
    if (selected) void apiGet<unknown>(`/responsibility/${encodeURIComponent(selected)}?page=${historyPage}`).then(value => {
      const parsed = responsibilityDetail.parse(value)
      if (active && current()) setDetail(parsed)
    }).catch(cause => { if (active && current()) setDetailError((cause as Error).message) })
    return () => { active = false }
  }, [selected, historyPage, refresh])
  useEffect(() => {
    let active = true; setChoices(null); setChoiceError('')
    if (action === 'appeal' && selected) void apiGet<unknown>(`/responsibility/${encodeURIComponent(selected)}/evidence-options?${new URLSearchParams({ keyword: search, page: String(choicePage) })}`).then(value => {
      const parsed = responsibilityEvidenceChoices.parse(value)
      if (active && current()) setChoices(parsed)
    }).catch(cause => { if (active && current()) setChoiceError((cause as Error).message) })
    return () => { active = false }
  }, [action, selected, choicePage, search])
  const finish = (marker: ResponsibilityPending, version?: number) => {
    if (!current()) return
    try { forgetResponsibilityPending(sessionStorage, key, marker) }
    catch { setStorageError('原结果已核对，但恢复标识未能清除。请重新读取并核对，不能直接另建请求。'); return }
    setPending(null); setAction(null); setReason(''); setEvidence([]); setRefresh(value => value + 1)
    setNotice(version ? marker.action === 'reroute' ? `处理人核对已保存，记录版本 v${version}。是否已分配请查看最新详情；此操作不代表责任确认或复核完成。` : `原操作已保存，记录版本 v${version}。详情仍按当前权限读取。` : '原请求确认未提交，已封闭迟到写入。请重新查看最新内容并确认后再操作。')
  }
  const resolve = async (marker: ResponsibilityPending) => {
    const result = responsibilityResolvedResult(await apiPost<unknown>(`${responsibilityCommandPath(marker)}/recover`, { commandId: marker.commandId }), marker)
    if (current()) finish(marker, result.state === 'committed' ? result.receipt.version : undefined)
  }
  const recover = async () => {
    if (!pending || submitting.current || !current()) return
    submitting.current = true; setBusy(true)
    try { await resolve(pending) }
    catch (cause) { if (current()) setNotice(`结果仍待确认：${(cause as Error).message}`) }
    finally { if (current()) { submitting.current = false; setBusy(false) } }
  }
  const submit = async () => {
    if (!detail || !action || blocked || submitting.current || !current()) return
    const marker = { projectId: detail.record.projectId, recordId: detail.record.id, commandId: crypto.randomUUID(), action }
    const parsed = responsibilityCommand.safeParse({ action, commandId: marker.commandId, recordId: marker.recordId, expectedVersion: detail.record.version, reason,
      ...(action === 'appeal' ? { evidence: evidence.map(({ fileId, version }) => ({ fileId, version })) } : {}),
      ...(action === 'confirm' ? { decision } : {}), ...(action === 'review' ? { decision, adjustedPoints: decision === 'adjust' ? Number(adjusted) : null } : {}) })
    if (!parsed.success) { setNotice(`尚未提交：${parsed.error.issues[0].message}`); return }
    try { rememberResponsibilityPending(sessionStorage, key, marker) }
    catch { setStorageError('无法安全保存恢复标识，尚未发送本次请求；请先重新读取并核对。'); return }
    submitting.current = true; setBusy(true); setPending(marker); setNotice('')
    try { const receipt = responsibilityWriteReceipt(await apiPost<unknown>(responsibilityCommandPath(marker), parsed.data), marker); if (current()) finish(marker, receipt.version) }
    catch (cause) {
      if (!current()) return
      setNotice(`提交结果待确认：${(cause as Error).message}`)
      if (!responsibilityResultUnknown(cause)) {
        try { await resolve(marker) }
        catch { if (current()) setNotice('请求被拒绝，但原结果尚未可靠核对。请保留标识并核对，不要重新提交。') }
      }
    } finally { if (current()) { submitting.current = false; setBusy(false) } }
  }
  const begin = (next: ResponsibilityPending['action']) => {
    setAction(next); setReason(next === 'read_notice' ? '本人明确标记此通知为已读' : ''); setDecision(next === 'confirm' ? 'confirm' : 'revoke'); setAdjusted('0'); setEvidence([]); setChoicePage(1); setSearch(''); setKeyword(''); setNotice('')
  }
  const recovery = <>{storageError && <div role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm">{storageError}<Button variant="secondary" disabled={busy} onClick={readRecovery}>重新读取恢复标识</Button></div>}{notice && <p role="status" className="mb-3 break-words rounded-lg bg-slate-50 p-3 text-sm">{notice}</p>}{pending && <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"><p>有一笔{actionNames[pending.action] ?? '通知已读'}操作结果待确认，不能重复提交。</p><p className="my-2 break-all text-xs">请求编号：{pending.commandId}</p><Button variant="secondary" disabled={busy} onClick={() => void recover()}>{busy ? '正在核对…' : '核对原操作结果'}</Button></div>}</>
  const record = detail?.record, allowedManagement = (!management || overview?.management === true) && (view !== 'assignment' || overview?.assignmentAccess === true)
  const close = () => { if (!busy) changeParams({ record: null, historyPage: null }) }
  return <div className="fde-workspace fde-responsibility-workspace space-y-4">
    {!selected && recovery}
    {!management && <div className="fde-workspace-tabs" role="tablist" aria-label="责任记录视图">{[['mine', '我的责任记录'], ['review', '待我确认与复核'], ...(overview?.assignmentAccess ? [['assignment', '待协调分配']] : [])].map(([key, label]) => <button key={key} role="tab" aria-selected={view === key} className={view === key ? 'active' : ''} disabled={busy} onClick={() => changeParams({ view: key, respPage: null, record: null, historyPage: null })}>{label}</button>)}</div>}
    {overview?.assignmentAccess && overview.assignment > 0 && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">当前有权范围内有 {overview.assignment} 条记录缺少有效独立处理人。{management ? <a className="ml-2 underline" href="/responsibility?view=assignment">进入待协调分配</a> : view !== 'assignment' && <button className="ml-2 underline" disabled={busy} onClick={() => changeParams({ view: 'assignment', respPage: null, record: null, historyPage: null, respStatus: null, respEvent: null })}>进入待协调分配</button>}</div>}
    <div className="fde-responsibility-layout">
      <Card className={management ? "fde-panel fde-score-ledger min-w-0" : "fde-panel min-w-0 p-5"}>
        <div className={management ? "fde-card-head" : "flex flex-wrap items-center justify-between gap-3"}><div><h2 className="font-semibold">{management ? '配合度责任流水' : view === 'assignment' ? '待协调分配' : view === 'review' ? '待我确认与复核' : '我的责任记录'}</h2><p className="mt-1 text-xs text-slate-500">{view === 'assignment' ? '仅显示当前有权协调的缺岗记录；重新分配不等于完成办理，也不授予证据权限。' : '按需查看、允许申诉、异人复核；不在日常工作台公开排名。'}</p></div>{management ? <Badge tone="green">规则可追溯</Badge> : <Button variant="secondary" disabled={busy} onClick={() => { readRecovery(); setRefresh(value => value + 1) }}>刷新权限与记录</Button>}</div>
        {management ? <details className="fde-knowledge-tools fde-score-filters"><summary>筛选与记录管理{status || event ? " · 已应用筛选" : ""}</summary><div className="fde-responsibility-filters my-4 flex flex-wrap gap-3"><select aria-label="责任状态筛选" className="input" value={status} disabled={busy} onChange={e => changeParams({ respStatus: e.target.value || null, respPage: null })}><option value="">全部状态</option>{Object.entries(responsibilityStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="责任事件筛选" className="input" value={event} disabled={busy} onChange={e => changeParams({ respEvent: e.target.value || null, respPage: null })}><option value="">全部事件</option>{responsibilityEvents.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select><Button variant="secondary" disabled={busy} onClick={() => { readRecovery(); setRefresh(value => value + 1) }}>刷新权限与记录</Button></div></details> : <div className="fde-responsibility-filters my-4 flex flex-wrap gap-3"><select aria-label="责任状态筛选" className="input" value={status} disabled={busy} onChange={e => changeParams({ respStatus: e.target.value || null, respPage: null })}><option value="">全部状态</option>{Object.entries(responsibilityStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="责任事件筛选" className="input" value={event} disabled={busy} onChange={e => changeParams({ respEvent: e.target.value || null, respPage: null })}><option value="">全部事件</option>{responsibilityEvents.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></div>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {!list && !error && <p role="status" className="text-sm text-slate-500">正在核验记录范围…</p>}
        {list && <><div className="overflow-x-auto"><table className="w-full min-w-[740px] text-left text-sm"><thead className="border-b text-xs text-slate-500"><tr>{['人员', '关联项目', '事项', '规则', '分值', '状态', '时间'].map(label => <th className="p-2" key={label}>{label}</th>)}</tr></thead><tbody>{list.list.map(item => <tr className="border-b border-slate-100" key={item.id}><td className="p-2 font-medium">{item.subjectName}</td><td className="max-w-40 break-words p-2">{item.projectName}</td><td className="max-w-48 break-words p-2"><button className="text-[#315f68] underline" onClick={() => changeParams({ record: item.id, historyPage: null })}>{item.taskTitle}</button></td><td className="p-2">{eventName(item.eventCode)}</td><td className="p-2"><strong className={item.countedPoints < 0 ? 'text-red-600' : 'text-emerald-700'}>{points(item.countedPoints)}</strong><small className="block text-slate-500">原值 {points(item.originalPoints)}</small></td><td className="p-2"><Badge tone={item.status === 'appealing' || item.status === 'pending_confirmation' ? 'amber' : 'slate'}>{responsibilityStatusLabels[item.status]}</Badge>{['unassigned', 'invalid'].includes(item.assignmentState) && <small className="block text-amber-700">{responsibilityAssignmentLabels[item.assignmentState]}</small>}</td><td className="p-2 text-xs text-slate-500">{when(item.occurredAt)}</td></tr>)}</tbody></table></div>{!list.list.length && <p className="py-8 text-center text-sm text-slate-500">当前权限和筛选范围内暂无记录。</p>}<div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500"><span>共 {list.total} 条 · 第 {list.page} 页</span><div className="flex gap-2"><Button variant="secondary" disabled={busy || page <= 1} onClick={() => changeParams({ respPage: String(page - 1) })}>上一页</Button><Button variant="secondary" disabled={busy || page * list.pageSize >= list.total} onClick={() => changeParams({ respPage: String(page + 1) })}>下一页</Button></div></div></>}
      </Card>
      <Card className={management ? "fde-panel fde-score-rules" : "fde-panel p-5"}><div className={management ? "fde-card-head" : undefined}><h3 className="font-semibold">责任记录规则</h3></div>{management && allowedManagement && <FdeResponsibilityCurrentPolicy refresh={refresh} compact />}{!management && <p className="mt-2 text-sm leading-6 text-slate-500">打开单条记录查看其绑定的已发布规则版本。当前页不假定任何正式计分已启用。</p>}<ul className="mt-4 list-inside list-disc space-y-3 text-xs leading-6 text-slate-600"><li>已批准延期须纠正失去依据的原期限记录。</li><li>上游依赖或领导日程导致延期须核对责任。</li><li>申诉由非本人的授权负责人或领导复核。</li><li>责任记录不改变项目优先级，也不自动形成人事决定。</li><li>原件读取仍需当前项目和文件权限。</li></ul></Card>
    </div>
    <div ref={dialog} role={selected ? 'dialog' : undefined} aria-modal={selected ? true : undefined} aria-label="责任记录办理" tabIndex={-1} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
      if (e.key !== 'Tab' || !dialog.current) return
      const elements = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')].filter(element => element.getClientRects().length > 0)
      const first = elements[0], last = elements.at(-1)
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first?.focus() }
    }}>
    <Modal open={Boolean(selected)} title={action === 'appeal' ? '责任记录申诉' : action === 'review' ? '复核责任记录申诉' : action === 'confirm' ? '确认责任候选' : action === 'reroute' ? '重新核对处理人' : '责任记录详情'} onClose={close} width="max-w-5xl" footer={<Button variant="secondary" disabled={busy} onClick={close}>返回台账</Button>}>
      {recovery}
      {detailError && <p role="alert" className="text-sm text-red-600">{detailError}</p>}
      {!allowedManagement && <p role="alert">正在核验入口资格，或当前无权使用此入口。</p>}
      {!detail && !detailError && <p role="status">正在读取记录与当前权限…</p>}
      {detail && record && allowedManagement && <div className="space-y-5">
        <section className="rounded-lg border p-3 text-xs leading-6 text-slate-500"><h3 className="font-medium text-slate-700">原触发来源</h3><p>{eventName(record.eventCode)} · {when(record.occurredAt)}</p><p className="break-all">任务：{record.taskId}</p>{record.sourceFeedbackId && <p className="break-all">反馈：{record.sourceFeedbackId}</p>}{record.sourceAcceptanceId && <p className="break-all">成果验收：{record.sourceAcceptanceId}</p>}{record.sourceRiskId && <p className="break-all">风险：{record.sourceRiskId}</p>}</section>
        <div className="rounded-lg bg-slate-50 p-4 text-sm leading-7"><h3 className="font-semibold">{detail.subjectName} · {detail.taskTitle}</h3><p>{detail.projectName} · {eventName(record.eventCode)} · {responsibilityStatusLabels[record.status]}</p><p>原始分值 {points(record.originalPoints)} / 当前有效值 {points(record.effectivePoints)} / 汇总计入 {points(detail.countedPoints)}</p><p>处理人：{detail.reviewerName ?? '未分配'} · 记录 v{record.version}</p><p className={['unassigned', 'invalid'].includes(detail.assignmentState) ? 'text-amber-800' : 'text-slate-500'}>{responsibilityAssignmentLabels[detail.assignmentState]}</p><p>有效期限快照：{record.deadlineKey ?? '该事件不按期限归责'}</p><p className="whitespace-pre-wrap break-words">最近处理理由：{record.reason}</p></div>
        <section><h3 className="font-semibold">冻结证据</h3><ul className="mt-2 space-y-2 text-sm">{detail.evidence.map(file => <li key={`${file.fileId}:${file.version}`} className="break-words rounded-lg border p-3">{file.fileName} · v{file.version}{file.canDownload ? <a className="ml-3 text-[#315f68] underline" href={`/api/projects/files/${file.fileId}/versions/${file.version}/download`} target="_blank" rel="noopener noreferrer">查看原件</a> : <span className="ml-3 text-xs text-slate-500">当前无原件下载权</span>}<small className="mt-1 block break-all text-slate-500">SHA-256 {file.sha256} · {file.byteSize} 字节</small></li>)}</ul></section>
        {detail.appeal && <section className="rounded-lg border border-amber-200 p-4 text-sm"><h3 className="font-semibold">本人申诉</h3><p className="mt-2 whitespace-pre-wrap break-words">{detail.appeal.reason}</p><p className="mt-2 text-xs text-slate-500">{when(detail.appeal.createdAt)} · 申诉版本 v{detail.appeal.version}</p><ul className="mt-2 list-inside list-disc">{detail.appeal.evidence.map(file => <li key={`${file.fileId}:${file.version}`}>{detail.evidence.find(item => item.fileId === file.fileId && item.version === file.version)?.fileName ?? file.fileId} · v{file.version}</li>)}</ul></section>}
        {!action && <div className="flex flex-wrap gap-2">{detail.capabilities.appeal && <Button disabled={blocked} onClick={() => begin('appeal')}>提交申诉</Button>}{detail.capabilities.confirm && <Button disabled={blocked} onClick={() => begin('confirm')}>确认责任候选</Button>}{detail.capabilities.review && <Button disabled={blocked} onClick={() => begin('review')}>复核申诉</Button>}{detail.capabilities.reroute && <Button variant="secondary" disabled={blocked} onClick={() => begin('reroute')}>重新核对处理人</Button>}{detail.capabilities.readNotice && <Button variant="secondary" disabled={blocked} onClick={() => begin('read_notice')}>标记通知已读</Button>}</div>}
        {action && <form className="space-y-4 rounded-xl border border-[#315f68] p-4" onSubmit={e => { e.preventDefault(); void submit() }}>
          <p className="text-sm text-slate-600">{action === 'reroute' ? '系统按当前职责和证据权限重新选择非本人处理人，不能手动指定或自动授予权限；仍无人可办时保留待分配，不改变责任结论。' : '原记录不删除；申诉每条限一次，处理人、时间、理由和证据完整留痕。'}</p>
          {action === 'confirm' && <label className="block text-sm">确认结论<select aria-label="确认结论" className="input mt-2 w-full" value={decision} disabled={blocked} onChange={e => setDecision(e.target.value)}><option value="confirm">确认生效</option><option value="revoke">撤销候选</option></select></label>}
          {action === 'review' && <label className="block text-sm">复核结论<select aria-label="复核结论" className="input mt-2 w-full" value={decision} disabled={blocked} onChange={e => setDecision(e.target.value)}><option value="revoke">撤销记录</option><option value="uphold">维持记录</option>{detail.policy.allowAdjustment && <option value="adjust">调整分值</option>}{detail.policy.allowExemption && <option value="exempt">豁免记录</option>}</select></label>}
          {action === 'review' && decision === 'adjust' && <label className="block text-sm">修订分值<input aria-label="修订分值" className="input mt-2 w-full" type="number" step="1" min={record.originalPoints} max="0" value={adjusted} disabled={blocked} onChange={e => setAdjusted(e.target.value)} required /></label>}
          <label className="block text-sm">{action === 'appeal' ? '申诉理由' : '处理意见'}<textarea aria-label={action === 'appeal' ? '申诉理由' : '处理意见'} className="input mt-2 min-h-24 w-full" value={reason} onChange={e => setReason(e.target.value)} disabled={blocked} minLength={5} maxLength={2000} required /></label>
          {action === 'appeal' && <section><h4 className="text-sm font-medium">申诉证据（1—20 项真实文件版本）</h4><div className="my-2 flex gap-2"><input aria-label="查找申诉证据" className="input min-w-0 flex-1" value={keyword} disabled={blocked} onChange={e => setKeyword(e.target.value)} /><Button type="button" variant="secondary" disabled={blocked} onClick={() => { setSearch(keyword); setChoicePage(1) }}>查找</Button></div>{choiceError && <p role="alert" className="text-sm text-red-600">{choiceError}</p>}{!choices && !choiceError && <p className="text-sm">正在核验可选证据…</p>}{choices?.list.map(file => <label className="my-2 flex items-center gap-2 text-sm" key={`${file.fileId}:${file.version}`}><input type="checkbox" checked={evidence.some(item => item.fileId === file.fileId && item.version === file.version)} disabled={blocked} onChange={e => setEvidence(items => e.target.checked ? [...items, file] : items.filter(item => item.fileId !== file.fileId || item.version !== file.version))} />{file.fileName} · v{file.version}</label>)}{choices && !choices.list.length && <p className="text-sm text-slate-500">未找到当前有权的文件。请先在项目中上传证据或核对授权。</p>}<div className="my-3 flex gap-2"><Button type="button" variant="secondary" disabled={blocked || choicePage <= 1} onClick={() => setChoicePage(value => value - 1)}>上一组证据</Button><Button type="button" variant="secondary" disabled={blocked || !choices?.hasMore} onClick={() => setChoicePage(value => value + 1)}>下一组证据</Button></div><p className="text-xs text-slate-500">已选 {evidence.length} 项：{evidence.map(file => `${file.fileName} v${file.version}`).join('；') || '尚未选择'}</p></section>}
          <div className="flex gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={() => { setAction(null); setReason(''); setEvidence([]) }}>取消办理</Button><Button type="submit" disabled={blocked || reason.trim().length < 5 || action === 'appeal' && (evidence.length < 1 || evidence.length > 20)}>{busy ? '正在提交…' : action === 'appeal' ? '确认提交申诉' : '确认处理'}</Button></div>
        </form>}
        <details className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">记录绑定规则与版本</summary><p className="my-3 break-all text-xs">版本 ID：{record.policyVersionId}（历史绑定，不代表当前启用）</p><div className="grid gap-2 sm:grid-cols-2">{detail.policy.rules.map(rule => <div key={rule.code} className="rounded-lg bg-slate-50 p-2">{eventName(rule.code)} · {rule.mode === 'automatic' ? '自动' : '人工确认'} · {rule.enabled ? points(rule.points ?? 0) : '未启用'}</div>)}</div><p className="mt-3">申诉中汇总：{detail.policy.appealAggregation === 'exclude_pending' ? '暂不计入' : '保留原有效值'}；历史修订保留，不自动重算。</p></details>
        <section><h3 className="font-semibold">处理历史</h3><ol className="mt-3 space-y-3">{detail.events.map(item => <li key={item.id} className="rounded-lg border p-3 text-sm"><strong>{actionNames[item.action] ?? item.action} · v{item.version}</strong><p className="my-1 text-xs text-slate-500">{item.actorName} · {when(item.createdAt)}</p><p className="whitespace-pre-wrap break-words">{item.reason}</p></li>)}</ol><div className="mt-3 flex gap-2"><Button variant="secondary" disabled={busy || historyPage <= 1} onClick={() => changeParams({ historyPage: String(historyPage - 1) })}>较新历史</Button><Button variant="secondary" disabled={busy || !detail.hasMoreEvents} onClick={() => changeParams({ historyPage: String(historyPage + 1) })}>更早历史</Button></div></section>
      </div>}
    </Modal>
    </div>
  </div>
}
