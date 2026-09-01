import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowRight, FilePlus2, GitBranch, History, LayoutDashboard, RefreshCw, UploadCloud } from 'lucide-react'
import { officeDefinition, officeKinds, type OfficeDefinition } from '../../server/src/contracts/fdeOfficeContract'
import { approvalCenterViews, approvalCenterViewLabels, approvalCenterDetailPath, type ApprovalCenterResult, type ApprovalCenterRow } from '../../server/src/contracts/fdeApprovalCenterContract'
import { apiGet, apiPost } from '../lib/api'
import { forgetOfficePending, officeRecoveryKey, officeResolvedResult, officeWriteReceipt, officeWriteResultUnknown, readOfficePending, rememberOfficePending, type OfficePending } from '../lib/fdeOfficeRecovery'
import { useAuthStore } from '../store/useAuthStore'
import { Badge, Button, Card, Modal } from './ui'
import { formatShanghaiDateTime } from '../lib/dateTime'
import './fde-workspace.css'
import { FdeOfficeExecutionPanel } from './FdeOfficeExecutionPanel'
import { FdeOfficeSmartFields, type LeaveBalance } from './FdeOfficeSmartFields'

type Person = { id: string; name: string; role: string }
type Row = ApprovalCenterRow
type Detail = Row & { definition: OfficeDefinition; currentNodeId: string | null; nodes: { id: string; name: string; mode: string; approverNames: string[]; approvedByNames: string[]; status: string }[]; attachments: { id: string; name: string; byteSize: number; sha256: string; version: number; purpose: string; canDownload: boolean; canManageGrants: boolean; grants?: { userId: string; canDownload: boolean }[] }[]; history: { id: string; version: number; action: string; reason: string; createdAt: string }[]; revisions: { id: string; revision: number }[]; capabilities: { author: boolean; review: boolean; withdraw: boolean; transfer: boolean; edit: boolean; delete: boolean } }
type Preview = { requestVersion: number; policyVersionId: string; policyRevision: number; routeHash: string; nodes: { rule: { name: string; mode: string }; names: string[] }[]; issues: string[]; sharingRequired: boolean }
type Reusable = { id: string; requestNo: string; title: string; status: string; updatedAt: string; definition: OfficeDefinition }
const views = approvalCenterViews.map(key => [key, approvalCenterViewLabels[key]] as const)
const base = '/oa/office/requests'
const newDefinition = (kind: typeof officeKinds[number]) => officeDefinition.parse({ title: '', reason: '', projectId: null, priority: '普通', details: { kind }, attachmentIds: [] })
const preparedDefinition = (value: OfficeDefinition) => officeDefinition.parse(value.details.kind === '用印' ? { ...value, title: `${value.details.sealType || '用印'}申请`, reason: value.details.purpose } : value)
const fieldLabels: Record<string, string> = { destination: '目的地', budget: '预算', currency: '币种', startDate: '开始日期', endDate: '结束日期', entity: '申请主体', sealType: '印章类型', purpose: '用途', copies: '份数', amount: '金额', leaveType: '假别', startAt: '开始时刻（上海）', endAt: '结束时刻（上海）', hours: '请假小时数', counterparty: '合同相对方', documentVersion: '合同版本' }
const readFile = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('本地文件读取失败')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file) })

