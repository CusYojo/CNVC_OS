import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowRight, History, RefreshCw, Trash2, UploadCloud } from 'lucide-react'
import { officeDefinition, officeKinds, type OfficeDefinition } from '../../server/src/contracts/fdeOfficeContract'
import { approvalCenterDetailPath, type ApprovalCenterResult, type ApprovalCenterRow } from '../../server/src/contracts/fdeApprovalCenterContract'
import { APPROVAL_CHANGED, type ApprovalSession } from '../lib/approvalWorkspace'
import { apiGet, apiPost } from '../lib/api'
import { forgetOfficePending, officeRecoveryKey, officeResolvedResult, officeWriteReceipt, officeWriteResultUnknown, readOfficePending, rememberOfficePending, type OfficePending } from '../lib/fdeOfficeRecovery'
import { useAuthStore } from '../store/useAuthStore'
import { Badge, Button, Card, Modal } from './ui'
import { formatShanghaiDateTime } from '../lib/dateTime'
import './fde-workspace.css'
import { FdeOfficeExecutionPanel } from './FdeOfficeExecutionPanel'
import { FdeOfficeSmartFields, type LeaveBalance, type TravelRequestOption } from './FdeOfficeSmartFields'

type Person = { id: string; name: string; role: string }
type Row = ApprovalCenterRow
type Detail = Row & { definition: OfficeDefinition; currentNodeId: string | null; nodes: { id: string; name: string; mode: string; approverNames: string[]; approvedByNames: string[]; status: string; completedAt?: string | null; comment?: string | null }[]; attachments: { id: string; name: string; byteSize: number; sha256: string; version: number; purpose: string; canDownload: boolean; canManageGrants: boolean; canDelete: boolean; grants?: { userId: string; canDownload: boolean }[] }[]; history: { id: string; version: number; action: string; reason: string; createdAt: string }[]; revisions: { id: string; revision: number }[]; capabilities: { author: boolean; review: boolean; withdraw: boolean; transfer: boolean; edit: boolean; delete: boolean } }
type Preview = { requestVersion: number; policyVersionId: string; policyRevision: number; routeHash: string; nodes: { rule: { name: string; mode: string }; names: string[] }[]; issues: string[]; sharingRequired: boolean }
type Reusable = { id: string; requestNo: string; title: string; status: string; updatedAt: string; definition: OfficeDefinition }
const views = [['processed', '已处理'], ['mine', '我发起的'], ['draft', '草稿']] as const
const base = '/oa/office/requests'
const newDefinition = (kind: typeof officeKinds[number]) => officeDefinition.parse({ title: ['报销', '请假'].includes(kind) ? `${kind}申请` : '', reason: '', projectId: null, priority: '普通', details: { kind }, attachmentIds: [] })
const preparedDefinition = (value: OfficeDefinition) => officeDefinition.parse(value.details.kind === '用印' ? { ...value, title: `${value.details.sealType || '用印'}申请`, reason: value.details.purpose } : value.details.kind === '报销' || value.details.kind === '请假' ? { ...value, title: `${value.details.kind}申请`, projectId: value.details.kind === '请假' ? null : value.projectId } : value)
const fieldLabels: Record<string, string> = { title: '申请标题', reason: '申请事由', projectId: '关联项目', projectExplanation: '报销事项说明', attachmentIds: '申请附件', travelerIds: '出差人', origin: '出发城市', destination: '目的城市', travelMode: '交通方式', itinerary: '多段行程', budget: '预算', currency: '币种', startDate: '开始日期', endDate: '结束日期', entity: '申请主体', sealType: '印章类型', purpose: '用途', copies: '用印份数', handlerId: '经办人', takeOutAt: '带出时间', returnAt: '归还时间', amount: '金额', items: '费用明细', leaveType: '假期类型', startAt: '开始时间', endAt: '结束时间', hours: '请假时长', counterparty: '合同相对方', documentVersion: '合同版本' }
const fieldLabelAliases: Record<string, string[]> = { startDate: ['出发日期', '开始日期'], endDate: ['返回日期', '结束日期'], purpose: ['用印事由', '用途'], reason: ['申请事由', '报销原因'] }
const readFile = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('本地文件读取失败')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file) })

