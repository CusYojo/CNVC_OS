import { useEffect, useRef, useState } from 'react'
import { Archive, MessageSquare, Plus, RefreshCw, Search, Undo2 } from 'lucide-react'
import { ApiError, apiGet, apiPost } from '../lib/api'
import { Badge, Button, Card, Modal } from './ui'
import { useToast } from './Toast'
import { projectRecordKinds } from '../../server/src/contracts/fdeProjectRecordContract'
import './fde-workspace.css'

type RecordItem = { id: string; kind: string; title: string; content: string; authorName: string; status: string; version: number; createdAt: string; updatedAt: string; closedAt: string | null; closureReason: string | null; commentCount: number; source: { kind: string; id: string; version: number } | null; capabilities: { comment: boolean; withdraw: boolean; archive: boolean } }
type List = { list: RecordItem[]; total: number; page: number; pageSize: number; canCreate: boolean }
type Detail = { record: RecordItem; comments: Array<{ id: string; authorName: string; content: string; createdAt: string; withdrawnAt: string | null; withdrawalReason: string | null; canWithdraw: boolean }>; events: Array<{ id: string; action: string; actorName: string; reason: string; version: number; createdAt: string }>; commentTotal: number; historyTotal: number; page: number; historyPage: number; pageSize: number }
const statusLabels: Record<string, string> = { published: '有效记录', archived: '已归档', withdrawn: '已撤回' }
const eventLabels: Record<string, string> = { publish: '发布记录', comment: '补充讨论', withdraw: '撤回记录', archive: '归档记录', 'withdraw-comment': '撤回评论', 'source-publish': '正式来源同步' }
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

