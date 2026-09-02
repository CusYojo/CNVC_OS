import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { responsibilityEvents, responsibilityPolicyCommand, responsibilityPolicySchema, type ResponsibilityPolicy, type ResponsibilityPolicyCommand } from '../../server/src/contracts/fdeResponsibilityPolicyContract'
import { responsibilityPolicyCurrentView, responsibilityPolicyFormMatches, responsibilityPolicyListView, responsibilityPolicyVersionView, type ResponsibilityPolicyCurrentView, type ResponsibilityPolicyListView, type ResponsibilityPolicyVersionView } from '../../server/src/contracts/fdeResponsibilityPolicyViewContract'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { forgetResponsibilityPolicyPending, policyPendingForCommand, readResponsibilityPolicyPending, rememberResponsibilityPolicyPending, responsibilityPolicyRecoveryKey, responsibilityPolicyResolvedResult, responsibilityPolicyWriteReceipt, type ResponsibilityPolicyPending } from '../lib/fdeResponsibilityPolicyRecovery'
import { Badge, Button, Card, Modal } from './ui'
import './fde-workspace.css'

const root = '/responsibility-policies'
const actionNames = { create: '新建草稿', save: '保存草稿', approve: '独立批准', publish: '发布版本', toggle: '启停规则' }
const statusNames = { draft: '草稿', approved: '已独立批准', published: '已发布' }
const when = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
const pageNumber = (value: string | null) => value && /^[1-9]\d{0,4}$/.test(value) ? Number(value) : 1
const empty = (): ResponsibilityPolicy => ({
  rules: responsibilityEvents.map(event => ({ code: event.code, mode: event.mode, enabled: false, points: null })),
  timezone: 'Asia/Shanghai', calendar: { workingWeekdays: [], holidays: [], extraWorkingDates: [] }, earlyWorkingDays: null, graceMinutes: null,
  appealLimit: 1, appealAggregation: 'exclude_pending', allowAdjustment: false, allowExemption: false,
  completionAggregation: 'one_per_task', feedbackAggregation: 'one_per_actor_task_business_day', missingReviewer: 'retain_pending_assignment', history: 'append_only_no_automatic_rescore',
})
const message = (error: unknown) => error && typeof error === 'object' && 'issues' in error ? (error.issues as Array<{ message: string }>).map(issue => issue.message).join('；') : (error as Error).message
type Editor = { kind: 'new' | 'version' | 'toggle'; version: ResponsibilityPolicyVersionView | null; headVersion: number; enabled?: boolean }

export function FdeResponsibilityPolicyPanel() {
  const uid = useAuthStore(state => state.user?.id ?? '')
  return <PolicyAccountPanel key={uid} uid={uid} />
}

