import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, GripVertical, Mic, Pause, Play, Plus, Save, Send, Square, Trash2 } from 'lucide-react'
import { Button, Card, Modal, StatusBadge } from '../ui'
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition'
import type { Interview, InterviewArtifact, InterviewPrompt, InterviewTranscript, TranscriptionJob } from './types'

const Field = ({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) => <label className={className}><span className="label">{label}</span>{children}</label>
const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

export function InterviewsWorkspace(props: {
  projectId: string
  interviews: Interview[]
  selected?: Interview
  prompts: InterviewPrompt[]
  artifacts: InterviewArtifact[]
  transcript?: InterviewTranscript
  transcriptionJobs: TranscriptionJob[]
  writeReady: boolean
  writeError?: string
  onSelect: (id: string) => void
  onCreate: () => void
  onSave: (interview: Interview, patch: Partial<Interview>) => Promise<Interview | null>
  onDelete: (interview: Interview) => Promise<void>
  onReorder: (ids: string[]) => Promise<void>
  onRemoveMaterial: (artifact: InterviewArtifact) => Promise<void>
  onUploadSummary: (interview: Interview, file: File) => Promise<void>
  onSaveTranscript: (interview: Interview, content: string, status: '草稿' | '已确认', expectedVersion?: number | null) => Promise<InterviewTranscript | null>
  onUploadRecording: (interview: Interview, blob: Blob, seconds: number) => Promise<string | null>
  onStartAsr: (interview: Interview, recordingFileId: string, browserText: string, transcriptVersion?: number | null) => Promise<void>
  onRetryAsr: (interview: Interview, job: TranscriptionJob) => Promise<void>
  onGenerateSummary: (interview: Interview, transcriptVersion: number) => Promise<{ summary: string; transcriptVersion: number } | null>
  onArchiveText: (interview: Interview, kind: '转写稿' | '访谈纪要', content: string) => Promise<void>
  onSendPrompt: (interview: Interview, content: string) => Promise<void>
  onConfirmPrompt: (interview: Interview, prompt: InterviewPrompt, status: InterviewPrompt['status']) => Promise<void>
  onRefreshLive: () => Promise<void>
  onRecordingState: (active: boolean) => void
}) {
  const [editOpen, setEditOpen] = useState(false)
  const [editDraft, setEditDraft] = useState<Partial<Interview>>({})
  const [orderOpen, setOrderOpen] = useState(false)
  const [order, setOrder] = useState<string[]>([])
  const [dragged, setDragged] = useState('')
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  const [interim, setInterim] = useState('')
  const [summary, setSummary] = useState('')
  const [promptText, setPromptText] = useState('')
  const [recordState, setRecordState] = useState<'idle' | 'requesting' | 'recording' | 'paused' | 'finishing'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const segmentStartedAt = useRef(0)
  const accumulatedSeconds = useRef(0)
  const recordingBaseDraft = useRef('')
  const promptVoiceBase = useRef('')
  const pendingRecording = useRef<{ blob: Blob; content: string; seconds: number } | null>(null)
  const [saveError, setSaveError] = useState('')

  const appendTranscript = (text: string) => setDraft(value => { const next = `${value}${value.trim() ? '\n' : ''}${text}`; draftRef.current = next; return next })
  const speech = useSpeechRecognition({ continuous: true, onFinal: appendTranscript, onInterim: setInterim })
  const promptSpeech = useSpeechRecognition({ onFinal: text => setPromptText(value => `${value}${value ? ' ' : ''}${text}`) })

  useEffect(() => { const value = props.transcript?.content || ''; setDraft(value); draftRef.current = value; setSummary(props.selected?.summary || '') }, [props.selected?.id, props.transcript?.id, props.transcript?.version])
  useEffect(() => { props.onRecordingState(recordState !== 'idle') }, [recordState]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!props.selected?.id) return
    void props.onRefreshLive()
    const timer = window.setInterval(() => { void props.onRefreshLive() }, 5_000)
    return () => window.clearInterval(timer)
  }, [props.selected?.id, props.onRefreshLive])
  useEffect(() => () => { speech.reset(); promptSpeech.reset(); recorder.current?.state !== 'inactive' && recorder.current?.stop(); stream.current?.getTracks().forEach(track => track.stop()) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (recordState !== 'recording') return; const timer = window.setInterval(() => setElapsed(Math.round(accumulatedSeconds.current + (Date.now() - segmentStartedAt.current) / 1000)), 500); return () => window.clearInterval(timer) }, [recordState])

  const begin = async () => {
    if (!props.selected) return
    if (!props.writeReady) { window.alert(`当前页面暂时无法保存录音：${props.writeError || '写入来源校验未通过'}`); return }
    setRecordState('requesting')
    try {
      recordingBaseDraft.current = draftRef.current
      const media = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.current = media; chunks.current = []; accumulatedSeconds.current = 0; setElapsed(0)
      const item = new MediaRecorder(media); item.ondataavailable = event => { if (event.data.size) chunks.current.push(event.data) }; recorder.current = item; item.start(1_000); segmentStartedAt.current = Date.now(); speech.start(); setRecordState('recording')
    } catch (error) { setRecordState('idle'); stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; window.alert(`无法开始录音：${error instanceof Error ? error.message : '麦克风不可用'}`) }
  }
  const pause = () => { if (recorder.current?.state === 'recording') recorder.current.pause(); accumulatedSeconds.current += (Date.now() - segmentStartedAt.current) / 1000; speech.pause(); setRecordState('paused'); setElapsed(Math.round(accumulatedSeconds.current)) }
  const resume = () => { if (recorder.current?.state === 'paused') recorder.current.resume(); segmentStartedAt.current = Date.now(); speech.start(); setRecordState('recording') }
  const discardRecording = () => {
    if (!window.confirm('确认放弃本次录入？本次尚未保存的录音和新增转写将被删除。')) return
    speech.reset()
    const current = recorder.current
    if (current && current.state !== 'inactive') {
      current.ondataavailable = null
      current.onerror = null
      current.onstop = null
      current.stop()
    }
    stream.current?.getTracks().forEach(track => track.stop())
    stream.current = null; recorder.current = null; chunks.current = []; pendingRecording.current = null
    accumulatedSeconds.current = 0; setElapsed(0); setInterim(''); setSaveError(''); setRecordState('idle')
    setDraft(recordingBaseDraft.current); draftRef.current = recordingBaseDraft.current
  }
  const startPromptSpeech = () => { promptVoiceBase.current = promptText; promptSpeech.start() }
  const discardPromptSpeech = () => { promptSpeech.reset(); setPromptText(promptVoiceBase.current) }
  const clearPrompt = () => { promptSpeech.reset(); promptVoiceBase.current = ''; setPromptText('') }
  const stopRecorder = () => new Promise<Blob>((resolve, reject) => {
    const current = recorder.current
    if (!current || current.state === 'inactive') return resolve(new Blob(chunks.current, { type: current?.mimeType || 'audio/webm' }))
    current.onerror = () => reject(new Error('录音文件生成失败'))
    current.onstop = () => resolve(new Blob(chunks.current, { type: current.mimeType || 'audio/webm' }))
    current.stop()
  })
  const describeSaveError = (error: unknown) => {
    const message = error instanceof Error ? error.message : '未知错误'
    return /来源不信任|ORIGIN_FORBIDDEN/i.test(message) ? '当前访问地址未加入可信来源。请使用配置的本地地址后重新保存。' : message
  }
  const persistRecording = async (item: { blob: Blob; content: string; seconds: number }) => {
    if (!props.selected) return false
    // Archive audio first, then commit its corresponding transcript. Both stay
    // in browser memory until the complete chain succeeds, enabling retry.
    const recordingFileId = item.blob.size ? await props.onUploadRecording(props.selected, item.blob, item.seconds) : null
    if (item.blob.size && !recordingFileId) throw new Error('录音保存未完成')
    const saved = item.content ? await props.onSaveTranscript(props.selected, item.content, '已确认', props.transcript?.version ?? null) : null
    if (item.content && !saved) throw new Error('转写保存未完成')
    if (recordingFileId) await props.onStartAsr(props.selected, recordingFileId, item.content, saved?.version ?? props.transcript?.version ?? null)
    pendingRecording.current = null; setSaveError('')
    if (saved && window.confirm('录入已结束，是否基于已保存的转写生成访谈纪要？')) { const result = await props.onGenerateSummary(props.selected, saved.version); if (result) setSummary(result.summary) }
    return true
  }
  const finish = async () => {
    if (!props.selected) return
    if (recordState === 'recording') accumulatedSeconds.current += (Date.now() - segmentStartedAt.current) / 1000
    setRecordState('finishing'); speech.stop(); await new Promise(resolve => window.setTimeout(resolve, 80))
    try {
      const blob = await stopRecorder(); stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; recorder.current = null
      const item = { blob, content: draftRef.current.trim(), seconds: Math.round(accumulatedSeconds.current) }; pendingRecording.current = item
      await persistRecording(item)
      setRecordState('idle'); setElapsed(0); accumulatedSeconds.current = 0; chunks.current = []
    } catch (error) { setRecordState('paused'); setSaveError(describeSaveError(error)) }
  }

  const selected = props.selected
  const projectMaterials = props.artifacts.filter(item => item.kind === '项目材料')
  const products = props.artifacts.filter(item => item.kind !== '项目材料')
  const newestJob = props.transcriptionJobs[0]

  return <div className="space-y-5">
      <Card className="p-4"><div className="flex flex-wrap items-end gap-3"><Field label="访谈安排" className="min-w-64 flex-1"><select className="input" disabled={recordState !== 'idle'} value={selected?.id || ''} onChange={event => props.onSelect(event.target.value)}><option value="">请选择访谈</option>{props.interviews.map(item => <option key={item.id} value={item.id}>{item.title} · {item.scheduledAt ? new Date(item.scheduledAt).toLocaleString('zh-CN') : '未排期'}</option>)}</select></Field><Button disabled={recordState !== 'idle'} onClick={props.onCreate}><Plus className="h-4 w-4" />新建</Button><Button variant="secondary" disabled={!selected || recordState !== 'idle'} onClick={() => { if (selected) setEditDraft({ ...selected, scheduledAt: selected.scheduledAt ? new Date(selected.scheduledAt).toISOString().slice(0, 16) : null }); setEditOpen(true) }}>编辑</Button><Button variant="secondary" disabled={!selected || recordState !== 'idle'} onClick={() => selected && void props.onDelete(selected)}><Trash2 className="h-4 w-4" />删除</Button><Button variant="secondary" disabled={props.interviews.length < 2 || recordState !== 'idle'} onClick={() => { setOrder(props.interviews.map(item => item.id)); setOrderOpen(true) }}>管理顺序</Button></div></Card>
    {!selected ? <Card className="p-8 text-center text-sm text-slate-400">请选择或新建一场访谈。</Card> : <>
      <Card className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">项目相关材料</h2><p className="mt-1 text-xs text-slate-500">创建访谈时从项目中心导入；在此移除不会删除项目中心原文件。</p></div></div><div className="mt-3 grid gap-2 md:grid-cols-2">{projectMaterials.map(item => <div key={item.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm"><a className="min-w-0 truncate text-brand-700" href={`/api/projects/files/${item.fileId}/download`}>{item.name}</a><button className="ml-3 text-rose-500" onClick={() => void props.onRemoveMaterial(item)}><Trash2 className="h-4 w-4" /></button></div>)}{!projectMaterials.length && <p className="text-sm text-slate-400">当前访谈没有项目材料引用。</p>}</div></Card>
      <Card className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">录音与实时转写</h2><p className="mt-1 text-xs text-slate-500">浏览器文字实时出现；结束后可用后台 ASR 补转写并人工合并。</p></div><div className="flex flex-wrap gap-2">{recordState === 'idle' && <Button disabled={!props.writeReady} onClick={() => void begin()}><Mic className="h-4 w-4" />开始录入</Button>}{recordState === 'requesting' && <Button disabled>正在申请权限…</Button>}{recordState === 'recording' && <Button variant="secondary" onClick={pause}><Pause className="h-4 w-4" />暂停 {formatTime(elapsed)}</Button>}{recordState === 'paused' && <Button onClick={resume}><Play className="h-4 w-4" />继续录入</Button>}{recordState !== 'idle' && recordState !== 'requesting' && <><Button variant="secondary" disabled={recordState === 'finishing'} onClick={() => void finish()}><Square className="h-4 w-4" />{recordState === 'finishing' ? '正在结束…' : '结束'}</Button><Button variant="secondary" className="text-rose-600" disabled={recordState === 'finishing'} onClick={discardRecording}><Trash2 className="h-4 w-4" />放弃本次</Button></>}</div></div>
        {speech.error && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{speech.error} 录音不受影响，结束后仍会尝试后台转写。</p>}
        {saveError && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-800"><span>保存未完成：{saveError}。录音和转写仍保留在当前页面。</span><Button size="sm" variant="secondary" disabled={!pendingRecording.current} onClick={() => { const item = pendingRecording.current; if (item) void persistRecording(item).then(ok => { if (ok) { setRecordState('idle'); setElapsed(0); accumulatedSeconds.current = 0; chunks.current = [] } }).catch(error => setSaveError(describeSaveError(error))) }}>重新保存</Button></div>}
        <textarea className="textarea mt-4 min-h-72 w-full" value={draft} onChange={event => { setDraft(event.target.value); draftRef.current = event.target.value }} placeholder="实时转写会持续显示在这里，也可随时手工修订。" />{interim && <p className="mt-2 text-sm text-slate-400">正在识别：{interim}</p>}
        <div className="mt-3 flex flex-wrap justify-end gap-2"><Button variant="secondary" disabled={!draft.trim()} onClick={() => void props.onSaveTranscript(selected, draft, '草稿', props.transcript?.version ?? null)}><Save className="h-4 w-4" />保存草稿</Button><Button variant="secondary" disabled={!draft.trim()} onClick={() => void props.onArchiveText(selected, '转写稿', draft)}>保存到项目材料</Button><a className="inline-flex items-center rounded-lg border px-3 py-2 text-sm" href={`/api/due-diligence/projects/${props.projectId}/interviews/${selected.id}/export/transcript`}><Download className="mr-1 h-4 w-4" />导出转写稿</a></div>
        {newestJob && <div className="mt-4 rounded-lg border border-slate-200 p-3 text-sm"><div className="flex items-center justify-between"><strong>后台转写：{newestJob.status}</strong>{(newestJob.status === '失败' || newestJob.status === '未配置') && <Button size="sm" variant="secondary" onClick={() => void props.onRetryAsr(selected, newestJob)}>重试</Button>}</div>{newestJob.providerText && <><p className="mt-3 text-xs text-slate-500">后台 ASR 结果</p><textarea className="textarea mt-1 min-h-32" value={newestJob.providerText} readOnly /><Button className="mt-2" size="sm" onClick={() => { const merged = newestJob.mergedText || [draft, newestJob.providerText].filter(Boolean).join('\n\n'); setDraft(merged); draftRef.current = merged }}>载入合并预览</Button></>}{newestJob.errorMessage && <p className="mt-2 text-amber-700">{newestJob.errorMessage}</p>}</div>}
      </Card>
      {summary && <Card className="p-5"><h2 className="font-semibold">访谈纪要草稿</h2><textarea className="textarea mt-3 min-h-52" value={summary} onChange={event => setSummary(event.target.value)} /><div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={() => void props.onArchiveText(selected, '访谈纪要', summary)}>保存到项目材料</Button><Button onClick={() => void props.onSave(selected, { summary, summaryTranscriptVersion: props.transcript?.version ?? null, status: '已结束' })}>确认并保存纪要</Button></div></Card>}
      <Card className="p-5"><div className="flex items-center justify-between"><h2 className="font-semibold">远程插问</h2>{props.prompts.some(item => item.status === '待确认') && <span className="rounded-full bg-rose-500 px-2 py-0.5 text-xs text-white">{props.prompts.filter(item => item.status === '待确认').length} 条新插问</span>}</div><div className="mt-3 flex flex-wrap gap-2"><input className="input min-w-64 flex-1" value={promptText} onChange={event => setPromptText(event.target.value)} placeholder="输入需由现场同事追问的问题…" /><Button variant="secondary" onClick={promptSpeech.state === 'listening' ? promptSpeech.stop : startPromptSpeech}>{promptSpeech.state === 'listening' ? '停止语音' : '语音'}</Button>{promptSpeech.state === 'listening' && <Button variant="secondary" className="text-rose-600" onClick={discardPromptSpeech}>放弃本次语音</Button>}{promptText && <Button variant="secondary" onClick={clearPrompt}>清空</Button>}<Button disabled={!promptText.trim()} onClick={async () => { await props.onSendPrompt(selected, promptText); clearPrompt() }}><Send className="h-4 w-4" />插问</Button></div>{promptSpeech.error && <p className="mt-2 text-xs text-amber-700">{promptSpeech.error}</p>}<div className="mt-4 space-y-2">{props.prompts.map(item => <div key={item.id} className="rounded-lg border p-3 text-sm"><div className="flex justify-between gap-3"><span>{item.content}</span><StatusBadge status={item.status} /></div>{item.response && <p className="mt-2 text-slate-500">答复：{item.response}</p>}{item.status === '待确认' && <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => void props.onConfirmPrompt(selected, item, '已确认')}>已追问</Button><Button size="sm" variant="secondary" onClick={() => void props.onConfirmPrompt(selected, item, '已忽略')}>忽略</Button></div>}</div>)}{!props.prompts.length && <p className="text-sm text-slate-400">暂无远程插问。</p>}</div></Card>
      <Card className="p-5"><h2 className="font-semibold">访谈产物</h2><div className="mt-3 grid gap-2 md:grid-cols-2">{products.map(item => <a key={item.id} className="rounded-lg border p-3 text-sm text-brand-700" href={`/api/projects/files/${item.fileId}/download`}>{item.kind}：{item.name}</a>)}{!products.length && <p className="text-sm text-slate-400">录音、转写稿和纪要将在此显示。</p>}</div></Card>
    </>}
    {selected && <Modal open={editOpen} title="编辑访谈安排" onClose={() => setEditOpen(false)} footer={<><Button variant="secondary" onClick={() => setEditOpen(false)}>取消</Button><Button onClick={async () => { await props.onSave(selected, editDraft); setEditOpen(false) }}>保存</Button></>}><div className="grid grid-cols-2 gap-4"><Field label="访谈名称" className="col-span-2"><input className="input" value={editDraft.title || ''} onChange={event => setEditDraft(value => ({ ...value, title: event.target.value }))} /></Field><Field label="形式"><select className="input" value={editDraft.mode || '现场'} onChange={event => setEditDraft(value => ({ ...value, mode: event.target.value as Interview['mode'] }))}><option>现场</option><option>远程</option></select></Field><Field label="状态"><select className="input" value={editDraft.status || '筹备中'} onChange={event => setEditDraft(value => ({ ...value, status: event.target.value as Interview['status'] }))}><option>筹备中</option><option>进行中</option><option>已结束</option></select></Field><Field label="计划时间"><input className="input" type="datetime-local" value={typeof editDraft.scheduledAt === 'string' ? editDraft.scheduledAt : ''} onChange={event => setEditDraft(value => ({ ...value, scheduledAt: event.target.value || null }))} /></Field><Field label="访谈对象/单位"><input className="input" value={editDraft.counterparty || ''} onChange={event => setEditDraft(value => ({ ...value, counterparty: event.target.value }))} /></Field><Field label="地点"><input className="input" value={editDraft.location || ''} onChange={event => setEditDraft(value => ({ ...value, location: event.target.value }))} /></Field><Field label="参与人（逗号分隔）"><input className="input" value={(editDraft.participantNames || []).join('，')} onChange={event => setEditDraft(value => ({ ...value, participantNames: event.target.value.split(/[，,]/).map(item => item.trim()).filter(Boolean) }))} /></Field><Field label="访谈议程" className="col-span-2"><textarea className="textarea min-h-24" value={editDraft.agenda || ''} onChange={event => setEditDraft(value => ({ ...value, agenda: event.target.value }))} /></Field><Field label="上传访谈纪要" className="col-span-2"><input className="input" type="file" accept=".doc,.docx,.pdf,.txt,.md" onChange={event => { const file = event.target.files?.[0]; if (file) void props.onUploadSummary(selected, file) }} /></Field></div></Modal>}
    <Modal open={orderOpen} title="管理访谈顺序" onClose={() => setOrderOpen(false)} footer={<><Button variant="secondary" onClick={() => setOrderOpen(false)}>取消</Button><Button onClick={async () => { await props.onReorder(order); setOrderOpen(false) }}>保存顺序</Button></>}><div className="space-y-2">{order.map(id => { const item = props.interviews.find(value => value.id === id); return item ? <div key={id} draggable onDragStart={() => setDragged(id)} onDragOver={event => event.preventDefault()} onDrop={() => { if (!dragged || dragged === id) return; const next = [...order]; const from = next.indexOf(dragged); const to = next.indexOf(id); next.splice(to, 0, next.splice(from, 1)[0]); setOrder(next); setDragged('') }} className="flex cursor-grab items-center gap-2 rounded-lg border p-3"><GripVertical className="h-4 w-4 text-slate-400" />{item.title}</div> : null })}</div></Modal>
  </div>
}