export function FdeOfficePanel() {
  const currentAccount = useAuthStore(s => s.user), userId = currentAccount?.id ?? ''
  const [params, setParams] = useSearchParams(), view = views.some(v => v[0] === params.get('view')) ? params.get('view')! : 'pending'
  const kind = params.get('kind') ?? '', query = params.get('q') ?? ''
  const requestedPage = Number(params.get('page') ?? 1), page = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 1_000_000) : 1
  const filter = (patch: Record<string, string>, resetPage = true) => setParams(previous => {
    const next = new URLSearchParams(previous)
    if (resetPage) next.delete('page')
    for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key)
    return next
  }, { replace: true })
  const [rows, setRows] = useState<Row[]>([]), [total, setTotal] = useState(0), [counts, setCounts] = useState<Record<string, number>>({})
  const [kinds, setKinds] = useState<string[]>([]), [canCreateOffice, setCanCreateOffice] = useState(false), [resolvedPage, setResolvedPage] = useState(1)
  const [options, setOptions] = useState<{ people: Person[]; projects: { id: string; name: string }[]; enabledKinds: string[]; leaveBalances: LeaveBalance[] }>({ people: [], projects: [], enabledKinds: [], leaveBalances: [] })
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [id, setId] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null), [form, setForm] = useState<OfficeDefinition>(newDefinition('出差'))
  const [preview, setPreview] = useState<Preview | null>(null), [reason, setReason] = useState(''), [share, setShare] = useState(false), [candidates, setCandidates] = useState<Person[] | null>(null), [target, setTarget] = useState('')
  const [historyPage, setHistoryPage] = useState(1), [revision, setRevision] = useState<{ revision: number; snapshot: { definition: OfficeDefinition } } | null>(null)
  const [grantFile, setGrantFile] = useState<string | null>(null), [grantRows, setGrantRows] = useState<{ userId: string; canDownload: boolean }[]>([])
  const [pending, setPending] = useState<OfficePending | null>(null), [storageError, setStorageError] = useState(false)
  const [recoveryNotice, setRecoveryNotice] = useState<{ message: string; id?: string } | null>(null)
  const [reusable, setReusable] = useState<Reusable[] | null>(null), [autoSavedAt, setAutoSavedAt] = useState('')
  const pendingBody = useRef<unknown>(null), loadSequence = useRef(0), busyRef = useRef(false), currentUser = useRef(userId); currentUser.current = userId
  const storageKey = officeRecoveryKey(userId)
  useEffect(() => {
    setId(null); setDetail(null); setRows([]); setCounts({}); setKinds([]); setCanCreateOffice(false); setRecoveryNotice(null); setGrantFile(null); setPending(null); setBusy(false); busyRef.current = false; pendingBody.current = null
    try { setPending(readOfficePending(sessionStorage, storageKey)); setStorageError(false) }
    catch { setStorageError(true); setError('无法读取安全恢复标识，办公写入已暂停。请保留当前页面并联系管理员核对。') }
  }, [storageKey])
  const refresh = useCallback(async () => {
    if (userId !== currentUser.current) return
    const seq = ++loadSequence.current, actor = userId
    setLoading(true)
    try {
      const filters = new URLSearchParams({ view, page: String(page), kind, q: query })
      const result = await apiGet<ApprovalCenterResult>(`/oa/center?${filters}`)
      if (seq !== loadSequence.current || actor !== currentUser.current) return
      setRows(result.list); setTotal(result.total); setCounts(result.counts); setKinds(result.kinds); setResolvedPage(result.page); setCanCreateOffice(result.canCreateOffice); setError('')
      if (!result.canCreateOffice) setOptions({ people: [], projects: [], enabledKinds: [], leaveBalances: [] })
      else {
        try { const opts = await apiGet<typeof options>('/oa/office/options'); if (seq === loadSequence.current && actor === currentUser.current) setOptions(opts) }
        catch (e) { if (seq === loadSequence.current && actor === currentUser.current) { setCanCreateOffice(false); setError(`申请配置读取失败：${(e as Error).message}`) } }
      }
    } catch (e) { if (seq === loadSequence.current) { setRows([]); setTotal(0); setCounts({}); setKinds([]); setCanCreateOffice(false); setError((e as Error).message) } }
    finally { if (seq === loadSequence.current) setLoading(false) }
  }, [view, page, kind, query, userId])
  useEffect(() => { void refresh(); return () => { loadSequence.current++ } }, [refresh])
  const open = async (requestId: string, requestedPage = 1) => {
    const actor = userId
    if (actor !== currentUser.current) return
    try { const row = await apiGet<Detail>(`${base}/${requestId}?page=${requestedPage}`); if (actor !== currentUser.current) return; setId(requestId); setDetail(row); setForm(row.definition); setPreview(null); setRevision(null); setHistoryPage(requestedPage); setCandidates(null); setError('') }
    catch (e) { if (actor === currentUser.current) { setId(null); setDetail(null); setError((e as Error).message) } }
  }
  useEffect(() => { const requestId = params.get('office'); if (requestId) void open(requestId) }, [params.get('office'), userId])
  const clearPending = (marker: OfficePending) => {
    try {
      if (!forgetOfficePending(sessionStorage, storageKey, marker)) throw new Error('恢复标识已变化，请核对当前待处理操作')
    } catch (e) { if (userId === currentUser.current) setStorageError(true); throw e }
    if (userId === currentUser.current) { setPending(null); pendingBody.current = null; setStorageError(false) }
  }
  const resolve = async (marker: OfficePending) => {
    if (userId !== currentUser.current) throw new Error('当前账号已变化，请在原账号下核对')
    return officeResolvedResult(await apiPost(`${base}/${marker.id}/commands/resolve`, { clientRequestId: marker.commandId }), marker.id)
  }
  const sendPending = async (marker: OfficePending, payload: unknown) => {
    if (userId !== currentUser.current) throw new Error('当前账号已变化，原操作保留在原账号下核对')
    let receipt
    try { receipt = officeWriteReceipt(await apiPost(marker.path, payload), marker.id) }
    catch (e) {
      if (officeWriteResultUnknown(e) || userId !== currentUser.current) throw e
      // Even an explicit business rejection is fenced before allowing a new
      // command: an older timed-out invocation may still be arriving.
      const resolution = await resolve(marker)
      if (resolution.state === 'not_applied') { clearPending(marker); throw e }
      receipt = resolution.receipt
    }
    clearPending(marker)
    if (userId !== currentUser.current) throw new Error('原操作已核对，当前账号已变化')
    return receipt
  }
  const perform = async (path: string, body: Record<string, unknown>) => {
    if (!id || pending || storageError || userId !== currentUser.current) throw new Error('请先核对未完成请求，不能创建新的操作')
    if (!path.endsWith('/save') && detail && JSON.stringify(form) !== JSON.stringify(detail.definition)) throw new Error('表单有未保存修改，请先保存草稿，再上传、授权或提交')
    const commandId = crypto.randomUUID(), payload = { ...body, clientRequestId: commandId }, marker = { id, commandId, path }
    setRecoveryNotice(null)
    try { rememberOfficePending(sessionStorage, storageKey, marker) } catch { setStorageError(true); throw new Error('无法保存最小恢复标识，未发送业务请求；请核对已有记录或联系管理员') }
    setPending(marker); pendingBody.current = payload
    return sendPending(marker, payload)
  }
  const work = async (fn: () => Promise<void>) => {
    if (busyRef.current) return
    const actor = userId
    busyRef.current = true; setBusy(true); setError('')
    try { await fn() } catch (e) { if (actor === currentUser.current) setError((e as Error).message) }
    finally { if (actor === currentUser.current) { busyRef.current = false; setBusy(false) } }
  }
  const save = () => work(async () => { const parsed = preparedDefinition(form); await perform(`${base}/${id}/save`, { expectedVersion: detail?.version ?? 0, definition: parsed }); await open(id!); await refresh() })
  const act = (action: string, extra = {}) => work(async () => {
    if (reason.trim().length < 5) throw new Error('请填写至少五字的操作说明')
    await perform(`${base}/${id}/actions`, { expectedVersion: detail!.version, action, reason, ...extra })
    if (action === 'delete' || action === 'transfer') { setId(null); setDetail(null) } else await open(id!)
    setReason(''); await refresh()
  })
  const recover = (retry = false) => work(async () => {
    if (!pending) return
    const marker = pending
    const retrying = retry && pendingBody.current != null
    const result = retrying
      ? { state: 'committed' as const, receipt: await sendPending(marker, pendingBody.current) }
      : await resolve(marker)
    if (!retrying) clearPending(marker)
    if (userId !== currentUser.current) return
    setId(null); setDetail(null); setGrantFile(null); setPreview(null); setCandidates(null); setReason('')
    setRecoveryNotice(result.state === 'committed'
      ? { message: `已确认原操作提交成功，回执版本 V${result.receipt.version}。不会重复执行；查看详情仍需当前权限。`, id: marker.id }
      : { message: '原操作未提交且已封闭，延迟到达的旧请求不会生效。请重新打开申请核对最新版本后再操作；未保存的新草稿需重新填写。' })
    await refresh()
  })
  const start = (value: typeof officeKinds[number]) => { setId(crypto.randomUUID()); setDetail(null); setForm(newDefinition(value)); setPreview(null); setRevision(null); setReason(''); setCandidates(null); setReusable(null); setAutoSavedAt(''); setRecoveryNotice(null); setError('') }
  const canWrite = !busy && !pending && !storageError, editable = !detail || detail.capabilities.edit
  const canManageGrantFile = Boolean(detail?.attachments.some(file => file.id === grantFile && file.canManageGrants))
  useEffect(() => { if (grantFile && !canManageGrantFile) { setGrantFile(null); setGrantRows([]) } }, [grantFile, canManageGrantFile])
  const changeDetail = (field: string, value: unknown) => { setForm(f => ({ ...f, details: { ...f.details, [field]: value } as OfficeDefinition['details'] })); setPreview(null) }
  const uploadFiles = (files: File[]) => work(async () => {
    if (!id) throw new Error('申请编号不存在，请重新打开申请')
    if (form.details.kind === '报销') {
      const unsupported = files.find(file => !/\.(pdf|jpe?g|png)$/i.test(file.name))
      if (unsupported) throw new Error(`报销证明材料仅支持 PDF、JPG/JPEG 和 PNG：${unsupported.name}`)
    }
    let version = detail?.version ?? 0
    if (!detail) {
      const receipt = await perform(`${base}/${id}/save`, { expectedVersion: 0, definition: preparedDefinition(form) })
      version = receipt.version
    }
    for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      const dataBase64 = await readFile(file)
      const receipt = await perform(`${base}/${id}/attachments/${crypto.randomUUID()}`, { expectedVersion: version, reason: '用户明确上传申请原始附件', name: file.name, declaredType: file.type || undefined, dataBase64, purpose: editable ? 'application' : 'signed' })
      version = receipt.version
    }
    await open(id); await refresh()
  })
  useEffect(() => {
    if (!id || !editable || pending || storageError || (detail && JSON.stringify(form) === JSON.stringify(detail.definition))) return
    const timer = window.setTimeout(() => {
      void work(async () => {
        const parsed = preparedDefinition(form)
        await perform(`${base}/${id}/save`, { expectedVersion: detail?.version ?? 0, definition: parsed })
        setAutoSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
        await open(id); await refresh()
      })
    }, 30_000)
    return () => window.clearTimeout(timer)
  }, [id, form, detail, editable, pending, storageError])
  return <div className="fde-workspace fde-office-page space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">审批与办公</h1><p className="mt-2 text-sm text-slate-500">出差、用印、报销、请假、合同与投资审批共用一个流程中心。</p></div><Button disabled={!canWrite || !canCreateOffice || loading} onClick={() => start('合同')}><FilePlus2 className="h-4 w-4" />发起办公申请</Button></header>
    <section className="fde-office-project-entry" aria-label="项目审批快捷入口"><div className="fde-office-project-entry-copy"><span><GitBranch />项目流程</span><h2>项目审批与阶段看板</h2><p>材料齐备后从项目页一键进入审批；也可以在这里直接发起项目阶段审批或查看全部项目排板。</p></div><div className="fde-office-project-entry-actions"><Link to="/workflow?view=project"><GitBranch />进入项目审批<ArrowRight /></Link><Link to="/workflow?view=board"><LayoutDashboard />查看阶段看板<ArrowRight /></Link></div></section>
    {error && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">{error}</div>}
    {storageError && <p role="alert" className="text-sm text-amber-900">安全恢复存储不可用或记录损坏，办公写入已暂停。请保留记录并联系管理员核对，不要清除浏览器数据后重发。</p>}
    {recoveryNotice && <Card className="p-4"><p role="status" className="text-sm">{recoveryNotice.message}</p>{recoveryNotice.id && <Button className="mt-3" variant="secondary" onClick={() => void open(recoveryNotice.id!)}>查看原申请</Button>}</Card>}
    {pending && <Card className="p-4"><p className="text-sm">有一笔操作结果尚待核对。核对会返回已提交回执，或封闭未提交的旧请求；不会自动重发申请。恢复标识不包含正文或文件内容。</p><p className="mt-2 break-all text-xs text-slate-500">操作编号：{pending.commandId}</p><div className="mt-3 flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void recover()}>核对原请求结果</Button>{pendingBody.current != null && <Button variant="secondary" disabled={busy || storageError} onClick={() => void recover(true)}>使用原标识重试</Button>}</div></Card>}
    <div className="fde-office-shortcuts grid grid-cols-2 gap-3 md:grid-cols-4">{officeKinds.slice(0, 4).map((value, i) => <button key={value} disabled={!canWrite || !canCreateOffice || loading} onClick={() => start(value)} title={!canCreateOffice ? '需有效业务岗位' : options.enabledKinds.includes(value) ? '按已发布规则匹配路径' : '可存草稿；提交前需发布规则'} className="flex items-center gap-3 rounded-xl border border-[#dfe6e4] bg-white p-5 text-left disabled:opacity-50"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e6f0ef] text-[#315f68]">{['行', '印', '费', '假'][i]}</span><span><strong className="text-sm">{value}申请</strong></span><i aria-hidden="true">＋</i></button>)}</div>
    <div className="fde-office-layout grid gap-5 lg:grid-cols-[180px_1fr]">
      <aside className="fde-panel rounded-xl border bg-white p-2 h-fit">
        {views.map(([key, label]) => <button key={key} onClick={() => filter({ view: key })} className={`mb-1 flex w-full justify-between rounded-lg p-3 text-sm ${view === key ? 'bg-[#e6f0ef] text-[#315f68] font-semibold' : 'text-slate-500'}`}>
          {label}<span>{loading || counts[key] == null ? '—' : counts[key]}</span>
        </button>)}
        <p className="px-3 py-2 text-xs text-slate-400">数量已应用当前搜索与类型筛选</p>
      </aside>
      <section className="space-y-3">
        <div className="fde-office-toolbar flex flex-wrap gap-2">
          <input className="input min-w-48 flex-1" placeholder="搜索审批、申请人、项目或单号" maxLength={100} value={query} onChange={e => filter({ q: e.target.value })} />
          <select aria-label="申请类型筛选" className="input w-36" value={kind} onChange={e => filter({ kind: e.target.value })}>
            <option value="">全部类型</option>{[...new Set([...kinds, ...officeKinds, ...(kind ? [kind] : [])])].map(k => <option key={k}>{k}</option>)}
          </select>
          <Button variant="secondary" disabled={loading} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" />刷新</Button>
        </div>
        <Card className="fde-panel divide-y divide-slate-100">
          {loading ? <p className="p-8 text-center text-sm text-slate-500">正在读取权限内记录…</p> : <>
            {rows.map(row => {
              const content = <><Badge>{row.kind}</Badge><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{row.title}</h3><p className="mt-2 text-xs text-slate-500">{row.applicantName} · {row.projectName || '非项目申请'} · 当前节点：{row.currentNodeName}{row.status === '审批中' ? '，预计 1 个工作日' : ''}</p>{row.kind === '报销' && <span className={`expense-progress status-${row.status}`}><i /><i /><i /><i /><i /></span>}<small className="text-slate-400">{row.requestNo}{row.businessType === 'office' ? ` · 修订 ${row.revision}` : ''}</small></div><Badge tone={row.status === '已通过' ? 'green' : row.status === '审批中' ? 'blue' : 'slate'}>{row.status}</Badge></>
              const className = 'flex w-full flex-wrap items-center gap-4 p-5 text-left hover:bg-slate-50'
              return row.businessType === 'office'
                ? <button key={row.id} className={className} onClick={() => void open(row.id)}>{content}</button>
                : <Link key={row.id} className={className} to={approvalCenterDetailPath(row, params.toString())}>{content}</Link>
            })}
            {rows.length === 0 && <p className="p-10 text-center text-sm text-slate-500">当前视图暂无权限内事项</p>}
          </>}
        </Card>
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{loading ? '正在核对数量…' : `共 ${total} 条权限内记录`}</span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={resolvedPage === 1 || loading} onClick={() => filter({ page: String(resolvedPage - 1) }, false)}>上一页</Button>
            <span className="p-2">{resolvedPage} / {Math.max(1, Math.ceil(total / 20))}</span>
            <Button variant="secondary" disabled={resolvedPage * 20 >= total || loading} onClick={() => filter({ page: String(resolvedPage + 1) }, false)}>下一页</Button>
          </div>
        </div>
      </section>
    </div>
    <Modal open={Boolean(id)} onClose={() => { setId(null); setDetail(null) }} title={`${form.details.kind}申请${detail ? ` · ${detail.status} · 修订 ${detail.revision}` : ' · 新草稿'}`} width="max-w-5xl" footer={<><span className="office-autosave-status">{autoSavedAt ? `已自动保存 ${autoSavedAt}` : '每 30 秒自动保存'}</span><Button variant="secondary" onClick={() => setId(null)}>关闭</Button>{editable && <Button variant="secondary" disabled={!canWrite} onClick={() => void work(async () => setReusable(await apiGet<Reusable[]>(`/oa/office/history?kind=${encodeURIComponent(form.details.kind)}`))) }><History className="h-4 w-4" />复用历史申请</Button>}{editable && <Button disabled={!canWrite} onClick={() => void save()}>保存草稿</Button>}{detail?.capabilities.edit && <Button variant="secondary" disabled={!canWrite} onClick={() => void work(async () => { if (JSON.stringify(form) !== JSON.stringify(detail.definition)) throw new Error('请先保存表单修改，再预览审批路径'); const result = await apiGet<Preview>(`${base}/${id}/preview`); setPreview(result); setShare(false) })}>预览审批链路</Button>}</>}>
      {error && <p role="alert" className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
      {pending && <p className="mb-4 text-sm text-amber-900">原请求结果未确认，新的写入已暂停；请关闭此窗口，在审批中心核对原请求。</p>}
      <section className="office-auto-identity"><div><span>申请人</span><strong>{currentAccount?.name || '—'}</strong></div><div><span>部门</span><strong>{currentAccount?.department || '—'}</strong></div><div><span>申请单号</span><strong>{detail?.requestNo || '保存草稿后生成'}</strong></div></section>
      {reusable && <section className="office-history-picker"><div className="office-section-title"><div><span><History size={14} /></span><h3>选择历史申请</h3></div><button type="button" onClick={() => setReusable(null)}>收起</button></div>{reusable.length ? reusable.map(item => <button type="button" key={item.id} onClick={() => { setForm({ ...item.definition, attachmentIds: [] }); setPreview(null); setReusable(null) }}><strong>{item.title}</strong><small>{item.requestNo} · {item.status} · {formatShanghaiDateTime(item.updatedAt)}</small><span>复用字段</span></button>) : <p>暂无可复用的同类申请</p>}</section>}
      <fieldset disabled={!editable || !canWrite} className="grid gap-4 sm:grid-cols-2"><label><span className="label">类型</span><select className="input" disabled={Boolean(detail)} value={form.details.kind} onChange={e => setForm(newDefinition(e.target.value as typeof officeKinds[number]))}>{officeKinds.map(k => <option key={k}>{k}</option>)}</select></label><label><span className="label">可选项目</span><select className="input" disabled={Boolean(detail?.revision)} value={form.projectId ?? ''} onChange={e => { setForm({ ...form, projectId: e.target.value || null }); setPreview(null) }}><option value="">不关联项目</option>{options.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{form.details.kind!=='用印'&&<label className="sm:col-span-2"><span className="label">申请标题</span><input className="input" value={form.title} onChange={e => { setForm({ ...form, title: e.target.value }); setPreview(null) }} /></label>}<label><span className="label">紧急程度</span><select className="input" value={form.priority} onChange={e => { setForm({ ...form, priority: e.target.value as OfficeDefinition['priority'] }); setPreview(null) }}><option>普通</option><option>重要</option><option>紧急</option></select></label>
        <FdeOfficeSmartFields form={form} people={options.people} attachments={detail?.attachments.filter(file => form.attachmentIds.includes(file.id)) ?? []} leaveBalances={options.leaveBalances} changeDetail={changeDetail} changeReason={value => { setForm(current => ({ ...current, reason: value })); setPreview(null) }} changeTitle={value => { setForm(current => ({ ...current, title: value })); setPreview(null) }} />
        {form.details.kind!=='用印'&&<label className="sm:col-span-2"><span className="label">{form.details.kind==='报销'?'报销原因':'申请事由'}</span><textarea className="textarea min-h-24" value={form.reason} onChange={e => { setForm({ ...form, reason: e.target.value }); setPreview(null) }} /></label>}
      </fieldset>
      <section className={`office-upload-section mt-6 space-y-3 ${form.details.kind === '报销' ? 'invoice-upload' : ''}`}>
        <div className="office-section-title"><div><span><UploadCloud size={15} /></span><h3>{form.details.kind === '报销' ? '报销证明材料' : '申请附件'}</h3></div><small>{detail?.attachments.length ?? 0} 个文件</small></div>
        {(editable || Boolean(detail?.capabilities.author && detail.kind === '合同' && detail.status === '已通过')) && <label className="office-dropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (event.dataTransfer.files.length) void uploadFiles([...event.dataTransfer.files]) }}>
          <UploadCloud size={25} /><strong>{editable ? '拖拽或选择多个文件' : '上传合同签署件'}</strong><span>{form.details.kind === '报销' ? '支持 PDF、JPG/JPEG、PNG，可一次选择多个凭证' : form.details.kind === '用印' ? '支持 Word、Excel、PDF 和图片，原件按名称排序保留' : '支持批量选择，选择完后统一上传'}</span>
          <input type="file" multiple accept={form.details.kind === '报销' ? '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png' : '.doc,.docx,.xls,.xlsx,.pdf,.jpg,.jpeg,.png'} disabled={!canWrite} onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void uploadFiles(files) }} />
        </label>}
        {!detail && <p className="office-upload-hint">选择文件后会自动建立草稿并继续上传，不需要先点保存。</p>}
        <div className="office-file-list">{detail?.attachments.map(f => <div key={f.id}>{f.purpose === 'application' && <input aria-label={`送审 ${f.name}`} type="checkbox" disabled={!editable || !canWrite} checked={form.attachmentIds.includes(f.id)} onChange={() => { setForm({ ...form, attachmentIds: form.attachmentIds.includes(f.id) ? form.attachmentIds.filter(x => x !== f.id) : [...form.attachmentIds, f.id] }); setPreview(null) }} />}<span>{f.name}<small>{f.purpose === 'signed' ? '签署件' : f.purpose === 'execution' ? '执行证明' : '已选入送审材料'} · {(f.byteSize / 1024).toFixed(1)} KB</small></span><a href={`/api${base}/${id}/attachments/${f.id}/preview`} target="_blank" rel="noreferrer">预览</a>{f.canDownload && <a href={`/api${base}/${id}/attachments/${f.id}/download`} target="_blank" rel="noreferrer">下载</a>}{f.canManageGrants && <button disabled={!canWrite} onClick={() => { setGrantFile(f.id); setGrantRows(f.grants ?? []) }}>授权</button>}</div>)}</div>
      </section>
      {preview && <section className="mt-6 rounded-xl border border-teal-200 bg-teal-50 p-4"><h3 className="text-sm font-semibold">已保存版本的审批预览 · 规则 V{preview.policyRevision}</h3>{preview.nodes.map((n, i) => <p key={i} className="mt-2 text-sm">{i + 1}. {n.rule.name} · {n.rule.mode} · {n.names.join('、')}</p>)}{preview.issues.map(issue => <p key={issue} className="mt-2 text-sm text-red-700">{issue}</p>)}{preview.sharingRequired && <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={share} onChange={e => setShare(e.target.checked)} />确认向以上审批路径人员授予本次原件查看权；不自动授予下载权</label>}<Button className="mt-4" disabled={!canWrite || preview.issues.length > 0 || (preview.sharingRequired && !share)} onClick={() => void act('submit', { expectedPolicyVersionId: preview.policyVersionId, expectedRouteHash: preview.routeHash, confirmAttachmentSharing: share })}>确认提交此版本</Button></section>}
      {detail && <section className="mt-6 space-y-3"><h3 className="text-sm font-semibold">当前审批链</h3><div className="office-timeline">{detail.nodes.map(n => <div key={n.id} className={n.status.includes('通过') ? 'done' : n.id === detail.currentNodeId ? 'active' : 'waiting'}><i /><div><strong>{n.name} · {n.mode}</strong><p>{n.approverNames.join('、')} · {n.status}</p>{n.approvedByNames.length > 0 && <small>已处理：{n.approvedByNames.join('、')}</small>}</div></div>)}</div><label className="block"><span className="label">本次操作说明（至少五字）</span><textarea className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></label><div className="flex flex-wrap gap-2">{detail.capabilities.review && <>{(['approve', 'return', 'reject'] as const).map((a, i) => <Button key={a} disabled={!canWrite} variant={i === 0 ? 'primary' : 'secondary'} onClick={() => void act(a)}>{['同意', '退回补充', '拒绝申请'][i]}</Button>)}</>}{detail.capabilities.withdraw && <Button variant="secondary" disabled={!canWrite} onClick={() => void act('withdraw')}>撤回申请</Button>}{detail.capabilities.delete && <Button variant="secondary" disabled={!canWrite} onClick={() => void act('delete')}>删除未提交草稿</Button>}{detail.capabilities.transfer && <Button variant="secondary" disabled={!canWrite} onClick={() => void work(async () => { setCandidates(await apiGet<Person[]>(`${base}/${id}/transfer-candidates`)); setTarget('') })}>选择转交人</Button>}</div>{candidates && <div className="rounded-lg border p-3"><select aria-label="合法转交人" className="input mb-3" value={target} onChange={e => setTarget(e.target.value)}><option value="">{candidates.length ? '请选择接收人' : '无合法候选人'}</option>{candidates.map(p => <option key={p.id} value={p.id}>{p.name} · {p.role}</option>)}</select><Button disabled={!canWrite || !target} onClick={() => void act('transfer', { targetUserId: target })}>确认转交</Button></div>}
        <h3 className="pt-3 text-sm font-semibold">修订与操作历史</h3><div className="flex flex-wrap gap-2">{detail.revisions.map(r => <Button key={r.id} variant="secondary" onClick={() => void work(async () => setRevision(await apiGet(`${base}/${id}/revisions/${r.revision}`)))}>查看提交 V{r.revision}</Button>)}</div>{revision && <Card className="p-4"><p className="text-sm font-semibold">提交 V{revision.revision} · {revision.snapshot.definition.title}</p><p className="mt-2 whitespace-pre-wrap text-sm">{revision.snapshot.definition.reason}</p><dl className="mt-3 grid gap-2 sm:grid-cols-2">{Object.entries(revision.snapshot.definition.details).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([key, value]) => <div key={key} className="text-xs"><dt className="text-slate-500">{fieldLabels[key] ?? key}</dt><dd>{String(value)}</dd></div>)}</dl></Card>}{detail.history.map(h => <div key={h.id} className="border-l-2 border-slate-200 pl-3 text-xs"><p>V{h.version} · {{create: "保存草稿", save: "修订草稿", submit: "提交", approve: "同意", return: "退回", reject: "拒绝", withdraw: "撤回", delete: "删除草稿", transfer: "转交", upload: "上传原件", "signed-copy": "签署件归档", "attachment-grants": "附件授权"}[h.action] ?? h.action} · {formatShanghaiDateTime(h.createdAt)}</p><p className="mt-1 text-slate-500">{h.reason}</p></div>)}<div className="flex gap-2"><Button variant="secondary" disabled={historyPage === 1} onClick={() => void open(id!, historyPage - 1)}>上一页历史</Button><Button variant="secondary" disabled={detail.history.length < 50} onClick={() => void open(id!, historyPage + 1)}>下一页历史</Button></div></section>}
      {detail && <FdeOfficeExecutionPanel key={userId + ':' + detail.id} id={detail.id} version={detail.version} canWrite={canWrite} attachments={detail.attachments} run={work} write={perform} reload={async () => { await open(detail.id); await refresh() }} />}
      {detail?.kind === '出差' && detail.status === '已通过' && <section className="office-followup-card"><div><strong>出差单已可用于报销</strong><span>新建报销时会保留当前出差单关联，不需要再查找单号。</span></div><Button onClick={() => { const sourceId = detail.id, sourceTitle = detail.title; setId(crypto.randomUUID()); setDetail(null); setForm(officeDefinition.parse({ title: `${sourceTitle}·差旅报销`, reason: `关联已批准出差单 ${detail.requestNo}`, projectId: detail.definition.projectId, priority: '普通', details: { kind: '报销', linkedRequestId: sourceId }, attachmentIds: [] })); setPreview(null); setReusable(null) }}>去报销 <ArrowRight className="h-4 w-4" /></Button></section>}
    </Modal>
    <Modal open={Boolean(grantFile) && canManageGrantFile} onClose={() => setGrantFile(null)} title="原件授权 · 查看与下载分开管理" footer={<Button disabled={!canWrite || !canManageGrantFile || reason.trim().length < 5} onClick={() => void work(async () => { await perform(`${base}/${id}/attachments/${grantFile}/grants`, { expectedVersion: detail!.version, reason, grants: grantRows }); setGrantFile(null); await open(id!); await refresh() })}>确认保存权限</Button>}><p className="mb-3 text-xs text-slate-500">撤权立即影响后续读取和审批；历史记录保留。</p>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<label className="mb-3 block"><span className="label">授权变更说明（至少五字）</span><textarea className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></label>{options.people.map(p => { const grant = grantRows.find(g => g.userId === p.id); return <div key={p.id} className="flex items-center gap-3 border-b py-3 text-sm"><span className="flex-1">{p.name} · {p.role}</span><label><input type="checkbox" checked={Boolean(grant)} onChange={e => setGrantRows(e.target.checked ? [...grantRows, { userId: p.id, canDownload: false }] : grantRows.filter(g => g.userId !== p.id))} /> 查看</label><label><input type="checkbox" disabled={!grant} checked={Boolean(grant?.canDownload)} onChange={e => setGrantRows(grantRows.map(g => g.userId === p.id ? { ...g, canDownload: e.target.checked } : g))} /> 下载</label></div> })}</Modal>
  </div>
}
