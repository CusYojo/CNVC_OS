import { useEffect, useRef, useState } from 'react'
import { ArchiveRestore, Download, FileText, RefreshCw, Search, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { ApiError, apiErrorFromResponse, apiGet, apiPost } from '../lib/api'
import { authedFetch } from '../store/useAuthStore'
import { Button, Card, Drawer, Modal, StatusBadge } from './ui'
import { useToast } from './Toast'
import { FdeMaterialPanel } from './FdeMaterialPanel'
import type { ProjectFile } from '../types'
import './fde-workspace.css'

type FileItem = ProjectFile & { byteSize: number; sha256: string | null; accessVersion: number; accessMode: string; lifecycle: string; deletedAt: string | null; deleteReason: string | null; retentionUntil: string | null }
type Grant = { userId: string; canView: boolean; canDownload: boolean }
type Detail = { file: FileItem; capabilities: { view: boolean; download: boolean; manage: boolean; replace: boolean; trash: boolean; restore: boolean }; blockers: string[]; people: Array<{ id: string; name: string; owner: boolean; secretary: boolean; leader: boolean }>; grants: Grant[]; events: Array<{ id: string; action: string; version: number; actorName: string; reason: string; createdAt: string }>; historyTotal: number; page: number; pageSize: number }
type FileList = { list: FileItem[]; total: number; canUpload: boolean; page: number; pageSize: number }
type Revision = { version: number; byteSize: number; sha256: string | null; createdAt: string }
const when = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
const bytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`
const eventNames: Record<string, string> = { permissions: '调整权限', trash: '移入回收站', restore: '恢复文件', 'material-view': '送审查看授权' }

export function FdeFilePanel({ projectId, refreshKey, initialFileId, onUpload, onReplace, onChanged }: { projectId: string; refreshKey: string; initialFileId?: string | null; onUpload: () => void; onReplace: (file: ProjectFile) => void; onChanged: () => void | Promise<void> }) {
  const { showToast } = useToast()
  const [view, setView] = useState('active'), [keyword, setKeyword] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0)
  const [list, setList] = useState<FileList | null>(null), [error, setError] = useState(''), [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null), [detailError, setDetailError] = useState('')
  const [versions, setVersions] = useState<Revision[]>([]), [versionError, setVersionError] = useState('')
  const [action, setAction] = useState<'permissions' | 'trash' | 'restore' | null>(null), [reason, setReason] = useState(''), [grants, setGrants] = useState<Grant[]>([]), [requestId, setRequestId] = useState(''), [busy, setBusy] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    let cancelled = false
    setList(null); setError('')
    void apiGet<FileList>(`/projects/${projectId}/file-workspace?${new URLSearchParams({ view, keyword: search, page: String(page), pageSize: '20' })}`).then(value => { if (!cancelled) setList(value) }).catch(cause => { if (!cancelled) { setError((cause as Error).message); setDetail(null); setSelected(null) } })
    return () => { cancelled = true }
  }, [projectId, view, search, page, refresh, refreshKey])
  useEffect(() => { generation.current++; setSelected(null); setDetail(null); setAction(null); setPage(1); return () => { generation.current++ } }, [projectId])
  const load = async (id: string, historyPage = 1) => {
    const current = ++generation.current
    try {
      const value = await apiGet<Detail>(`/projects/files/${id}/workspace?page=${historyPage}`)
      if (current !== generation.current) return
      if (value.file.projectId !== projectId) throw new Error('该文件不属于当前项目，请从项目档案重新选择')
      setDetail(value); setDetailError(''); setVersions([]); setVersionError('')
      if (value.capabilities.view) {
        try { const result = await apiGet<{ list: Revision[] }>(`/projects/files/${id}/versions`); if (current === generation.current) setVersions(result.list) }
        catch (cause) { if (current === generation.current) setVersionError((cause as Error).message) }
      }
    } catch (cause) { if (current === generation.current) { setDetail(null); setDetailError((cause as Error).message) }; throw cause }
  }
  const open = (id: string) => { setSelected(id); setDetail(null); setDetailError(''); setAction(null); void load(id).catch(() => {}) }
  useEffect(() => { if (initialFileId) open(initialFileId) }, [projectId, initialFileId])
  useEffect(() => { if (selected) { setAction(null); void load(selected).catch(() => {}) } }, [refreshKey])
  const close = () => { if (!busy) { generation.current++; setSelected(null); setDetail(null); setAction(null) } }
  const chooseAction = (value: NonNullable<typeof action>) => { if (!detail) return; setAction(value); setReason(''); setGrants(detail.grants.map(item => ({ ...item }))); setRequestId(crypto.randomUUID()) }
  const changeGrant = (userId: string, field: 'canView' | 'canDownload', checked: boolean) => {
    setGrants(previous => {
      const next = previous.map(item => ({ ...item })), existing = next.find(item => item.userId === userId) ?? { userId, canView: false, canDownload: false }
      if (!next.some(item => item.userId === userId)) next.push(existing)
      existing[field] = checked
      if (field === 'canDownload' && checked) existing.canView = true
      if (field === 'canView' && !checked) existing.canDownload = false
      return next
    }); setRequestId(crypto.randomUUID())
  }
  const submit = async () => {
    if (!detail || !action || busy) return
    setBusy(true)
    try {
      const input = { clientRequestId: requestId, expectedVersion: detail.file.accessVersion, reason }
      await apiPost(`/projects/files/${detail.file.id}/${action === 'permissions' ? 'permissions' : 'lifecycle'}`, action === 'permissions' ? { ...input, grants } : { ...input, action })
      setAction(null); setRefresh(value => value + 1); await load(detail.file.id); await onChanged()
      showToast(action === 'permissions' ? '文件权限已保存' : action === 'trash' ? '文件已移入回收站，原字节与历史版本保留' : '原文件及历史版本已校验并恢复')
    } catch (cause) {
      showToast((cause as Error).message, 'error')
      if (cause instanceof ApiError && ['VERSION_CONFLICT', 'FILE_REQUEST_REUSED'].includes(cause.code)) { setAction(null); await load(detail.file.id).catch(() => {}) }
      if (cause instanceof ApiError && [403, 404].includes(cause.status)) { setAction(null); setDetail(null); setDetailError(cause.message); setRefresh(value => value + 1) }
    } finally { setBusy(false) }
  }
  const download = async (version?: number) => {
    if (!detail || busy) return
    setBusy(true)
    try {
      const response = await authedFetch(`/api/projects/files/${detail.file.id}/${version ? `versions/${version}/download` : 'download'}`)
      if (!response.ok) throw apiErrorFromResponse(response.status, await response.json().catch(() => null), response.headers.get('x-request-id'))
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a')
      link.href = url; link.download = detail.file.name; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) { showToast((cause as Error).message, 'error'); await load(detail.file.id).catch(() => {}) }
    finally { setBusy(false) }
  }
  const pages = Math.max(1, Math.ceil((list?.total ?? 0) / 20))
  return <div className="fde-workspace">
    <Card className="fde-panel overflow-hidden">
      <div className="fde-detail-file-head flex flex-wrap items-center justify-between gap-3 border-b border-[#dfe6e4] p-5"><h2 className="font-semibold">项目文件</h2><div className="flex gap-2"><Button variant="secondary" onClick={() => setRefresh(value => value + 1)}><RefreshCw className="h-4 w-4" />刷新文件</Button>{list?.canUpload && view === 'active' && <Button onClick={onUpload}><Upload className="h-4 w-4" />上传资料</Button>}</div></div>
      <div className="flex flex-wrap items-center gap-3 p-5"><label><span className="sr-only">文件状态</span><select className="input" value={view} onChange={event => { setView(event.target.value); setPage(1) }}><option value="active">有效文件</option><option value="deleted">回收站</option></select></label><form className="flex flex-1 gap-2" onSubmit={event => { event.preventDefault(); setSearch(keyword); setPage(1) }}><input className="input min-w-0 flex-1" aria-label="搜索文件" placeholder="搜索有权访问的文件名称" maxLength={100} value={keyword} onChange={event => setKeyword(event.target.value)} /><Button variant="secondary" type="submit"><Search className="h-4 w-4" />搜索</Button></form></div>
      {error ? <p role="alert" className="p-5 text-sm text-red-600">文件加载失败：{error}</p> : !list ? <p className="p-5 text-sm text-slate-500">正在读取有权访问的文件…</p> : <>
        <div className="fde-detail-file-grid">{list.list.map(file => <article className="fde-detail-file-card" key={file.id}><button onClick={() => open(file.id)}><span className="fde-detail-file-icon">{file.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'}</span><span><strong>{file.name}</strong><small>{file.category}</small><small>{bytes(file.byteSize)} · {file.uploader}</small></span></button><footer><StatusBadge status={file.parseStatus} /><button onClick={() => open(file.id)}>{view === 'deleted' ? '查看回收详情' : '查看详情'} →</button></footer></article>)}</div>
        {!list.list.length && <p className="p-8 text-center text-sm text-slate-500">{view === 'deleted' ? '没有可管理的回收文件' : '没有符合条件的文件；仅显示当前有查看权的资料。'}</p>}
        <div className="flex items-center justify-between gap-2 border-t border-[#dfe6e4] p-4 text-xs text-slate-500"><span>共 {list.total} 个文件 · 第 {page}/{pages} 页</span><div className="flex gap-2"><Button variant="secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><Button variant="secondary" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>
      </>}
    </Card>
    <FdeMaterialPanel projectId={projectId} onChanged={() => { setRefresh(value => value + 1); if (selected) void load(selected).catch(() => {}) }} />
    <Drawer open={Boolean(selected)} title="文件详情" onClose={close} width="w-full sm:w-[620px]" footer={<div className="flex flex-wrap gap-2">{detail?.capabilities.trash && <Button variant="secondary" disabled={busy || detail.blockers.length > 0} onClick={() => chooseAction('trash')}><Trash2 className="h-4 w-4" />移入回收站</Button>}{detail?.capabilities.restore && <Button variant="secondary" disabled={busy} onClick={() => chooseAction('restore')}><ArchiveRestore className="h-4 w-4" />恢复文件</Button>}{detail?.capabilities.manage && detail.file.lifecycle === 'active' && <Button variant="secondary" disabled={busy} onClick={() => chooseAction('permissions')}><ShieldCheck className="h-4 w-4" />设置权限</Button>}<Button disabled={busy} onClick={close}>完成</Button></div>}>
      {detailError ? <p role="alert" className="text-sm text-red-600">{detailError}</p> : !detail ? <p className="text-sm text-slate-500">正在读取文件详情…</p> : <div className="space-y-5" role="region" aria-label="文件详情内容">
        <section className="rounded-xl border border-[#dfe6e4] p-4"><h3 className="break-all font-semibold">{detail.file.name}</h3><dl className="mt-4 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-slate-400">分类</dt><dd>{detail.file.category}</dd></div><div><dt className="text-xs text-slate-400">上传人</dt><dd>{detail.file.uploader}</dd></div><div><dt className="text-xs text-slate-400">文件状态</dt><dd>{detail.file.lifecycle === 'active' ? '有效文件' : '已移入回收站'}</dd></div><div><dt className="text-xs text-slate-400">下载权限</dt><dd>{detail.capabilities.download ? '允许下载' : '不可下载'}</dd></div></dl></section>
        <div className="flex flex-wrap gap-2">{detail.capabilities.view && detail.file.hasOriginal && <a className="rounded-lg border border-[#dfe6e4] px-3 py-2 text-sm text-[#315f68]" href={`/api/projects/files/${detail.file.id}/preview`} target="_blank" rel="noopener noreferrer">在新窗口预览</a>}{detail.capabilities.download && <Button disabled={busy || !detail.file.hasOriginal} onClick={() => { void download() }}><Download className="h-4 w-4" />下载原文件</Button>}{detail.capabilities.replace && <Button variant="secondary" disabled={busy} onClick={() => onReplace(detail.file)}><Upload className="h-4 w-4" />{detail.file.hasOriginal ? '替换原文件' : '补传原文件'}</Button>}</div>
        {detail.blockers.length > 0 && <section className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800"><h3 className="font-medium">当前不能删除</h3><ul className="mt-2 list-inside list-disc">{detail.blockers.map(item => <li key={item}>{item}</li>)}</ul></section>}
        {detail.file.lifecycle === 'deleted' && <section className="rounded-lg bg-slate-50 p-3 text-sm"><p>回收原因：{detail.file.deleteReason}</p><p className="mt-2">保留截止：{when(detail.file.retentionUntil)}</p></section>}
        {detail.capabilities.view && <details><summary className="cursor-pointer font-semibold">文件信息与历史版本</summary>{versionError ? <p role="alert" className="mt-2 text-sm text-red-600">{versionError}</p> : <ul className="mt-3 space-y-2">{versions.map(item => <li key={item.version} className="flex items-center justify-between gap-3 rounded-lg border border-[#dfe6e4] p-3 text-xs"><span>版本 {item.version} · {bytes(item.byteSize)}<br />{when(item.createdAt)}</span>{detail.capabilities.download && <button className="text-[#315f68]" disabled={busy} onClick={() => { void download(item.version) }}>下载此版本</button>}</li>)}</ul>}</details>}
        <details><summary className="cursor-pointer font-semibold">权限与操作记录</summary><ol className="mt-3 space-y-3">{detail.events.map(event => <li key={event.id} className="border-l-2 border-[#dfe6e4] pl-3 text-sm"><p>{event.actorName} · {eventNames[event.action] ?? event.action}</p><p className="mt-1 whitespace-pre-wrap text-slate-500">{event.reason}</p><p className="mt-1 text-xs text-slate-400">{when(event.createdAt)}</p></li>)}</ol>{!detail.events.length && <p className="mt-2 text-sm text-slate-400">暂无权限或操作记录</p>}<div className="mt-3 flex items-center justify-between gap-2 text-xs text-slate-500"><span>共 {detail.historyTotal} 条操作记录</span><div className="flex gap-2"><button disabled={detail.page <= 1 || busy} onClick={() => { void load(detail.file.id, detail.page - 1).catch(() => {}) }}>上一页</button><button disabled={detail.page * detail.pageSize >= detail.historyTotal || busy} onClick={() => { void load(detail.file.id, detail.page + 1).catch(() => {}) }}>下一页</button></div></div></details>
      </div>}
    </Drawer>
    <Modal open={Boolean(action && detail)} title={action === 'permissions' ? '设置文件权限' : action === 'trash' ? '移入回收站' : '恢复文件'} onClose={() => { if (!busy) setAction(null) }} width="max-w-2xl" footer={<><Button variant="secondary" disabled={busy} onClick={() => setAction(null)}>取消</Button><Button loading={busy} disabled={reason.trim().length < 5} onClick={() => { void submit() }}>确认{action === 'permissions' ? '保存权限' : action === 'trash' ? '回收' : '恢复'}</Button></>}>
      {detail && <div className="space-y-4"><p className="break-all text-sm font-medium">{detail.file.name}</p>{action === 'permissions' ? <><p className="text-xs leading-5 text-slate-500">下载权限同时包含查看权限。</p><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-2">项目人员</th><th className="p-2">查看</th><th className="p-2">下载</th></tr></thead><tbody>{detail.people.map(person => { const grant = grants.find(item => item.userId === person.id); return <tr key={person.id} className="border-b border-slate-100"><td className="p-2">{person.name}<span className="ml-2 text-xs text-slate-400">{person.owner ? '负责人' : person.secretary ? '秘书' : person.leader ? '领导' : '项目人员'}</span></td><td className="p-2"><input aria-label={`${person.name}查看权`} type="checkbox" disabled={busy} checked={Boolean(grant?.canView)} onChange={event => changeGrant(person.id, 'canView', event.target.checked)} /></td><td className="p-2"><input aria-label={`${person.name}下载权`} type="checkbox" disabled={!grant} checked={Boolean(grant?.canDownload)} onChange={event => changeGrant(person.id, 'canDownload', event.target.checked)} /></td></tr> })}</tbody></table></div></> : <p className="text-sm text-slate-500">{action === 'trash' ? '文件将移入回收站。' : '文件将恢复到项目文件列表。'}</p>}<label className="block"><span className="label">操作原因（至少 5 字）</span><textarea className="textarea min-h-24" maxLength={600} disabled={busy} value={reason} onChange={event => { setReason(event.target.value); setRequestId(crypto.randomUUID()) }} /></label></div>}
    </Modal>
  </div>
}