export function FdeProjectRecordPanel({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
  const { showToast } = useToast()
  const [view, setView] = useState('published'), [keyword, setKeyword] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(1)
  const [list, setList] = useState<List | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [createOpen, setCreateOpen] = useState(false), [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null), [detailError, setDetailError] = useState('')
  const [busy, setBusy] = useState(false), [requestId, setRequestId] = useState('')
  const [form, setForm] = useState({ kind: '关键判断', title: '', content: '' }), [comment, setComment] = useState(''), [reason, setReason] = useState('')
  const [action, setAction] = useState<'withdraw' | 'archive' | 'withdraw-comment' | null>(null), [commentId, setCommentId] = useState('')
  const detailGeneration = useRef(0)
  const endpoint = `/projects/${projectId}/records`
  useEffect(() => {
    let cancelled = false
    setList(null); setError('')
    void apiGet<List>(`${endpoint}?${new URLSearchParams({ view, keyword: search, page: String(page), pageSize: '20' })}`).then(value => { if (!cancelled) setList(value) }).catch(cause => { if (!cancelled) { setError((cause as Error).message); setDetail(null); setSelected(null) } })
    return () => { cancelled = true }
  }, [endpoint, view, search, page, refresh])
  useEffect(() => { detailGeneration.current += 1; setSelected(null); setDetail(null); setCreateOpen(false); setAction(null); return () => { detailGeneration.current += 1 } }, [projectId])
  const loadDetail = async (id: string, commentPage = 1, historyPage = 1) => {
    const generation = ++detailGeneration.current
    try { const value = await apiGet<Detail>(`${endpoint}/${id}?page=${commentPage}&historyPage=${historyPage}`); if (generation === detailGeneration.current) { setDetail(value); setDetailError('') } }
    catch (cause) { if (generation === detailGeneration.current) { setDetail(null); setDetailError((cause as Error).message) }; throw cause }
  }
  const closeDetail = () => { if (!busy) { detailGeneration.current += 1; setSelected(null); setDetail(null); setAction(null) } }
  const openDetail = (id: string, nextAction: typeof action = null) => {
    setSelected(id); setDetail(null); setDetailError(''); setComment(''); setReason(''); setAction(nextAction); setCommentId(''); setRequestId(crypto.randomUUID())
    void loadDetail(id).catch(() => {})
  }
  const run = async (operation: () => Promise<unknown>, message: string, close = false) => {
    setBusy(true)
    try {
      await operation(); setRefresh(value => value + 1); setComment(''); setReason(''); setAction(null); setRequestId(crypto.randomUUID())
      if (close) setCreateOpen(false)
      else if (selected) await loadDetail(selected, detail?.page ?? 1, detail?.historyPage ?? 1)
      showToast(message)
    } catch (cause) {
      showToast((cause as Error).message, 'error')
      if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT' && selected) { await loadDetail(selected).catch(() => {}); setRequestId(crypto.randomUUID()) }
      if (cause instanceof ApiError && [403, 404].includes(cause.status)) { setDetail(null); setDetailError(cause.message); setRefresh(value => value + 1) }
    } finally { setBusy(false) }
  }
  const updateForm = (patch: Partial<typeof form>) => { setForm(previous => ({ ...previous, ...patch })); setRequestId(crypto.randomUUID()) }
  const canSubmitDetail = Boolean(detail && (action === 'withdraw-comment' ? detail.comments.some(item => item.id === commentId && item.canWithdraw) : action ? detail.record.capabilities[action] : detail.record.capabilities.comment))
  const submitDetail = () => {
    if (!detail || !selected || !canSubmitDetail) return
    const common = { clientRequestId: requestId, expectedVersion: detail.record.version }
    if (action === 'withdraw-comment') void run(() => apiPost(`${endpoint}/${selected}/comments/${commentId}/withdraw`, { ...common, reason }), '评论已撤回，历史保留')
    else if (action) void run(() => apiPost(`${endpoint}/${selected}/actions`, { ...common, action, reason }), action === 'withdraw' ? '记录已撤回，正文退出正常展示与搜索' : '记录已归档，原业务来源保持不变')
    else void run(() => apiPost(`${endpoint}/${selected}/comments`, { ...common, content: comment }), '补充已发布')
  }
  const pages = Math.max(1, Math.ceil((list?.total ?? 0) / 20))
  return <div className={`fde-workspace ${compact ? 'fde-detail-records' : ''}`}><Card className="fde-panel p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{compact ? '关键讨论' : '关键讨论 · 人工项目记录'}</h2><p className="mt-1 text-xs text-slate-500">沉淀关键判断、沟通结论和风险处置；记录不代替任务成果、阶段审批或正式纪要。</p></div><div className="flex gap-2"><Button variant="secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw className="h-4 w-4" />刷新记录</Button>{list?.canCreate && <Button onClick={() => { setForm({ kind: '关键判断', title: '', content: '' }); setRequestId(crypto.randomUUID()); setCreateOpen(true) }}><Plus className="h-4 w-4" />记录关键事项</Button>}</div></div>
    <div className="mt-4 flex flex-wrap items-center gap-3"><label><span className="sr-only">记录状态</span><select className="input" value={view} onChange={event => { setView(event.target.value); setPage(1); setSearch(''); setKeyword('') }}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><form className="flex flex-1 gap-2" onSubmit={event => { event.preventDefault(); setSearch(keyword); setPage(1) }}><input aria-label="搜索项目记录" className="input min-w-0 flex-1" maxLength={100} placeholder={view === 'withdrawn' ? '按记录编号查找，不搜索撤回正文' : '搜索标题、正文或有效评论'} value={keyword} onChange={event => setKeyword(event.target.value)} /><Button type="submit" variant="secondary"><Search className="h-4 w-4" />搜索</Button></form></div>
    {error ? <p className="mt-4 text-sm text-red-600" role="alert">项目记录加载失败：{error}</p> : !list ? <p className="mt-4 text-sm text-slate-500">正在读取项目记录…</p> : <>
      <div className="mt-4 grid gap-3 xl:grid-cols-2">{list.list.map(item => <article key={item.id} className="min-w-0 rounded-xl border border-[#dfe6e4] p-4">
        <div className="flex flex-wrap items-center gap-2"><Badge tone="blue">{item.kind}</Badge><Badge tone="slate">{statusLabels[item.status]}</Badge><span className="text-xs text-slate-400">v{item.version}</span></div><h3 className="mt-3 break-words text-sm font-semibold">{item.title}</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{item.content || '正文与评论已隐藏；撤回操作仍可追溯。'}</p><p className="mt-3 text-xs text-slate-400">{item.authorName} · {date(item.updatedAt)}</p>
        {item.source && <p className="mt-2 break-all text-xs text-[#315f68]">正式{item.source.kind === 'meeting' ? '例会纪要' : '计划审核'}关联 · 来源 v{item.source.version} · {item.source.id}</p>}
        <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" onClick={() => openDetail(item.id)}><MessageSquare className="h-4 w-4" />{item.capabilities.comment ? `评论与补充（${item.commentCount}）` : '查看记录与留痕'}</Button>{item.capabilities.archive && <Button variant="secondary" onClick={() => openDetail(item.id, 'archive')}><Archive className="h-4 w-4" />归档</Button>}{item.capabilities.withdraw && <Button variant="secondary" onClick={() => openDetail(item.id, 'withdraw')}><Undo2 className="h-4 w-4" />撤回</Button>}</div>
      </article>)}</div>{!list.list.length && <p className="mt-4 rounded-lg bg-slate-50 p-5 text-sm text-slate-500">暂无匹配的{statusLabels[view]}。</p>}<div className="mt-4 flex items-center justify-between text-xs text-slate-500"><span>共 {list.total} 条 · 第 {page}/{pages} 页</span><div className="flex gap-2"><Button variant="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><Button variant="secondary" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>
    </>}
  </Card>
  <Modal open={createOpen} title="记录关键事项" onClose={() => { if (!busy) setCreateOpen(false) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setCreateOpen(false)}>取消</Button><Button loading={busy} disabled={!form.title.trim() || !form.content.trim()} onClick={() => void run(() => apiPost(endpoint, { clientRequestId: requestId, ...form }), '项目记录已保存', true)}>保存项目记录</Button></>}><div className="space-y-4"><label className="block"><span className="label">记录类型</span><select className="input w-full" value={form.kind} onChange={event => updateForm({ kind: event.target.value })}>{projectRecordKinds.map(kind => <option key={kind}>{kind}</option>)}</select></label><label className="block"><span className="label">标题</span><input className="input w-full" maxLength={100} value={form.title} onChange={event => updateForm({ title: event.target.value })} /></label><label className="block"><span className="label">内容</span><textarea className="textarea min-h-32 w-full" maxLength={600} placeholder="写明事实、判断依据、结论和下一步" value={form.content} onChange={event => updateForm({ content: event.target.value })} /></label><p className="text-xs text-slate-500">发布后在本项目授权范围内可见；不会自动创建任务、完成审批或公开到公司知识库。</p></div></Modal>
  <Modal open={Boolean(selected)} title={action === 'withdraw' ? '撤回项目记录' : action === 'archive' ? '归档项目记录' : action === 'withdraw-comment' ? '撤回评论' : '评论与补充'} onClose={closeDetail} footer={<><Button variant="secondary" disabled={busy} onClick={closeDetail}>关闭</Button>{detail && (action || detail.record.capabilities.comment) && <Button loading={busy} disabled={!canSubmitDetail || (action ? reason.trim().length < 5 : !comment.trim())} onClick={submitDetail}>{action ? '确认操作' : '发布评论'}</Button>}</>}>
    {detailError ? <p role="alert" className="text-sm text-red-600">{detailError}</p> : !detail ? <p className="text-sm text-slate-500">正在读取记录与权限…</p> : <div className="space-y-4"><div><h3 className="font-semibold">{detail.record.title}</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{detail.record.content || '正文与评论已隐藏。'}</p><p className="mt-2 text-xs text-slate-400">{detail.record.authorName} · v{detail.record.version} · {statusLabels[detail.record.status]}</p>{detail.record.closureReason && <p className="mt-2 text-xs text-slate-500">关闭原因：{detail.record.closureReason}</p>}</div>
      {action ? <><p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{action === 'archive' ? '归档后退出有效记录列表，授权人员仍可查看归档历史；正式来源不变。' : '撤回后正文退出常规展示与搜索，操作人、时间和原因保留；原任务、审批及会议不改变。'}</p><label className="block"><span className="label">操作原因（至少 5 字）</span><textarea className="textarea min-h-24 w-full" maxLength={600} value={reason} onChange={event => { setReason(event.target.value); setRequestId(crypto.randomUUID()) }} /></label><Button variant="secondary" disabled={busy} onClick={() => setAction(null)}>返回讨论</Button></> : <>
        <section className="space-y-3 border-t pt-3"><h4 className="text-sm font-medium">讨论与补充</h4>{detail.comments.map(item => <div key={item.id} className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">{item.authorName} · {date(item.createdAt)}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.withdrawnAt ? '此评论已撤回' : item.content}</p>{item.withdrawalReason && <p className="mt-2 text-xs text-slate-400">原因：{item.withdrawalReason}</p>}{item.canWithdraw && <Button variant="secondary" className="mt-2" onClick={() => { setAction('withdraw-comment'); setCommentId(item.id); setReason(''); setRequestId(crypto.randomUUID()) }}>撤回评论</Button>}</div>)}{detail.commentTotal === 0 && <p className="text-xs text-slate-400">暂无可显示的评论。</p>}<div className="flex flex-wrap items-center gap-2 text-xs"><span>共 {detail.commentTotal} 条评论</span><Button variant="secondary" disabled={busy || detail.page <= 1} onClick={() => void loadDetail(selected!, detail.page - 1, detail.historyPage).catch(() => {})}>上页评论</Button><Button variant="secondary" disabled={busy || detail.page * detail.pageSize >= detail.commentTotal} onClick={() => void loadDetail(selected!, detail.page + 1, detail.historyPage).catch(() => {})}>下页评论</Button></div></section>
        {detail.record.capabilities.comment && <label className="block"><span className="label">补充内容</span><textarea className="textarea min-h-24 w-full" maxLength={300} placeholder="补充事实、依据或需要跟进的事项" value={comment} onChange={event => { setComment(event.target.value); setRequestId(crypto.randomUUID()) }} /></label>}
        <details className="border-t pt-3"><summary className="cursor-pointer text-xs text-slate-500">版本与操作留痕（{detail.historyTotal}）</summary><div className="mt-3 space-y-2">{detail.events.map(item => <p key={item.id} className="break-words text-xs text-slate-500">v{item.version} · {eventLabels[item.action] ?? item.action} · {item.actorName} · {date(item.createdAt)} · {item.reason}</p>)}</div><div className="mt-3 flex gap-2"><Button variant="secondary" disabled={busy || detail.historyPage <= 1} onClick={() => void loadDetail(selected!, detail.page, detail.historyPage - 1).catch(() => {})}>上页留痕</Button><Button variant="secondary" disabled={busy || detail.historyPage * detail.pageSize >= detail.historyTotal} onClick={() => void loadDetail(selected!, detail.page, detail.historyPage + 1).catch(() => {})}>下页留痕</Button></div></details>
      </>}
    </div>}
  </Modal></div>
}
