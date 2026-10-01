import { Bot, BookOpenText, Clipboard, Download, FileText, Plus, Search, Trash2, Upload, X } from 'lucide-react'
import React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'
import { readPromptMarkdownFile } from '../lib/promptLibrary'

type Kind = 'skill' | 'agent'
type Visibility = 'private' | 'organization'
type PromptItem = {
  id: string
  kind: Kind
  name: string
  description: string
  markdown: string
  fileName: string | null
  sourceUrl: string | null
  license: string | null
  ownerUserId: string
  visibility: Visibility
  version: number
  source: 'builtin' | 'user'
  editable: boolean
  updatedAt: string | null
}
type PromptSummary = Omit<PromptItem, 'markdown'>
type Draft = { name: string; description: string; markdown: string; fileName: string; visibility: Visibility }
const emptyDraft = (): Draft => ({ name: '', description: '', markdown: '', fileName: '', visibility: 'private' })
const libraryRoot = '/ai/prompt-library'

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

export function PromptLibraryPage({ kind }: { kind: Kind }) {
  const label = kind === 'skill' ? 'Skill' : 'Agent'
  const Icon = kind === 'skill' ? BookOpenText : Bot
  const [items, setItems] = useState<PromptSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [selected, setSelected] = useState<PromptItem | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<'create' | 'edit' | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)

  const refresh = useCallback(async (preferredId?: string) => {
    setLoading(true)
    try {
      const result = await apiGet<{ list: PromptSummary[] }>(`${libraryRoot}?kind=${kind}`)
      setItems(result.list)
      setSelectedId(current => {
        if (preferredId && result.list.some(item => item.id === preferredId)) return preferredId
        return result.list.some(item => item.id === current) ? current : result.list[0]?.id ?? ''
      })
      setError('')
    } catch (cause) {
      setError(`读取${label}库失败：${errorMessage(cause)}`)
    } finally {
      setLoading(false)
    }
  }, [kind, label])

  useEffect(() => {
    setItems([])
    setSelected(null)
    setSelectedId('')
    setMode(null)
    setSearch('')
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!selectedId) { setSelected(null); return }
    let active = true
    setDetailLoading(true)
    void apiGet<PromptItem>(`${libraryRoot}/${encodeURIComponent(selectedId)}`)
      .then(item => { if (active) { setSelected(item); setError('') } })
      .catch(cause => { if (active) { setSelected(null); setError(`读取提示词失败：${errorMessage(cause)}`) } })
      .finally(() => { if (active) setDetailLoading(false) })
    return () => { active = false }
  }, [selectedId])

  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return query ? items.filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(query)) : items
  }, [items, search])

  function startCreate() {
    setDraft(emptyDraft())
    setMode('create')
    setError('')
    setNotice('')
  }

  function startEdit() {
    if (!selected?.editable) return
    setDraft({
      name: selected.name, description: selected.description, markdown: selected.markdown,
      fileName: selected.fileName ?? '', visibility: selected.visibility,
    })
    setMode('edit')
    setError('')
    setNotice('')
  }

  async function handleFile(file?: File) {
    if (!file) return
    try {
      const imported = await readPromptMarkdownFile(file)
      setDraft(current => ({ ...current, name: current.name || imported.name, markdown: imported.markdown, fileName: imported.fileName }))
      setError('')
      setNotice('Markdown 已载入，请检查后保存。')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function save() {
    if (!draft.name.trim() || !draft.markdown.trim()) {
      setError('请填写名称和 Markdown 提示词正文。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const payload = {
        name: draft.name, description: draft.description, markdown: draft.markdown,
        ...(draft.fileName ? { fileName: draft.fileName } : {}), visibility: draft.visibility,
      }
      const saved = mode === 'edit' && selected
        ? await apiPatch<PromptItem>(`${libraryRoot}/${encodeURIComponent(selected.id)}`, { ...payload, expectedVersion: selected.version })
        : await apiPost<PromptItem>(libraryRoot, { kind, ...payload })
      setMode(null)
      setNotice(`${label} 已保存。`)
      await refresh(saved.id)
      setSelected(saved)
    } catch (cause) {
      setError(`保存失败：${errorMessage(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!selected?.editable || !window.confirm(`确定删除“${selected.name}”吗？`)) return
    setBusy(true)
    setError('')
    try {
      await apiDelete(`${libraryRoot}/${encodeURIComponent(selected.id)}`, { expectedVersion: selected.version })
      setSelected(null)
      setNotice(`${label} 已删除。`)
      await refresh()
    } catch (cause) {
      setError(`删除失败：${errorMessage(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  async function copyPrompt() {
    if (!selected) return
    try {
      await navigator.clipboard.writeText(selected.markdown)
      setNotice('提示词已复制到剪贴板。')
      setError('')
    } catch {
      setError('复制失败，请检查浏览器剪贴板权限。')
    }
  }

  return <main className="space-y-5 pb-10">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700"><Icon className="h-5 w-5" aria-hidden="true" /></span>
        <div><h1 className="text-2xl font-semibold text-slate-900">智能 {label} 库</h1><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">保存可直接复制或下载的 Markdown 提示词。这里的文档不会自动成为平台可执行能力。</p></div>
      </div>
      <button type="button" onClick={startCreate} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"><Plus className="h-4 w-4" aria-hidden="true" />创建 {label}</button>
    </header>

    {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

    <div className="grid gap-4 xl:grid-cols-[minmax(280px,350px)_minmax(0,1fr)]">
      <section aria-label={`${label} 列表`} className="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-4">
          <label htmlFor="prompt-library-search" className="mb-2 block text-sm font-medium text-slate-700">搜索提示词</label>
          <span className="relative block"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden="true" /><input id="prompt-library-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={`搜索 ${label} 名称或说明`} className="w-full rounded-lg border border-slate-200 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" /></span>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-2">
          {loading && <p className="p-4 text-sm text-slate-500">正在加载…</p>}
          {!loading && !visibleItems.length && <p className="p-4 text-sm text-slate-500">{search ? '没有匹配的提示词。' : `暂无 ${label}，可以创建第一个。`}</p>}
          {!loading && visibleItems.map(item => <button key={item.id} type="button" onClick={() => { setSelectedId(item.id); setMode(null); setNotice('') }} aria-pressed={selectedId === item.id} className={`mb-1 w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${selectedId === item.id ? 'border-brand-200 bg-brand-50' : 'border-transparent hover:bg-slate-50'}`}>
            <span className="flex items-start justify-between gap-2"><strong className="line-clamp-1 text-sm text-slate-900">{item.name}</strong><span className="shrink-0 text-xs text-slate-500">{item.source === 'builtin' ? '内置' : item.visibility === 'private' ? '仅自己' : '组织共享'}</span></span>
            <span className="mt-1 line-clamp-2 block text-xs leading-5 text-slate-500">{item.description || '暂无说明'}</span>
          </button>)}
        </div>
      </section>

      <section aria-label={`${label} 内容`} className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        {mode ? <div className="space-y-4">
          <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold text-slate-900">{mode === 'create' ? `创建 ${label}` : `编辑 ${label}`}</h2><button type="button" onClick={() => setMode(null)} aria-label="关闭编辑" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"><X className="h-4 w-4" /></button></div>
          <label className="block text-sm font-medium text-slate-700">名称<input value={draft.name} maxLength={128} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} className="mt-1.5 w-full rounded-lg border border-slate-200 p-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" /></label>
          <label className="block text-sm font-medium text-slate-700">说明<textarea value={draft.description} maxLength={4000} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} rows={2} className="mt-1.5 w-full rounded-lg border border-slate-200 p-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" /></label>
          <label className="block text-sm font-medium text-slate-700">Markdown 提示词<textarea value={draft.markdown} onChange={event => setDraft(current => ({ ...current, markdown: event.target.value }))} rows={16} spellCheck={false} placeholder="粘贴提示词，或上传 .md 文档…" className="mt-1.5 w-full rounded-lg border border-slate-200 p-3 font-mono text-sm leading-6 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" /></label>
          <div className="flex flex-wrap items-end justify-between gap-3"><label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><Upload className="h-4 w-4" aria-hidden="true" />上传 UTF‑8 .md<input type="file" accept=".md,text/markdown" className="sr-only" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void handleFile(file) }} /></label><label className="text-sm font-medium text-slate-700">可见范围<select value={draft.visibility} onChange={event => setDraft(current => ({ ...current, visibility: event.target.value as Visibility }))} className="ml-2 rounded-lg border border-slate-200 p-2 text-sm"><option value="private">仅自己</option><option value="organization">组织共享</option></select></label></div>
          <p className="text-xs leading-5 text-slate-500">单份文档最多 128KB。组织共享后，其他已登录用户可查看、复制和下载；只有作者或管理员可修改。</p>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setMode(null)} className="min-h-11 rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">取消</button><button type="button" disabled={busy} onClick={() => void save()} className="min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{busy ? '正在保存…' : '保存'}</button></div>
        </div> : detailLoading ? <p className="text-sm text-slate-500">正在读取提示词…</p> : selected ? <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-xl font-semibold text-slate-900">{selected.name}</h2><p className="mt-1 text-sm leading-6 text-slate-600">{selected.description || '暂无说明'}</p></div><span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{selected.source === 'builtin' ? '内置模板' : selected.visibility === 'private' ? '仅自己' : '组织共享'}</span></div>
          {(selected.sourceUrl || selected.license) && <p className="text-xs leading-5 text-slate-500">{selected.sourceUrl && <>参考来源：<a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer" className="break-all text-brand-700 underline">{selected.sourceUrl}</a></>}{selected.license && <> · {selected.license}</>}</p>}
          <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void copyPrompt()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-brand-200 px-3 py-2 text-sm text-brand-700 hover:bg-brand-50"><Clipboard className="h-4 w-4" aria-hidden="true" />复制提示词</button><a href={`${libraryRoot}/${encodeURIComponent(selected.id)}/download`} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" aria-hidden="true" />下载 .md</a>{selected.editable && <><button type="button" onClick={startEdit} className="min-h-11 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">编辑</button><button type="button" disabled={busy} onClick={() => void remove()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-4 w-4" aria-hidden="true" />删除</button></>}</div>
          <div className="rounded-lg border border-slate-200 bg-slate-50"><div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2 text-xs font-medium text-slate-600"><FileText className="h-4 w-4" aria-hidden="true" />Markdown 正文</div><pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-sm leading-6 text-slate-800">{selected.markdown}</pre></div>
        </div> : <div className="grid min-h-64 place-content-center gap-2 text-center text-slate-500"><Icon className="mx-auto h-8 w-8" aria-hidden="true" /><p className="text-sm">选择一个 {label} 查看提示词，或创建新条目。</p></div>}
      </section>
    </div>
  </main>
}
