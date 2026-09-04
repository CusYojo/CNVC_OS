import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Bold, CalendarDays, LockKeyhole, NotebookPen, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'
import { useToast } from './Toast'
import { Button, Modal } from './ui'

const noteColors = {
  default: '#24353a',
  teal: '#267078',
  blue: '#356aa0',
  amber: '#9a681f',
  rose: '#a94e5d',
  violet: '#76588f',
} as const

type NoteColor = keyof typeof noteColors
type NoteRun = { text: string; bold: boolean; color: NoteColor }
type PersonalNote = {
  id: string
  title: string
  noteDate: string
  content: NoteRun[]
  version: number
  createdAt: string
  updatedAt: string
}
type NoteList = { list: PersonalNote[]; total: number; page: number; pageSize: number }
type NoteDraft = { title: string; noteDate: string; content: NoteRun[] }

const emptyContent = (): NoteRun[] => [{ text: '', bold: false, color: 'default' }]
const localDate = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
const defaultTitle = (date: string) => {
  const [, month, day] = date.split('-')
  return `${Number(month)}月${Number(day)}日 随记`
}
const initialDraft = (): NoteDraft => {
  const noteDate = localDate()
  return { title: defaultTitle(noteDate), noteDate, content: emptyContent() }
}
const plainText = (content: NoteRun[]) => content.map(run => run.text).join('').trim()
const mergeRuns = (runs: NoteRun[]) => runs.reduce<NoteRun[]>((result, run) => {
  if (!run.text) return result
  const previous = result.at(-1)
  if (previous && previous.bold === run.bold && previous.color === run.color) previous.text += run.text
  else result.push({ ...run })
  return result
}, [])

function normalizedColor(value: string): NoteColor {
  const normalized = value.toLowerCase().replace(/\s/g, '')
  return (Object.entries(noteColors).find(([, hex]) => normalized === hex || normalized === rgbFor(hex))?.[0] ?? 'default') as NoteColor
}

