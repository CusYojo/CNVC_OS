import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Download, FileText, Grid2X2, List, RefreshCw, Search, ShieldCheck, Upload } from 'lucide-react'
import { apiGet, apiErrorFromResponse } from '../lib/api'
import { authedFetch, useAuthStore } from '../store/useAuthStore'
import { Button, Card, Drawer } from './ui'
import { useToast } from './Toast'
import { archiveQuery, type ArchiveAudit, type ArchiveDetail, type ArchiveFile, type ArchiveList } from '../../server/src/contracts/fdeArchiveContract'
import type { DataKnowledgeCapabilities } from '../../server/src/contracts/fdeDataKnowledgeContract'
import './fde-workspace.css'

const when = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const size = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
const eventNames: Record<string, string> = { permissions: '调整权限', trash: '移入回收站', restore: '恢复文件', 'material-view': '材料送审查看授权' }
type Tools = 'upload' | 'input' | 'meetings'
function Pager({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (page: number) => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-xs text-slate-500"><span>共 {total} 项 · 第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页</span><div className="flex gap-2"><Button variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</Button><Button variant="secondary" disabled={page * pageSize >= total} onClick={() => onChange(page + 1)}>下一页</Button></div></div>
}

export function FdeProjectArchivePanel(props: { onOpenTools: (tool: Tools) => void; capabilities: DataKnowledgeCapabilities }) {
  const userId = useAuthStore(state => state.user?.id ?? '')
  return <ArchiveWorkspace key={userId} userId={userId} {...props} />
}

function ArchiveWorkspace({ userId, onOpenTools, capabilities }: { userId: string; onOpenTools: (tool: Tools) => void; capabilities: DataKnowledgeCapabilities }) {
  const [params, setParams] = useSearchParams(), location = useLocation(), navigate = useNavigate(), { showToast } = useToast()
  const [keyword, setKeyword] = useState(params.get('archiveQ') ?? ''), [refresh, setRefresh] = useState(0)
  const [list, setList] = useState<ArchiveList | null>(null), [error, setError] = useState('')
  const [detail, setDetail] = useState<ArchiveDetail | null>(null), [detailError, setDetailError] = useState(''), [versionPage, setVersionPage] = useState(1)
  const [audit, setAudit] = useState<{ kind: 'access' | 'permissions'; fileId?: string; page: number } | null>(null), [auditData, setAuditData] = useState<ArchiveAudit | null>(null), [auditError, setAuditError] = useState('')
  const [busy, setBusy] = useState(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = () => mounted.current && useAuthStore.getState().user?.id === userId
  const parsed = archiveQuery.safeParse({ keyword: params.get('archiveQ') ?? '', projectId: params.get('archiveProject') || undefined, category: params.get('archiveCategory') ?? '', type: params.get('archiveType') ?? '', page: params.get('archivePage') ?? 1 })
  const query = parsed.success ? parsed.data : null
  const queryString = query ? new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])).toString() : ''
  const selected = params.get('file'), grid = params.get('archiveLayout') === 'grid'
  const update = (values: Record<string, string | null>, resetPage = false) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key)
    if (resetPage) { next.delete('archivePage'); next.delete('file'); setAudit(null) }
    setParams(next)
  }
  useEffect(() => { setKeyword(params.get('archiveQ') ?? '') }, [params.get('archiveQ')])
  useEffect(() => { const focus = () => setRefresh(value => value + 1); window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus) }, [])
  useEffect(() => {
    let active = true; setList(null); setError('')
    if (!queryString) { setError('筛选参数无效，请重置筛选'); return }
    void apiGet<ArchiveList>(`/project-archives?${queryString}`).then(value => { if (active && current()) setList(value) }).catch(cause => { if (active && current()) { setError((cause as Error).message); setDetail(null) } })
    return () => { active = false }
  }, [queryString, refresh, userId])
  useEffect(() => { setVersionPage(1) }, [selected])
  useEffect(() => {
    let active = true; setDetail(null); setDetailError('')
    if (selected) void apiGet<ArchiveDetail>(`/project-archives/${encodeURIComponent(selected)}?page=${versionPage}`).then(value => { if (active && current()) setDetail(value) }).catch(cause => { if (active && current()) setDetailError((cause as Error).message) })
    return () => { active = false }
  }, [selected, versionPage, refresh, userId])
  useEffect(() => {
    let active = true; setAuditData(null); setAuditError('')
    if (audit && queryString) {
      const search = new URLSearchParams(queryString); search.set('kind', audit.kind); search.set('page', String(audit.page)); if (audit.fileId) search.set('fileId', audit.fileId)
      void apiGet<ArchiveAudit>(`/project-archives/audit?${search}`).then(value => { if (active && current()) setAuditData(value) }).catch(cause => { if (active && current()) setAuditError((cause as Error).message) })
    }
    return () => { active = false }
  }, [audit, queryString, refresh, userId])

  const saveBlob = (blob: Blob, name: string) => { const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) }
  const download = async (file?: ArchiveFile, version?: number) => {
    if (!query || busy) return
    setBusy(true)
    try {
      const response = await authedFetch(file ? `/api/projects/files/${file.id}/${version ? `versions/${version}/download` : 'download'}` : '/api/project-archives/export', file ? {} : { method: 'POST', body: JSON.stringify(query) })
      if (!response.ok) throw apiErrorFromResponse(response.status, await response.json().catch(() => ({})), response.headers.get('x-request-id'))
      if (!file && !response.headers.get('content-type')?.includes('text/csv')) throw new Error('服务未返回有效 CSV 清单，请刷新后重试')
      const blob = await response.blob()
      if (!current()) return
      saveBlob(blob, file ? file.name : '项目档案可下载清单.csv')
      showToast(file ? '已取得原件并发起浏览器下载' : `已生成 ${response.headers.get('X-Archive-File-Count') ?? '—'} 项清单（非原件打包）`)
      setRefresh(value => value + 1)
    } catch (cause) { if (current()) { showToast((cause as Error).message, 'error'); setRefresh(value => value + 1) } }
    finally { if (current()) setBusy(false) }
  }
  const open = (file: ArchiveFile) => update({ file: file.id })
  const reset = () => { const next = new URLSearchParams({ view: 'archives' }); setParams(next); setKeyword(''); setAudit(null) }
  const projectLink = (file: ArchiveFile) => `/projects/${file.projectId}?${new URLSearchParams({ tab: 'files', file: file.id, archiveReturn: location.pathname + location.search })}`

  return <div className="fde-archive-page">
    <Card className="fde-panel fde-archive-library">
      <div className="fde-card-head"><div><h2>全公司项目档案</h2><p>按当前项目与文件权限查阅云端记录。</p></div><Button variant="secondary" disabled={!list || busy} onClick={() => void download()}>{busy ? '正在准备下载…' : '导出可下载清单'}</Button></div>
      {error ? <div className="fde-knowledge-state"><p role="alert">{error}</p><Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>重新读取</Button></div> : !list ? <p role="status" className="fde-knowledge-state">正在读取有权项目档案…</p> : <>
        {!list.list.length ? <div className="fde-knowledge-state"><strong>当前角色没有可检索的项目文件</strong><small>请核对筛选；管理员和时间协调人默认不读取商业资料。</small></div> : grid ? <div className="fde-knowledge-grid">{list.list.map(file => <article className="fde-knowledge-card" key={file.id}><span className="fde-archive-type">{file.type}</span><h3>{file.name}</h3><p>{file.projectName} · {file.category}</p><div className="fde-knowledge-stats"><span>{file.uploader} · {size(file.byteSize)} · V{file.version}</span></div><div className="fde-knowledge-actions"><Button size="sm" variant="secondary" onClick={() => open(file)}>详情</Button><span className="fde-archive-permission" data-download={file.canDownload}>{file.canDownload ? '可查看与下载' : '仅可查看'}</span></div></article>)}</div> : <div className="fde-knowledge-table-scroll"><table className="fde-knowledge-table"><thead><tr>{['文件', '项目', '分类', '上传人', '权限', '操作'].map(title => <th key={title}>{title}</th>)}</tr></thead><tbody>{list.list.map(file => <tr key={file.id}>
          <td><strong>{file.name}</strong><br /><small>{file.type} · {size(file.byteSize)} · V{file.version}</small></td><td>{file.projectName}</td><td>{file.category}</td><td>{file.uploader}</td><td><span className="fde-archive-permission" data-download={file.canDownload}>{file.canDownload ? '可查看与下载' : '仅可查看'}</span></td><td><Button size="sm" variant="secondary" onClick={() => open(file)}>详情</Button></td>
        </tr>)}</tbody></table></div>}
        {(list.total > list.pageSize || list.page > 1) && <Pager {...list} onChange={page => update({ archivePage: String(page) })} />}
      </>}
    </Card>
    <details className="fde-knowledge-tools">
      <summary>档案筛选与工具{query?.keyword || query?.projectId || query?.category || query?.type ? ' · 已应用筛选' : ''}</summary>
      <div className="fde-knowledge-tool-body"><form onSubmit={event => { event.preventDefault(); update({ archiveQ: keyword.trim() }, true) }}>
        <input aria-label="搜索项目档案" placeholder="搜索文件名称、项目或上传人" maxLength={100} className="input" value={keyword} onChange={event => setKeyword(event.target.value)} />
        <select aria-label="档案项目" className="input" value={query?.projectId ?? ''} onChange={event => update({ archiveProject: event.target.value }, true)}><option value="">全部项目</option>{list?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <select aria-label="档案分类" className="input" value={query?.category ?? ''} onChange={event => update({ archiveCategory: event.target.value }, true)}><option value="">全部档案</option>{list?.categories.map(category => <option key={category.name} value={category.name}>{category.name || '未分类'} · {category.count}</option>)}</select>
        <select aria-label="档案文件类型" className="input" value={query?.type ?? ''} onChange={event => update({ archiveType: event.target.value }, true)}><option value="">全部文件类型</option>{list?.types.map(type => <option key={type}>{type}</option>)}</select>
        <Button type="submit" variant="secondary"><Search className="h-4 w-4" />搜索</Button><Button type="button" variant="secondary" onClick={reset}>重置</Button>
      </form><div className="fde-knowledge-tool-actions">
        <Button variant="secondary" disabled={!list?.canAudit} onClick={() => setAudit({ kind: 'permissions', page: 1 })}><ShieldCheck className="h-4 w-4" />权限审计</Button>
        <Button variant="secondary" onClick={() => setRefresh(value => value + 1)}><RefreshCw className="h-4 w-4" />刷新</Button>
        <Button variant="secondary" aria-label="档案列表视图" aria-pressed={!grid} onClick={() => update({ archiveLayout: 'list' })}><List className="h-4 w-4" />列表</Button>
        <Button variant="secondary" aria-label="档案网格视图" aria-pressed={grid} onClick={() => update({ archiveLayout: 'grid' })}><Grid2X2 className="h-4 w-4" />网格</Button>
        {capabilities.input && <Button variant="secondary" onClick={() => onOpenTools('input')}>知识输入</Button>}
        {capabilities.meetings && <Button variant="secondary" onClick={() => onOpenTools('meetings')}>会议纪要</Button>}
        {capabilities.upload && <Button onClick={() => onOpenTools('upload')}><Upload className="h-4 w-4" />上传文件</Button>}
      </div><p>清单包含完整筛选内具备下载权的文件，不限当前页；原件仍按当前权限读取。</p></div>
    </details>
    <Drawer open={Boolean(selected)} title="档案详情" width="w-[680px]" onClose={() => update({ file: null })}>
      {detailError ? <p role="alert" className="text-sm text-rose-600">{detailError}</p> : !detail ? <p>正在重新核验文件权限…</p> : <div className="space-y-5"><div><FileText className="mb-3 h-8 w-8 text-[#315f68]" /><h3 className="break-words text-lg font-semibold">{detail.file.name}</h3><p className="mt-2 text-sm text-slate-500">{detail.file.projectName} · {detail.file.category}</p><p className="mt-1 text-xs text-slate-400">{detail.file.uploader} · {when(detail.file.uploadedAt)}</p></div><div className="rounded-lg bg-slate-50 p-4 text-sm leading-7"><p>{size(detail.file.byteSize)} · 内容 V{detail.file.version} · 权限 V{detail.file.accessVersion}</p><p>解析状态：{detail.file.parseStatus}</p><p>{detail.file.hasOriginal ? '原件已登记，实际读取时校验' : '原件未登记，请到项目工作区补传'}</p><p>{detail.file.canDownload ? '当前可查看与下载' : '当前仅可查看，不具有下载权'}</p></div><div className="flex flex-wrap gap-2">{detail.file.hasOriginal && <a className="rounded-lg border border-slate-200 px-3 py-2 text-sm" target="_blank" rel="noopener noreferrer" href={`/api/projects/files/${detail.file.id}/preview`}>预览原件</a>}<Button disabled={!detail.file.canDownload || !detail.file.hasOriginal || busy} onClick={() => void download(detail.file)}><Download className="h-4 w-4" />下载原件</Button><Button variant="secondary" onClick={() => navigate(projectLink(detail.file))}>进入项目文件工作区</Button>{detail.file.canAudit && <Button variant="secondary" onClick={() => { setAudit({ kind: 'access', fileId: detail.file.id, page: 1 }); update({ file: null }) }}>文件审计</Button>}</div><p className="text-xs text-slate-400">预览在新窗口打开；不支持在线预览的格式会明确提示。权限调整、替换及回收继续在原项目工作区办理。</p><h4 className="font-semibold">不可变原件版本</h4>{detail.versions.map(version => <div key={version.version} className="flex items-center justify-between gap-2 border-b border-slate-100 py-3 text-sm"><span>V{version.version} · {size(version.byteSize)}<small className="mt-1 block text-slate-400">{when(version.createdAt)}</small></span><Button variant="secondary" disabled={!detail.file.canDownload || busy} onClick={() => void download(detail.file, version.version)}>下载 V{version.version}</Button></div>)}{!detail.total && <p className="text-sm text-slate-400">暂无已登记的历史原件版本</p>}<Pager {...detail} onChange={setVersionPage} /></div>}
    </Drawer>
    <Drawer open={Boolean(audit)} title="项目档案权限审计" width="w-[860px]" onClose={() => setAudit(null)}>
      <div className="mb-4 flex gap-2"><Button variant={audit?.kind === 'permissions' ? 'primary' : 'secondary'} onClick={() => setAudit(value => value && ({ ...value, kind: 'permissions', page: 1 }))}>权限与状态</Button><Button variant={audit?.kind === 'access' ? 'primary' : 'secondary'} onClick={() => setAudit(value => value && ({ ...value, kind: 'access', page: 1 }))}>原件访问记录</Button></div>
      {auditError ? <p role="alert" className="text-sm text-rose-600">{auditError}</p> : !auditData ? <p>正在读取有权审计…</p> : <><p className="mb-4 text-xs leading-6 text-slate-500">{auditData.coverage}</p>{auditData.list.map(row => <article key={row.id} className="border-b border-slate-100 py-4 text-sm"><p className="font-medium">{row.fileName} · {eventNames[row.action] ?? row.action}</p><p className="mt-1 text-xs text-slate-500">{row.projectName} · {row.actorName} · V{row.version} · {when(row.createdAt)}</p><p className="mt-1 text-xs text-slate-400">{row.result === 'success' ? '服务端已记录' : row.result}{row.reason ? ` · ${row.reason}` : ''}</p></article>)}{!auditData.list.length && <p className="py-8 text-sm text-slate-500">当前筛选下暂无可查阅的审计记录</p>}<Pager {...auditData} onChange={page => setAudit(value => value && ({ ...value, page }))} /></>}
    </Drawer>
  </div>
}