function PolicyAccountPanel({ uid }: { uid: string }) {
  const [params, setParams] = useSearchParams(), page = pageNumber(params.get('rulePage')), eventPage = pageNumber(params.get('ruleHistoryPage'))
  const [data, setData] = useState<ResponsibilityPolicyListView | null>(null), [refresh, setRefresh] = useState(0), [error, setError] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null), [configuration, setConfiguration] = useState<ResponsibilityPolicy>(empty)
  const [holidays, setHolidays] = useState(''), [extraDays, setExtraDays] = useState(''), [aggregation, setAggregation] = useState('')
  const [reason, setReason] = useState(''), [acknowledged, setAcknowledged] = useState(false), [formError, setFormError] = useState('')
  const [pending, setPending] = useState<ResponsibilityPolicyPending | null>(null), [storageError, setStorageError] = useState(''), [ready, setReady] = useState(false), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const mounted = useRef(true), writing = useRef(false), sequence = useRef(0), dialog = useRef<HTMLDivElement | null>(null)
  const key = responsibilityPolicyRecoveryKey(uid), current = () => mounted.current && useAuthStore.getState().user?.id === uid
  const blocked = busy || !ready || Boolean(pending) || Boolean(storageError)
  const dates = (value: string) => value.split(/[\s,，;；]+/).filter(Boolean)
  const formConfiguration = { ...configuration, appealAggregation: aggregation, calendar: { ...configuration.calendar, holidays: dates(holidays), extraWorkingDates: dates(extraDays) } }
  const unsaved = editor?.kind === 'version' && !responsibilityPolicyFormMatches(formConfiguration, editor.version?.configuration)
  const readRecovery = () => {
    try { setPending(readResponsibilityPolicyPending(sessionStorage, key)); setReady(true); setStorageError('') }
    catch { setReady(false); setStorageError('无法读取规则恢复标识，已阻止新写入。请恢复浏览器存储后重新核对，不要直接删除未知请求。') }
  }
  const reload = () => { if (!writing.current) { readRecovery(); setRefresh(value => value + 1) } }
  useEffect(() => {
    mounted.current = true; readRecovery(); window.addEventListener('focus', reload)
    return () => { mounted.current = false; ++sequence.current; window.removeEventListener('focus', reload) }
  }, [])
  useEffect(() => {
    const request = ++sequence.current; setData(null); setError(''); setEditor(null)
    void apiGet<unknown>(`${root}?${new URLSearchParams({ page: String(page), eventPage: String(eventPage) })}`).then(value => {
      const result = responsibilityPolicyListView.parse(value)
      if (current() && request === sequence.current) setData(result)
    }).catch(cause => { if (current() && request === sequence.current) setError(message(cause)) })
    return () => { ++sequence.current }
  }, [page, eventPage, refresh])
  useEffect(() => {
    if (!editor) return
    const previous = document.activeElement as HTMLElement | null; dialog.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [Boolean(editor)])
  const changePage = (name: string, value: number) => { if (writing.current) return; const next = new URLSearchParams(params); next.set(name, String(value)); setParams(next) }
  const prepare = (next: Editor, config: ResponsibilityPolicy) => {
    setConfiguration(structuredClone(config)); setHolidays(config.calendar.holidays.join('\n')); setExtraDays(config.calendar.extraWorkingDates.join('\n'))
    setAggregation(next.kind === 'new' && !next.version ? '' : config.appealAggregation); setReason(''); setAcknowledged(false); setFormError(''); setEditor(next)
  }
  const openVersion = async (id: string, clone = false) => {
    if (writing.current || !data) return
    const request = ++sequence.current; setBusy(true); setFormError('')
    try {
      const version = responsibilityPolicyVersionView.parse(await apiGet<unknown>(`${root}/versions/${id}`))
      if (current() && request === sequence.current) prepare({ kind: clone ? 'new' : 'version', version, headVersion: data.policy?.version ?? 0 }, version.configuration)
    } catch (cause) { if (current() && request === sequence.current) setError(message(cause)) }
    finally { if (current()) setBusy(false) }
  }
  const finish = (marker: ResponsibilityPolicyPending, result: string) => {
    if (!current()) return
    try { forgetResponsibilityPolicyPending(sessionStorage, key, marker) }
    catch { setStorageError('结果已核对，但标识未能清理。请重新读取并核对，不能直接重发。'); return }
    setPending(null); setEditor(null); setNotice(result); setRefresh(value => value + 1)
  }
  const recover = async () => {
    if (writing.current || !pending || !current()) return
    writing.current = true; setBusy(true)
    try {
      const marker = readResponsibilityPolicyPending(sessionStorage, key)
      if (!marker) throw new Error('恢复标识已变化，请重新读取')
      const result = responsibilityPolicyResolvedResult(await apiPost<unknown>(`${root}/commands/recover`, { commandId: marker.commandId }), marker)
      finish(marker, result.state === 'committed' ? `原${actionNames[marker.action]}已提交，规则头版本 v${result.receipt.policyVersion}；未重复执行。当前内容仍按现有权限读取。` : '原请求确认未提交，迟到命令已封闭。请重新读取最新规则、核对后再确认。')
    } catch (cause) { if (current()) setNotice(`结果仍待核对：${message(cause)}`) }
    finally { if (current()) { writing.current = false; setBusy(false) } }
  }
  const submit = async (action: ResponsibilityPolicyCommand['action']) => {
    if (blocked || writing.current || !editor || !data || !current()) return
    let input: ResponsibilityPolicyCommand, marker: ResponsibilityPolicyPending
    try {
      if (!acknowledged) throw new Error('请先核对规则内容和影响范围')
      if ((action === 'approve' || action === 'publish') && unsaved) throw new Error('存在未保存修改，不能批准或发布与页面内容不一致的原版本；请先保存，再交独立业务人员批准')
      const common = { commandId: crypto.randomUUID(), reason }
      const config = () => responsibilityPolicySchema.parse(formConfiguration)
      input = responsibilityPolicyCommand.parse(action === 'create' ? { ...common, action, expectedPolicyVersion: editor.headVersion, configuration: config() }
        : action === 'toggle' ? { ...common, action, expectedPolicyVersion: editor.headVersion, enabled: editor.enabled }
          : { ...common, action, versionId: editor.version?.id, expectedDraftVersion: editor.version?.version, ...(action === 'save' ? { configuration: config() } : action === 'publish' ? { expectedPolicyVersion: editor.headVersion } : {}) })
      marker = policyPendingForCommand(input); rememberResponsibilityPolicyPending(sessionStorage, key, marker)
    } catch (cause) { setFormError(message(cause)); return }
    writing.current = true; setBusy(true); setPending(marker); setNotice(''); setFormError('')
    try {
      const receipt = responsibilityPolicyWriteReceipt(await apiPost<unknown>(`${root}/commands`, input), marker)
      finish(marker, `${actionNames[action]}已提交，规则头版本 v${receipt.policyVersion}。发布不等于启用，历史记录不会自动重算。`)
    } catch (cause) { if (current()) setNotice(`提交结果待确认：${message(cause)}。请核对原命令，不能直接另换编号重试。`) }
    finally { if (current()) { writing.current = false; setBusy(false) } }
  }
  const close = () => { if (!writing.current) { ++sequence.current; setEditor(null) } }
  const editable = editor?.kind === 'new' || editor?.kind === 'version' && editor.version?.capabilities.save
  const confirmationReady = !blocked && acknowledged && reason.trim().length >= 5 && reason.trim().length <= 1000
  const recovery = <>{storageError && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm">{storageError}<Button variant="secondary" disabled={busy} onClick={readRecovery}>重新读取规则恢复标识</Button></div>}{notice && <p role="status" className="rounded-lg bg-slate-50 p-3 text-sm">{notice}</p>}{pending && <Card className="p-4"><p className="mb-3 text-sm">有一笔{actionNames[pending.action]}结果待核对。原编号跨重载保留，核对前禁止新写入。</p><Button disabled={busy || Boolean(storageError)} onClick={() => void recover()}>核对上一笔责任规则操作</Button></Card>}</>
  return <div className="fde-workspace space-y-4">
    <Card className="fde-panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">责任规则配置与独立批准</h2><Button variant="secondary" disabled={busy} onClick={reload}>刷新规则与权限</Button></div></Card>
    {!editor && recovery}
    {error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm">{error}</p>}
    {!data && !error && <p role="status">正在核对责任规则访问权限…</p>}
    {data && <>
      <Card className="fde-panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">当前发布规则 <Badge tone={data.policy?.enabled ? 'green' : 'slate'}>{data.activeVersion ? data.policy?.enabled ? '已启用' : '已发布 · 停用' : '未配置发布版本'}</Badge></h3><p className="mt-2 text-sm text-slate-500">{data.activeVersion ? `V${data.activeVersion.revision} · 发布于 ${when(data.activeVersion.publishedAt)} · 规则头 v${data.policy!.version}` : '没有当前发布版本；不会产生责任计分。'} 历史记录继续绑定原版本。</p></div><div className="flex flex-wrap gap-2">{data.activeVersion && <Button variant="secondary" disabled={busy} onClick={() => void openVersion(data.activeVersion!.id)}>查看当前发布版本</Button>}{data.capabilities.manage && <><Button disabled={blocked} onClick={() => prepare({ kind: 'new', version: null, headVersion: data.policy?.version ?? 0 }, empty())}>新建责任规则草稿</Button><Button variant="secondary" disabled={blocked || !data.activeVersion} onClick={() => prepare({ kind: 'toggle', version: data.activeVersion, headVersion: data.policy!.version, enabled: !data.policy!.enabled }, data.activeVersion!.configuration)}>{data.policy?.enabled ? '停用责任规则' : '启用已发布责任规则'}</Button></>}</div></div></Card>
      <Card className="fde-panel p-5"><h3 className="font-semibold">规则版本</h3><p className="my-2 text-xs text-slate-500">配置权限与业务批准权限分开；已批准或发布的版本不可编辑。需要调整时另建草稿。</p><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr>{['版本 / 状态', '编制 / 修订', '批准 / 发布', '依据', '操作'].map(title => <th className="border-b p-3" key={title}>{title}</th>)}</tr></thead><tbody>{data.versions.map(version => <tr className="border-b" key={version.id}><td className="p-3">V{version.revision} · {statusNames[version.status]}<small className="block text-slate-500">修订 v{version.version}{version.id === data.policy?.activeVersionId ? ' · 当前发布' : ''}</small></td><td className="p-3">{version.createdByName}<small className="block text-slate-500">最近：{version.lastEditedByName}</small></td><td className="p-3">{version.approvedByName ?? '未批准'}<small className="block text-slate-500">发布：{version.publishedByName ?? '未发布'}</small></td><td className="max-w-56 break-words p-3">{version.reason}</td><td className="p-3"><div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={() => void openVersion(version.id)}>{version.capabilities.save ? '编辑草稿' : version.capabilities.approve ? '查看并批准' : version.capabilities.publish ? '查看并发布' : '查看版本'}</Button>{data.capabilities.manage && <Button variant="secondary" disabled={blocked} onClick={() => void openVersion(version.id, true)}>基于此版新建</Button>}</div></td></tr>)}</tbody></table></div>{!data.versions.length && <p className="py-5 text-sm text-slate-500">当前页暂无规则版本。</p>}<div className="mt-4 flex items-center gap-3"><Button variant="secondary" disabled={busy || page <= 1} onClick={() => changePage('rulePage', page - 1)}>较新版本</Button><span className="text-xs">第 {page} 页</span><Button variant="secondary" disabled={busy || !data.hasMore} onClick={() => changePage('rulePage', page + 1)}>更早版本</Button></div></Card>
      <Card className="fde-panel p-5"><h3 className="font-semibold">规则操作历史</h3><ol className="mt-3 space-y-3">{data.events.map(event => <li className="rounded-lg border p-3 text-sm" key={event.id}><strong>{actionNames[event.action]} · {event.actorName}</strong><p className="my-1 text-xs text-slate-500">{when(event.createdAt)}</p><p className="whitespace-pre-wrap break-words">{event.reason}</p></li>)}</ol>{!data.events.length && <p className="py-4 text-sm text-slate-500">当前页暂无操作历史。</p>}<div className="mt-4 flex items-center gap-3"><Button variant="secondary" disabled={busy || eventPage <= 1} onClick={() => changePage('ruleHistoryPage', eventPage - 1)}>较新操作</Button><span className="text-xs">第 {eventPage} 页</span><Button variant="secondary" disabled={busy || !data.eventsHaveMore} onClick={() => changePage('ruleHistoryPage', eventPage + 1)}>更早操作</Button></div></Card>
    </>}
    <div ref={dialog} tabIndex={-1} role={editor ? 'dialog' : undefined} aria-modal={editor ? true : undefined} aria-label="责任规则版本与操作" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key !== 'Tab' || !dialog.current) return
      const elements = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')].filter(element => element.getClientRects().length > 0)
      const first = elements[0], last = elements.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus() }
    }}><Modal open={Boolean(editor)} title={editor?.kind === 'toggle' ? editor.enabled ? '确认启用责任规则' : '确认停用责任规则' : editor?.kind === 'new' ? '新建责任规则草稿' : `责任规则 V${editor?.version?.revision} · ${editor?.version ? statusNames[editor.version.status] : ''}`} width="max-w-5xl" onClose={close} footer={<><Button variant="secondary" disabled={busy} onClick={close}>关闭规则详情</Button>{editor?.kind === 'new' && <Button disabled={!confirmationReady} onClick={() => void submit('create')}>校验并创建草稿</Button>}{editor?.kind === 'toggle' && <Button disabled={!confirmationReady} onClick={() => void submit('toggle')}>{editor.enabled ? '确认启用' : '确认停用'}</Button>}{editor?.kind === 'version' && <>{editor.version?.capabilities.save && <Button disabled={!confirmationReady} onClick={() => void submit('save')}>校验并保存草稿</Button>}{editor.version?.capabilities.approve && <Button disabled={!confirmationReady || unsaved} onClick={() => void submit('approve')}>独立批准此版本</Button>}{editor.version?.capabilities.publish && <Button disabled={!confirmationReady || unsaved} onClick={() => void submit('publish')}>发布此版本并保持停用</Button>}</>}</>}>
      <div className="space-y-4">{recovery}{formError && <p role="alert" className="text-sm text-red-700">{formError}</p>}
        {unsaved && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm">存在未保存修改，批准/发布已禁用。请先保存，再交未参与编制的业务人员批准。</p>}
        {editor?.version && <details className="rounded-lg bg-slate-50 p-3 text-xs leading-6"><summary className="cursor-pointer font-medium">版本与审批记录</summary><div className="mt-2"><p>编制：{editor.version.createdByName} · 最近修订：{editor.version.lastEditedByName}</p><p>批准：{editor.version.approvedByName ?? '未批准'} · {when(editor.version.approvedAt)}</p><p>发布：{editor.version.publishedByName ?? '未发布'} · {when(editor.version.publishedAt)}</p><p>变更依据：{editor.version.reason}</p></div></details>}
        <fieldset disabled={!editable || blocked} className="space-y-4">
          <p className="text-sm text-slate-500">初始事件全部停用、分值留空；请逐项配置。人工类必须经责任确认，不能改为自动定责。</p>
          <div className="overflow-x-auto"><table className="w-full min-w-[510px] text-left text-sm"><thead><tr>{['责任事件', '处理方式', '事件启用', '分值（未配置留空）'].map(title => <th className="border-b p-2" key={title}>{title}</th>)}</tr></thead><tbody>{responsibilityEvents.map(event => { const rule = configuration.rules.find(rule => rule.code === event.code)!; const update = (patch: Partial<typeof rule>) => setConfiguration(value => ({ ...value, rules: value.rules.map(item => item.code === event.code ? { ...item, ...patch } : item) })); return <tr key={event.code}><td className="p-2">{event.label}</td><td className="p-2 text-slate-500">{event.mode === 'manual' ? '人工确认' : '正式事实自动记录'}</td><td className="p-2"><input type="checkbox" aria-label={`${event.label}事件启用`} checked={rule.enabled} onChange={e => update({ enabled: e.target.checked })} /></td><td className="p-2"><input type="number" className="input w-28" aria-label={`${event.label}分值`} min={event.positive ? 1 : -100} max={event.positive ? 100 : -1} step="1" value={rule.points ?? ''} onChange={e => update({ points: e.target.value === '' ? null : Number(e.target.value) })} /></td></tr> })}</tbody></table></div>
          <section><h3 className="text-sm font-medium">工作日历 · Asia/Shanghai</h3><div className="mt-3 flex flex-wrap gap-4">{['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, day) => <label className="text-sm" key={day}><input type="checkbox" checked={configuration.calendar.workingWeekdays.includes(day)} onChange={e => setConfiguration(value => ({ ...value, calendar: { ...value.calendar, workingWeekdays: e.target.checked ? [...value.calendar.workingWeekdays, day].sort() : value.calendar.workingWeekdays.filter(item => item !== day) } }))} /> {label}</label>)}</div></section>
          <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">额外休息日期（YYYY-MM-DD，每行一个）<textarea className="input mt-2 min-h-20 w-full" value={holidays} onChange={e => setHolidays(e.target.value)} /></label><label className="text-sm">调休补班日期（YYYY-MM-DD，每行一个）<textarea className="input mt-2 min-h-20 w-full" value={extraDays} onChange={e => setExtraDays(e.target.value)} /></label>{(['earlyWorkingDays', 'graceMinutes'] as const).map(field => <label className="text-sm" key={field}>{field === 'earlyWorkingDays' ? '提前完成门槛（工作日）' : '逾期宽限（分钟）'}<input type="number" className="input mt-2 w-full" step="1" min={field === 'earlyWorkingDays' ? 1 : 0} max={field === 'earlyWorkingDays' ? 30 : 43200} value={configuration[field] ?? ''} onChange={e => setConfiguration({ ...configuration, [field]: e.target.value === '' ? null : Number(e.target.value) })} /></label>)}</div>
          <label className="block text-sm">申诉期间的汇总口径<select className="input mt-2 w-full" value={aggregation} onChange={e => setAggregation(e.target.value)}><option value="">请选择已确认口径</option><option value="exclude_pending">申诉中暂不计入</option><option value="retain_pending">申诉中保留原有效值</option></select></label>
          <div className="flex flex-wrap gap-5 text-sm"><label><input type="checkbox" checked={configuration.allowAdjustment} onChange={e => setConfiguration({ ...configuration, allowAdjustment: e.target.checked })} /> 允许复核调整分值</label><label><input type="checkbox" checked={configuration.allowExemption} onChange={e => setConfiguration({ ...configuration, allowExemption: e.target.checked })} /> 允许复核豁免</label></div>
        </fieldset>
        {(editable || editor?.kind === 'toggle' || editor?.version?.capabilities.approve || editor?.version?.capabilities.publish) && <><label className="block text-sm">本次操作依据与原因（5—1000 字）<textarea aria-label="责任规则操作依据" className="input mt-2 min-h-24 w-full" minLength={5} maxLength={1000} value={reason} disabled={blocked} onChange={e => setReason(e.target.value)} /></label><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={blocked} onChange={e => setAcknowledged(e.target.checked)} /><span>已核对本次规则、当前版本和影响范围；正式业务政策需有明确批准，不能把测试演练当作正式启用。</span></label></>}
      </div>
    </Modal></div>
  </div>
}

export function FdeResponsibilityCurrentPolicy({ refresh, compact = false }: { refresh: number; compact?: boolean }) {
  const uid = useAuthStore(state => state.user?.id ?? '')
  const [state, setState] = useState<{ uid: string; value: ResponsibilityPolicyCurrentView | null; error: string }>({ uid, value: null, error: '' })
  useEffect(() => {
    let active = true; setState({ uid, value: null, error: '' })
    void apiGet<unknown>(`${root}/current`).then(value => { const parsed = responsibilityPolicyCurrentView.parse(value); if (active && useAuthStore.getState().user?.id === uid) setState({ uid, value: parsed, error: '' }) }).catch(cause => { if (active && useAuthStore.getState().user?.id === uid) setState({ uid, value: null, error: message(cause) }) })
    return () => { active = false }
  }, [uid, refresh])
  const data = state.uid === uid ? state.value : null
  if (compact) return <section className="fde-score-rule-list">
    {state.uid === uid && state.error ? <p role="alert">{state.error}</p> : !data ? <p role="status">正在核验当前规则…</p> : <>
      <p className="fde-score-policy-state">{data.activeVersion ? `V${data.activeVersion.revision} · ${data.policy?.enabled ? '已启用' : '已发布但停用'}` : '暂无已发布规则'}</p>
      {data.activeVersion?.configuration.rules.map(rule => <div key={rule.code}><span className={(rule.points ?? 0) < 0 ? 'negative' : 'positive'}>{rule.enabled ? `${rule.points! > 0 ? '+' : ''}${rule.points}` : '—'}</span><p><strong>{responsibilityEvents.find(event => event.code === rule.code)?.label} <span className="fde-score-rule-mode">{rule.mode === 'manual' ? '人工确认' : '自动'}</span></strong><small>{rule.enabled ? '按已发布版本与当前启用状态执行' : '事件停用'} · 旧记录保留绑定版本</small></p></div>)}
      <Link className="fde-score-rule-link" to="/responsibility/rules">查看与批准责任规则</Link>
    </>}
  </section>
  return <section className="mt-4 space-y-3 border-t pt-4 text-xs leading-6"><h4 className="font-semibold">当前发布与启用状态</h4>{state.uid === uid && state.error ? <p role="alert">{state.error}</p> : !data ? <p role="status">正在核验当前规则…</p> : <><p>{data.activeVersion ? `V${data.activeVersion.revision} · ${data.policy?.enabled ? '已启用' : '已发布但停用'}` : '暂无已发布规则'}</p>{data.activeVersion?.configuration.rules.map(rule => <p key={rule.code}>{responsibilityEvents.find(event => event.code === rule.code)?.label}：{rule.enabled ? `${rule.points! > 0 ? '+' : ''}${rule.points} · ${rule.mode === 'manual' ? '人工确认' : '自动记录'}` : '事件停用'}</p>)}<p>此处为当前配置；旧记录仍按详情中的绑定版本处理。</p><Link className="font-medium text-[#315f68] underline" to="/responsibility/rules">查看与批准责任规则</Link></>}</section>
}
