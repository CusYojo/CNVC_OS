import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCw, Search, Send } from 'lucide-react'
import { ApiError, apiGet, apiPost } from '../lib/api'
import { Badge, Button, Card, Drawer, Modal } from './ui'
import { useToast } from './Toast'
import { useAuthStore } from '../store/useAuthStore'
import { forgetMaterialPending, materialRecoveryKey, materialWriteId, materialWriteResultUnknown, readMaterialPending, rememberMaterialPending, type MaterialPendingRequest, type MaterialResolution } from '../lib/fdeMaterialRecovery'
import './fde-workspace.css'

type Recipient = { userId: string; name: string; readAt: string | null; decision: string | null; feedback: string | null; decidedAt: string | null; version: number }
type Material = { id: string; status: string; statusLabel: string; title: string; note: string; version: number; revision: number; restricted: boolean; senderName: string; createdAt: string; withdrawalReason: string | null; previousId: string | null; nextId: string | null; ownRecipientVersion: number | null; file: { id: string; name: string; version: number; currentVersion: number; sha256: string } | null; recipients: Recipient[]; capabilities: { read: boolean; download: boolean; decide: boolean; withdraw: boolean; resubmit: boolean } }
type List = { list: Material[]; total: number; canSubmit: boolean }
type Detail = { submission: Material; events: Array<{ id: string; actorName: string; action: string; reason: string; version: number; createdAt: string }>; historyTotal: number; page: number; pageSize: number }
type Context = { canSubmit: boolean; projectVersion: number; governanceVersion: number; recipients: Array<{ id: string; name: string }> }
type FileChoice = { id: string; name: string; version: number; accessVersion: number; hasOriginal: boolean }
type FileList = { list: FileChoice[]; total: number }
const when = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
const actions: Record<string, string> = { submit: '发起送审', resubmit: '新轮次送审', read: '阅读回执', approve: '批复通过', return: '退回补充', withdraw: '撤回送审' }