function rgbFor(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${value >> 16},${(value >> 8) & 255},${value & 255})`
}

function editorRuns(root: HTMLElement): NoteRun[] {
  const runs: NoteRun[] = []
  const visit = (node: Node, inherited: Pick<NoteRun, 'bold' | 'color'>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      runs.push({ text: node.textContent ?? '', ...inherited })
      return
    }
    if (!(node instanceof HTMLElement)) return
    const tag = node.tagName.toLowerCase()
    if (tag === 'br') {
      runs.push({ text: '\n', ...inherited })
      return
    }
    const weight = node.style.fontWeight
    const bold = inherited.bold || tag === 'b' || tag === 'strong' || Number.parseInt(weight, 10) >= 600 || weight === 'bold'
    const colorValue = node.style.color || (tag === 'font' ? node.getAttribute('color') ?? '' : '')
    const color = colorValue ? normalizedColor(colorValue) : inherited.color
    const before = runs.length
    node.childNodes.forEach(child => visit(child, { bold, color }))
    if ((tag === 'div' || tag === 'p') && before !== runs.length && !runs.at(-1)?.text.endsWith('\n')) runs.push({ text: '\n', bold, color })
  }
  root.childNodes.forEach(node => visit(node, { bold: false, color: 'default' }))
  const merged = mergeRuns(runs)
  while (merged.at(-1)?.text.endsWith('\n')) {
    const last = merged.at(-1)!
    last.text = last.text.slice(0, -1)
    if (!last.text) merged.pop()
  }
  return merged.length ? merged : emptyContent()
}

function RichNoteEditor({ value, editorKey, onChange }: { value: NoteRun[]; editorKey: string; onChange: (value: NoteRun[]) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const editor = ref.current
    if (!editor) return
    const fragment = document.createDocumentFragment()
    value.filter(run => run.text).forEach(run => {
      const span = document.createElement('span')
      span.textContent = run.text
      span.style.fontWeight = run.bold ? '700' : '400'
      span.style.color = noteColors[run.color]
      fragment.append(span)
    })
    editor.replaceChildren(fragment)
  // Only reset the DOM when a different note is opened; input remains caret-safe.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey])

  const sync = () => { if (ref.current) onChange(editorRuns(ref.current)) }
  const command = (name: 'bold' | 'foreColor', value?: string) => {
    ref.current?.focus()
    document.execCommand(name, false, value)
    sync()
  }
  return <div className="personal-note-editor-shell">
    <div className="personal-note-editor-toolbar" aria-label="文字格式">
      <button type="button" className="personal-note-format-button" title="加粗" aria-label="加粗选中文字" onMouseDown={event => event.preventDefault()} onClick={() => command('bold')}><Bold size={16}/></button>
      <span className="personal-note-toolbar-divider" aria-hidden="true"/>
      <span className="personal-note-color-label">文字颜色</span>
      {(Object.entries(noteColors) as [NoteColor, string][]).map(([name, color]) => <button key={name} type="button" className="personal-note-color" style={{ '--note-color': color } as CSSProperties} title={name === 'default' ? '正文色' : `${name} 色`} aria-label={`设置文字颜色为${name}`} onMouseDown={event => event.preventDefault()} onClick={() => command('foreColor', color)}/>) }
    </div>
    <div ref={ref} className="personal-note-editor" contentEditable role="textbox" aria-multiline="true" aria-label="笔记内容" data-placeholder="写下今天的思考、判断或灵感…" onInput={sync} onBlur={sync} onPaste={event => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); sync() }} />
  </div>
}

function NoteContent({ content }: { content: NoteRun[] }) {
  return <div className="personal-note-content">{content.map((run, index) => <span key={`${index}-${run.text.slice(0, 8)}`} style={{ color: noteColors[run.color], fontWeight: run.bold ? 700 : 400 }}>{run.text}</span>)}</div>
}

function displayDate(value: string) {
  const [year, month, day] = value.split('-')
  return `${year}年${Number(month)}月${Number(day)}日`
}

export function PersonalNotesPanel() {
  const { showToast } = useToast()
  const [data, setData] = useState<NoteList | null>(null)
  const [keyword, setKeyword] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<PersonalNote | 'new' | null>(null)
  const [deleting, setDeleting] = useState<PersonalNote | null>(null)
  const [draft, setDraft] = useState<NoteDraft>(initialDraft)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    const suffix = new URLSearchParams({ keyword: query, page: String(page), pageSize: '18' })
    void apiGet<NoteList>(`/personal-notes?${suffix}`).then(value => { if (active) setData(value) }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '个人笔记加载失败')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [page, query, revision])

  const openNew = () => { setDraft(initialDraft()); setEditing('new') }
  const openEdit = (note: PersonalNote) => {
    setDraft({ title: note.title, noteDate: note.noteDate, content: note.content })
    setEditing(note)
  }
  const closeEditor = () => { if (!busy) setEditing(null) }
  const save = async () => {
    const title = draft.title.trim()
    if (!title || !plainText(draft.content) || busy) return
    setBusy(true)
    try {
      if (editing === 'new') await apiPost('/personal-notes', { ...draft, title })
      else if (editing) await apiPatch(`/personal-notes/${editing.id}`, { ...draft, title, expectedVersion: editing.version })
      showToast(editing === 'new' ? '笔记已保存' : '笔记已更新')
      setEditing(null); setPage(1); setRevision(value => value + 1)
    } catch (cause) { showToast(cause instanceof Error ? cause.message : '笔记保存失败', 'error') }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!deleting || busy) return
    setBusy(true)
    try {
      await apiDelete(`/personal-notes/${deleting.id}`, { expectedVersion: deleting.version })
      showToast('笔记已删除'); setDeleting(null); setRevision(value => value + 1)
    } catch (cause) { showToast(cause instanceof Error ? cause.message : '笔记删除失败', 'error') }
    finally { setBusy(false) }
  }
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 18)))

  return <section className="fde-personal-notes" aria-label="个人笔记">
    <header className="personal-notes-head">
      <div className="personal-notes-title"><span className="personal-notes-title-icon"><NotebookPen size={19}/></span><div><h2>个人笔记</h2><span><LockKeyhole size={13}/>仅自己可见</span></div></div>
      <Button type="button" onClick={openNew}><Plus size={16}/>新建笔记</Button>
    </header>
    <form className="personal-notes-search" onSubmit={event => { event.preventDefault(); setPage(1); setQuery(keyword.trim()) }}>
      <label><Search size={16}/><input value={keyword} maxLength={100} placeholder="搜索标题或内容" aria-label="搜索个人笔记" onChange={event => setKeyword(event.target.value)}/></label>
      {query && <button type="button" onClick={() => { setKeyword(''); setQuery(''); setPage(1) }}>清除</button>}
    </form>
    {error ? <div className="personal-notes-state" role="alert"><strong>个人笔记暂时无法加载</strong><Button variant="secondary" size="sm" onClick={() => setRevision(value => value + 1)}>重新加载</Button></div>
      : loading ? <div className="personal-notes-state" role="status">正在加载个人笔记…</div>
        : data?.list.length ? <>
          <div className="personal-notes-grid">{data.list.map(note => <article className="personal-note-card" key={note.id}>
            <div className="personal-note-card-meta"><time dateTime={note.noteDate}><CalendarDays size={14}/>{displayDate(note.noteDate)}</time><span className="personal-note-private"><LockKeyhole size={12}/>私密</span></div>
            <h3>{note.title}</h3>
            <NoteContent content={note.content}/>
            <footer><time dateTime={note.updatedAt}>更新于 {new Date(note.updatedAt).toLocaleDateString('zh-CN')}</time><div><button type="button" title="编辑笔记" aria-label={`编辑笔记：${note.title}`} onClick={() => openEdit(note)}><Pencil size={15}/></button><button type="button" className="danger" title="删除笔记" aria-label={`删除笔记：${note.title}`} onClick={() => setDeleting(note)}><Trash2 size={15}/></button></div></footer>
          </article>)}</div>
          {totalPages > 1 && <div className="personal-notes-pagination"><span>共 {data.total} 篇</span><div><Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><span>{page} / {totalPages}</span><Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>}
        </> : <div className="personal-notes-empty"><span><NotebookPen size={22}/></span><strong>{query ? '没有找到相关笔记' : '开始记录第一篇笔记'}</strong><p>{query ? '换一个关键词试试' : '把每日心得、判断和灵感留在自己的空间里'}</p>{!query && <Button type="button" onClick={openNew}><Plus size={16}/>新建笔记</Button>}</div>}

    <Modal open={Boolean(editing)} title={editing === 'new' ? '新建个人笔记' : '编辑个人笔记'} width="max-w-3xl" onClose={closeEditor} footer={<><Button variant="secondary" onClick={closeEditor} disabled={busy}>取消</Button><Button onClick={() => void save()} loading={busy} disabled={!draft.title.trim() || !plainText(draft.content)}>保存笔记</Button></>}>
      <div className="personal-note-form">
        <div className="personal-note-form-row"><label><span>标题</span><input className="input" maxLength={120} value={draft.title} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))}/></label><label><span>记录日期</span><input className="input" type="date" value={draft.noteDate} onChange={event => setDraft(value => ({ ...value, noteDate: event.target.value }))}/></label></div>
        <label className="personal-note-body-label"><span>笔记内容</span><RichNoteEditor editorKey={editing === 'new' ? 'new' : editing?.id ?? 'closed'} value={draft.content} onChange={content => setDraft(value => ({ ...value, content }))}/></label>
      </div>
    </Modal>
    <Modal open={Boolean(deleting)} title="删除笔记" onClose={() => !busy && setDeleting(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" loading={busy} onClick={() => void remove()}>确认删除</Button></>}>
      <p className="personal-note-delete-copy">确定删除“{deleting?.title}”吗？删除后无法恢复。</p>
    </Modal>
  </section>
}
