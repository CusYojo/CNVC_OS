import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, Modal } from '../components/ui'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { committeeActionLabels, committeeCommand, committeeLabels, type CommitteeDefinition } from '../../server/src/contracts/fdeCommitteeContract'
import { shanghaiToday, shiftDate, weekStartFor } from '../../server/src/contracts/fdeWeeklyPlanContract'
import { committeePendingKey, forgetCommitteePending, markerForCommittee, readCommitteePending, reserveCommitteePending, validateCommitteeReceipt, validateCommitteeRecovery, type CommitteePending } from '../lib/fdeCommitteeRecovery'
import { CommitteeEditorEpoch, committeeEditorAccessFailure, committeeFormError, pinCommitteeEditorTarget, reconcileCommitteeEditor, type CommitteeEditorAccess, type CommitteeEditorAccessRequest, type CommitteeEditorTarget } from '../lib/fdeCommitteeEditor'
import { CommitteeCandidatePaging, CommitteeHistoryPanel, type CommitteeCandidateKind, type CommitteeOptionsPage } from '../components/FdeCommitteePaging'
import '../components/fde-workspace.css'

type Status = keyof typeof committeeLabels
type Row = { id: string; title: string; version: number; status: Status; startsAt: string; endsAt: string; sequenceYear: number | null; sequenceNumber: number | null; archivedAt: string | null; checkedAt: string | null }
type Source = { fileId: string; version: number; name: string; sha256: string; kind: 'material' | 'minutes' | 'resolution' | 'approval' }
type Agenda = { id: string; projectId: string; title: string; participantIds: string[]; minutes: string | null; resolutionNote: string | null; approvalId: string | null; canRecord: boolean; canLinkDecision: boolean; files: Source[] }
type Detail = Row & { hostUserId: string; hostName: string; materialCheckAt: string | null; ruleNote: string; people: Array<{ id: string; name: string; status: string }>; agendas: Agenda[]; partial: boolean;
  canReadHistory: boolean;
  notices: Array<{ id: string; kind: string; version: number; readAt: string | null }>; capabilities: Record<'save' | 'schedule' | 'check' | 'complete' | 'cancel' | 'archive', boolean> }
type Board = { rows: Row[]; total: number; page: number; pageSize: number; canCreate: boolean }
type Options = CommitteeOptionsPage
type ProjectOptions = { projects: Array<{ id: string; name: string }>; hasMore: boolean; page: number }
type RecordForm = { target: CommitteeEditorTarget; projectId: string; title: string; agendaId: string; minutes: string; minutesFile: { fileId: string; version: number } | null; resolutionNote: string; resolutionFile: { fileId: string; version: number } | null; approvalId: string | null }
type DecisionForm = Pick<RecordForm, 'target' | 'projectId' | 'title' | 'agendaId' | 'resolutionFile' | 'approvalId'>
type Confirmation = { action: 'schedule' | 'check_materials' | 'complete' | 'cancel' | 'archive'; target: CommitteeEditorTarget }
const localClock = (value: string) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16)
const timeLabel = (value: string | null) => value ? localClock(value).replace('T', ' ') : '未设置'
const sequence = (row: Row) => row.sequenceNumber ? `${row.sequenceYear} 年第 ${row.sequenceNumber} 次投决会` : '未分配年度编号 · 草案'
const fileKey = (ref: { fileId: string; version: number } | null) => ref ? `${ref.fileId}:${ref.version}` : ''
const bareFile = (ref?: { fileId: string; version: number }) => ref ? { fileId: ref.fileId, version: ref.version } : null
const message = committeeFormError

function FileSelect({ label, options, value, onChange, nullable = false }: { label: string; options: Options['files']; value: { fileId: string; version: number } | null; onChange: (value: { fileId: string; version: number } | null) => void; nullable?: boolean }) {
  return <label className="block space-y-1 text-xs">{label}<select className="input w-full" value={fileKey(value)} onChange={event => { const row = options.find(r => fileKey(r) === event.target.value); onChange(row ? { fileId: row.fileId, version: row.version } : null) }}><option value="">{nullable ? '暂不关联' : '请选择原件版本'}</option>{value && !options.some(r => fileKey(r) === fileKey(value)) && <option value={fileKey(value)}>已选版本不在当前候选页；提交前重新校验</option>}{options.filter(r => r.sha256).map(row => <option key={fileKey(row)} value={fileKey(row)}>{row.name} · v{row.version}</option>)}</select></label>
}

export function CommitteePage({ embedded = false }: { embedded?: boolean }) {
  const uid = useAuthStore(state => state.user?.id ?? '')
  return <CommitteeWorkspace key={uid} uid={uid} embedded={embedded} />
}