export function FdeMaterialPanel({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const { showToast } = useToast(), [params, setParams] = useSearchParams()
  const base = `/projects/${projectId}/material-submissions`
  const userId = useAuthStore(state => state.user?.id ?? '')
  const recoveryKey = materialRecoveryKey(userId, projectId)
  const [pending, setPending] = useState<MaterialPendingRequest | null>(null), [recoveryError, setRecoveryError] = useState('')
  const [storageError, setStorageError] = useState('')
  const writing = useRef(false), currentScope = useRef(recoveryKey)
  const recoveryPanel = useRef<HTMLDivElement>(null)
  currentScope.current = recoveryKey
  const [list, setList] = useState<List | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [view, setView] = useState('all'), [keyword, setKeyword] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null), [detailError, setDetailError] = useState('')
  const [createOpen, setCreateOpen] = useState(false), [context, setContext] = useState<Context | null>(null), [createError, setCreateError] = useState('')
  const [createRefresh, setCreateRefresh] = useState(0), [createStale, setCreateStale] = useState(false)
  const [fileList, setFileList] = useState<FileList | null>(null), [fileSearch, setFileSearch] = useState(''), [filePage, setFilePage] = useState(1), [chosenFile, setChosenFile] = useState<FileChoice | null>(null)
  const [title, setTitle] = useState(''), [note, setNote] = useState(''), [recipientIds, setRecipientIds] = useState<string[]>([]), [previousId, setPreviousId] = useState<string | undefined>()
  const [action, setAction] = useState<'approve' | 'return' | 'withdraw' | null>(null), [feedback, setFeedback] = useState(''), [requestId, setRequestId] = useState(''), [busy, setBusy] = useState(false)
  const generation = useRef(0), currentProject = useRef(projectId)
  currentProject.current = projectId
  const changeRequest = () => setRequestId(crypto.randomUUID())
  const blocked = busy || Boolean(pending) || Boolean(storageError)
  useEffect(() => {
    if ((pending || storageError) && !busy) recoveryPanel.current?.scrollIntoView({ block: 'nearest' })
  }, [pending, storageError, busy, createOpen, action, selected])
  useEffect(() => {
    setRecoveryError(''); setStorageError('')
    try { setPending(readMaterialPending(sessionStorage, recoveryKey)) }
    catch { setStorageError('无法读取提交恢复记录，请保留当前页面并联系管理员核对；暂不能重新提交') }
  }, [recoveryKey])
  useEffect(() => {
    let cancelled = false; setList(null); setError('')
    void apiGet<List>(`${base}?${new URLSearchParams({ view, keyword: search, page: String(page) })}`).then(value => { if (!cancelled) setList(value) }).catch(cause => { if (!cancelled) setError((cause as Error).message) })
    return () => { cancelled = true }
  }, [base, userId, view, search, page, refresh])
  useEffect(() => { generation.current++; setSelected(null); setDetail(null); setCreateOpen(false); setAction(null); setPage(1); return () => { generation.current++ } }, [projectId, userId])
  useEffect(() => {
    if (!createOpen) return
    let cancelled = false; setContext(null)
    void apiGet<Context>(`/projects/${projectId}/material-context`).then(value => { if (!cancelled) setContext(value) }).catch(cause => { if (!cancelled) { setCreateError((cause as Error).message); setCreateStale(true) } })
    return () => { cancelled = true }
  }, [createOpen, projectId, createRefresh])
  useEffect(() => {
    if (!createOpen) return
    let cancelled = false; setFileList(null)
    void apiGet<FileList>(`/projects/${projectId}/file-workspace?${new URLSearchParams({ keyword: fileSearch, page: String(filePage), pageSize: '20' })}`).then(value => { if (!cancelled) setFileList(value) }).catch(cause => { if (!cancelled) { setCreateError((cause as Error).message); setCreateStale(true) } })
    return () => { cancelled = true }
  }, [createOpen, projectId, fileSearch, filePage, createRefresh])
  const load = async (id: string, markRead = false, historyPage = 1) => {
    const token = ++generation.current, targetProject = projectId
    try {
      let value = await apiGet<Detail>(`${base}/${id}?page=${historyPage}`)
      if (token !== generation.current || currentProject.current !== targetProject) return
      if (markRead && value.submission.capabilities.read) { await apiPost(`${base}/${id}/read`, { clientRequestId: crypto.randomUUID() }); value = await apiGet<Detail>(`${base}/${id}?page=${historyPage}`) }
      if (token === generation.current && currentProject.current === targetProject) { setDetail(value); setDetailError(''); if (markRead) setRefresh(n => n + 1) }
    } catch (cause) { if (token === generation.current && currentProject.current === targetProject) { setDetail(null); setDetailError((cause as Error).message) }; throw cause }
  }
  const open = (id: string) => { setSelected(id); setDetail(null); setDetailError(''); setAction(null); void load(id, true).catch(() => {}) }
  const requested = params.get('material')
  useEffect(() => { if (requested) open(requested) }, [requested, projectId])
  const close = () => { if (busy) return; generation.current++; setSelected(null); setDetail(null); setAction(null); if (params.has('material')) { const next = new URLSearchParams(params); next.delete('material'); setParams(next, { replace: true }) } }
  const beginCreate = (previous?: Material) => { if (blocked) return; setCreateOpen(true); setCreateError(''); setCreateStale(false); setTitle(previous?.title ?? ''); setNote(''); setRecipientIds([]); setPreviousId(previous?.id); setChosenFile(null); setFileSearch(''); setFilePage(1); setAction(null); changeRequest() }
  const refreshCreateContext = () => {
    if (blocked) return
    // Keep the user's prose, but require explicit selection against fresh versions.
    setContext(null); setFileList(null); setChosenFile(null); setRecipientIds([]); setFilePage(1)
    setCreateError(''); setCreateStale(false); setCreateRefresh(value => value + 1); changeRequest()
  }
  const showSaved = async (id: string, created: boolean) => {
    setAction(null); setCreateOpen(false); setCreateError(''); setRefresh(n => n + 1); onChanged(); setSelected(id)
    showToast(created ? '材料送审已保存并送达站内通知；不会自动推进项目阶段' : '处理已保存，其他接收人仍独立反馈')
    // A failed detail read must not be mistaken for a failed committed command.
    await load(id).catch(() => showToast('操作已保存，详情读取失败，请刷新送审记录', 'error'))
  }
  const run = async (operation: () => Promise<{ id: string }>, kind: MaterialPendingRequest['kind']) => {
    if (blocked || writing.current || !userId) return
    const targetScope = recoveryKey, created = kind === 'submit', request = { clientRequestId: requestId, kind }
    try { rememberMaterialPending(sessionStorage, targetScope, request) }
    catch (cause) { setStorageError((cause as Error).message); return }
    writing.current = true; setPending(request); setRecoveryError(''); setBusy(true)
    try {
      const id = materialWriteId(await operation())
      forgetMaterialPending(sessionStorage, targetScope, request.clientRequestId)
      if (currentScope.current !== targetScope) return
      setPending(null); await showSaved(id, created)
    } catch (cause) {
      if (currentScope.current !== targetScope) return
      if (materialWriteResultUnknown(cause)) {
        setRecoveryError('提交结果尚未确认，请先核对原请求；不要重复送审或修改后另发。')
        return
      }
      try { forgetMaterialPending(sessionStorage, targetScope, request.clientRequestId); setPending(null) }
      catch { setStorageError('提交恢复记录无法更新，请先核对结果'); return }
      showToast((cause as Error).message, 'error'); if (created) setCreateError((cause as Error).message)
      if (created && cause instanceof ApiError && (cause.status === 403 || cause.status === 404 || ['VERSION_CONFLICT', 'MATERIAL_RECIPIENT_INVALID', 'MATERIAL_FILE_INTEGRITY', 'MATERIAL_ALREADY_RESUBMITTED', 'MATERIAL_REQUEST_CLOSED'].includes(cause.code))) setCreateStale(true)
      if (cause instanceof ApiError && ['VERSION_CONFLICT', 'MATERIAL_REQUEST_REUSED', 'MATERIAL_DECISION_CLOSED', 'MATERIAL_WITHDRAW_CLOSED'].includes(cause.code)) { setAction(null); if (selected) await load(selected).catch(() => {}) }
      if (cause instanceof ApiError && [403, 404].includes(cause.status)) { setDetail(null); setDetailError(cause.message); setRefresh(n => n + 1) }
    } finally { writing.current = false; setBusy(false) }
  }
  const resolvePending = async () => {
    if (!pending || busy || writing.current) return
    const targetScope = recoveryKey, request = pending
    writing.current = true; setBusy(true); setRecoveryError('')
    try {
      const result = await apiPost<MaterialResolution>(`/projects/${projectId}/material-request-resolution`, { clientRequestId: request.clientRequestId })
      if (result.state !== 'committed' && result.state !== 'not_applied') throw new Error('核对响应不完整，请再次核对')
      const id = result.state === 'committed' ? materialWriteId(result) : null
      forgetMaterialPending(sessionStorage, targetScope, request.clientRequestId)
      if (currentScope.current !== targetScope) return
      setPending(null); setStorageError(''); changeRequest()
      if (id) await showSaved(id, request.kind === 'submit')
      else {
        setAction(null); setRefresh(n => n + 1)
        if (request.kind === 'submit' && createOpen) { setCreateStale(true); setCreateError('已确认未提交，旧请求已封闭。请刷新文件与接收人后重新确认；标题和说明已保留。') }
        else if (selected) await load(selected).catch(() => {})
        showToast('已确认未提交并封闭旧请求；没有新增送审或反馈，请重新确认操作')
      }
    } catch (cause) { if (currentScope.current === targetScope) setRecoveryError((cause as Error).message) }
    finally { writing.current = false; setBusy(false) }
  }
  const submit = () => { if (!createStale && context && chosenFile) void run(() => apiPost(base, { clientRequestId: requestId, fileId: chosenFile.id, fileVersion: chosenFile.version, expectedAccessVersion: chosenFile.accessVersion, expectedProjectVersion: context.projectVersion, expectedGovernanceVersion: context.governanceVersion, title, note, recipientIds, ...(previousId ? { previousSubmissionId: previousId } : {}) }), 'submit') }
  const decide = () => { if (detail && action) void run(() => apiPost(`${base}/${detail.submission.id}/${action === 'withdraw' ? 'withdraw' : 'decision'}`, action === 'withdraw' ? { clientRequestId: requestId, expectedVersion: detail.submission.version, reason: feedback } : { clientRequestId: requestId, expectedRecipientVersion: detail.submission.ownRecipientVersion, decision: action, feedback }), action) }
  const recovery = (pending || storageError) && <div ref={recoveryPanel} role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p>{storageError || recoveryError || '存在一笔尚未确认结果的送审操作，请先核对。'}</p>{pending && <><p className="my-2 text-xs">只核对原请求；已提交则打开原记录，未提交则封闭旧请求。不会自动重新送审。</p><Button variant="secondary" disabled={busy} onClick={resolvePending}>核对提交结果</Button></>}</div>
  const row = detail?.submission
  return <div className="fde-workspace mt-5">
    {!selected && !createOpen && !action && recovery}
    <Card className="fde-panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dfe6e4] p-5"><h2 className="font-semibold">材料送审</h2><div className="flex gap-2"><Button variant="secondary" onClick={() => setRefresh(n => n + 1)}><RefreshCw className="h-4 w-4" />刷新送审</Button>{list?.canSubmit && <Button disabled={blocked} onClick={() => beginCreate()}><Send className="h-4 w-4" />送审材料</Button>}</div></div>
      <div className="flex flex-wrap gap-3 p-5"><select className="input" aria-label="送审范围" value={view} onChange={event => { setView(event.target.value); setPage(1) }}>{[['all', '有权查看'], ['received', '我收到的'], ['sent', '我发出的'], ['pending', '待我批复'], ['withdrawn', '已撤回']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><form className="flex flex-1 gap-2" onSubmit={event => { event.preventDefault(); setSearch(keyword); setPage(1) }}><input className="input min-w-0 flex-1" aria-label="搜索送审标题" value={keyword} maxLength={100} onChange={event => setKeyword(event.target.value)} /><Button variant="secondary" type="submit"><Search className="h-4 w-4" />搜索送审</Button></form></div>
      {error ? <p role="alert" className="p-5 text-sm text-red-600">{error}</p> : !list ? <p className="p-5 text-sm text-slate-500">正在读取送审记录…</p> : <>
        <div className="overflow-x-auto"><table className="fde-plan-table"><thead><tr><th>材料 / 送审标题</th><th>发送人</th><th>逐人进度</th><th>状态</th><th>操作</th></tr></thead><tbody>{list.list.map(item => <tr key={item.id}><td><p className="font-medium">{item.title}</p><p className="mt-1 text-xs text-slate-400">{item.file ? `${item.file.name} · V${item.file.version} · 第 ${item.revision} 轮` : '文件权限已失效，正文隐藏'}</p></td><td>{item.senderName}</td><td>{item.restricted ? '—' : `${item.recipients.filter(person => person.readAt).length}/${item.recipients.length} 已读 · ${item.recipients.filter(person => person.decision).length}/${item.recipients.length} 已反馈`}</td><td><Badge tone={item.status === 'approved' ? 'green' : item.status.includes('return') ? 'red' : 'slate'}>{item.statusLabel}</Badge></td><td><Button variant="secondary" onClick={() => open(item.id)}>查看送审</Button></td></tr>)}</tbody></table></div>
        {!list.list.length && <p className="p-7 text-center text-sm text-slate-400">暂无符合范围的送审记录。</p>}<div className="flex items-center justify-between gap-3 border-t border-[#dfe6e4] p-4 text-xs text-slate-500"><span>共 {list.total} 条 · 第 {page} 页</span><div className="flex gap-2"><Button variant="secondary" disabled={page <= 1} onClick={() => setPage(n => n - 1)}>上一页送审</Button><Button variant="secondary" disabled={page * 20 >= list.total} onClick={() => setPage(n => n + 1)}>下一页送审</Button></div></div>
      </>}
    </Card>
    <Drawer open={Boolean(selected)} title="送审材料详情" onClose={close} width="w-full sm:w-[660px]" footer={<div className="flex flex-wrap gap-2">{row?.capabilities.withdraw && <Button variant="secondary" disabled={blocked} onClick={() => { setAction('withdraw'); setFeedback(''); changeRequest() }}>撤回送审</Button>}{row?.capabilities.resubmit && <Button variant="secondary" disabled={blocked} onClick={() => beginCreate(row)}>补充后新轮次送审</Button>}{row?.capabilities.decide && <><Button variant="secondary" disabled={blocked} onClick={() => { setAction('return'); setFeedback(''); changeRequest() }}>退回补充</Button><Button disabled={blocked} onClick={() => { setAction('approve'); setFeedback(''); changeRequest() }}>批复通过</Button></>}<Button variant="secondary" disabled={busy} onClick={close}>完成</Button></div>}>
      {!createOpen && !action && recovery}
      {detailError ? <p role="alert" className="text-sm text-red-600">{detailError}</p> : !row ? <p className="text-sm text-slate-500">正在读取送审与当前权限…</p> : <div className="space-y-5">
        <section className="rounded-xl border border-[#dfe6e4] p-4"><Badge tone="slate">{row.statusLabel}</Badge><h3 className="mt-3 break-all font-semibold">{row.title}</h3><p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{row.note}</p><p className="mt-3 text-xs text-slate-400">{row.senderName} · {when(row.createdAt)} · 第 {row.revision} 轮</p>{row.withdrawalReason && <p className="mt-3 text-sm text-slate-600">撤回原因：{row.withdrawalReason}</p>}{row.restricted && <p role="alert" className="mt-3 text-sm text-amber-800">关联文件权限已失效，正文和反馈不再显示；符合条件时发送人仍可撤回。</p>}</section>
        {row.file && <section className="rounded-xl border border-[#dfe6e4] p-4"><h4 className="break-all text-sm font-medium">{row.file.name} · 送审 V{row.file.version}</h4><p className="mt-2 break-all text-xs text-slate-400">SHA-256：{row.file.sha256}</p>{row.file.currentVersion !== row.file.version && <p className="mt-2 text-sm text-amber-800">文件已更新至 V{row.file.currentVersion}；本轮批复仍针对送审 V{row.file.version}。</p>}<div className="mt-3 flex flex-wrap gap-3 text-sm text-[#315f68]"><a href={`/api${base}/${row.id}/preview`} target="_blank" rel="noopener noreferrer">在新窗口预览送审版本</a>{row.capabilities.download && <a href={`/api/projects/files/${row.file.id}/versions/${row.file.version}/download`}>下载送审版本</a>}</div></section>}
        {!row.restricted && <section><h3 className="font-semibold">逐人送达与批复</h3><div className="mt-3 space-y-3">{row.recipients.map(person => <div key={person.userId} className="rounded-lg border border-[#dfe6e4] p-3"><div className="flex justify-between gap-3 text-sm"><strong>{person.name}</strong><span>{person.decision === 'approve' ? '批复通过' : person.decision === 'return' ? '退回补充' : '待批复'}</span></div><p className="mt-2 text-xs text-slate-400">{person.readAt ? `已读 ${when(person.readAt)}` : '等待阅读'}</p>{person.feedback && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-600">{person.feedback}</p>}{person.decidedAt && <p className="mt-2 text-xs text-slate-400">反馈时间：{when(person.decidedAt)}</p>}</div>)}</div></section>}
        {(row.previousId || row.nextId) && <div className="flex gap-3">{row.previousId && <Button variant="secondary" onClick={() => open(row.previousId!)}>查看上一轮</Button>}{row.nextId && <Button variant="secondary" onClick={() => open(row.nextId!)}>查看后续轮次</Button>}</div>}
        {detail && !row.restricted && <section><h3 className="font-semibold">操作留痕</h3><ol className="mt-3 space-y-3">{detail.events.map(event => <li key={event.id} className="border-l-2 border-[#dfe6e4] pl-3 text-xs text-slate-500"><p>{event.actorName} · {actions[event.action] ?? event.action} · v{event.version}</p><p className="mt-1 whitespace-pre-wrap">{event.reason}</p><p className="mt-1">{when(event.createdAt)}</p></li>)}</ol><div className="mt-3 flex items-center justify-between gap-2 text-xs text-slate-400"><span>共 {detail.historyTotal} 条</span><div className="flex gap-2"><Button variant="secondary" disabled={detail.page <= 1 || busy} onClick={() => void load(row.id, false, detail.page - 1).catch(() => {})}>上页历史</Button><Button variant="secondary" disabled={detail.page * detail.pageSize >= detail.historyTotal || busy} onClick={() => void load(row.id, false, detail.page + 1).catch(() => {})}>下页历史</Button></div></div></section>}
      </div>}
    </Drawer>
    <Modal open={createOpen} title={previousId ? '补充后新轮次送审' : '送审材料'} onClose={() => { if (!busy) setCreateOpen(false) }} width="max-w-2xl" footer={<><Button variant="secondary" disabled={blocked} onClick={() => setCreateOpen(false)}>取消</Button><Button loading={busy} disabled={blocked || createStale || !context?.canSubmit || !chosenFile?.hasOriginal || !title.trim() || !recipientIds.length} onClick={submit}>确认送审</Button></>}>
      {recovery}
      <div className="space-y-4">{createError && <p role="alert" className="text-sm text-red-600">{createError}</p>}{createStale && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3"><p className="mb-2 text-xs text-amber-900">请刷新文件与接收人后重新选择。标题和说明会保留，不会自动重新送审。</p><Button variant="secondary" disabled={blocked} onClick={refreshCreateContext}>刷新文件与接收人</Button></div>}
        <label className="block"><span className="label">查找有权查看的文件</span><input className="input w-full" value={fileSearch} maxLength={100} disabled={blocked} onChange={event => { setFileSearch(event.target.value); setFilePage(1) }} /></label>
        <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-[#dfe6e4] p-3">{!fileList ? <p className="text-xs text-slate-500">读取文件…</p> : fileList.list.length ? fileList.list.map(file => <label key={file.id} className="flex items-start gap-2 text-sm"><input type="radio" name="material-file" disabled={blocked || !file.hasOriginal} checked={chosenFile?.id === file.id} onChange={() => { setChosenFile(file); changeRequest() }} /><span className="break-all">{file.name} · V{file.version}{!file.hasOriginal && '（须先补传原件）'}</span></label>) : <p className="text-xs text-slate-500">没有符合条件的文件，请先上传或调整搜索。</p>}</div>
        {fileList && <div className="flex items-center justify-between gap-2 text-xs text-slate-400"><span>共 {fileList.total} 个文件 · 第 {filePage} 页</span><div className="flex gap-2"><button disabled={busy || filePage <= 1} onClick={() => setFilePage(n => n - 1)}>上页文件</button><button disabled={busy || filePage * 20 >= fileList.total} onClick={() => setFilePage(n => n + 1)}>下页文件</button></div></div>}
        {chosenFile && <p className="text-xs text-[#315f68]">已选：{chosenFile.name} · V{chosenFile.version}</p>}
        <label className="block"><span className="label">送审标题</span><input className="input w-full" disabled={blocked} maxLength={100} value={title} onChange={event => { setTitle(event.target.value); changeRequest() }} /></label><label className="block"><span className="label">送审说明</span><textarea className="textarea min-h-24 w-full" disabled={blocked} maxLength={300} value={note} onChange={event => { setNote(event.target.value); changeRequest() }} /></label>
        <fieldset><legend className="label">接收人（当前项目负责人及相关领导）</legend><div className="flex flex-wrap gap-3">{context?.recipients.map(person => <label key={person.id} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={blocked} checked={recipientIds.includes(person.id)} onChange={event => { setRecipientIds(ids => event.target.checked ? [...ids, person.id] : ids.filter(id => id !== person.id)); changeRequest() }} />{person.name}</label>)}</div>{context && !context.recipients.length && <p className="text-xs text-amber-800">暂无合法接收人，请先配置项目职责；不能选择自己。</p>}</fieldset>
      </div>
    </Modal>
    <Modal open={Boolean(action)} title={action === 'withdraw' ? '撤回送审' : action === 'approve' ? '批复通过' : '退回补充'} onClose={() => { if (!busy) setAction(null) }} footer={<><Button variant="secondary" disabled={blocked} onClick={() => setAction(null)}>取消</Button><Button loading={busy} disabled={blocked || feedback.trim().length < (action === 'withdraw' ? 5 : 1)} onClick={decide}>确认{action === 'withdraw' ? '撤回' : action === 'approve' ? '批复通过' : '退回补充'}</Button></>}>{recovery}<label className="block"><span className="label">{action === 'withdraw' ? '撤回原因（至少 5 字）' : '反馈意见'}</span><textarea className="textarea min-h-28 w-full" disabled={blocked} maxLength={action === 'withdraw' ? 600 : 400} value={feedback} onChange={event => { setFeedback(event.target.value); changeRequest() }} /></label><p className="mt-3 text-xs text-slate-500">{action === 'withdraw' ? '只有尚无人反馈的送审可以撤回，原记录保留；不撤销其他来源的合法授权。' : '本次只保存您的意见，其他接收人独立处理；不会推进项目阶段。'}</p></Modal>
  </div>
}
