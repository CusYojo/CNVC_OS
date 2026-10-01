import { useMemo, useState, type ReactNode } from 'react'
import { Download, GripVertical, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Modal } from '../ui'
import type { ProjectFile } from '../../types'
import type { Member, PublicTwin, Question, QuestionPack } from './types'

const Field = ({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) => <label className={className}><span className="label">{label}</span>{children}</label>

export function QuestionsWorkspace(props: {
  projectId: string
  files: ProjectFile[]
  members: Member[]
  publicTwins: PublicTwin[]
  questions: Question[]
  loading: boolean
  defaultAssigneeId: string
  defaultAssigneeName: string
  onCreate: (value: { title: string; category: string; priority: '高' | '中' | '低'; evidenceRequirement: string; assigneeUserId: string; assigneeName: string; fileIds: string[] }) => Promise<void>
  onStatus: (question: Question, status: Question['status']) => Promise<void>
  onDelete: (question: Question) => Promise<void>
  onReorder: (ids: string[]) => Promise<void>
  onGenerate: (value: { fileIds: string[]; publicationIds: string[]; mode: 'auto' | 'baseline' | 'ai' }) => Promise<QuestionPack & { created: number }>
  onUpload: (file: File) => Promise<ProjectFile | null>
}) {
  const [status, setStatus] = useState('')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showGenerate, setShowGenerate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [dragged, setDragged] = useState('')
  const [pack, setPack] = useState<(QuestionPack & { created: number }) | null>(null)
  const [mode, setMode] = useState<'auto' | 'baseline' | 'ai'>('auto')
  const [fileIds, setFileIds] = useState<string[]>([])
  const [publicationIds, setPublicationIds] = useState<string[]>([])
  const [form, setForm] = useState<{ title: string; category: string; priority: '高' | '中' | '低'; evidenceRequirement: string; assigneeUserId: string; assigneeName: string; fileIds: string[] }>({ title: '', category: '业务', priority: '中', evidenceRequirement: '', assigneeUserId: '', assigneeName: '', fileIds: [] })
  const visible = useMemo(() => props.questions.filter(item => (!status || item.status === status) && (!assignee || item.assigneeUserId === assignee) && (!priority || item.priority === priority)), [props.questions, status, assignee, priority])

  const drop = async (targetId: string) => {
    if (!dragged || dragged === targetId) return
    if (visible.length !== props.questions.length) return
    const ids = props.questions.map(item => item.id); const from = ids.indexOf(dragged); const to = ids.indexOf(targetId)
    ids.splice(to, 0, ids.splice(from, 1)[0]); setDragged(''); await props.onReorder(ids)
  }

  return <div className="space-y-4">
    <Card className="flex flex-wrap items-end gap-3 p-4">
      <div className="mr-auto"><h2 className="font-semibold">从项目材料开始尽调</h2><p className="mt-1 text-xs text-slate-500">无模型也可生成标准清单；模型可用时自动按材料增强。</p></div>
      <Field label="状态"><select className="input w-28" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部</option><option>待核查</option><option>已完成</option></select></Field>
      <Field label="负责人"><select className="input w-32" value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">全部</option>{props.members.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <Field label="优先级"><select className="input w-24" value={priority} onChange={event => setPriority(event.target.value)}><option value="">全部</option><option>高</option><option>中</option><option>低</option></select></Field>
      <Button onClick={() => { setFileIds(props.files.map(file => file.id)); setPack(null); setShowGenerate(true) }}>生成尽调清单</Button>
    </Card>
    <div className="grid grid-cols-2 gap-4">{(['待核查', '已完成'] as const).map(label => <Card key={label} className="p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold">{props.questions.filter(item => item.status === label).length}</p></Card>)}</div>
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 p-4"><h2 className="font-semibold">问题包与核查清单</h2><Button onClick={() => { const current = props.members.find(item => item.id === props.defaultAssigneeId); setForm({ title: '', category: '业务', priority: '中', evidenceRequirement: '', assigneeUserId: current?.id || '', assigneeName: current?.name || props.defaultAssigneeName, fileIds: [] }); setShowCreate(true) }}><Plus className="h-4 w-4" />新建问题</Button></div>
      <div className="divide-y divide-slate-100">{visible.map(item => <div key={item.id} draggable={visible.length === props.questions.length} onDragStart={() => setDragged(item.id)} onDragOver={event => event.preventDefault()} onDrop={() => { void drop(item.id) }} className="grid gap-3 p-4 md:grid-cols-[24px_1fr_110px_40px]">
        <GripVertical className="mt-1 h-4 w-4 text-slate-300" />
        <div><div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-slate-800">{item.title}</strong><Badge tone={item.priority === '高' ? 'red' : item.priority === '中' ? 'amber' : 'green'}>{item.priority}优先级</Badge>{item.category && <Badge>{item.category}</Badge>}</div><p className="mt-2 text-xs text-slate-500">备注：{item.evidenceRequirement || '无'} · 负责人：{item.assigneeName || '未分配'}</p>{(item.fileIds?.length || item.fileId) && <p className="mt-1 text-xs text-brand-600">关联材料：{[...new Set([...(item.fileIds || []), ...(item.fileId ? [item.fileId] : [])])].map(id => props.files.find(file => file.id === id)?.name || '已不可用').join('、')}</p>}{item.attentionSource && <p className="mt-1 text-xs text-slate-500">关注来源：{item.attentionSource}</p>}</div>
        <select className="input h-9 text-xs" value={item.status} onChange={event => { void props.onStatus(item, event.target.value as Question['status']) }}><option>待核查</option><option>已完成</option></select>
        <button className="text-rose-500" title="删除问题" onClick={() => { void props.onDelete(item) }}><Trash2 className="h-4 w-4" /></button>
      </div>)}{!visible.length && <p className="p-8 text-center text-sm text-slate-400">{props.loading ? '正在加载…' : '暂无符合条件的核查问题'}</p>}</div>
    </Card>
    <Modal open={showCreate} title="新建核查问题" onClose={() => !creating && setShowCreate(false)} footer={<><Button variant="secondary" onClick={() => setShowCreate(false)}>取消</Button><Button disabled={creating || !form.title.trim()} onClick={async () => { setCreating(true); try { await props.onCreate(form); setShowCreate(false) } finally { setCreating(false) } }}>{creating ? '创建中…' : '创建问题'}</Button></>}>
      <div className="grid grid-cols-2 gap-4"><Field label="核查问题 *" className="col-span-2"><input className="input" value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></Field><Field label="负责人"><select className="input" value={form.assigneeUserId} onChange={event => { const member = props.members.find(item => item.id === event.target.value); setForm({ ...form, assigneeUserId: event.target.value, assigneeName: member?.name || '' }) }}><option value="">未分配</option>{props.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></Field><Field label="类别"><select className="input" value={form.category} onChange={event => setForm({ ...form, category: event.target.value })}>{['业务', '财务', '法务', '团队', '技术', '合规'].map(value => <option key={value}>{value}</option>)}</select></Field><Field label="优先级"><select className="input" value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value as '高' | '中' | '低' })}><option>高</option><option>中</option><option>低</option></select></Field><Field label="关联材料" className="col-span-2"><select multiple className="input h-28" value={form.fileIds} onChange={event => setForm({ ...form, fileIds: Array.from(event.target.selectedOptions).map(option => option.value) })}>{props.files.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select></Field><Field label="备注" className="col-span-2"><textarea className="textarea min-h-24" value={form.evidenceRequirement} onChange={event => setForm({ ...form, evidenceRequirement: event.target.value })} /></Field></div>
    </Modal>
    <Modal open={showGenerate} title="生成尽调问题清单" onClose={() => !generating && setShowGenerate(false)} footer={<><Button variant="secondary" onClick={() => setShowGenerate(false)}>关闭</Button>{pack ? <a className="inline-flex items-center rounded-lg border border-brand-200 px-3 py-2 text-sm text-brand-700" href={`/api/due-diligence/projects/${props.projectId}/question-packs/${pack.id}/docx`}><Download className="mr-1 h-4 w-4" />下载 Word</a> : <Button disabled={generating} onClick={async () => { setGenerating(true); try { setPack(await props.onGenerate({ fileIds, publicationIds, mode })) } finally { setGenerating(false) } }}>{generating ? '正在生成…' : '生成尽调清单'}</Button>}</>}>
      <div className="space-y-4"><Field label="生成方式"><select className="input" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="auto">自动模式（推荐）</option><option value="baseline">标准清单（不调用模型）</option><option value="ai">智能增强</option></select></Field><Field label="本次分析材料"><select multiple className="input h-32" value={fileIds} onChange={event => setFileIds(Array.from(event.target.selectedOptions).map(option => option.value))}>{props.files.map(file => <option key={file.id} value={file.id}>{file.name} · {file.parseStatus}</option>)}</select></Field><label className="inline-flex cursor-pointer items-center rounded-lg border border-brand-200 px-3 py-2 text-sm font-medium text-brand-700">上传补充材料<input className="hidden" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.md" onChange={async event => { const file = event.target.files?.[0]; if (file) { const uploaded = await props.onUpload(file); if (uploaded) setFileIds(ids => [...ids, uploaded.id]) } event.currentTarget.value = '' }} /></label><Field label="参考公司分身（最多 5 位，可不选）"><select multiple className="input h-28" value={publicationIds} onChange={event => setPublicationIds(Array.from(event.target.selectedOptions).map(option => option.value).slice(0, 5))}>{props.publicTwins.map(twin => <option key={twin.id} value={twin.id}>{twin.ownerName} · v{twin.publishedVersion}</option>)}</select></Field>{pack && <><div className={`rounded-lg border p-3 text-sm ${pack.warning ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}><strong>{pack.generationMode === 'ai' ? '已智能增强' : `已使用标准清单 v${pack.templateVersion}`}</strong>{pack.warning && <p className="mt-1">{pack.warning}</p>}</div><div className="max-h-72 space-y-2 overflow-auto rounded-lg bg-slate-50 p-3">{pack.questions.map((question, index) => <div key={`${question.title}-${index}`} className="rounded border bg-white p-3 text-sm"><strong>{index + 1}. {question.title}</strong><p className="mt-1 text-xs text-slate-500">{question.category} · {question.priority} · {question.attentionSource || '标准模板'}</p></div>)}</div></>}</div>
    </Modal>
  </div>
}