function submissionIssueFields(form: OfficeDefinition, issues: string[]) {
  const result = new Map<string, string>()
  const add = (key: string, message: string) => { if (!result.has(key)) result.set(key, message) }
  for (const issue of issues) {
    const required = issue.match(/^缺少必填字段：(.+)$/)?.[1]
    if (required) { add(required, `请填写${fieldLabels[required] ?? required}`); continue }
    if (issue.includes('标题和至少五字事由')) {
      if (!form.title.trim()) add('title', '请填写申请标题')
      if (form.reason.trim().length < 5) add('reason', '申请事由至少填写 5 个字')
    } else if (issue.includes('出差申请必须关联项目')) add('projectId', '请选择本次出差对应的项目')
    else if (issue.includes('关联的出差申请')) add('linkedRequestId', issue)
    else if (issue.includes('报销事项说明')) add('projectExplanation', issue)
    else if (form.details.kind === '报销' && /发票|住宿单|行程单|报销事项|费用明细/.test(issue)) add('items', issue)
    else if (issue.includes('附件')) add('attachmentIds', issue)
    else if (issue.includes('结束日期')) add('endDate', issue)
    else if (issue.includes('出发城市') || issue.includes('目的城市')) { add('origin', issue); add('destination', issue) }
    else if (issue.includes('行程')) add('itinerary', issue)
    else if (issue.includes('带出') || issue.includes('归还')) { add('takeOutAt', issue); add('returnAt', issue) }
    else if (issue.includes('请假结束')) add('endAt', issue)
    else if (issue.includes('报销') || issue.includes('票据') || issue.includes('水单') || issue.includes('费用明细')) add('items', issue)
  }
  return result
}