function CommitteeWorkspace({ uid, embedded }: { uid: string; embedded: boolean }) {
  const [params, setParams] = useSearchParams(), [board, setBoard] = useState<Board | null>(null), [detail, setDetail] = useState<Detail | null>(null)
  const [page, setPage] = useState(1), [view, setView] = useState('active'), [query, setQuery] = useState(''), [date, setDate] = useState(''), [week, setWeek] = useState(() => weekStartFor(shanghaiToday()))
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [pending, setPending] = useState<CommitteePending | null>(null), [storageError, setStorageError] = useState('')
  const [definition, setDefinition] = useState<CommitteeDefinition | null>(null), [editing, setEditing] = useState<CommitteeEditorTarget | null>(null)
  const [projectOptions, setProjectOptions] = useState<ProjectOptions | null>(null), [projectQuery, setProjectQuery] = useState(''), [projectPage, setProjectPage] = useState(1), [selectedProject, setSelectedProject] = useState('')
  const [options, setOptions] = useState<Record<string, Options>>({}), [record, setRecord] = useState<RecordForm | null>(null), [confirmation, setConfirmation] = useState<Confirmation | null>(null), [reason, setReason] = useState('')
  const [decision, setDecision] = useState<DecisionForm | null>(null), [editorAccess, setEditorAccess] = useState<CommitteeEditorAccess>('ready'), [candidateEpoch, setCandidateEpoch] = useState(0)
  const [knownPeople, setKnownPeople] = useState<Record<string, string>>({}), [fallbackSelection, setFallbackSelection] = useState('')
  const editorEpoch = useRef(new CommitteeEditorEpoch()), viewEpoch = useRef(new CommitteeEditorEpoch())
  const editorGate = useRef<CommitteeEditorAccess>('ready'), deferredFocus = useRef(false), revalidateRef = useRef<() => Promise<void>>(async () => {})
  const alive = useRef(true), working = useRef(false), pendingKey = committeePendingKey(uid)
  const current = useCallback(() => alive.current && useAuthStore.getState().user?.id === uid, [uid])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const loadPending = useCallback(() => { try { setPending(readCommitteePending(localStorage, pendingKey)); setStorageError('') } catch { setStorageError('恢复标识不可读或浏览器存储不可用，暂不能提交新操作。请保留现场，不要盲目重发。') } }, [pendingKey])
  useEffect(() => { loadPending(); const changed = (event: StorageEvent) => { if (event.key === pendingKey || event.key === null) loadPending() }; window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed) }, [loadPending, pendingKey])
  useEffect(() => {
    let valid = true; const token = viewEpoch.current.capture(uid, ''); setLoading(true); setBoard(null)
    const search = new URLSearchParams({ page: String(page), view, q: query }); if (date) search.set('date', date)
    const active = () => valid && current() && viewEpoch.current.accepts(token, uid, '')
    apiGet<Board>(`/committee?${search}`).then(value => { if (active()) { setBoard(value); setFallbackSelection(previous => previous || value.rows[0]?.id || '') } }).catch(e => { if (active()) setError(message(e)) }).finally(() => { if (active()) setLoading(false) })
    return () => { valid = false }
  }, [page, view, query, date, refresh, current])
  const selectedId = params.get('meeting') ?? fallbackSelection
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId
  useEffect(() => {
    let valid = true; const token = viewEpoch.current.capture(uid, ''); setDetail(null)
    const active = () => valid && current() && viewEpoch.current.accepts(token, uid, '')
    if (selectedId) apiGet<Detail>(`/committee/${selectedId}`).then(value => { if (active()) setDetail(value) }).catch(e => { if (active()) setError(message(e)) })
    return () => { valid = false }
  }, [selectedId, refresh, current])
  // Selection changes invalidate in-flight editor opens. Background refreshes
  // never replace the target/version captured by an already-open form.
  useEffect(() => { clearEditors() }, [selectedId])
  useEffect(() => { const focus = () => { void revalidateEditor() }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus) })
  useEffect(() => {
    let valid = true; const token = viewEpoch.current.capture(uid, ''); setProjectOptions(null)
    const active = () => valid && current() && viewEpoch.current.accepts(token, uid, '')
    if (definition && (editorAccess === 'ready' || editorAccess === 'conflict')) apiGet<ProjectOptions>(`/committee/options?${new URLSearchParams({ q: projectQuery, page: String(projectPage) })}`).then(value => { if (active()) setProjectOptions(value) }).catch(e => { if (active()) { setProjectOptions(null); handleEditorReadFailure(e) } })
    return () => { valid = false }
  }, [Boolean(definition), projectQuery, projectPage, current, editorAccess, candidateEpoch])
  const blocked = busy || Boolean(pending || storageError) || editorAccess !== 'ready'
  const editorHidden = editorAccess === 'checking' || editorAccess === 'hidden'
  const editorTarget = editing ?? record?.target ?? decision?.target ?? confirmation?.target ?? null
  function changeEditorAccess(value: CommitteeEditorAccess) { editorGate.current = value; setEditorAccess(value) }
  function clearProtectedViews() { viewEpoch.current.invalidate(); setBoard(null); setDetail(null); setOptions({}); setKnownPeople({}); setProjectOptions(null) }
  function clearEditors() { editorEpoch.current.invalidate(); setDefinition(null); setEditing(null); setRecord(null); setDecision(null); setConfirmation(null); setOptions({}); setKnownPeople({}); setProjectOptions(null); setReason(''); changeEditorAccess('ready') }
  function handleEditorReadFailure(error: unknown) {
    if (committeeEditorAccessFailure(error) === 'clear') { clearEditors(); clearProtectedViews(); setError('当前权限或来源已失效，已清理受保护的旧表单。') }
    else setError(message(error))
  }
  const acceptsEditor = (token: ReturnType<CommitteeEditorEpoch['begin']>) => current() && editorEpoch.current.accepts(token, uid, selectedRef.current)
  function mergeOptions(value: Options, kind: CommitteeCandidateKind | 'all' = 'all') {
    setOptions(previous => { const base = previous[value.projectId] ?? { projectId: value.projectId, people: [], files: [], approvals: [], pagination: {} }; return { ...previous, [value.projectId]: kind === 'all' ? value : { ...base, [kind]: value[kind], pagination: { ...base.pagination, [kind]: value.pagination[kind] } } } })
    setKnownPeople(previous => ({ ...previous, ...Object.fromEntries(value.people.map(person => [person.id, person.name])) }))
  }
  async function revalidateEditor() {
    if (working.current) { deferredFocus.current = true; return }
    clearProtectedViews()
    if (!definition && !record && !decision && !confirmation) { setRefresh(n => n + 1); return }
    const token = editorEpoch.current.begin(uid, selectedRef.current), target = editorTarget
    changeEditorAccess('checking'); setError('')
    const request: CommitteeEditorAccessRequest = { action: definition ? editing ? 'save' : 'create' : record ? 'record' : decision ? 'link_decision' : confirmation!.action,
      ...(target ? { meetingId: target.meetingId } : {}), ...(record || decision ? { agendaId: (record ?? decision)!.agendaId } : {}), projectIds: [], files: [], participants: [] }
    if (definition) for (const agenda of definition.agendas) { request.projectIds.push(agenda.projectId); request.files.push(...agenda.materials.map(ref => ({ ...ref, projectId: agenda.projectId }))); request.participants.push(...agenda.participantIds.map(userId => ({ userId, projectId: agenda.projectId }))) }
    if (record || decision) { const form = (record ?? decision)!; request.projectIds.push(form.projectId); for (const ref of [record?.minutesFile, form.resolutionFile]) if (ref) request.files.push({ ...ref, projectId: form.projectId }) }
    request.projectIds = [...new Set(request.projectIds)]
    try {
      const result = await apiPost('/committee/editor-access', request)
      if (!acceptsEditor(token)) return
      changeEditorAccess(reconcileCommitteeEditor(target, result)); setCandidateEpoch(n => n + 1); setRefresh(n => n + 1)
    } catch (e) {
      if (!acceptsEditor(token)) return
      if (committeeEditorAccessFailure(e) === 'clear') handleEditorReadFailure(e)
      else { changeEditorAccess('hidden'); setError(`未能核对当前权限，草稿暂时隐藏且不能提交：${message(e)}`) }
    }
  }
  revalidateRef.current = revalidateEditor
  function selectMeeting(id: string) { const next = new URLSearchParams(params); next.set('meeting', id); setParams(next) }
  async function runRead(work: () => Promise<void>) {
    if (working.current) return; working.current = true; setBusy(true); setError('')
    const token = editorEpoch.current.capture(uid, selectedRef.current)
    try { await work() } catch (e) { if (acceptsEditor(token)) { handleEditorReadFailure(e); loadPending() } } finally { working.current = false; if (current()) { setBusy(false); if (deferredFocus.current) { deferredFocus.current = false; void revalidateRef.current() } } }
  }
  async function addProjectAgenda() {
    if (!selectedProject || blocked) return
    const projectId = selectedProject, title = projectOptions?.projects.find(project => project.id === selectedProject)?.name ?? ''
    const token = editorEpoch.current.begin(uid, selectedId)
    await runRead(async () => { await loadOptions(projectId, token); if (acceptsEditor(token)) setDefinition(value => value ? { ...value, agendas: [...value.agendas, { id: crypto.randomUUID(), projectId, title, participantIds: [], materials: [] }] } : null) })
  }
  async function loadOptions(projectId: string, token: ReturnType<CommitteeEditorEpoch['begin']>) { const result = await apiGet<Options>(`/committee/options?projectId=${projectId}`); if (acceptsEditor(token)) mergeOptions(result); return result }
  function showCreate() { if (blocked) return; clearEditors(); setError(''); setProjectPage(1); setProjectQuery(''); setSelectedProject(''); setDefinition({ title: '', startsAt: '', endsAt: '', hostUserId: '', materialCheckAt: null, ruleNote: '', agendas: [] }) }
  async function showEdit() {
    if (!detail || blocked) return
    const token = editorEpoch.current.begin(uid, selectedId)
    await runRead(async () => { const latest = await apiGet<Detail>(`/committee/${detail.id}`); if (!acceptsEditor(token)) return; setDetail(latest); if (!latest.capabilities.save || latest.partial) throw new Error('会议或来源权限已变化，不能编辑')
      for (const id of [...new Set(latest.agendas.map(r => r.projectId))]) await loadOptions(id, token)
      if (!acceptsEditor(token)) return; setEditing(pinCommitteeEditorTarget(latest)); setKnownPeople(previous => ({ ...previous, ...Object.fromEntries(latest.people.map(person => [person.id, person.name])) })); setReason(''); setDefinition({ title: latest.title, hostUserId: latest.hostUserId, startsAt: localClock(latest.startsAt), endsAt: localClock(latest.endsAt), ruleNote: latest.ruleNote, materialCheckAt: latest.materialCheckAt ? localClock(latest.materialCheckAt) : null,
        agendas: latest.agendas.map(row => ({ id: row.id, projectId: row.projectId, title: row.title, participantIds: row.participantIds, materials: row.files.filter(r => r.kind === 'material').map(r => ({ fileId: r.fileId, version: r.version })) })) }) })
  }
  async function showRecord(agenda: Agenda) {
    if (blocked || !detail) return
    const token = editorEpoch.current.begin(uid, selectedId)
    await runRead(async () => { const latest = await apiGet<Detail>(`/committee/${detail.id}`); if (!acceptsEditor(token)) return; setDetail(latest); const row = latest.agendas.find(r => r.id === agenda.id); if (!row?.canRecord) throw new Error('当前议题已不可办理'); await loadOptions(row.projectId, token); if (!acceptsEditor(token)) return
      setReason(''); setRecord({ target: pinCommitteeEditorTarget(latest), projectId: row.projectId, title: row.title, agendaId: row.id, minutes: row.minutes ?? '', minutesFile: bareFile(row.files.find(r => r.kind === 'minutes')), resolutionNote: row.resolutionNote ?? '', resolutionFile: bareFile(row.files.find(r => r.kind === 'resolution')), approvalId: row.approvalId }) })
  }
  async function showDecision(agenda: Agenda) {
    if (blocked || !detail) return
    const token = editorEpoch.current.begin(uid, selectedId)
    await runRead(async () => { const latest = await apiGet<Detail>(`/committee/${detail.id}`); if (!acceptsEditor(token)) return; setDetail(latest); const row = latest.agendas.find(r => r.id === agenda.id); if (!row?.canLinkDecision) throw new Error('该议题当前不能追加正式审批'); await loadOptions(row.projectId, token); if (!acceptsEditor(token)) return
      setReason(''); setDecision({ target: pinCommitteeEditorTarget(latest), projectId: row.projectId, title: row.title, agendaId: row.id, resolutionFile: null, approvalId: null }) })
  }
  async function submit(raw: unknown) {
    if (blocked || working.current || editorGate.current !== 'ready') return
    const commandSelection = selectedRef.current
    let command: ReturnType<typeof committeeCommand.parse>
    try { command = committeeCommand.parse(raw) } catch (e) { setError(message(e)); return }
    await runRead(async () => {
      if (!current()) return
      const marker = markerForCommittee(command)
      await reserveCommitteePending(navigator.locks, localStorage, pendingKey, marker)
      if (!current()) return
      setPending(marker)
      const receipt = validateCommitteeReceipt(await apiPost('/committee/commands', command), marker)
      if (!current()) return
      forgetCommitteePending(localStorage, pendingKey, marker); setPending(null); clearEditors(); setDetail(null)
      setNotice(`${committeeActionLabels[receipt.action]}已提交（版本 ${receipt.version}）。会议状态不代表投资审批通过。`); if (selectedRef.current === commandSelection) selectMeeting(receipt.meetingId); setRefresh(n => n + 1)
    })
  }
  async function recover() {
    if (working.current || !pending) return
    const recoverySelection = selectedRef.current
    await runRead(async () => { const marker = readCommitteePending(localStorage, pendingKey); if (!marker) throw new Error('恢复标识已变化，请刷新')
      const result = validateCommitteeRecovery(await apiPost('/committee/commands/recover', { commandId: marker.commandId }), marker)
      if (!current()) return
      forgetCommitteePending(localStorage, pendingKey, marker); setPending(null); clearEditors(); setDetail(null)
      setNotice(result.state === 'committed' ? '原操作已提交，已恢复原回执；没有重复办理。' : '原请求未提交且已封闭，请读取最新状态后重新填写并确认。')
      if (result.receipt && selectedRef.current === recoverySelection) selectMeeting(result.receipt.meetingId)
      setRefresh(n => n + 1)
    })
  }
  const recordOptions = record ? options[record.projectId] : undefined, decisionOptions = decision ? options[decision.projectId] : undefined
  const names = new Map(Object.entries(knownPeople))
  const participants = [...new Set(definition?.agendas.flatMap(row => row.participantIds) ?? [])]
  function updateAgenda(id: string, patch: Partial<CommitteeDefinition['agendas'][number]>) { setDefinition(value => value ? { ...value, agendas: value.agendas.map(row => row.id === id ? { ...row, ...patch } : row) } : null) }
  const editorFeedback = <div className="mb-4 space-y-2">{(error || storageError) && <p role="alert" className="break-words rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error || storageError}</p>}{pending && <div className="rounded-lg bg-amber-50 p-3 text-sm"><p>上一笔操作结果待核对，暂不能再次提交。</p><Button size="sm" variant="secondary" loading={busy} onClick={() => void recover()}>核对上一笔操作</Button></div>}{editorAccess === 'conflict' && <p role="alert" className="text-sm text-amber-800">原会议版本或可办理状态已变化。已保留输入，但不会套用新版本提交；请关闭后读取最新状态并重新确认。</p>}{editorHidden && <div className="rounded-lg bg-slate-50 p-3 text-sm"><p>{editorAccess === 'checking' ? '正在核对当前权限，暂时隐藏草稿内容…' : '草稿暂存于本页内存，当前不可展示或提交。'}</p><Button size="sm" variant="secondary" disabled={editorAccess === 'checking'} onClick={() => void revalidateEditor()}>重新核对权限</Button></div>}{editorTarget && !editorHidden && <p className="text-xs text-slate-500">本表单固定会议版本 v{editorTarget.expectedVersion}；后台刷新不会改变提交版本。</p>}</div>
  return <div className="fde-workspace fde-committee-workspace space-y-5">
    {!editorHidden && <><header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-[22px] font-semibold">投决管理</h1><p className="mt-1 text-sm text-slate-500">排期、议题材料、纪要与正式决议关联；按项目及原件权限分别可见。</p></div><div className="flex gap-2">{!embedded && <Link className="text-sm text-[#315f68] self-center" to="/collaboration">返回协同中心</Link>}<Button disabled={blocked || !board?.canCreate} onClick={showCreate}>＋ 安排投决会</Button><Button variant="secondary" disabled={busy} onClick={() => { setRefresh(n => n + 1); loadPending() }}>刷新</Button></div></header>
    {(error || storageError) && <div role="alert" className="break-words rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error || storageError}</div>}
    {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
    {pending && <Card className="p-4"><p className="text-sm">上一笔“{committeeActionLabels[pending.action]}”尚待核对，暂不能提交新操作。恢复仅查询原回执或封闭未提交请求。</p><Button className="mt-3" loading={busy} onClick={() => void recover()}>核对上一笔操作</Button></Card>}
    <Card className="fde-panel p-4"><div className="mb-3 flex flex-wrap items-center gap-3"><Button variant="ghost" size="sm" onClick={() => setWeek(shiftDate(week, -7))}>上一周</Button><span className="text-sm">{week} — {shiftDate(week, 6)}</span><Button variant="ghost" size="sm" onClick={() => setWeek(shiftDate(week, 7))}>下一周</Button><Button variant="ghost" size="sm" onClick={() => { setDate(''); setPage(1) }}>全部日期</Button></div><div className="grid grid-cols-7 gap-2">{['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label, i) => { const day = shiftDate(week, i); return <button key={day} aria-pressed={date === day} className={`rounded-lg border py-3 text-center ${date === day ? 'border-[#315f68] bg-[#e6f0ef] text-[#315f68]' : 'border-slate-100 bg-slate-50 text-slate-500'}`} onClick={() => { setDate(day); setPage(1) }}><span className="block text-xs">{label}</span><strong className="mt-1 block text-lg">{day.slice(-2)}</strong></button> })}</div></Card>
    {detail && <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_290px]"><Card className="fde-panel p-5"><div className="mb-4 flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs text-slate-500">{sequence(detail)}</p><h2 className="mt-1 text-lg font-semibold">{detail.title}</h2></div><Badge tone={detail.status === 'completed' ? 'green' : detail.status === 'cancelled' ? 'slate' : 'blue'}>{detail.archivedAt ? '已归档 · ' : ''}{committeeLabels[detail.status]}</Badge></div>{detail.partial && <p className="mb-3 text-xs text-amber-700">仅显示当前账号有权读取的议题；未展示的议题及人员不会向你授权。</p>}
      {detail.agendas.map(agenda => <article key={agenda.id} className="space-y-3 border-t border-slate-100 py-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{agenda.title}</h3><Link className="text-xs text-[#315f68]" to={`/projects/${agenda.projectId}`}>查看项目 →</Link></div><p className="text-xs text-slate-500">议题参会人：{agenda.participantIds.map(id => { const person = detail.people.find(r => r.id === id); return person ? `${person.name}${person.status !== '启用' ? '（已停用）' : ''}` : '原账号不可用' }).join('、')}</p>
        <div className="space-y-2">{agenda.files.map(source => <div key={`${source.kind}:${fileKey(source)}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2 text-xs"><Badge>{{ material: '会前材料', minutes: '纪要原件', resolution: '正式决议', approval: '审批冻结材料' }[source.kind]}</Badge><span className="min-w-0 break-all">{source.name} · v{source.version}</span><a className="ml-auto text-[#315f68]" href={`/api/committee/${detail.id}/agendas/${agenda.id}/files/${source.fileId}/${source.version}/preview`} target="_blank" rel="noreferrer">查看原件</a></div>)}{!agenda.files.length && <p className="text-xs text-amber-700">尚未关联会前原件，请从项目文件选择明确版本。</p>}</div>
        {agenda.minutes && <div className="whitespace-pre-wrap rounded-lg border border-slate-100 p-3 text-sm"><h4 className="mb-2 font-medium">议题纪要</h4>{agenda.minutes}{agenda.resolutionNote && <p className="mt-3">{agenda.resolutionNote}</p>}</div>}
        {agenda.approvalId ? <Link className="block text-xs text-[#315f68]" to={`/workflow?view=completed&request=${agenda.approvalId}`}>查看关联正式审批 →</Link> : <p className="text-xs text-slate-500">尚未关联已通过的正式投决审批；不能据会议状态认定投决通过。</p>}
        {agenda.canRecord && <Button size="sm" variant="secondary" disabled={blocked} onClick={() => void showRecord(agenda)}>记录纪要与决议</Button>}{agenda.canLinkDecision && <Button size="sm" variant="secondary" disabled={blocked} onClick={() => void showDecision(agenda)}>追加正式审批关联</Button>}
      </article>)}</Card><aside className="space-y-4"><Card className="fde-panel space-y-3 p-5"><h3 className="font-semibold">参会与办理</h3><p className="text-xs text-slate-500">主持人 <strong className="ml-2 text-slate-700">{detail.hostName}</strong></p><p className="text-xs">{timeLabel(detail.startsAt)} 至 {timeLabel(detail.endsAt)}</p><p className="text-xs text-slate-500">材料检查时点：{timeLabel(detail.materialCheckAt)}</p><p className="text-xs text-slate-500">最近人工核对：{timeLabel(detail.checkedAt)}</p><p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs">{detail.ruleNote}</p><p className="text-xs text-slate-500">本版本未启用线上逐票表决。年度编号仅在首次排期或跨年改期时分配，不代表项目审批编号。</p>
        <div className="flex flex-wrap gap-2">{detail.capabilities.save && <Button size="sm" variant="secondary" disabled={blocked} onClick={() => void showEdit()}>编辑 / 改期</Button>}{([['schedule', 'schedule'], ['check', 'check_materials'], ['complete', 'complete'], ['cancel', 'cancel'], ['archive', 'archive']] as const).map(([cap, command]) => detail.capabilities[cap] && <Button key={command} size="sm" variant={command === 'cancel' ? 'danger' : 'secondary'} disabled={blocked} onClick={() => { setReason(''); setConfirmation({ action: command, target: pinCommitteeEditorTarget(detail) }); changeEditorAccess('ready'); editorEpoch.current.invalidate() }}>{committeeActionLabels[command]}</Button>)}</div>
        {detail.notices.map(row => <div key={row.id} className="flex flex-wrap items-center gap-2 text-xs"><span>站内通知 · v{row.version} · {row.readAt ? '已读' : '未读'}</span>{!row.readAt && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void runRead(async () => { await apiPost(`/committee/${detail.id}/notices/${row.id}/read`, {}); if (current()) setRefresh(n => n + 1) })}>标为已读</Button>}</div>)}</Card>
        <Card className="fde-panel p-5"><h3 className="mb-3 font-semibold">办理历史</h3>{detail.canReadHistory ? <CommitteeHistoryPanel key={detail.id} meetingId={detail.id} version={detail.version} /> : <p className="text-xs text-slate-500">当前账号无完整历史来源权限。</p>}</Card></aside></div>}
    <Card className="fde-panel overflow-hidden"><div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4"><h2 className="mr-auto font-semibold">会议排期</h2><input className="input" aria-label="搜索会议标题" placeholder="搜索会议标题" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} /><select className="input" aria-label="会议归档范围" value={view} onChange={event => { setView(event.target.value); setPage(1) }}><option value="active">未归档会议</option><option value="archived">已归档会议</option><option value="all">全部有权会议</option></select></div><div className="overflow-x-auto"><table className="fde-plan-table"><thead><tr><th>会议</th><th>日期时间（上海）</th><th>材料核对</th><th>状态</th><th>操作</th></tr></thead><tbody>{board?.rows.map(row => <tr key={row.id}><td><strong>{row.title}</strong><p className="mt-1 text-slate-400">{sequence(row)}</p></td><td>{timeLabel(row.startsAt)}<br />至 {timeLabel(row.endsAt)}</td><td>{row.checkedAt ? timeLabel(row.checkedAt) : '待核对'}</td><td>{row.archivedAt ? '已归档 · ' : ''}{committeeLabels[row.status]}</td><td><Button size="sm" variant="ghost" onClick={() => selectMeeting(row.id)}>查看</Button></td></tr>)}</tbody></table></div>{!board?.rows.length && <p className="p-8 text-center text-sm text-slate-500">{loading ? '正在读取投决会…' : board ? '当前范围暂无有权读取的会议。' : '尚未读取到会议，请查看错误信息或刷新。'}</p>}<div className="flex items-center justify-between gap-3 p-4 text-xs text-slate-500"><span>共 {board?.total ?? '—'} 场 · 第 {page} 页</span><div className="flex gap-2"><Button size="sm" variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage(n => n - 1)}>上一页</Button><Button size="sm" variant="ghost" disabled={!board || page * board.pageSize >= board.total || loading} onClick={() => setPage(n => n + 1)}>下一页</Button></div></div></Card>
    </>}
    <Modal open={Boolean(definition)} title={editing ? '编辑投决会 / 改期' : '安排投决会草案'} width="max-w-4xl" onClose={() => { if (!busy) clearEditors() }} footer={<><Button variant="secondary" disabled={busy} onClick={clearEditors}>关闭</Button><Button disabled={blocked} onClick={() => void submit({ commandId: crypto.randomUUID(), action: editing ? 'save' : 'create', ...(editing ?? {}), reason, definition })}>保存草案 / 修改</Button></>}>
      {editorFeedback}{definition && !editorHidden && <div className="space-y-5"><label className="block text-sm">会议名称<input className="input mt-1 w-full" value={definition.title} onChange={e => setDefinition({ ...definition, title: e.target.value })} /></label><div className="grid gap-3 sm:grid-cols-2">{(['startsAt', 'endsAt'] as const).map(key => <label key={key} className="text-sm">{key === 'startsAt' ? '开始时间（上海）' : '结束时间（上海）'}<input className="input mt-1 w-full" type="datetime-local" value={definition[key]} onChange={e => setDefinition({ ...definition, [key]: e.target.value })} /></label>)}</div><label className="block text-sm">材料检查时点（可不设置，不默认提前 24 小时）<input className="input mt-1 w-full" type="datetime-local" value={definition.materialCheckAt ?? ''} onChange={e => setDefinition({ ...definition, materialCheckAt: e.target.value || null })} /></label><label className="block text-sm">会议办理与表决规则说明<textarea className="input mt-1 min-h-20 w-full" value={definition.ruleNote} placeholder="填写已确认的会议规则；仅记录说明，不启用线上投票" onChange={e => setDefinition({ ...definition, ruleNote: e.target.value })} /></label>
        {definition.agendas.map((agenda, i) => { const candidates = options[agenda.projectId]; return <fieldset key={agenda.id} className="space-y-3 rounded-lg border border-slate-200 p-4"><legend className="px-2 text-sm font-semibold">议题 {i + 1}</legend><div className="flex justify-between gap-2"><Link className="text-xs text-[#315f68]" to={`/projects/${agenda.projectId}`} target="_blank">查看议题项目</Link><Button size="sm" variant="danger" onClick={() => setDefinition({ ...definition, agendas: definition.agendas.filter(r => r.id !== agenda.id) })}>移除议题</Button></div><label className="block text-sm">议题标题<input className="input mt-1 w-full" value={agenda.title} onChange={e => updateAgenda(agenda.id, { title: e.target.value })} /></label><div><CommitteeCandidatePaging key={`people:${agenda.id}:${candidateEpoch}`} projectId={agenda.projectId} kind="people" label="参会账号" onFailure={handleEditorReadFailure} onPage={value => mergeOptions(value, 'people')} /><p className="mb-2 mt-2 text-xs font-medium">明确指定本议题参会账号</p><div className="mb-2 flex flex-wrap gap-2">{agenda.participantIds.map(id => <button type="button" key={id} className="rounded bg-slate-100 px-2 py-1 text-xs" onClick={() => updateAgenda(agenda.id, { participantIds: agenda.participantIds.filter(value => value !== id) })}>已选 {names.get(id) ?? '账号不可用'} ×</button>)}</div><div className="flex flex-wrap gap-3">{candidates?.people.map(person => <label key={person.id} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={agenda.participantIds.includes(person.id)} onChange={e => updateAgenda(agenda.id, { participantIds: e.target.checked ? [...agenda.participantIds, person.id] : agenda.participantIds.filter(id => id !== person.id) })} />{person.name}</label>)}</div></div><CommitteeCandidatePaging key={`files:${agenda.id}:${candidateEpoch}`} projectId={agenda.projectId} kind="files" label="会前原件版本" onFailure={handleEditorReadFailure} onPage={value => mergeOptions(value, 'files')} /><FileSelect label="添加会前原件（选择明确版本）" options={candidates?.files ?? []} value={null} onChange={ref => { if (ref) updateAgenda(agenda.id, { materials: [...agenda.materials.filter(r => r.fileId !== ref.fileId), ref] }) }} />{agenda.materials.map(ref => <div key={ref.fileId} className="flex items-center justify-between gap-2 text-xs"><span className="break-all">{candidates?.files.find(r => fileKey(r) === fileKey(ref))?.name ?? '当前不可用原件'} · 版本 {ref.version}</span><Button size="sm" variant="ghost" onClick={() => updateAgenda(agenda.id, { materials: agenda.materials.filter(r => r.fileId !== ref.fileId) })}>移除</Button></div>)}</fieldset> })}
        <Card className="space-y-3 p-4"><label className="block text-sm">搜索可办理的投资项目<input className="input mt-1 w-full" value={projectQuery} onChange={e => { setProjectQuery(e.target.value); setProjectPage(1); setSelectedProject('') }} /></label><select className="input w-full" aria-label="选择新增议题项目" value={selectedProject} onChange={e => setSelectedProject(e.target.value)}><option value="">请选择项目</option>{projectOptions?.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" disabled={busy || !selectedProject} onClick={() => void addProjectAgenda()}>添加项目议题</Button><Button size="sm" variant="ghost" disabled={projectPage === 1} onClick={() => setProjectPage(n => n - 1)}>上一页项目</Button><Button size="sm" variant="ghost" disabled={!projectOptions?.hasMore} onClick={() => setProjectPage(n => n + 1)}>下一页项目</Button></div></Card>
        <label className="block text-sm">主持人（须明确加入至少一个议题）<select className="input mt-1 w-full" value={definition.hostUserId} onChange={e => setDefinition({ ...definition, hostUserId: e.target.value })}><option value="">请选择已选参会账号</option>{participants.map(id => <option key={id} value={id}>{names.get(id) ?? '原账号不可用'}</option>)}</select></label><label className="block text-sm">本次保存 / 改期原因<textarea className="input mt-1 min-h-20 w-full" value={reason} onChange={e => setReason(e.target.value)} placeholder="至少五个字" /></label><p className="text-xs text-slate-500">改期会重新校验所有参会人的时间占用，并使既有材料检查失效。已记录纪要后不能覆盖排期及议题。</p>
      </div>}
    </Modal>
    <Modal open={Boolean(record)} title="记录议题纪要与正式决议" width="max-w-3xl" onClose={() => { if (!busy) clearEditors() }} footer={<><Button variant="secondary" disabled={busy} onClick={clearEditors}>关闭</Button><Button disabled={blocked || !recordOptions} onClick={() => { if (record) { const { target, title: _title, projectId: _projectId, ...fields } = record; void submit({ ...fields, ...target, commandId: crypto.randomUUID(), action: 'record', reason }) } }}>保存议题记录</Button></>}>
      {editorFeedback}{record && !editorHidden && <div className="space-y-4"><p className="text-sm font-medium">{record.title}</p><CommitteeCandidatePaging key={`record-files:${record.agendaId}:${candidateEpoch}`} projectId={record.projectId} kind="files" label="议题原件版本" onFailure={handleEditorReadFailure} onPage={value => mergeOptions(value, 'files')} /><CommitteeCandidatePaging key={`record-approvals:${record.agendaId}:${candidateEpoch}`} projectId={record.projectId} kind="approvals" label="正式审批" onFailure={handleEditorReadFailure} onPage={value => mergeOptions(value, 'approvals')} /><label className="block text-sm">实际会议纪要<textarea className="input mt-1 min-h-28 w-full" value={record.minutes} onChange={e => setRecord({ ...record, minutes: e.target.value })} /></label><FileSelect label="纪要原件版本（必填）" options={recordOptions?.files ?? []} value={record.minutesFile} onChange={ref => setRecord({ ...record, minutesFile: ref })} /><label className="block text-sm">决议说明<textarea className="input mt-1 min-h-20 w-full" value={record.resolutionNote} onChange={e => setRecord({ ...record, resolutionNote: e.target.value })} /></label><FileSelect label="正式决议原件版本（与审批同时关联）" nullable options={recordOptions?.files ?? []} value={record.resolutionFile} onChange={ref => setRecord({ ...record, resolutionFile: ref })} /><label className="block text-sm">对应正式投决审批<select className="input mt-1 w-full" value={record.approvalId ?? ''} onChange={e => setRecord({ ...record, approvalId: e.target.value || null })}><option value="">暂不关联，仅记录纪要</option>{record.approvalId && !recordOptions?.approvals.some(row => row.id === record.approvalId) && <option value={record.approvalId}>已选审批不在当前候选页</option>}{recordOptions?.approvals.map(row => <option key={row.id} value={row.id}>{row.requestNo} · {row.title}</option>)}</select></label><p className="text-xs text-slate-500">仅列同项目已通过的“投决 → 打款”审批。进入投决阶段的审批不能作为投决通过证明；本操作不修改审批或项目状态。</p><label className="block text-sm">记录原因<textarea className="input mt-1 min-h-20 w-full" value={reason} onChange={e => setReason(e.target.value)} placeholder="至少五个字" /></label></div>}
    </Modal>

    <Modal open={Boolean(decision)} title="追加正式投决审批关联" width="max-w-3xl" onClose={() => { if (!busy) clearEditors() }} footer={<><Button variant="secondary" disabled={busy} onClick={clearEditors}>关闭</Button><Button disabled={blocked || !decisionOptions} onClick={() => { if (decision) void submit({ ...decision.target, commandId: crypto.randomUUID(), action: 'link_decision', agendaId: decision.agendaId, approvalId: decision.approvalId, resolutionFile: decision.resolutionFile, reason }) }}>确认追加关联</Button></>}>
      {editorFeedback}{decision && !editorHidden && <div className="space-y-4"><p className="text-sm font-medium">{decision.title}</p><p className="text-sm text-slate-500">仅在归档前追加一次已通过的正式审批及决议原件；保留原纪要、记录人、确认时间和原文件。不能更换已关联决议，不改变项目或审批状态。</p>
        <CommitteeCandidatePaging key={`decision-files:${decision.agendaId}:${candidateEpoch}`} projectId={decision.projectId} kind="files" label="决议原件版本" onFailure={handleEditorReadFailure} onPage={value => mergeOptions(value, 'files')} />
        <FileSelect label="正式决议原件版本" options={decisionOptions?.files ?? []} value={decision.resolutionFile} onChange={ref => setDecision({ ...decision, resolutionFile: ref })} />
        <CommitteeCandidatePaging key={`decision-approvals:${decision.agendaId}:${candidateEpoch}`} projectId={decision.projectId} kind="approvals" label="会后正式审批" onFailure={handleEditorReadFailure} onPage={value => mergeOptions(value, 'approvals')} />
        <label className="block text-sm">已通过的正式投决审批<select className="input mt-1 w-full" value={decision.approvalId ?? ''} onChange={e => setDecision({ ...decision, approvalId: e.target.value || null })}><option value="">请选择同项目已通过的投决→打款审批</option>{decision.approvalId && !decisionOptions?.approvals.some(row => row.id === decision.approvalId) && <option value={decision.approvalId}>已选审批不在当前候选页</option>}{decisionOptions?.approvals.map(row => <option key={row.id} value={row.id}>{row.requestNo} · {row.title}</option>)}</select></label>
        <label className="block text-sm">追加关联原因<textarea className="input mt-1 min-h-24 w-full" value={reason} onChange={e => setReason(e.target.value)} placeholder="至少五个字" /></label></div>}
    </Modal>
    <Modal open={Boolean(confirmation)} title={confirmation ? committeeActionLabels[confirmation.action] : ''} onClose={() => { if (!busy) clearEditors() }} footer={<><Button variant="secondary" disabled={busy} onClick={clearEditors}>返回</Button><Button disabled={blocked} onClick={() => { if (confirmation) void submit({ ...confirmation.target, commandId: crypto.randomUUID(), action: confirmation.action, reason }) }}>确认办理</Button></>}>{editorFeedback}{!editorHidden && <><p className="mb-4 text-sm">{confirmation?.action === 'cancel' ? '取消后将移除日历占用，并保留会议记录。' : confirmation?.action === 'archive' ? '归档后会议仅供查看。' : confirmation?.action === 'complete' ? '请确认纪要和相关材料已齐全。' : '请核对参会人和相关材料。'}</p><label className="block text-sm">办理原因<textarea className="input mt-1 min-h-24 w-full" value={reason} onChange={e => setReason(e.target.value)} placeholder="至少五个字" /></label></>}</Modal>
  </div>
}
