import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, Mic, Plus, Send, Trash2, Upload } from 'lucide-react'
import { Badge, Button, Card, Modal } from '../ui'
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition'
import type { LearningCandidate, PublicTwin, Twin, TwinAsset } from './types'

type TwinDraft = { id: string; name: string; role: string; rules: string; cases: string }
type ImportableSource = { id: string; name: string; text: string; sourceType: string }
const Field = ({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) => <label className={className}><span className="label">{label}</span>{children}</label>

export function ExperienceAssetsWorkspace(props: {
  currentUserId: string
  twins: Twin[]
  publicTwins: PublicTwin[]
  selectedTwin?: Twin
  draft: TwinDraft
  isNew: boolean
  dirty: boolean
  saving: boolean
  assets: TwinAsset[]
  candidates: LearningCandidate[]
  sources: ImportableSource[]
  onNew: () => void
  onSelect: (twin: Twin) => void
  onDraft: (draft: TwinDraft) => void
  onSave: () => Promise<void>
  onDelete: (twin: Twin) => Promise<void>
  onPublish: (twin: Twin) => Promise<void>
  onWithdraw: (twin: Twin) => Promise<void>
  onImportLocal: (file: File) => Promise<void>
  onImportSource: (source: ImportableSource) => Promise<void>
  onParseAsset: (asset: TwinAsset) => Promise<string | null>
  onDecideCandidates: (ids: string[], decision: '确认' | '拒绝') => Promise<void>
  onInvoke: (twin: PublicTwin, question: string) => Promise<{ advice: string } | null>
  onConversationFeedback: (input: { userQuestion: string; assistantAnswer: string; feedback: '采纳' | '修改' | '拒绝'; feedbackNote: string }) => Promise<void>
}) {
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([])
  const [sourceOpen, setSourceOpen] = useState(false)
  const [conversationTwin, setConversationTwin] = useState<PublicTwin | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [asking, setAsking] = useState(false)
  const [feedbackNote, setFeedbackNote] = useState('')
  const nameRef = useRef<HTMLInputElement | null>(null)
  const speech = useSpeechRecognition({ continuous: true, onFinal: text => props.onDraft({ ...props.draft, rules: `${props.draft.rules}${props.draft.rules ? '\n' : ''}${text}` }) })
  useEffect(() => { if (props.isNew) nameRef.current?.focus() }, [props.isNew])
  const ownPublished = new Map(props.publicTwins.filter(item => item.ownerUserId === props.currentUserId).map(item => [item.twinId, item]))
  const otherPublished = props.publicTwins.filter(item => item.ownerUserId !== props.currentUserId)

  return <div className="space-y-5">
    <Card className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">我的数字分身</h2><p className="mt-1 text-xs text-slate-500">判断偏好和素材默认仅本人可见；公开时只发布当前确认内容。</p></div><Button onClick={props.onNew}><Plus className="h-4 w-4" />新增数字分身</Button></div>
      <div className="mt-4 flex gap-3 overflow-x-auto pb-2">{props.twins.map(twin => <button key={twin.id} className={`min-w-52 rounded-xl border p-4 text-left ${props.selectedTwin?.id === twin.id ? 'border-brand-400 bg-brand-50' : 'border-slate-200'}`} onClick={() => props.onSelect(twin)}><div className="flex items-center justify-between gap-2"><strong>{twin.name}</strong><div className="flex gap-1">{twin.learningTargetAt && <Badge tone="green">当前学习</Badge>}<Badge>{ownPublished.has(twin.id) ? '已公开' : '未公开'}</Badge></div></div><p className="mt-2 text-xs text-slate-500">私有版本 v{twin.activeVersion}</p></button>)}{!props.twins.length && !props.isNew && <p className="text-sm text-slate-400">尚未创建数字分身。</p>}</div>
      {(props.selectedTwin || props.isNew) && <div className="mt-5 rounded-xl border border-slate-200 p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><strong>{props.isNew ? '未保存的新分身' : '编辑当前分身'}{props.dirty && <span className="ml-2 text-xs font-normal text-amber-700">有未保存修改</span>}</strong><div className="flex gap-2">{props.selectedTwin && (ownPublished.has(props.selectedTwin.id) ? <Button size="sm" variant="secondary" onClick={() => void props.onWithdraw(props.selectedTwin!)}>取消公开</Button> : <Button size="sm" variant="secondary" onClick={() => void props.onPublish(props.selectedTwin!)}>公开到分身库</Button>)}{props.selectedTwin && <Button size="sm" variant="secondary" onClick={() => void props.onDelete(props.selectedTwin!)}><Trash2 className="h-3.5 w-3.5" />删除</Button>}</div></div><div className="grid gap-4 md:grid-cols-2"><Field label="分身名称"><input ref={nameRef} className="input" value={props.draft.name} onChange={event => props.onDraft({ ...props.draft, name: event.target.value })} /></Field><div className="flex items-end gap-2"><Button variant="secondary" onClick={speech.state === 'listening' ? speech.pause : speech.start}><Mic className="h-4 w-4" />{speech.state === 'listening' ? '暂停语音' : '语音录入偏好'}</Button>{speech.error && <span className="text-xs text-amber-700">{speech.error}</span>}</div><Field label="判断偏好" className="md:col-span-2"><textarea className="textarea min-h-44" value={props.draft.rules} onChange={event => props.onDraft({ ...props.draft, rules: event.target.value })} placeholder="例如：优先核验现金流、客户集中度和收入确认口径…" /></Field><Field label="案例与适用边界" className="md:col-span-2"><textarea className="textarea min-h-32" value={props.draft.cases} onChange={event => props.onDraft({ ...props.draft, cases: event.target.value })} /></Field></div><div className="mt-4 flex justify-end"><Button disabled={props.saving || !props.draft.name.trim()} onClick={() => void props.onSave()}>{props.saving ? '保存中…' : props.isNew ? '创建分身' : '保存新版本'}</Button></div></div>}
    </Card>
    {props.selectedTwin && <Card className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">私有学习素材</h2><p className="mt-1 text-xs text-slate-500">导入后先解析为可编辑建议，采纳到判断偏好后仍需保存分身。</p></div><div className="flex gap-2"><label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-200 px-3 py-2 text-sm"><Upload className="mr-1 h-4 w-4" />本地导入<input className="hidden" type="file" accept=".txt,.md,.pdf,.doc,.docx,.mp3,.m4a,.wav,.webm" onChange={event => { const file = event.target.files?.[0]; if (file) void props.onImportLocal(file); event.currentTarget.value = '' }} /></label><Button variant="secondary" onClick={() => setSourceOpen(true)}>从知识库导入</Button></div></div><div className="mt-4 space-y-2">{props.assets.map(asset => <div key={asset.id} className="rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><strong className="text-sm">{asset.sourceName}</strong><p className="mt-1 text-xs text-slate-500">{asset.sourceType} · {asset.parseStatus}</p></div><Button size="sm" variant="secondary" disabled={asset.parseStatus === '解析中'} onClick={async () => { const suggestion = await props.onParseAsset(asset); if (suggestion) props.onDraft({ ...props.draft, rules: `${props.draft.rules}${props.draft.rules ? '\n\n' : ''}${suggestion}` }) }}>解析</Button></div>{asset.traitSuggestion && <div className="mt-3 rounded bg-slate-50 p-3 text-sm whitespace-pre-wrap">{asset.traitSuggestion}</div>}{asset.parseError && <p className="mt-2 text-xs text-rose-600">{asset.parseError}</p>}</div>)}{!props.assets.length && <p className="text-sm text-slate-400">尚未导入素材。</p>}</div></Card>}
    {props.selectedTwin && <Card className="p-5"><div className="flex items-center justify-between"><div><h2 className="font-semibold">待确认经验</h2><p className="mt-1 text-xs text-slate-500">系统自动提炼，只有确认后才更新分身并沉淀私有 Skill。</p></div><div className="flex gap-2"><Button size="sm" variant="secondary" disabled={!selectedCandidates.length} onClick={() => void props.onDecideCandidates(selectedCandidates, '拒绝').then(() => setSelectedCandidates([]))}>排除</Button><Button size="sm" disabled={!selectedCandidates.length} onClick={() => void props.onDecideCandidates(selectedCandidates, '确认').then(() => setSelectedCandidates([]))}>采纳</Button></div></div><div className="mt-4 space-y-2">{props.candidates.filter(item => item.status === '待确认').map(item => <label key={item.id} className="flex gap-3 rounded-lg border p-3"><input type="checkbox" checked={selectedCandidates.includes(item.id)} onChange={() => setSelectedCandidates(ids => ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id])} /><div><strong className="text-sm">{item.topic}</strong><p className="mt-1 text-xs text-slate-500">{item.sourceName} · 置信度 {item.confidence}%</p><p className="mt-2 text-sm whitespace-pre-wrap">{item.rules}</p></div></label>)}{!props.candidates.some(item => item.status === '待确认') && <p className="text-sm text-slate-400">暂无待确认经验</p>}</div></Card>}
    <Card className="p-5"><h2 className="font-semibold">公司分身库</h2><p className="mt-1 text-xs text-slate-500">以下分身只使用所有者主动发布的公开内容。</p><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{otherPublished.map(twin => <div key={twin.id} className="rounded-xl border p-4"><div className="flex items-center gap-2"><Bot className="h-5 w-5 text-brand-600" /><strong>{twin.ownerName}分身</strong><Badge>v{twin.publishedVersion}</Badge></div><p className="mt-2 text-sm text-slate-600">{twin.introduction}</p><Button className="mt-3" size="sm" onClick={() => { setConversationTwin(twin); setQuestion(''); setAnswer('') }}>调用对话</Button></div>)}{!otherPublished.length && <p className="text-sm text-slate-400">暂无其他员工公开分身。</p>}</div></Card>
    <Modal open={sourceOpen} title="从知识库导入" onClose={() => setSourceOpen(false)} footer={<Button variant="secondary" onClick={() => setSourceOpen(false)}>关闭</Button>}><div className="max-h-96 space-y-2 overflow-auto">{props.sources.map(source => <button key={`${source.sourceType}-${source.id}`} className="w-full rounded-lg border p-3 text-left hover:bg-slate-50" onClick={async () => { await props.onImportSource(source); setSourceOpen(false) }}><strong className="text-sm">{source.name}</strong><p className="mt-1 text-xs text-slate-500">{source.sourceType}</p></button>)}{!props.sources.length && <p className="text-sm text-slate-400">没有可导入的已解析材料或个人笔记。</p>}</div></Modal>
    <Modal open={Boolean(conversationTwin)} title={conversationTwin ? `与 ${conversationTwin.ownerName}分身对话` : '公司分身对话'} onClose={() => setConversationTwin(null)} footer={<Button variant="secondary" onClick={() => setConversationTwin(null)}>关闭</Button>}><div className="space-y-3">{answer && <div className="rounded-lg bg-slate-50 p-4 text-sm whitespace-pre-wrap">{answer}</div>}<div className="flex gap-2"><textarea className="textarea min-h-24" value={question} onChange={event => setQuestion(event.target.value)} placeholder="输入希望该专家分身关注的问题…" /><Button disabled={asking || !question.trim()} onClick={async () => { if (!conversationTwin) return; setAsking(true); try { const result = await props.onInvoke(conversationTwin, question); setAnswer(result?.advice || '') } finally { setAsking(false) } }}><Send className="h-4 w-4" />{asking ? '回答中…' : '发送'}</Button></div>{answer && props.selectedTwin && <div className="rounded-lg border p-3"><p className="text-xs text-slate-500">这次回答是否体现了你希望沉淀的判断方式？</p><input className="input mt-2" value={feedbackNote} onChange={event => setFeedbackNote(event.target.value)} placeholder="如有修改，可补充你的正确判断" /><div className="mt-2 flex gap-2">{(['采纳', '修改', '拒绝'] as const).map(value => <Button key={value} size="sm" variant={value === '采纳' ? 'default' : 'secondary'} onClick={() => void props.onConversationFeedback({ userQuestion: question, assistantAnswer: answer, feedback: value, feedbackNote })}>{value}</Button>)}</div></div>}</div></Modal>
  </div>
}