export function FdeOfficePanel({ session }: { session?: ApprovalSession } = {}) {
  const currentAccount = useAuthStore(s => s.user), userId = currentAccount?.id ?? ''
  const [params, setParams] = useSearchParams(), view = views.some(v => v[0] === params.get('view')) ? params.get('view')! : 'processed'
  const statusFilter = ['tracking', 'completed'].includes(params.get('status') ?? '') ? params.get('status')! : ''
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
  const [options, setOptions] = useState<{ people: Person[]; projects: { id: string; name: string }[]; travelRequests: TravelRequestOption[]; enabledKinds: string[]; leaveBalances: LeaveBalance[] }>({ people: [], projects: [], travelRequests: [], enabledKinds: [], leaveBalances: [] })
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [id, setId] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null), [form, setForm] = useState<OfficeDefinition>(newDefinition('出差'))
  const [preview, setPreview] = useState<Preview | null>(null), [reason, setReason] = useState(''), [share, setShare] = useState(false), [candidates, setCandidates] = useState<Person[] | null>(null), [target, setTarget] = useState('')
  const [historyPage, setHistoryPage] = useState(1), [revision, setRevision] = useState<{ revision: number; snapshot: { definition: OfficeDefinition } } | null>(null)
  const [grantFile, setGrantFile] = useState<string | null>(null), [grantRows, setGrantRows] = useState<{ userId: string; canDownload: boolean }[]>([])
  const [pending, setPending] = useState<OfficePending | null>(null), [storageError, setStorageError] = useState(false)
  const [recoveryNotice, setRecoveryNotice] = useState<{ message: string; id?: string } | null>(null)
  const [reusable, setReusable] = useState<Reusable[] | null>(null), [autoSavedAt, setAutoSavedAt] = useState('')
  const [submissionIssues, setSubmissionIssues] = useState<string[]>([])
  const [deletingAttachment, setDeletingAttachment] = useState<{ id: string; name: string } | null>(null)
  const pendingBody = useRef<unknown>(null), loadSequence = useRef(0), busyRef = useRef(false), currentUser = useRef(userId); currentUser.current = userId
  const formRoot = useRef<HTMLDivElement>(null)
  const storageKey = officeRecoveryKey(userId)
  const detailSequence = useRef(0)
  useEffect(() => { currentUser.current = userId; return () => { currentUser.current = ''; detailSequence.current++ } }, [userId])
  useEffect(() => {
    setId(null); setDetail(null); setRows([]); setCounts({}); setKinds([]); setCanCreateOffice(false); setRecoveryNotice(null); setGrantFile(null); setDeletingAttachment(null); setPending(null); setBusy(false); busyRef.current = false; pendingBody.current = null
    try { setPending(readOfficePending(sessionStorage, storageKey)); setStorageError(false) }
    catch { setStorageError(true); setError('无法读取安全恢复标识，办公写入已暂停。请保留当前页面并联系管理员核对。') }
  }, [storageKey])
  const refresh = useCallback(async () => {
    if (userId !== currentUser.current) return
    const seq = ++loadSequence.current, actor = userId
    setLoading(true)
    try {
      const filters = new URLSearchParams({ view: statusFilter || view, page: String(page), kind, q: query })
      const result = await apiGet<ApprovalCenterResult>(`/oa/center?${filters}`)
      if (seq !== loadSequence.current || actor !== currentUser.current) return
      setRows(result.list); setTotal(result.total); setCounts(result.counts); setKinds(result.kinds); setResolvedPage(result.page); setCanCreateOffice(result.canCreateOffice); setError('')
      if (!result.canCreateOffice) setOptions({ people: [], projects: [], travelRequests: [], enabledKinds: [], leaveBalances: [] })
      else {
        try { const opts = await apiGet<typeof options>('/oa/office/options'); if (seq === loadSequence.current && actor === currentUser.current) setOptions(opts) }
        catch (e) { if (seq === loadSequence.current && actor === currentUser.current) { setCanCreateOffice(false); setError(`申请配置读取失败：${(e as Error).message}`) } }
      }
    } catch (e) { if (seq === loadSequence.current) { setRows([]); setTotal(0); setCounts({}); setKinds([]); setCanCreateOffice(false); setError((e as Error).message) } }
    finally { if (seq === loadSequence.current) setLoading(false) }
  }, [view, statusFilter, page, kind, query, userId])
  useEffect(() => { void refresh(); return () => { loadSequence.current++ } }, [refresh])
  const open = async (requestId: string, requestedPage = 1) => {
    const actor = userId, sequence = ++detailSequence.current
    if (actor !== currentUser.current) return
    try { const row = await apiGet<Detail>(`${base}/${requestId}?page=${requestedPage}`); if (actor !== currentUser.current || sequence !== detailSequence.current) return; setId(requestId); setDetail(row); setForm(row.definition); setPreview(null); setRevision(null); setHistoryPage(requestedPage); setCandidates(null); setError('') }
    catch (e) { if (actor === currentUser.current && sequence === detailSequence.current) { setId(null); setDetail(null); setError((e as Error).message) } }
  }
  useEffect(() => { const requestId = session?.requestId ?? params.get('office'); if (requestId) void open(requestId) }, [session?.requestId, params.get('office'), userId])
  const closeDetail = () => { if (busyRef.current) return; if (session) session.onClose(); else { setId(null); setDetail(null) } }
  useEffect(() => { session?.onBusyChange(busy) }, [busy, session?.onBusyChange])
  useEffect(() => { session?.onDirtyChange(Boolean(reason.trim() || detail && JSON.stringify(form) !== JSON.stringify(detail.definition))) }, [reason, form, detail, session?.onDirtyChange])
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
  const perform = async (path: string, body: Record<string, unknown>, allowDirty = false) => {
    if (!id || pending || storageError || userId !== currentUser.current) throw new Error('请先核对未完成请求，不能创建新的操作')
    if (!allowDirty && !path.endsWith('/save') && detail && JSON.stringify(form) !== JSON.stringify(detail.definition)) throw new Error('表单有未保存修改，请先保存草稿，再上传、授权或提交')
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
    try { await fn() } catch (e) {
      if (actor === currentUser.current) {
        const message = (e as Error).message
        setError(message)
        if (submissionIssueFields(form, message.split('；')).size) setSubmissionIssues(message.split('；'))
        if (message.includes('重新预览') || message.includes('审批路径')) window.requestAnimationFrame(() => formRoot.current?.querySelector<HTMLElement>('[data-office-preview]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
      }
    }
    finally { if (actor === currentUser.current) { busyRef.current = false; setBusy(false) } }
  }
  const save = () => work(async () => { const parsed = preparedDefinition(form); await perform(`${base}/${id}/save`, { expectedVersion: detail?.version ?? 0, definition: parsed }); await open(id!); await refresh() })
  const act = (action: string, extra = {}) => work(async () => {
    const operationReason = action === 'submit' ? '确认提交办公申请' : action === 'approve' && !reason.trim() ? '同意本次申请' : reason.trim()
    if (operationReason.length < 5) {
      const input = formRoot.current?.querySelector<HTMLTextAreaElement>('textarea[placeholder="填写本次处理意见"]')
      const field = input?.closest<HTMLElement>('label')
      field?.classList.add('office-field-invalid')
      if (field) field.dataset.error = '请填写至少 5 个字的审批意见'
      input?.setAttribute('aria-invalid', 'true')
      window.requestAnimationFrame(() => {
        field?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        input?.focus({ preventScroll: true })
      })
      return
    }
    await perform(`${base}/${id}/actions`, { expectedVersion: detail!.version, action, reason: operationReason, ...extra })
    window.dispatchEvent(new Event(APPROVAL_CHANGED))
    if (session && ['approve', 'return', 'reject', 'transfer'].includes(action)) { setReason(''); await session.onHandled(); return }
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
      ? { message: '原操作已确认完成。', id: marker.id }
      : { message: '原操作未提交，请重新打开申请后操作。' })
    await refresh()
    if (session) await open(session.requestId)
  })
  const start = (value: typeof officeKinds[number]) => { setId(crypto.randomUUID()); setDetail(null); setForm(newDefinition(value)); setPreview(null); setRevision(null); setReason(''); setCandidates(null); setReusable(null); setAutoSavedAt(''); setRecoveryNotice(null); setError('') }
  const canWrite = !busy && !pending && !storageError, editable = !detail || detail.capabilities.edit
  const canManageGrantFile = Boolean(detail?.attachments.some(file => file.id === grantFile && file.canManageGrants))
  useEffect(() => { if (grantFile && !canManageGrantFile) { setGrantFile(null); setGrantRows([]) } }, [grantFile, canManageGrantFile])
  const changeDetail = (field: string, value: unknown) => { setForm(f => ({ ...f, details: { ...f.details, [field]: value } as OfficeDefinition['details'] })); setPreview(null) }
  useEffect(() => {
    if (reason.trim().length < 5) return
    const input = formRoot.current?.querySelector<HTMLTextAreaElement>('textarea[placeholder="填写本次处理意见"]')
    const field = input?.closest<HTMLElement>('label')
    field?.classList.remove('office-field-invalid'); field?.removeAttribute('data-error'); input?.removeAttribute('aria-invalid')
  }, [reason])
  useEffect(() => { setSubmissionIssues([]) }, [form])
  useEffect(() => {
    const root = formRoot.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('.office-field-invalid').forEach(element => { element.classList.remove('office-field-invalid'); element.removeAttribute('data-error') })
    if (!submissionIssues.length) return
    const fields = submissionIssueFields(form, submissionIssues)
    let first: HTMLElement | null = null
    for (const [key, message] of fields) {
      let target = root.querySelector<HTMLElement>(`[data-office-field="${key}"]`)
      if (!target) {
        const labels = fieldLabelAliases[key] ?? [fieldLabels[key]]
        target = [...root.querySelectorAll<HTMLElement>('label')].find(element => labels.some(label => label && element.querySelector('.label')?.textContent?.includes(label))) ?? null
      }
      if (!target && key === 'items') target = root.querySelector<HTMLElement>('.expense-sheet')
      if (!target && key === 'itinerary') target = root.querySelector<HTMLElement>('.office-itinerary')
      if (!target) continue
      target.classList.add('office-field-invalid'); target.dataset.error = message; first ??= target
    }
    window.requestAnimationFrame(() => {
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      first?.querySelector<HTMLElement>('input, select, textarea, button')?.focus({ preventScroll: true })
    })
  }, [submissionIssues, form])
  const submit = () => {
    if (!preview) return
    if (preview.issues.length) { setSubmissionIssues(preview.issues); return }
    setSubmissionIssues([])
    void act('submit', { expectedPolicyVersionId: preview.policyVersionId, expectedRouteHash: preview.routeHash, confirmAttachmentSharing: share })
  }
  const uploadFiles = (files: File[]) => work(async () => {
    if (!id) throw new Error('申请编号不存在，请重新打开申请')
    if (form.details.kind === '报销') {
      const unsupported = files.find(file => !/\.pdf$/i.test(file.name))
      if (unsupported) throw new Error(`报销证明材料仅支持 PDF：${unsupported.name}`)
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
  const uploadExpenseMaterial = (itemId: string, field: 'attachmentId' | 'waterAttachmentId', file: File) => work(async () => {
    if (!id || form.details.kind !== '报销') throw new Error('请重新打开报销申请')
    if (!/\.pdf$/i.test(file.name)) throw new Error(`报销证明材料仅支持 PDF：${file.name}`)
    const prepared = preparedDefinition(form)
    if (prepared.details.kind !== '报销' || !prepared.details.items.some(item => item.id === itemId)) throw new Error('报销事项已变化，请刷新后重试')
    let version = detail?.version ?? 0
    if (!detail || JSON.stringify(form) !== JSON.stringify(detail.definition)) {
      const saved = await perform(`${base}/${id}/save`, { expectedVersion: version, definition: prepared })
      version = saved.version
    }
    const fileId = crypto.randomUUID(), dataBase64 = await readFile(file)
    const uploaded = await perform(`${base}/${id}/attachments/${fileId}`, { expectedVersion: version, reason: '上传报销事项证明材料', name: file.name, declaredType: file.type || 'application/pdf', dataBase64, purpose: 'application' }, true)
    const next = officeDefinition.parse({ ...prepared, attachmentIds: [...new Set([...prepared.attachmentIds, fileId])], details: { ...prepared.details, items: prepared.details.items.map(item => item.id === itemId ? { ...item, [field]: fileId } : item) } })
    await perform(`${base}/${id}/save`, { expectedVersion: uploaded.version, definition: next }, true)
    await open(id); await refresh()
  })
  const removeAttachment = () => work(async () => {
    if (!id || !detail || !deletingAttachment) throw new Error('附件已变化，请重新打开草稿')
    await perform(`${base}/${id}/attachments/${deletingAttachment.id}/delete`, { expectedVersion: detail.version, reason: '用户确认删除草稿附件' })
    setDeletingAttachment(null); await open(id); await refresh()
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
  const officeModalFooter = detail ? <>
    <Button variant="secondary" onClick={closeDetail}>关闭</Button>
    {detail.capabilities.withdraw && <Button variant="secondary" disabled={!canWrite} onClick={() => void act('withdraw')}>撤回申请</Button>}
    {detail.capabilities.delete && <Button variant="secondary" disabled={!canWrite} onClick={() => void act('delete')}>删除草稿</Button>}
    {detail.capabilities.transfer && <Button variant="secondary" disabled={!canWrite} onClick={() => void work(async () => { setCandidates(await apiGet<Person[]>(`${base}/${id}/transfer-candidates`)); setTarget('') })}>转交</Button>}
    {editable && <Button variant="secondary" disabled={!canWrite} onClick={() => void work(async () => setReusable(await apiGet<Reusable[]>(`/oa/office/history?kind=${encodeURIComponent(form.details.kind)}`))) }><History className="h-4 w-4" />复用历史</Button>}
    {detail.capabilities.edit && <Button variant="secondary" disabled={!canWrite} onClick={() => void work(async () => { if (JSON.stringify(form) !== JSON.stringify(detail.definition)) throw new Error('请先保存表单修改，再预览审批路径'); const result = await apiGet<Preview>(`${base}/${id}/preview`); setPreview(result); setShare(false) })}>预览审批链路</Button>}
    {detail.capabilities.review && <><Button variant="secondary" disabled={!canWrite} onClick={() => void act('return')}>退回补充</Button><Button variant="secondary" disabled={!canWrite} onClick={() => void act('reject')}>拒绝</Button><Button disabled={!canWrite} onClick={() => void act('approve')}>同意并流转</Button></>}
    {editable && <Button disabled={!canWrite} onClick={() => void save()}>保存草稿</Button>}
  </> : <><span className="office-autosave-status">{autoSavedAt ? `已自动保存 ${autoSavedAt}` : '每 30 秒自动保存'}</span><Button variant="secondary" onClick={() => setId(null)}>取消</Button><Button variant="secondary" disabled={!canWrite} onClick={() => void work(async () => setReusable(await apiGet<Reusable[]>(`/oa/office/history?kind=${encodeURIComponent(form.details.kind)}`))) }><History className="h-4 w-4" />复用历史</Button><Button disabled={!canWrite} onClick={() => void save()}>保存草稿</Button></>
  const expenseBoundAttachmentIds = form.details.kind === '报销' ? new Set(form.details.items.flatMap(item => [item.attachmentId, item.waterAttachmentId].filter((value): value is string => Boolean(value)))) : new Set<string>()
  const displayedAttachments = detail?.attachments.filter(file => form.details.kind !== '报销' || !expenseBoundAttachmentIds.has(file.id)) ?? []
  return <div className="fde-workspace fde-office-page space-y-5">
    {!session && <>
    <header><h2 className="text-lg font-semibold text-slate-900">办公申请</h2><p className="mt-1 text-sm text-slate-500">出差、用印、报销、请假与合同</p></header>
    {error && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">{error}</div>}
    {storageError && <p role="alert" className="text-sm text-amber-900">安全恢复存储不可用或记录损坏，办公写入已暂停。请保留记录并联系管理员核对，不要清除浏览器数据后重发。</p>}
    {recoveryNotice && <Card className="p-4"><p role="status" className="text-sm">{recoveryNotice.message}</p>{recoveryNotice.id && <Button className="mt-3" variant="secondary" onClick={() => void open(recoveryNotice.id!)}>查看原申请</Button>}</Card>}
    {pending && <Card className="p-4"><p className="text-sm">上一笔操作结果待核对，完成核对后即可继续。</p><div className="mt-3 flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void recover()}>核对操作结果</Button>{pendingBody.current != null && <Button variant="secondary" disabled={busy || storageError} onClick={() => void recover(true)}>重试原操作</Button>}</div></Card>}
    <div className="fde-office-shortcuts grid grid-cols-2 gap-3 lg:grid-cols-5">{officeKinds.map((value, i) => <button key={value} disabled={!canWrite || !canCreateOffice || loading} onClick={() => start(value)} title={!canCreateOffice ? '需有效业务岗位' : options.enabledKinds.includes(value) ? '按已发布规则匹配路径' : '可存草稿；提交前需发布规则'} className="flex items-center gap-3 rounded-xl border border-[#dfe6e4] bg-white p-5 text-left disabled:opacity-50"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e6f0ef] text-[#315f68]">{['行', '印', '费', '假', '合'][i]}</span><span><strong className="text-sm">{value}申请</strong></span><i aria-hidden="true">＋</i></button>)}</div>
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4">
        <div className="flex overflow-x-auto">{views.map(([key, label]) => <button key={key} onClick={() => filter({ view: key, status: '' })} className={`relative whitespace-nowrap px-4 py-4 text-sm font-medium transition ${view === key && !statusFilter ? 'text-brand-700' : 'text-slate-500 hover:text-slate-800'}`}>{label}{counts[key] != null && <span className="ml-1.5 text-xs">{counts[key]}</span>}{view === key && !statusFilter && <i className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand-600" />}</button>)}</div>
        <select aria-label="流程状态筛选" className="input w-36" value={statusFilter} onChange={e => filter({ status: e.target.value })}><option value="">全部状态</option><option value="tracking">流程跟踪</option><option value="completed">已完成</option></select>
      </div>
      <section className="space-y-3 p-4">
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
    </Card>
    </>}
    <Modal open={Boolean(id) || Boolean(session)} onClose={closeDetail} title={session && !detail ? '审批详情' : `${form.details.kind}申请${detail ? ` · ${detail.status}` : ' · 新草稿'}`} width="max-w-5xl" footer={session && !detail ? undefined : officeModalFooter}>
      <div ref={formRoot}>
      {session?.navigation}
      {session && !detail && !error && <p role="status" className="py-6 text-sm text-slate-500">正在读取申请详情…</p>}
      {session && pending && <Button variant="secondary" disabled={busy} onClick={() => void recover()}>核对上次操作结果</Button>}
      {session && recoveryNotice && <p role="status" className="mb-4 text-sm text-brand-700">{recoveryNotice.message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
      {pending && <p className="mb-4 text-sm text-amber-900">原请求结果未确认，请先核对上次操作结果。</p>}
      {(!session || detail) && <>
      <section><h3 className="mb-3 text-sm font-semibold text-slate-800">核心摘要</h3><div className="office-auto-identity"><div><span>申请人</span><strong>{detail?.applicantName || currentAccount?.name || '—'}</strong></div><div><span>{detail ? '申请类型' : '部门'}</span><strong>{detail ? detail.kind + '申请' : currentAccount?.department || '—'}</strong></div><div><span>申请单号</span><strong>{detail?.requestNo || '保存草稿后生成'}</strong></div></div></section>
      {reusable && <section className="office-history-picker"><div className="office-section-title"><div><span><History size={14} /></span><h3>选择历史申请</h3></div><button type="button" onClick={() => setReusable(null)}>收起</button></div>{reusable.length ? reusable.map(item => <button type="button" key={item.id} onClick={() => { setForm({ ...item.definition, attachmentIds: [] }); setPreview(null); setReusable(null) }}><strong>{item.title}</strong><small>{item.requestNo} · {item.status} · {formatShanghaiDateTime(item.updatedAt)}</small><span>复用字段</span></button>) : <p>暂无可复用的同类申请</p>}</section>}
      <h3 className="mt-6 mb-3 text-sm font-semibold text-slate-800">申请内容</h3><fieldset disabled={!editable || !canWrite} className="grid gap-4 sm:grid-cols-2">{form.details.kind !== '报销' && form.details.kind !== '请假' && <><label data-office-field="projectId"><span className="label">{form.details.kind === '出差' ? '关联项目 *' : '可选项目'}</span><select className="input" disabled={Boolean(detail?.revision)} value={form.projectId ?? ''} onChange={e => { setForm({ ...form, projectId: e.target.value || null }); setPreview(null) }}><option value="">{form.details.kind === '出差' ? '请选择对应项目' : '不关联项目'}</option>{options.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{form.details.kind !== '用印' && <label data-office-field="title"><span className="label">申请标题</span><input className="input" value={form.title} onChange={e => { setForm({ ...form, title: e.target.value }); setPreview(null) }} /></label>}<label><span className="label">紧急程度</span><select className="input" value={form.priority} onChange={e => { setForm({ ...form, priority: e.target.value as OfficeDefinition['priority'] }); setPreview(null) }}><option>普通</option><option>重要</option><option>紧急</option></select></label></>}
        <FdeOfficeSmartFields form={form} people={options.people} attachments={detail?.attachments.filter(file => form.attachmentIds.includes(file.id)) ?? []} travelRequests={options.travelRequests} leaveBalances={options.leaveBalances} uploadExpenseMaterial={editable ? uploadExpenseMaterial : undefined} changeDetail={changeDetail} changeReason={value => { setForm(current => ({ ...current, reason: value })); setPreview(null) }} changeTitle={value => { setForm(current => ({ ...current, title: value })); setPreview(null) }} />
        {form.details.kind !== '用印' && form.details.kind !== '报销' && form.details.kind !== '请假' && <label data-office-field="reason" className="sm:col-span-2"><span className="label">申请事由</span><textarea className="textarea min-h-24" value={form.reason} onChange={e => { setForm({ ...form, reason: e.target.value }); setPreview(null) }} /></label>}
        {form.details.kind === '报销' && <details className="expense-optional-settings sm:col-span-2"><summary>更多信息</summary><div><label><span className="label">关联项目（可选）</span><select className="input" disabled={Boolean(detail?.revision)} value={form.projectId ?? ''} onChange={e => { setForm({ ...form, projectId: e.target.value || null }); setPreview(null) }}><option value="">不关联项目</option>{options.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label><span className="label">紧急程度</span><select className="input" value={form.priority} onChange={e => { setForm({ ...form, priority: e.target.value as OfficeDefinition['priority'] }); setPreview(null) }}><option>普通</option><option>重要</option><option>紧急</option></select></label></div></details>}
      </fieldset>
      <section data-office-field="attachmentIds" className={`office-upload-section mt-6 space-y-3 ${form.details.kind === '报销' ? 'invoice-upload' : ''}`}>
        <div className="office-section-title"><div><span><UploadCloud size={15} /></span><h3>{form.details.kind === '报销' ? '其他需要上传材料（可选）' : form.details.kind === '出差' ? '申请附件（可选）' : '申请附件'}</h3></div><small>{displayedAttachments.length} 个文件</small></div>
        {form.details.kind === '报销' && <label className="mx-4 block"><span className="label">补充说明（可选）</span><textarea className="textarea min-h-20" value={form.details.additionalNote} onChange={event => changeDetail('additionalNote', event.target.value)} placeholder="如有其他材料，可在这里补充说明" /></label>}
        {(editable || Boolean(detail?.capabilities.author && detail.kind === '合同' && detail.status === '已通过')) && <label className="office-dropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (event.dataTransfer.files.length) void uploadFiles([...event.dataTransfer.files]) }}>
          <UploadCloud size={25} /><strong>{editable ? '拖拽或选择多个文件' : '上传合同签署件'}</strong><span>{form.details.kind === '报销' ? '如有其他证明材料，可在此补充上传 PDF' : form.details.kind === '用印' ? '支持 Word、Excel、PDF 和图片，原件按名称排序保留' : '支持批量选择，选择完后统一上传'}</span>
          <input type="file" multiple accept={form.details.kind === '报销' ? '.pdf,application/pdf' : '.doc,.docx,.xls,.xlsx,.pdf,.jpg,.jpeg,.png'} disabled={!canWrite} onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void uploadFiles(files) }} />
        </label>}
        {!detail && <p className="office-upload-hint">选择文件后会自动建立草稿并继续上传，不需要先点保存。</p>}
        <div className="office-file-list">{displayedAttachments.map(f => <div key={f.id}>{f.purpose === 'application' && <input aria-label={`送审 ${f.name}`} type="checkbox" disabled={!editable || !canWrite} checked={form.attachmentIds.includes(f.id)} onChange={() => { setForm({ ...form, attachmentIds: form.attachmentIds.includes(f.id) ? form.attachmentIds.filter(x => x !== f.id) : [...form.attachmentIds, f.id] }); setPreview(null) }} />}<span>{f.name}<small>{f.purpose === 'signed' ? '签署件' : f.purpose === 'execution' ? '执行证明' : '已选入送审材料'} · {(f.byteSize / 1024).toFixed(1)} KB</small></span><a href={`/api${base}/${id}/attachments/${f.id}/preview`} target="_blank" rel="noreferrer">预览</a>{f.canDownload && <a href={`/api${base}/${id}/attachments/${f.id}/download`} target="_blank" rel="noreferrer">下载</a>}{f.canManageGrants && <button disabled={!canWrite} onClick={() => { setGrantFile(f.id); setGrantRows(f.grants ?? []) }}>授权</button>}{f.canDelete && <button className="office-file-delete" disabled={!canWrite} onClick={() => setDeletingAttachment({ id: f.id, name: f.name })}><Trash2 size={14} />删除</button>}</div>)}</div>
      </section>
      {preview && <section className="mt-6 rounded-xl border border-teal-200 bg-teal-50 p-4"><h3 className="text-sm font-semibold">审批链路</h3>{preview.nodes.map((n, i) => <p key={i} className="mt-2 text-sm">{i + 1}. {n.rule.name} · {n.rule.mode} · {n.names.join('、')}</p>)}{preview.issues.map(issue => <p key={issue} className="mt-2 text-sm text-red-700">{issue}</p>)}{submissionIssues.length > 0 && <p role="alert" className="mt-3 font-semibold text-red-700">还有 {submissionIssueFields(form, submissionIssues).size || submissionIssues.length} 项内容需要完善，已定位到第一项。</p>}{preview.sharingRequired && <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={share} onChange={e => setShare(e.target.checked)} />允许以上审批人查看本次附件</label>}<Button className="mt-4" disabled={!canWrite || (preview.sharingRequired && !share)} onClick={submit}>确认提交</Button></section>}
      {detail && <section className="mt-6 space-y-3"><h3 className="text-sm font-semibold">审批时间轴</h3><div className="office-timeline">{detail.nodes.map(n => <div key={n.id} className={n.status.includes('通过') ? 'done' : n.id === detail.currentNodeId ? 'active' : 'waiting'}><i /><div><strong>{n.name} · {n.mode}</strong><p>处理人：{n.approverNames.join('、')} · {n.status}</p>{n.completedAt && <small>处理时间：{formatShanghaiDateTime(n.completedAt)}</small>}{n.approvedByNames.length > 0 && <small>已处理：{n.approvedByNames.join('、')}</small>}{n.comment && <small>审批意见：{n.comment}</small>}</div></div>)}</div>{(detail.capabilities.review || detail.capabilities.withdraw || detail.capabilities.transfer) && <label className="block"><span className="label">审批意见（同意可不填，退回或拒绝至少五字）</span><textarea className="textarea" value={reason} onChange={e => setReason(e.target.value)} placeholder="填写本次处理意见" /></label>}{candidates && <div className="rounded-lg border p-3"><select aria-label="合法转交人" className="input mb-3" value={target} onChange={e => setTarget(e.target.value)}><option value="">{candidates.length ? '请选择接收人' : '无合法候选人'}</option>{candidates.map(p => <option key={p.id} value={p.id}>{p.name} · {p.role}</option>)}</select><Button disabled={!canWrite || !target} onClick={() => void act('transfer', { targetUserId: target })}>确认转交</Button></div>}
        <details className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold">版本与操作记录</summary><div className="mt-4 space-y-3"><div className="flex flex-wrap gap-2">{detail.revisions.map(r => <Button key={r.id} variant="secondary" onClick={() => void work(async () => setRevision(await apiGet(`${base}/${id}/revisions/${r.revision}`)))}>提交版本 {r.revision}</Button>)}</div>{revision && <Card className="p-4"><p className="text-sm font-semibold">提交版本 {revision.revision} · {revision.snapshot.definition.title}</p><p className="mt-2 whitespace-pre-wrap text-sm">{revision.snapshot.definition.reason}</p><dl className="mt-3 grid gap-2 sm:grid-cols-2">{Object.entries(revision.snapshot.definition.details).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([key, value]) => <div key={key} className="text-xs"><dt className="text-slate-500">{fieldLabels[key] ?? key}</dt><dd>{String(value)}</dd></div>)}</dl></Card>}{detail.history.map(h => <div key={h.id} className="border-l-2 border-slate-200 pl-3 text-xs"><p>{{create: "保存草稿", save: "修订草稿", submit: "提交", approve: "同意", return: "退回", reject: "拒绝", withdraw: "撤回", delete: "删除草稿", transfer: "转交", upload: "上传原件", "delete-attachment": "删除草稿附件", "signed-copy": "签署件归档", "attachment-grants": "附件授权"}[h.action] ?? h.action} · {formatShanghaiDateTime(h.createdAt)}</p><p className="mt-1 text-slate-500">{h.reason}</p></div>)}<div className="flex gap-2"><Button variant="secondary" disabled={historyPage === 1} onClick={() => void open(id!, historyPage - 1)}>上一页</Button><Button variant="secondary" disabled={detail.history.length < 50} onClick={() => void open(id!, historyPage + 1)}>下一页</Button></div></div></details></section>}
      {detail && <FdeOfficeExecutionPanel key={userId + ':' + detail.id} id={detail.id} version={detail.version} canWrite={canWrite} attachments={detail.attachments} run={work} write={perform} reload={async () => { await open(detail.id); await refresh() }} />}
      {detail?.kind === '出差' && detail.status === '已通过' && <section className="office-followup-card"><div><strong>出差单已关联报销</strong></div><Button onClick={() => { const sourceId = detail.id, sourceTitle = detail.title; setId(crypto.randomUUID()); setDetail(null); setForm(officeDefinition.parse({ title: `${sourceTitle}·差旅报销`, reason: `关联已批准出差单 ${detail.requestNo}`, projectId: detail.definition.projectId, priority: '普通', details: { kind: '报销', linkedRequestId: sourceId }, attachmentIds: [] })); setPreview(null); setReusable(null) }}>去报销 <ArrowRight className="h-4 w-4" /></Button></section>}
      </>}
      </div>
    </Modal>
    <Modal open={Boolean(grantFile) && canManageGrantFile} onClose={() => setGrantFile(null)} title="附件访问范围" footer={<Button disabled={!canWrite || !canManageGrantFile || reason.trim().length < 5} onClick={() => void work(async () => { await perform(`${base}/${id}/attachments/${grantFile}/grants`, { expectedVersion: detail!.version, reason, grants: grantRows }); setGrantFile(null); await open(id!); await refresh() })}>保存权限</Button>}>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<label className="mb-3 block"><span className="label">变更说明（至少五字）</span><textarea className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></label>{options.people.map(p => { const grant = grantRows.find(g => g.userId === p.id); return <div key={p.id} className="flex items-center gap-3 border-b py-3 text-sm"><span className="flex-1">{p.name} · {p.role}</span><label><input type="checkbox" checked={Boolean(grant)} onChange={e => setGrantRows(e.target.checked ? [...grantRows, { userId: p.id, canDownload: false }] : grantRows.filter(g => g.userId !== p.id))} /> 查看</label><label><input type="checkbox" disabled={!grant} checked={Boolean(grant?.canDownload)} onChange={e => setGrantRows(grantRows.map(g => g.userId === p.id ? { ...g, canDownload: e.target.checked } : g))} /> 下载</label></div> })}</Modal>
    <Modal open={Boolean(deletingAttachment)} onClose={() => !busy && setDeletingAttachment(null)} title="删除草稿附件" footer={<><Button variant="secondary" disabled={busy} onClick={() => setDeletingAttachment(null)}>取消</Button><Button variant="danger" loading={busy} onClick={() => void removeAttachment()}>确认删除</Button></>}>
      <div className="rounded-xl bg-rose-50 p-4 text-sm leading-6 text-rose-700"><strong className="block text-rose-900">{deletingAttachment?.name}</strong><span>删除后将从当前草稿和报销明细中移除，已提交过的申请附件不可删除。</span></div>
    </Modal>
  </div>
}
