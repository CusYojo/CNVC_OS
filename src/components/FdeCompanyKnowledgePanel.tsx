import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Archive, ExternalLink, FileText, MessageSquare, RefreshCw, Search, Star, X } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { Badge, Button, Card, Modal } from './ui'
import { useToast } from './Toast'
import { knowledgeDefinition, knowledgeKinds } from '../../server/src/contracts/fdeKnowledgeContract'
import type { z } from 'zod'
import { useAuthStore } from '../store/useAuthStore'
import { forgetKnowledgePending, knowledgeCommandPath, knowledgeRecoveryKey, knowledgeResolvedResult, knowledgeWriteReceipt, knowledgeWriteResultUnknown, readKnowledgePending, rememberKnowledgePending, type KnowledgePending } from '../lib/fdeKnowledgeRecovery'
import './fde-workspace.css'

type Entry = { id: string; authorId: string; authorName: string; kind: string; title: string; summary: string; link: string; audience: 'company' | 'selected'; status: string; version: number; updatedAt: string; rating: number | null; ratings: number; commentCount: number; file: { id: string; name: string; version: number } | null; capabilities: { edit: boolean; manageAudience: boolean; publish: boolean; archive: boolean; interact: boolean; download: boolean } }
type List = { list: Entry[]; total: number; canCreate: boolean }
type Detail = { entry: Entry; readerIds: string[]; editorIds: string[]; ownRating: number | null; comments: Array<{ id: string; authorName: string; content: string; createdAt: string; withdrawnAt: string | null; canWithdraw: boolean }>; commentTotal: number; history: Array<{ id: string; action: string; actorName: string; version: number; reason: string }>; historyTotal: number; page: number; historyPage: number; pageSize: number }
type Options = { people: Array<{ id: string; name: string; department: string }>; files: Array<{ id: string; name: string; version: number }> }
type Form = z.infer<typeof knowledgeDefinition>
const endpoint = '/company-knowledge'
const scoreLabels: Record<number, string> = { 5: '很有价值', 4: '有帮助', 3: '一般', 2: '需完善' }
const empty = (): Form => ({ kind: '行业资讯', title: '', summary: '', link: '', audience: 'selected', readerIds: [], editorIds: [], fileId: null, fileVersion: null })
const labels: Record<string, string> = { published: '已发布', draft: '草稿', archived: '已归档', create: '保存草稿', edit: '更新知识', publish: '发布', archive: '归档', comment: '发布批注', 'withdraw-comment': '撤回批注', rate: '保存评分', 'withdraw-rating': '撤回评分' }

export function FdeCompanyKnowledgePanel() {
  const userId = useAuthStore(state => state.user?.id ?? '')
  return userId ? <KnowledgeAccountPanel key={userId} userId={userId} /> : <p className="p-4 text-sm text-slate-500">请登录后访问公司知识库。</p>
}

