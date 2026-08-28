import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { approvalCenterReturnPath } from '../../server/src/contracts/fdeApprovalCenterContract'
import { typeRuntimeCommand, typeRuntimeEffectiveDeadline, type TypeRuntimeCommand, type TypeRuntimeView } from '../../server/src/contracts/fdeTypeRuntimeContract'
import { apiGet, apiPost } from '../lib/api'
import { readTypeRuntimePending, typeRuntimeMarker, typeRuntimePendingKey, verifyTypeRuntimeReceipt, verifyTypeRuntimeRecovery, type TypeRuntimePending } from '../lib/fdeTypeRuntimeRecovery'
import { useAuthStore } from '../store/useAuthStore'
import type { Project, ProjectFile } from '../types'
import { Badge, Button, Card } from './ui'
import './fde-workspace.css'
import { shortProjectDate } from '../lib/projectDetailPresentation'

const statuses = { draft: '计划草稿', plan_review: '计划审核中', active: '阶段执行中', stage_review: '阶段审核中', closed: '已结案' }
const explain = (e: unknown) => e && typeof e === 'object' && 'issues' in e ? (e.issues as Array<{ message: string }>).map(v => v.message).join('；') : (e as Error).message
type Props = { project: Project; files: ProjectFile[]; onChanged: () => unknown }
export function FdeTypeRuntimePanel(props: Props) { const uid = useAuthStore(s => s.user?.id ?? ''); return <RuntimePanel key={`${uid}:${props.project.id}`} {...props} uid={uid} /> }
function RuntimePanel({ project, files, onChanged, uid }: Props & { uid: string }) {
  const [searchParams] = useSearchParams(), requestedReview = searchParams.get('typeReview'), returnCenter = searchParams.get('center')
  const [focusReview, setFocusReview] = useState(requestedReview)
  useEffect(() => { setFocusReview(requestedReview); setPage(1) }, [requestedReview])
  const root = `/projects/${project.id}/type-execution`, key = typeRuntimePendingKey(uid, project.id)
  const [data, setData] = useState<TypeRuntimeView | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [page, setPage] = useState(1), [reload, setReload] = useState(0), [pending, setPending] = useState<TypeRuntimePending | null>(null), [ready, setReady] = useState(false)
  const [target, setTarget] = useState(project.targetDate ?? ''), [cycle, setCycle] = useState(project.cycleDays ?? 15)
  const [selections, setSelections] = useState<Record<string, { userId: string; dueTime: string }>>({}), [reason, setReason] = useState(''), [result, setResult] = useState('')
  const [materials, setMaterials] = useState<Record<string, { value: string; reason: string }>>({})
  const mounted = useRef(true), writing = useRef(false), generation = useRef(0)
  const current = () => mounted.current && useAuthStore.getState().user?.id === uid
  const readMarker = () => { try { setPending(readTypeRuntimePending(sessionStorage, key)); setReady(true) } catch { setReady(false); setError('恢复标识不可读，已阻止写入。请先恢复浏览器存储并核对原请求。') } }
  useEffect(() => { mounted.current = true; readMarker(); const focus = () => { if (!writing.current) { readMarker(); setReload(n => n + 1) } }; window.addEventListener('focus', focus); return () => { mounted.current = false; generation.current++; window.removeEventListener('focus', focus) } }, [])
  useEffect(() => {
    const seq = ++generation.current; setData(null)
    void apiGet<TypeRuntimeView>(`${root}?page=${page}${focusReview ? `&review=${encodeURIComponent(focusReview)}` : ''}`).then(value => {
      if (!current() || seq !== generation.current) return
      setData(value); setError(''); setMaterials({})
      if (page === 1) {
        const plan = value.instance?.plan, config = plan?.configuration ?? value.preparation?.configuration
        setTarget(plan?.targetDate ?? project.targetDate ?? ''); setCycle(plan?.cycleDays ?? config?.cycleDays[0] ?? 15)
        setSelections(Object.fromEntries((config?.actions ?? []).map(a => {
          const saved = plan?.actions.find(s => s.key === a.key), candidates = value.people.filter(p => p.duties.includes(a.duty))
          return [a.key, { userId: saved?.ownerUserId ?? (candidates.length === 1 ? candidates[0].id : ''), dueTime: saved?.dueTime ?? '' }]
        })))
      }
    }).catch(e => { if (current() && seq === generation.current) setError(explain(e)) })
    return () => { generation.current++ }
  }, [page, reload, project.version, focusReview])
  const blocked = busy || !ready || Boolean(pending)
  async function finish(message: string) { sessionStorage.removeItem(key); if (!current()) return; setPending(null); setReason(''); setError(''); setNotice(message); setPage(1); setReload(n => n + 1); await onChanged() }
  async function execute(body: Record<string, unknown>) {
    if (!data || blocked || writing.current) return
    let command: TypeRuntimeCommand, marker: TypeRuntimePending
    try { command = typeRuntimeCommand.parse({ ...body, commandId: crypto.randomUUID(), expectedVersion: data.instance?.version ?? 0, reason }); marker = typeRuntimeMarker(project.id, command); sessionStorage.setItem(key, JSON.stringify(marker)); setPending(marker) } catch (e) { setError(explain(e)); return }
    writing.current = true; setBusy(true); setError(''); setNotice('')
    try { verifyTypeRuntimeReceipt(await apiPost(`${root}/commands`, command), marker); await finish('操作已持久化，已重新读取执行状态。') }
    catch (e) { if (current()) setError(`${explain(e)}；请核对原请求结果，不要重复发起。`) }
    finally { writing.current = false; if (current()) setBusy(false) }
  }
  async function recover() {
    if (!pending || writing.current) return
    writing.current = true; setBusy(true)
    try { const r = verifyTypeRuntimeRecovery(await apiPost(`${root}/commands/recover`, { commandId: pending.commandId }), pending); await finish(r.state === 'committed' ? '原操作已提交，已恢复同一结果。' : '原操作未提交且已封闭，可重新核对后发起。') }
    catch (e) { if (current()) setError(explain(e)) } finally { writing.current = false; if (current()) setBusy(false) }
  }
  const instance = data?.instance, config = instance?.plan.configuration ?? data?.preparation?.configuration
  const unsaved = Boolean(instance && (target !== instance.plan.targetDate || cycle !== instance.plan.cycleDays || instance.plan.actions.some(a => a.ownerUserId !== selections[a.key]?.userId || (a.dueTime ?? '') !== (selections[a.key]?.dueTime ?? ''))))
  const stage = config?.stages.find(s => s.key === instance?.stageKey), active = data?.reviews.find(r => r.status === 'reviewing')
  const savePlan = () => { if (!data?.preparation) return; void execute({ action: 'save_plan', plan: { expectedProjectVersion: data.projectVersion, expectedGovernanceVersion: data.governanceVersion, expectedPolicyVersionId: data.preparation.policyVersionId, expectedPolicySha256: data.preparation.policySha256, cycleDays: cycle, targetDate: target, selections: (config?.actions ?? []).map(a => ({ actionKey: a.key, userId: selections[a.key]?.userId ?? '', dueTime: selections[a.key]?.dueTime || null })) } }) }
  const submitStage = () => { if (!data || !stage) return; try {
    const list = stage.materials.map(m => { const chosen = materials[m.key]; if (chosen?.value === 'waiver') return { requirementKey: m.key, kind: 'waiver', reason: chosen.reason }; const file = files.find(f => f.id === chosen?.value); if (!file) throw new Error(`请选择“${m.label}”的真实文件版本`); return { requirementKey: m.key, kind: 'file', fileId: file.id, version: file.version } })
    void execute({ action: 'submit_stage', stageKey: stage.key, expectedGovernanceVersion: data.governanceVersion, result, materials: list })
  } catch (e) { setError(explain(e)) } }
  return <Card className="fde-workspace fde-detail-type-flow space-y-4 p-5">
    {returnCenter !== null && <Link className="text-sm text-[#315f68]" to={approvalCenterReturnPath(returnCenter)}>返回统一审批中心</Link>}
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">流程推进</h2><p className="mt-1 text-xs text-slate-500">绑定批准版本，计划发布后生成正式任务，阶段通过依赖真实成果验收。</p></div><Badge>{instance ? statuses[instance.status] : '尚未保存执行计划'}</Badge></div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}{notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
    {pending && <div className="rounded-lg bg-amber-50 p-3 text-sm">存在待核对操作：{pending.action}。<Button variant="secondary" disabled={busy} onClick={() => void recover()}>核对原请求结果</Button></div>}
    {!data && <p className="text-sm text-slate-500">{error ? '当前执行状态未能读取。' : '正在读取执行状态…'}</p>}
    {data && <>
      {!data.policyEnabled && <p className="rounded-lg bg-amber-50 p-3 text-sm">{data.canAdvance ? '模板当前不接受新登记；本项目按独立批准的停用规则继续绑定版本，不自动换版。' : '模板未获准执行；可编制/核对计划，不能生成正式任务或推进阶段。'}</p>}
      {config?.actions.some(a => a.needLeader) && <section className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm" aria-label="非投资计划领导时间">
        <p>需领导参与行动在计划批准后生成独立时间需求，按当前有效牵头领导关联；生成申请不代表领导已确认。</p>
        {data.leaderTimes.issues.map(issue => <p role="alert" className="text-amber-800" key={issue}>{issue}</p>)}
        {data.leaderTimes.requests.map(row => <div key={row.id}><Link className="text-[#315f68] underline" to={row.target}>{data.tasks.find(t => t.id === row.taskId)?.title ?? '计划行动'} · {row.leaderName} · {{ draft: '草稿', requested: '已申请', pending: '待领导确认', supplement: '需补信息', confirmed: '已确认', rejected: '已拒绝', withdrawn: '已撤回', cancelled: '已取消' }[row.status] ?? row.status}</Link>{row.changed && <p className="text-amber-800">{row.reason}</p>}</div>)}
        {instance?.planId && data.canPrepare && data.canWrite && <Button variant="secondary" disabled={blocked || reason.trim().length < 5} onClick={() => void execute({ action: 'reconcile_times' })}>按当前职责核对领导需求</Button>}
      </section>}
      {config && <><div className="fde-detail-timeline" aria-label="项目流程" style={{ '--stage-count': config.stages.length } as CSSProperties}>{config.stages.map((item, index) => {
        const completed = instance?.status === 'closed' || index < config.stages.findIndex(value => value.key === instance?.stageKey)
        const current = item.key === instance?.stageKey
        const dates = (instance?.plan.actions ?? []).filter(action => action.stageKey === item.key).map(action => action.dueDate).filter(Boolean).sort()
        return <div key={item.key} className={`fde-detail-stage ${completed ? 'completed' : current ? 'current' : ''}`}><span className="fde-detail-stage-rail"><span>{completed ? '✓' : index + 1}</span></span><span className="fde-detail-stage-copy"><strong>{item.name}</strong><small>计划 {shortProjectDate(dates.at(-1))}</small></span><span className="fde-detail-stage-state"><Badge tone={completed ? 'green' : current ? 'blue' : 'slate'}>{completed ? '已通过' : current ? '进行中' : '待开始'}</Badge></span></div>
      })}</div><div className="fde-detail-focus-layout"><div className="fde-detail-focus-facts"><div><span>当前阶段</span><strong>{stage?.name ?? project.stage}</strong></div><div><span>负责人</span><strong>{project.owner}</strong></div><div><span>目标日</span><strong>{shortProjectDate(project.targetDate)}</strong></div><div><span>执行状态</span><strong>{instance ? statuses[instance.status] : '待制定计划'}</strong></div></div><aside className="fde-detail-next-step"><span>下一成果</span><strong>{stage?.outcome || project.requirements || '形成可验收成果并由组长确认'}</strong></aside></div></>}
      {data.canPrepare && data.canWrite && (!instance || instance.status === 'draft') && <fieldset disabled={blocked} className="space-y-3 rounded-xl border p-4"><legend>计划编制</legend>
        {!config?.planApprovals && <p className="text-sm text-amber-700">绑定模板未配置计划审核规则，请先修订模板并完成独立审核，不能借用投资审批。</p>}
        <div className="grid gap-3 md:grid-cols-2"><label>执行周期<select aria-label="执行周期" className="input w-full" value={cycle} onChange={e => setCycle(Number(e.target.value))}>{config?.cycleDays.map(d => <option key={d} value={d}>{d} 天</option>)}</select></label><label>最终目标日<input aria-label="最终目标日" type="date" className="input w-full" value={target} onInput={e => setTarget(e.currentTarget.value)} onChange={e => setTarget(e.target.value)} /></label></div>
        {config?.actions.map(a => <div key={a.key} className="grid gap-2 rounded-lg bg-slate-50 p-3 md:grid-cols-3"><div><p className="text-sm">{a.title}</p><p className="text-xs text-slate-500">{config.stages.find(s => s.key === a.stageKey)?.name} · {a.deliverable}</p></div><select aria-label={`${a.title}负责人`} className="input" value={selections[a.key]?.userId ?? ''} onChange={e => setSelections(v => ({ ...v, [a.key]: { ...v[a.key], userId: e.target.value } }))}><option value="">请选择职责人员</option>{data.people.filter(p => p.duties.includes(a.duty)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><input aria-label={`${a.title}截止时刻`} type="time" className="input" value={selections[a.key]?.dueTime ?? ''} onInput={e => { const value = e.currentTarget.value; setSelections(v => ({ ...v, [a.key]: { ...v[a.key], dueTime: value } })) }} onChange={e => setSelections(v => ({ ...v, [a.key]: { ...v[a.key], dueTime: e.target.value } }))} /></div>)}
        <Button disabled={blocked || !config?.planApprovals || reason.trim().length < 5} onClick={savePlan}>保存执行计划</Button>
        {instance && <Button variant="secondary" disabled={blocked || unsaved || reason.trim().length < 5} onClick={() => void execute({ action: 'submit_plan' })}>提交已保存计划审核</Button>}
        {unsaved && <p className="text-sm text-amber-700">计划存在未保存修改，请保存后再提交，审核不会采用未保存内容。</p>}
      </fieldset>}
      {instance && <div className="space-y-2">{instance.plan.actions.map(a => { const task = data.tasks.find(t => t.actionKey === a.key), deadline = typeRuntimeEffectiveDeadline(a, task); return <div key={a.key} className="flex flex-wrap justify-between gap-2 border-b pb-2 text-sm"><span>{a.title}</span><span>{deadline.dueDate ?? '未定日期'} {deadline.dueTime} · {task?.status ?? '未生成正式任务'}</span></div> })}</div>}
      {instance?.status === 'active' && data.canPrepare && data.canWrite && stage && <fieldset disabled={blocked} className="space-y-3 rounded-xl border p-4"><legend>{stage.name} · 提交阶段成果</legend><p className="text-sm text-slate-500">{stage.outcome}</p><textarea aria-label="阶段成果说明" className="input min-h-24 w-full" value={result} onChange={e => setResult(e.target.value)} />{stage.materials.map(m => <div key={m.key}><label>{m.label}<select className="input w-full" value={materials[m.key]?.value ?? ''} onChange={e => setMaterials(v => ({ ...v, [m.key]: { ...v[m.key], value: e.target.value } }))}><option value="">请选择原件版本</option>{files.map(f => <option key={f.id} value={f.id}>{f.name} · V{f.version}</option>)}{stage.allowWaiver && <option value="waiver">按模板申请免传（仅负责人）</option>}</select></label>{materials[m.key]?.value === 'waiver' && <input aria-label={`${m.label}免传理由`} className="input w-full" value={materials[m.key]?.reason ?? ''} onChange={e => setMaterials(v => ({ ...v, [m.key]: { ...v[m.key], reason: e.target.value } }))} />}</div>)}<Button disabled={blocked || reason.trim().length < 5} onClick={submitStage}>核验成果并提交审核</Button></fieldset>}
      {data.canWrite && <label className="block text-sm">本次操作理由（至少 5 字）<textarea aria-label="执行操作理由" className="input mt-1 w-full" value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></label>}
      <h3 className="font-medium">计划与阶段审核记录</h3>{data.reviews.map(r => { const node = r.snapshot.nodes[r.snapshot.currentNodeIndex], mayDecide = r.canDecide; return <div key={r.id} id={`type-review-${r.id}`} className={`space-y-2 rounded-xl border p-3 ${focusReview === r.id ? 'border-teal-500 bg-teal-50' : ''}`}>{focusReview === r.id && <p className="text-sm font-semibold text-teal-800">从统一审批中心定位的申请</p>}<p className="text-sm">{r.kind === 'plan' ? '计划审核' : '阶段审核'} · {{reviewing: '审核中', approved: '已通过', returned: '已退回', withdrawn: '已撤回'}[r.status]} · {node.name}</p><p className="text-xs text-slate-500">申请 {r.id} · V{r.version} · {r.snapshot.decisions.length} 条决定</p>{r.snapshot.decisions.map((d, i) => <p key={i} className="text-xs">{data.people.find(p => p.id === d.actorId)?.name ?? '原人员'}：{{approve: '同意', return: '退回', withdraw: '撤回'}[d.action]} · {d.reason}</p>)}{active?.id === r.id && data.canWrite && <div className="flex gap-2">{mayDecide && <><Button disabled={blocked || !data.canAdvance || reason.trim().length < 5} onClick={() => void execute({ action: 'decide', requestId: r.id, expectedReviewVersion: r.version, decision: 'approve' })}>同意当前节点</Button><Button variant="secondary" disabled={blocked || reason.trim().length < 5} onClick={() => void execute({ action: 'decide', requestId: r.id, expectedReviewVersion: r.version, decision: 'return' })}>退回</Button></>}{r.snapshot.requesterUserId === uid && <Button variant="secondary" disabled={blocked || reason.trim().length < 5} onClick={() => void execute({ action: 'decide', requestId: r.id, expectedReviewVersion: r.version, decision: 'withdraw' })}>撤回申请</Button>}</div>}</div> })}
      <div className="flex gap-3"><Button variant="secondary" disabled={busy || data.page <= 1} onClick={() => { setFocusReview(null); setPage(data.page - 1) }}>上一页</Button><span>第 {data.page} 页</span><Button variant="secondary" disabled={busy || !data.hasMore} onClick={() => { setFocusReview(null); setPage(data.page + 1) }}>下一页</Button></div>
    </>}
  </Card>
}