function KnowledgeAccountPanel({ userId }: { userId: string }) {
  const { showToast } = useToast()
  const [params, setParams] = useSearchParams(), selected = params.get('entry')
  const [view, setView] = useState('published'), [kind, setKind] = useState(''), [keyword, setKeyword] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(1)
  const [list, setList] = useState<List | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [detail, setDetail] = useState<Detail | null>(null), [detailError, setDetailError] = useState(''), [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<{ id: string; version: number; audience: boolean } | null>(null), [form, setForm] = useState<Form>(empty), [options, setOptions] = useState<Options | null>(null)
  const [comment, setComment] = useState(''), [score, setScore] = useState(5), [reason, setReason] = useState(''), [action, setAction] = useState<'publish' | 'archive' | null>(null)
  const [shortcut, setShortcut] = useState<{ id: string; action: 'edit' | 'rate' | 'comment' } | null>(null)
  const [interaction, setInteraction] = useState<'rate' | 'comment' | null>(null)
  const [pending, setPending] = useState<KnowledgePending | null>(null)
  const [ready, setReady] = useState(false), [storageError, setStorageError] = useState(''), [notice, setNotice] = useState('')
  const mounted = useRef(true), key = knowledgeRecoveryKey(userId)
  const current = () => mounted.current && useAuthStore.getState().user?.id === userId
  const blocked = !ready || Boolean(pending) || Boolean(storageError)
  const readRecovery = () => {
    try { setPending(readKnowledgePending(sessionStorage, key)); setStorageError(''); setReady(true) }
    catch { setStorageError('无法读取知识恢复标识，已阻止新提交；请恢复浏览器存储后重新读取。'); setReady(false) }
  }
  useEffect(() => { mounted.current = true; readRecovery(); return () => { mounted.current = false } }, [])
  const generation = useRef(0), submitting = useRef(false)
  const navigateEntry = (id: string | null) => { const next = new URLSearchParams(params); if (id) next.set('entry', id); else next.delete('entry'); setParams(next) }
  useEffect(() => {
    let active = true; setList(null); setError('')
    const query = new URLSearchParams({ view, page: String(page), keyword: search }); if (kind) query.set('kind', kind)
    void apiGet<List>(`${endpoint}?${query}`).then(value => { if (active && current()) setList(value) }).catch(cause => { if (active && current()) { setError((cause as Error).message); setDetail(null) } })
    return () => { active = false }
  }, [view, kind, search, page, refresh])
  const loadDetail = async (id: string, commentPage = 1, historyPage = 1) => {
    const current = ++generation.current; setDetail(null); setDetailError('')
    try { const value = await apiGet<Detail>(`${endpoint}/${id}?page=${commentPage}&historyPage=${historyPage}`); if (mounted.current && useAuthStore.getState().user?.id === userId && current === generation.current) { setDetail(value); setScore(value.ownRating ?? 5) } }
    catch (cause) { if (mounted.current && useAuthStore.getState().user?.id === userId && current === generation.current) setDetailError((cause as Error).message) }
  }
  useEffect(() => { setAction(null); setInteraction(null); setComment(''); setReason(''); if (selected) void loadDetail(selected); else { generation.current++; setDetail(null) } return () => { generation.current++ } }, [selected])
  const edit = async (entry?: Detail) => {
    if (blocked || !current()) return
    setError(''); setOptions(null)
    const value = entry?.entry
    setEditor({ id: value?.id ?? crypto.randomUUID(), version: value?.version ?? 0, audience: !value || value.capabilities.manageAudience })
    setForm(value ? { kind: value.kind as Form['kind'], title: value.title, summary: value.summary, link: value.link, audience: value.audience, readerIds: entry!.readerIds, editorIds: entry!.editorIds, fileId: value.file?.id ?? null, fileVersion: value.file?.version ?? null } : empty())
    try { const value = await apiGet<Options>(`${endpoint}/options`); if (current()) setOptions(value) } catch (cause) { if (current()) { setError((cause as Error).message); setEditor(null) } }
  }
  useEffect(() => {
    if (!shortcut || !detail || detail.entry.id !== shortcut.id || selected !== shortcut.id || blocked) return
    setShortcut(null)
    const allowed = shortcut.action === 'edit' ? detail.entry.capabilities.edit : detail.entry.capabilities.interact
    if (!allowed) { setNotice('当前权限已变化，请重新核对知识详情。'); return }
    if (shortcut.action === 'edit') void edit(detail)
    else setInteraction(shortcut.action)
  }, [detail, shortcut, selected, blocked])
  const openShortcut = (id: string, action: 'edit' | 'rate' | 'comment') => {
    if (blocked || busy) return
    setDetail(null); setInteraction(null); setShortcut({ id, action }); navigateEntry(id)
    if (selected === id) void loadDetail(id)
  }
  const finish = (marker: KnowledgePending, version?: number) => {
    if (!current()) return
    try { forgetKnowledgePending(sessionStorage, key, marker) }
    catch { setStorageError('结果已核对，但恢复标识未能清除；请重新读取后核对，不能直接另建请求。'); return }
    setPending(null); setEditor(null); setShortcut(null); setInteraction(null); setAction(null); setForm(empty()); setComment(''); setReason(''); setRefresh(value => value + 1)
    const message = version ? `原操作已保存：${marker.id} · v${version}。详情仍按当前权限读取。` : '原请求确认未提交，已封闭迟到写入。请重新读取当前内容并确认后再操作。'
    setNotice(message); showToast(version ? '已核对原操作结果' : '原请求未提交，已安全封闭')
    if (version) { navigateEntry(marker.id); void loadDetail(marker.id) }
    else if (selected) void loadDetail(selected)
  }
  const resolve = async (marker: KnowledgePending) => {
    const result = knowledgeResolvedResult(await apiPost<unknown>(`${endpoint}/commands/resolve`, marker), marker)
    if (current()) finish(marker, result.state === 'committed' ? result.receipt.version : undefined)
  }
  const recover = async () => {
    if (!pending || submitting.current || !current()) return
    submitting.current = true; setBusy(true)
    try { await resolve(pending) }
    catch (cause) { if (current()) { setNotice(`结果仍待确认：${(cause as Error).message}`); showToast('核对未完成，请保留原请求标识', 'error') } }
    finally { if (current()) { submitting.current = false; setBusy(false) } }
  }
  const run = async (marker: KnowledgePending, payload: object) => {
    if (submitting.current || blocked || !current()) return
    try { rememberKnowledgePending(sessionStorage, key, marker) }
    catch { setStorageError('无法安全保存恢复标识，尚未发送本次请求；请重新读取并核对已有记录。'); return }
    submitting.current = true; setBusy(true); setPending(marker); setNotice('')
    try {
      const receipt = knowledgeWriteReceipt(await apiPost<unknown>(knowledgeCommandPath(marker), payload), marker)
      if (current()) finish(marker, receipt.version)
    } catch (cause) {
      if (!current()) return
      setNotice(`提交结果待确认：${(cause as Error).message}`); showToast((cause as Error).message, 'error')
      if (!knowledgeWriteResultUnknown(cause)) {
        try { await resolve(marker) }
        catch { if (current()) setNotice('请求被拒绝，但原结果尚未可靠核对。请保留标识并重新核对，不要另建请求。') }
      }
    } finally { if (current()) { submitting.current = false; setBusy(false) } }
  }
  const submit = (suffix: string, data: { action?: 'publish' | 'archive'; content?: string; score?: number | null; reason?: string }) => {
    if (!detail || blocked) return
    const clientRequestId = crypto.randomUUID(), commentId = suffix.startsWith('comments/') ? suffix.split('/')[1] : undefined
    const action = suffix === 'actions' ? data.action! : suffix === 'rating' ? 'rate' : commentId ? 'withdraw-comment' : 'comment'
    void run({ id: detail.entry.id, action, clientRequestId, ...(commentId ? { commentId } : {}) }, { clientRequestId, expectedVersion: detail.entry.version, ...data })
  }
  const save = () => {
    if (!editor || blocked) return
    const parsed = knowledgeDefinition.safeParse(form)
    if (!parsed.success) { showToast(parsed.error.issues[0].message, 'error'); return }
    const clientRequestId = crypto.randomUUID()
    void run({ id: editor.id, action: 'save', clientRequestId }, { clientRequestId, expectedVersion: editor.version, definition: parsed.data })
  }
  const close = () => { if (!busy && !pending) { generation.current++; setShortcut(null); setInteraction(null); navigateEntry(null); setDetail(null) } }
  const entry = detail?.entry, pages = Math.max(1, Math.ceil((list?.total ?? 0) / 20))
  const toggle = (field: 'readerIds' | 'editorIds', id: string) => setForm(value => ({ ...value, [field]: value[field].includes(id) ? value[field].filter(item => item !== id) : [...value[field], id] }))
  return <div className="fde-workspace">
    {storageError && <div role="alert" className="mb-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm">{storageError}<Button className="ml-3" variant="secondary" disabled={busy} onClick={readRecovery}>重新读取恢复标识</Button></div>}
    {notice && <p role="status" className="mb-4 break-words rounded-xl bg-slate-50 p-4 text-sm">{notice}</p>}
    <Card className="fde-panel fde-knowledge-library">
      <div className="fde-card-head"><div><h2>公司知识库</h2><p>文档、方法论和新闻链接由同事共同沉淀，可查阅、下载摘要、编辑、评价与批注。</p></div>{list?.canCreate && <Button disabled={busy || blocked} onClick={() => void edit()}>分享知识</Button>}</div>
      {error && <div className="fde-knowledge-state"><p role="alert">{error}</p><Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>重新读取</Button></div>}
      {!list && !error && <p role="status" className="fde-knowledge-state">正在读取知识及当前权限…</p>}
      {list && <>
        <div className="fde-knowledge-grid">{list.list.map(item => <article className="fde-knowledge-card" key={item.id}>
          <button className="fde-knowledge-card-main" disabled={blocked} onClick={() => navigateEntry(item.id)} aria-label={`查阅：${item.title}`}>
            <div className="fde-knowledge-meta"><Badge tone="blue">{item.kind}</Badge><span title={item.file ? '仍须通过原文件查看权限核验' : undefined}>{item.audience === 'company' ? '公司业务成员可见' : '指定范围可见'}</span></div>
            <h3>{item.title}</h3><p>{item.summary}</p>
            <div className="fde-knowledge-stats"><span>{item.authorName} · {new Date(item.updatedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span><strong>{item.rating === null ? '暂无评分' : `★ ${item.rating.toFixed(1)}`} · {item.ratings} 人</strong></div>
          </button>
          <div className="fde-knowledge-actions">
            <Button size="sm" variant="secondary" disabled={blocked} onClick={() => navigateEntry(item.id)}>查阅</Button>
            {item.capabilities.edit && <Button size="sm" variant="secondary" disabled={busy || blocked} onClick={() => openShortcut(item.id, 'edit')}>编辑</Button>}
            {item.capabilities.interact && <><Button size="sm" variant="secondary" disabled={busy || blocked} onClick={() => openShortcut(item.id, 'rate')}>评价</Button><Button size="sm" variant="secondary" disabled={busy || blocked} onClick={() => openShortcut(item.id, 'comment')}>批注</Button></>}
            {item.status !== 'published' && <span className="fde-knowledge-lifecycle">{labels[item.status]} · v{item.version}</span>}
          </div>
        </article>)}</div>
        {!list.list.length && <div className="fde-knowledge-state"><strong>当前范围暂无匹配知识</strong><small>草稿与归档只向作者和授权编辑人开放。</small></div>}
        {pages > 1 && <div className="fde-knowledge-pagination"><span>共 {list.total} 条 · 第 {page}/{pages} 页</span><div><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>}
      </>}
    </Card>
    <details className="fde-knowledge-tools">
      <summary>筛选与知识管理{view !== 'published' || search || kind ? ' · 已应用筛选' : ''}</summary>
      <div className="fde-knowledge-tool-body"><select className="input" aria-label="知识状态" value={view} onChange={e => { setView(e.target.value); setPage(1) }}>{['published', 'draft', 'archived'].map(value => <option key={value} value={value}>{labels[value]}</option>)}</select><select className="input" aria-label="知识类型筛选" value={kind} onChange={e => { setKind(e.target.value); setPage(1) }}><option value="">全部类型</option>{knowledgeKinds.map(value => <option key={value}>{value}</option>)}</select><form onSubmit={e => { e.preventDefault(); setSearch(keyword); setPage(1) }}><input className="input" aria-label="搜索知识" placeholder="搜索标题、摘要或有效批注" value={keyword} onChange={e => setKeyword(e.target.value)} /><Button variant="secondary" type="submit"><Search className="h-4 w-4" />搜索</Button></form><Button variant="secondary" disabled={busy || blocked} onClick={() => setRefresh(value => value + 1)}><RefreshCw className="h-4 w-4" />刷新</Button></div>
    </details>
    {pending && !busy && <div role="alert" className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">提交结果尚未确认。刷新后仍可核对；不会自动重放原请求。<Button className="ml-3" variant="secondary" onClick={() => void recover()}>核对原请求结果</Button><p className="mt-2 break-all text-xs">知识编号：{pending.id}</p></div>}
    {selected && !editor && !interaction && <div className="fixed inset-0 z-40 bg-slate-900/25" onClick={close}><aside role="dialog" aria-modal="true" aria-label="知识详情" className="absolute bottom-0 right-0 top-0 flex w-full max-w-2xl flex-col bg-[#f4f6f5] shadow-xl" onClick={e => e.stopPropagation()}>
      <div className="flex items-start justify-between border-b border-[#dfe6e4] bg-white p-5"><div><h2 className="font-semibold">{entry?.title ?? '知识详情'}</h2><p className="mt-1 text-xs text-slate-500">{entry ? `${entry.kind} · ${labels[entry.status]} · v${entry.version}` : '正在核对当前访问权限'}</p></div><button aria-label="关闭知识详情" disabled={busy || blocked} onClick={close}><X className="h-5 w-5" /></button></div>
      <div className="flex-1 space-y-5 overflow-y-auto p-5">{detailError && <p role="alert" className="text-sm text-red-600">{detailError}</p>}{!detail && !detailError && <p>正在读取…</p>}{detail && entry && <>
        <Card className="fde-panel p-5"><h3 className="text-sm font-semibold">内容摘要</h3><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7">{entry.summary}</p><p className="mt-3 text-xs text-slate-500">{entry.authorName} · {entry.audience === 'company' ? '公司业务成员可见' : '指定人员可见'}{entry.file && '；仍须原文件查看权'}</p><div className="mt-4 flex flex-wrap gap-3">{entry.link && <a className="inline-flex items-center gap-1 text-sm text-[#315f68]" href={entry.link} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" />打开原文</a>}{entry.file && <a className="text-sm text-[#315f68]" href={`/api${endpoint}/${entry.id}/preview`} target="_blank" rel="noopener noreferrer">查看原始附件 · V{entry.file.version}</a>}{entry.capabilities.download && <><a className="text-sm text-[#315f68]" href={`/api${endpoint}/${entry.id}/summary`}>下载摘要</a>{entry.file && <a className="text-sm text-[#315f68]" href={`/api${endpoint}/${entry.id}/download`}>下载原始附件</a>}</>}</div></Card>
        {action ? <Card className="fde-panel p-4"><h3>{action === 'publish' ? '确认发布范围' : '归档知识'}</h3><p className="mt-2 text-xs leading-6 text-slate-500">{action === 'publish' ? '发布后在所选范围检索可见；不会增加任何原文件的查看或下载权限。' : '归档后退出常规列表和检索，保留历史及原文件，不自动删除附件。'}</p><label className="mt-3 block text-sm">操作原因（至少5字）<textarea className="textarea mt-2 w-full" value={reason} onChange={e => setReason(e.target.value)} disabled={blocked} /></label><div className="mt-3 flex gap-2"><Button disabled={busy || blocked || reason.trim().length < 5} onClick={() => submit('actions', { action, reason })}>确认{action === 'publish' ? '发布' : '归档'}</Button><Button variant="secondary" disabled={busy || blocked} onClick={() => setAction(null)}>取消</Button></div></Card> : null}
        <Card className="fde-panel p-4"><h3 className="flex items-center gap-2 text-sm font-semibold"><Star className="h-4 w-4 text-amber-600" />{entry.rating === null ? '暂无评分' : entry.rating.toFixed(1)} · {entry.ratings} 人评价</h3>{entry.capabilities.interact && <div className="mt-3 flex flex-wrap gap-2"><select className="input" aria-label="知识评分" value={score} onChange={e => setScore(Number(e.target.value))} disabled={blocked}>{[5, 4, 3, 2].map(value => <option key={value} value={value}>{value} 分 · {scoreLabels[value]}</option>)}</select><Button variant="secondary" disabled={busy || blocked} onClick={() => submit('rating', { score })}>{detail.ownRating === null ? '提交评价' : '更新我的评价'}</Button>{detail.ownRating !== null && <Button variant="secondary" disabled={busy || blocked} onClick={() => submit('rating', { score: null })}>撤回我的评价</Button>}</div>}</Card>
        <section className="space-y-3"><h3 className="flex items-center gap-2 text-sm font-semibold"><MessageSquare className="h-4 w-4" />批注交流</h3>{detail.comments.map(item => <Card key={item.id} className="fde-panel p-4"><p className="text-xs text-slate-500">{item.authorName}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.withdrawnAt ? '此批注已撤回' : item.content}</p>{item.canWithdraw && <Button className="mt-2" variant="secondary" disabled={busy || blocked} onClick={() => { const value = window.prompt('撤回原因（至少5字）'); if (value && value.trim().length >= 5) submit(`comments/${item.id}/withdraw`, { reason: value }) }}>撤回批注</Button>}</Card>)}<div className="flex flex-wrap items-center gap-2 text-xs"><span>共 {detail.commentTotal} 条</span><Button variant="secondary" disabled={busy || blocked || detail.page <= 1} onClick={() => void loadDetail(entry.id, detail.page - 1, detail.historyPage)}>上页批注</Button><Button variant="secondary" disabled={busy || blocked || detail.page * detail.pageSize >= detail.commentTotal} onClick={() => void loadDetail(entry.id, detail.page + 1, detail.historyPage)}>下页批注</Button></div>{entry.capabilities.interact && <><label className="block text-sm">批注内容<textarea className="textarea mt-2 w-full" maxLength={300} value={comment} disabled={blocked} onChange={e => setComment(e.target.value)} /></label><Button disabled={busy || blocked || !comment.trim()} onClick={() => submit('comments', { content: comment })}>发布批注</Button></>}</section>
        <section className="space-y-2"><h3 className="text-sm font-semibold">版本与操作留痕</h3>{detail.history.map(item => <p className="text-xs leading-6 text-slate-500" key={item.id}>v{item.version} · {labels[item.action] ?? item.action} · {item.actorName} · {item.reason}</p>)}<div className="flex gap-2"><Button variant="secondary" disabled={busy || blocked || detail.historyPage <= 1} onClick={() => void loadDetail(entry.id, detail.page, detail.historyPage - 1)}>上页历史</Button><Button variant="secondary" disabled={busy || blocked || detail.historyPage * detail.pageSize >= detail.historyTotal} onClick={() => void loadDetail(entry.id, detail.page, detail.historyPage + 1)}>下页历史</Button></div></section>
      </>}</div><div className="flex flex-wrap gap-2 border-t border-[#dfe6e4] bg-white p-4">{entry?.capabilities.archive && <Button variant="secondary" disabled={busy || blocked} onClick={() => { setAction('archive'); setReason('') }}><Archive className="h-4 w-4" />归档</Button>}{entry?.capabilities.edit && <Button variant="secondary" disabled={busy || blocked} onClick={() => void edit(detail!)}><FileText className="h-4 w-4" />编辑内容</Button>}{entry?.capabilities.publish && <Button disabled={busy || blocked} onClick={() => { setAction('publish'); setReason('') }}>发布知识</Button>}<Button variant="secondary" disabled={busy || blocked} onClick={close}>完成</Button>{storageError && <Button variant="secondary" onClick={readRecovery}>重新读取恢复标识</Button>}{pending && !busy && <Button onClick={() => void recover()}>核对原请求结果</Button>}</div>
    </aside></div>}
    <Modal open={Boolean(interaction && detail && selected === detail.entry.id)} title={interaction === 'rate' ? '评价知识内容' : '批注交流'} onClose={close} footer={<><Button variant="secondary" disabled={busy || blocked} onClick={close}>取消</Button><Button disabled={busy || blocked || !entry?.capabilities.interact || (interaction === 'comment' && !comment.trim())} onClick={() => interaction === 'rate' ? submit('rating', { score }) : submit('comments', { content: comment })}>{interaction === 'rate' ? '提交评价' : '发布批注'}</Button></>}>
      <p className="mb-4 text-sm text-slate-500">{entry?.title}</p>
      {interaction === 'rate' ? <label className="block text-sm">评分<select className="input mt-2 w-full" aria-label="知识评分" value={score} disabled={busy || blocked} onChange={e => setScore(Number(e.target.value))}>{[5, 4, 3, 2].map(value => <option key={value} value={value}>{value} 分 · {scoreLabels[value]}</option>)}</select></label> : <label className="block text-sm">批注内容<textarea className="textarea mt-2 w-full" maxLength={300} value={comment} disabled={busy || blocked} onChange={e => setComment(e.target.value)} /></label>}
      {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
      {pending && !busy && <Button variant="secondary" className="mt-3" onClick={() => void recover()}>核对原请求结果</Button>}
    </Modal>
    <Modal open={Boolean(editor)} title={editor?.version ? '编辑公司知识' : '分享公司知识'} onClose={() => { if (!busy && !pending) setEditor(null) }} footer={<><Button variant="secondary" disabled={busy || blocked} onClick={() => setEditor(null)}>取消</Button><Button loading={busy} disabled={!options || blocked} onClick={save}>{editor?.version ? '保存修改' : '保存草稿'}</Button>{storageError && <Button variant="secondary" onClick={readRecovery}>重新读取恢复标识</Button>}{pending && !busy && <Button onClick={() => void recover()}>核对原请求结果</Button>}</>}>
      <fieldset disabled={busy || blocked} className="space-y-4"><label className="block text-sm">类型<select className="input mt-2 w-full" value={form.kind} onChange={e => setForm(value => ({ ...value, kind: e.target.value as Form['kind'] }))}>{knowledgeKinds.map(value => <option key={value}>{value}</option>)}</select></label><label className="block text-sm">标题<input className="input mt-2 w-full" maxLength={120} value={form.title} onChange={e => setForm(value => ({ ...value, title: e.target.value }))} /></label><label className="block text-sm">摘要<textarea className="textarea mt-2 min-h-28 w-full" maxLength={500} value={form.summary} onChange={e => setForm(value => ({ ...value, summary: e.target.value }))} /></label><label className="block text-sm">文档或新闻链接<input className="input mt-2 w-full" placeholder="https:// 开头；留空为站内原创" value={form.link} onChange={e => setForm(value => ({ ...value, link: e.target.value }))} /></label>
      <label className="block text-sm">关联已授权文件<select className="input mt-2 w-full" value={form.fileId ?? ''} onChange={e => { const file = options?.files.find(item => item.id === e.target.value); setForm(value => ({ ...value, fileId: file?.id ?? null, fileVersion: file?.version ?? null })) }}><option value="">不关联文件</option>{form.fileId && !options?.files.some(file => file.id === form.fileId) && <option value={form.fileId}>原关联文件权限已变化，请重新核对</option>}{options?.files.map(file => <option value={file.id} key={file.id}>{file.name} · V{file.version}</option>)}</select></label>
      <fieldset disabled={!editor?.audience} className="space-y-3 rounded-xl border border-[#dfe6e4] p-3"><legend className="px-1 text-sm">可见范围与协作编辑</legend><label className="block text-sm">分享范围<select className="input mt-2 w-full" value={form.audience} onChange={e => setForm(value => ({ ...value, audience: e.target.value as Form['audience'] }))}><option value="selected">仅作者与指定人员</option><option value="company">公司业务成员（不含仅系统管理职责）</option></select></label><div className="max-h-56 overflow-auto"><table className="w-full text-xs"><thead><tr><th className="py-2 text-left">人员</th><th>可查看</th><th>可编辑</th></tr></thead><tbody>{options?.people.map(person => <tr key={person.id}><td className="py-2">{person.name}<span className="ml-2 text-slate-400">{person.department}</span></td><td className="text-center"><input type="checkbox" aria-label={`${person.name}可查看`} checked={form.readerIds.includes(person.id) || form.editorIds.includes(person.id)} onChange={() => toggle('readerIds', person.id)} disabled={form.editorIds.includes(person.id)} /></td><td className="text-center"><input type="checkbox" aria-label={`${person.name}可编辑`} checked={form.editorIds.includes(person.id)} onChange={() => toggle('editorIds', person.id)} /></td></tr>)}</tbody></table></div></fieldset><p className="text-xs leading-6 text-slate-500">仅能关联本人有下载权的真实文件版本。分享及编辑授权不增加原文件权限；保存草稿后须明确发布。评分采用 FDE 的 2—5 分选项，同一账号只保留一个有效评分。</p></fieldset>
    </Modal>
  </div>
}
