import { notifyTaskChanged, openTaskAction, openTaskPath } from '../lib/taskWorkspace'
import { createLatestRequestGuard, subscribeWorkspaceRefresh } from '../lib/workspaceRefresh'
import { openApproval, openApprovalPath } from '../lib/approvalWorkspace'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EyeOff, Plus } from 'lucide-react'
import { ApiError, apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { Button, Card, Modal } from './ui'
import { useToast } from './Toast'
import { FdeTimeGrid, type TimeProposal } from './FdeTimeGrid'
import { FdeCompanyCalendar } from './FdeCompanyCalendar'
import { FdeLeaderTimePanel } from './FdeLeaderTimePanel'
import { shanghaiToday, shiftDate, weekStartFor } from '../../server/src/contracts/fdeWeeklyPlanContract'
import { calendarDefinitionSchema, calendarTaskCreateSchema, timeInstant, timeLocal } from '../../server/src/contracts/fdeTimeContract'
import type { UnifiedTask, UnifiedTaskPrimaryAction } from '../../server/src/contracts/unifiedTaskContract'
import { HelpPopover, TaskDrawer } from './task/TaskSystem'

type Item = { key:string;id:string|null;source:string;title:string;detail:string;projectId?:string|null;projectName?:string|null;ownerId:string;ownerName:string;startsAt:string;endsAt:string|null;allDay:boolean;version:number|null;sourceVersion?:number;visibility?:string;editable:boolean;target:string|null }
type Calendar = {items:Item[];notice:string}
const blank = () => ({clientRequestId:crypto.randomUUID(),title:'',detail:'',startsAt:`${shiftDate(shanghaiToday(),1)}T10:00`,endsAt:`${shiftDate(shanghaiToday(),1)}T11:00`,visibility:'private' as 'private'|'company',reason:''})
export function FdeCalendarPanel({initialWeek, initialLayer = 'personal', allowLeader = true, companyOnly = false, compact = false, overview = false, onHide}:{initialWeek?:string; initialLayer?:'personal'|'leader'; allowLeader?:boolean; companyOnly?:boolean; compact?:boolean; overview?:boolean; onHide?:()=>void}) {
  const userId = useAuthStore(state => state.user?.id ?? '')
  return <CalendarForAccount key={`${userId}:${initialLayer}:${companyOnly}:${compact}`} initialWeek={initialWeek} initialLayer={initialLayer} allowLeader={allowLeader} companyOnly={companyOnly} compact={compact} overview={overview} onHide={onHide} />
}
function CalendarForAccount({initialWeek, initialLayer, allowLeader, companyOnly, compact, overview, onHide}:{initialWeek?:string; initialLayer:'personal'|'leader'; allowLeader:boolean; companyOnly:boolean; compact:boolean; overview:boolean; onHide?:()=>void}) {
  const userId = useAuthStore(state => state.user?.id ?? 'anonymous')
  const userName = useAuthStore(state => state.user?.name ?? '我的日历')
  const weekendKey = `fde-calendar-weekends:${userId}`
  const [layer, setLayer] = useState(initialLayer)
  const [fitToHeight, setFitToHeight] = useState(true)
  const [showWeekends, setShowWeekends] = useState(() => { try { return localStorage.getItem(weekendKey) === '1' } catch { return false } })
  const navigate=useNavigate(),{showToast}=useToast(),[week,setWeek]=useState(initialWeek??weekStartFor(shanghaiToday())),[view,setView]=useState<'personal'|'company'>(companyOnly?'company':'personal'),[includeMilestones,setIncludeMilestones]=useState(false),[data,setData]=useState<Calendar|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[dialog,setDialog]=useState<{item?:Item;cancel?:boolean}|null>(null),[selectedTaskId,setSelectedTaskId]=useState<string|null>(null),[form,setForm]=useState(blank)
  const endpoint=`/calendar?weekStart=${week}&view=${view}&includeMilestones=${includeMilestones}`
  const reads = useRef(createLatestRequestGuard())
  const busyRef = useRef(false)
  const [dialogStale, setDialogStale] = useState(false)
  function openSource(path: string) { if (!openApprovalPath(path) && !openTaskPath(path)) navigate(path) }
  useEffect(() => { if (initialWeek) setWeek(initialWeek) }, [initialWeek])
  useEffect(() => { try { localStorage.setItem(weekendKey, showWeekends ? '1' : '0') } catch { /* preference remains active for this session */ } }, [showWeekends, weekendKey])
  const reload = useCallback(async () => {
    const current = reads.current.begin()
    try {
      const next = await apiGet<Calendar>(endpoint)
      if (current()) { setData(next); setError(''); return next }
    } catch (cause) { if (current()) setError((cause as Error).message) }
    return null
  }, [endpoint])
  useEffect(() => { setData(null); setError(''); void reload(); return () => reads.current.invalidate() }, [reload])
  useEffect(() => subscribeWorkspaceRefresh(() => { void reload() }), [reload])
  function field(key:string,value:string){setForm(previous=>({...previous,[key]:value,clientRequestId:crypto.randomUUID()}))}
  function open(item?:Item,cancel=false,proposal?:TimeProposal){
    if (busyRef.current) return
    if(proposal&&(!Number.isFinite(timeInstant(proposal.startsAt).getTime())||!Number.isFinite(proposal.durationMinutes)||proposal.durationMinutes<=0||proposal.durationMinutes>1440)){showToast('调整后的时间范围无效，请重新选择','error');return}
    setDialogStale(false);setDialog({item,cancel});setForm({...blank(),...(item?{title:item.title,detail:item.detail,visibility:item.visibility==='company'?'company' as const:'private' as const,startsAt:timeLocal(new Date(item.startsAt)),endsAt:timeLocal(new Date(item.endsAt ?? new Date(item.startsAt).getTime()+3600000))}:{}),...(proposal?{startsAt:proposal.startsAt,endsAt:timeLocal(new Date(timeInstant(proposal.startsAt).getTime()+proposal.durationMinutes*60000))}:{})})
  }
  function createAt(startsAt:string){open(undefined,false,{id:'new',startsAt,durationMinutes:60,method:'drag'})}
  const definition={title:form.title,detail:form.detail,startsAt:form.startsAt,endsAt:form.endsAt,visibility:form.visibility}
  function taskScheduleBody(item:Item,startsAt:string,endsAt:string,hidden:boolean,reason:string,clientRequestId=crypto.randomUUID()){return{clientRequestId,expectedVersion:item.version??0,sourceVersion:item.sourceVersion,startsAt,endsAt,hidden,reason}}
  async function submit() {
    if (!dialog || busyRef.current || dialogStale) return
    busyRef.current = true; setBusy(true)
    const item = dialog.item
    try {
      if (item?.source === 'task' && dialog.cancel) {
        if (item.projectId) await apiPost(`/calendar/tasks/${item.id}/schedule`, taskScheduleBody(item,form.startsAt,form.endsAt,true,'本人从日历移除任务',form.clientRequestId))
        else await apiPost(`/calendar/tasks/${item.id}/cancel`, {clientRequestId:form.clientRequestId,expectedTaskVersion:item.sourceVersion,expectedScheduleVersion:item.version??0,reason:'本人删除个人事项'})
      } else if (item?.source === 'task') await apiPost(`/calendar/tasks/${item.id}/schedule`, taskScheduleBody(item,form.startsAt,form.endsAt,false,'本人修改任务排期',form.clientRequestId))
      else if (dialog.cancel) await apiPost(`/calendar/${item!.id}/cancel`, {clientRequestId:form.clientRequestId,expectedVersion:item!.version,reason:'本人删除个人事项'})
      else if (!item) await apiPost('/calendar/tasks', {clientRequestId:form.clientRequestId,title:form.title,detail:form.detail,startsAt:form.startsAt,endsAt:form.endsAt})
      else await apiPost(`/calendar/${item.id}/save`, {clientRequestId:form.clientRequestId,expectedVersion:item.version,definition})
      reads.current.invalidate(); setDialog(null); notifyTaskChanged()
      showToast(dialog.cancel ? (item?.source==='task'&&item.projectId?'已从日历移除':'个人事项已删除') : '任务时间已保存')
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setDialogStale(true)
      showToast((cause as Error).message, 'error'); await reload()
    } finally { busyRef.current = false; setBusy(false) }
  }
  async function rereadDialog() {
    if (!dialog?.item || busyRef.current) return
    const next = await reload()
    if (!next) return
    const item = next.items.find(row => row.key === dialog.item!.key)
    if (!item?.editable) { setDialog(null); showToast('该事项已删除或不可修改，请查看最新日历', 'info'); return }
    open(item, dialog.cancel)
  }
  async function applyProposal(proposal:TimeProposal) {
    const item = data?.items.find(value => value.id===proposal.id && value.editable)
    if (!item?.endsAt || busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      const endsAt=timeLocal(new Date(timeInstant(proposal.startsAt).getTime()+proposal.durationMinutes*60000))
      if(item.source==='task') await apiPost(`/calendar/tasks/${item.id}/schedule`,taskScheduleBody(item,proposal.startsAt,endsAt,false,proposal.method==='resize'?'本人拉伸任务时长':'本人移动任务时间'))
      else await apiPost(`/calendar/${item.id}/save`,{clientRequestId:crypto.randomUUID(),expectedVersion:item.version,definition:{title:item.title,detail:item.detail,startsAt:proposal.startsAt,endsAt,visibility:item.visibility==='company'?'company':'private'}})
      reads.current.invalidate(); notifyTaskChanged()
      showToast(proposal.method==='resize'?'任务时长已更新':'任务时间已更新')
    } catch(cause) { showToast((cause as Error).message,'error'); await reload() }
    finally { busyRef.current=false; setBusy(false) }
  }
  function taskAction(action:string,task:UnifiedTask){if(!task.project)return;if(action==='approval'){setSelectedTaskId(null);openApproval(task.approvalRequestId ? { id: task.approvalRequestId, kind: 'project', projectId: task.project.id } : undefined);return}const route=action==='not_started'?'start':action==='in_progress'||action==='returned'?'submission':action==='pending_acceptance'?'accept':action==='feedback'?'progress':action==='extension'||action==='cancel'?action:'';setSelectedTaskId(null);route?openTaskAction(task.project.id,task.id,route):navigate(`/projects/${task.project.id}?tab=tasks&task=${task.id}`)}
  const calendarActions = <><HelpPopover>单击空白时间新建任务；拖动任务可改变时间和日期，拖动底部横条可调整时长。点击任务可编辑或删除。{overview && '全貌展示整周，详细刻度便于精细调整。'}</HelpPopover><Button onClick={()=>open()}><Plus size={16}/>新增任务</Button></>
  return <div className={`fde-workspace fde-collab-calendar ${compact?'fde-collab-calendar-compact':''} ${overview?'fde-calendar-overview':''}`}>
    {overview&&<div className="fde-calendar-overview-heading"><strong>日历</strong><div className="fde-collab-calendar-actions">{calendarActions}</div></div>}
    <div className="fde-collab-calendar-scope">{!overview&&<strong>{compact?'任务时间轴':'日历'}</strong>}<div className="fde-collab-calendar-actions">{!compact&&<div className="fde-collab-segmented" aria-label="日历范围">{!companyOnly&&<button aria-pressed={view==='personal'} onClick={()=>setView('personal')}>我的日历</button>}<button aria-pressed={view==='company'} onClick={()=>setView('company')}>公司总表</button></div>}<div className="fde-collab-week"><button aria-label="上一周" onClick={()=>setWeek(shiftDate(week,-7))}>‹</button><button onClick={()=>setWeek(weekStartFor(shanghaiToday()))}>本周</button><button aria-label="下一周" onClick={()=>setWeek(shiftDate(week,7))}>›</button><input aria-label="日历周日期" type="date" value={week} onChange={event=>{if(event.target.value)setWeek(weekStartFor(event.target.value))}} /></div>{overview&&<div className="fde-collab-segmented" aria-label="日历比例尺"><button type="button" aria-pressed={fitToHeight} onClick={()=>setFitToHeight(true)}>全貌</button><button type="button" aria-pressed={!fitToHeight} onClick={()=>setFitToHeight(false)}>详细刻度</button></div>}{view==='personal'&&layer==='personal'&&<button className="fde-weekend-toggle" type="button" aria-pressed={showWeekends} onClick={()=>setShowWeekends(value=>!value)}>{showWeekends?'隐藏周末':'显示周末'}</button>}{compact&&onHide&&<button className="fde-calendar-hide" type="button" title="隐藏时间轴" aria-label="隐藏时间轴" onClick={onHide}><EyeOff size={17}/></button>}</div></div>
    {view==='personal'&&allowLeader&&<div className="fde-collab-calendar-layer"><strong>个人时间视图</strong><div className="fde-collab-segmented"><button aria-pressed={layer==='personal'} onClick={()=>setLayer('personal')}>我的安排</button><button aria-pressed={layer==='leader'} onClick={()=>setLayer('leader')}>领导时间</button></div></div>}
    {view==='personal'&&layer==='leader'?<FdeLeaderTimePanel initialWeek={week}/>:<section className="fde-collab-card fde-collab-calendar-card">{!overview&&<div className="fde-collab-card-head"><h2>{view==='personal'?userName:'全公司日程'} · {week}—{shiftDate(week,view==='company'||!showWeekends?4:6)}</h2><div className="fde-collab-calendar-actions">{view==='personal'&&<><div className="fde-collab-legend"><span><i/>个人事项</span><span><i data-tone="pending"/>时间冲突</span><span><i data-tone="locked"/>只读事项</span></div>{calendarActions}</>}</div></div>}
      {error&&<div role="alert" className="fde-collab-state">{error}<Button variant="secondary" onClick={()=>void reload().catch(e=>setError(e.message))}>重试</Button></div>}{!data&&!error&&<div className="fde-collab-state" role="status">正在读取真实日历来源…</div>}
      {data&&(view==='company'?<FdeCompanyCalendar week={week} items={data.items}/>:<FdeTimeGrid weekStart={week} items={data.items} showWeekends={showWeekends} overview={overview} fitToHeight={overview&&fitToHeight} onCreateAt={createAt} onOpen={key=>{const item=data.items.find(v=>v.key===key);if(item?.editable)open(item);else if(item?.target)openSource(item.target)}} onPropose={proposal=>void applyProposal(proposal)} />)}
    </section>}
    <details className="fde-collab-tools"><summary>日期标记与全部事项</summary><div><Button variant="secondary" onClick={()=>void reload().catch(e=>setError(e.message))}>刷新日历</Button><label><input type="checkbox" checked={includeMilestones} onChange={event=>setIncludeMilestones(event.target.checked)}/>显示已批准节点日期</label></div>
<Card className="p-5"><h3 className="font-semibold">本周事项（含全天、截止点与非工作时段）</h3><div className="mt-3 space-y-3">{data?.items.length===0&&<p className="text-sm text-slate-500">本周暂无可展示的安排。</p>}{data?.items.map(item=><article className="rounded-lg border border-slate-200 p-4" key={item.key}><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{item.title}</h4><span className="text-xs text-slate-500">{item.ownerName} · {item.editable?(item.source==='task'?'本人任务排期':'本人独立安排'):'只读'}</span></div><p className="mt-2 text-xs text-slate-600">{item.source==='milestone'?timeLocal(new Date(item.startsAt)).slice(0,10):timeLocal(new Date(item.startsAt)).replace('T',' ')}{item.endsAt?` — ${timeLocal(new Date(item.endsAt)).replace('T',' ')}`:item.source==='milestone'?' · 节点日期标记':item.allDay?' · 当日截止':' · 截止点/结束时间未记录'}</p>{item.detail&&<p className="mt-2 whitespace-pre-wrap text-sm text-slate-500">{item.detail}</p>}<div className="mt-3 flex gap-2">{item.editable&&<><Button variant="secondary" disabled={busy} onClick={()=>open(item)}>{item.source==='task'?'编辑任务时间':'编辑安排'}</Button><Button variant="secondary" disabled={busy} onClick={()=>open(item,true)}>{item.source==='task'?'移出时间轴':'取消安排'}</Button></>}{item.target&&<Button variant="secondary" onClick={()=>openSource(item.target!)}>打开来源</Button>}</div></article>)}</div></Card>
    </details>
    <TaskDrawer taskId={selectedTaskId} open={Boolean(selectedTaskId)} onClose={()=>setSelectedTaskId(null)} onAction={(action,task)=>void taskAction(action as UnifiedTaskPrimaryAction,task)}/>
    <Modal open={Boolean(dialog)} title={dialog?.cancel?(dialog.item?.source==='task'&&dialog.item.projectId?'移出日历':'删除个人事项'):dialog?.item?'编辑任务':'新建任务'} onClose={()=>{if(!busy)setDialog(null)}} footer={<>{dialog?.item&&!dialog.cancel&&dialog.item.source==='task'&&<Button variant="secondary" disabled={busy} onClick={()=>{setDialog(null);setSelectedTaskId(dialog.item!.id)}}>查看任务详情</Button>}{dialog?.item&&!dialog.cancel&&<Button variant="secondary" disabled={busy||dialogStale} onClick={()=>open(dialog.item,true)}>{dialog.item.source==='task'&&dialog.item.projectId?'移出日历':'删除'}</Button>}<Button variant="secondary" disabled={busy} onClick={()=>setDialog(null)}>取消</Button><Button loading={busy} disabled={dialogStale||(!dialog?.cancel&&!(dialog?.item?.source==='task'?calendarTaskCreateSchema.safeParse({clientRequestId:form.clientRequestId,title:form.title,detail:form.detail,startsAt:form.startsAt,endsAt:form.endsAt}).success:dialog?.item?calendarDefinitionSchema.safeParse(definition).success:calendarTaskCreateSchema.safeParse({clientRequestId:form.clientRequestId,title:form.title,detail:form.detail,startsAt:form.startsAt,endsAt:form.endsAt}).success))} onClick={()=>void submit()}>{dialog?.cancel?(dialog.item?.source==='task'&&dialog.item.projectId?'确认移出':'确认删除'):'保存任务'}</Button></>}>
      {dialogStale && <div className="mb-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-900" role="alert"><p>该事项已被更新，当前输入尚未保存。请读取最新安排后重新调整。</p><Button variant="secondary" disabled={busy} onClick={() => void rereadDialog()}>重新读取最新安排</Button></div>}
      <div className="space-y-4">{dialog?.cancel?<div className="fde-calendar-delete-confirm"><strong>{dialog.item?.title}</strong><p>{dialog.item?.source==='task'&&dialog.item.projectId?'任务仍保留在项目任务中，仅从你的日历移除。':'删除后不会再出现在待办和日历中。'}</p></div>:<><label className="block"><span className="label">任务名称</span><input className="input w-full" disabled={dialog?.item?.source==='task'} value={form.title} onChange={e=>field('title',e.target.value)} /></label><label className="block"><span className="label">任务说明</span><textarea className="textarea w-full" disabled={dialog?.item?.source==='task'} value={form.detail} onChange={e=>field('detail',e.target.value)} /></label><div className="fde-calendar-time-fields">{(['startsAt','endsAt'] as const).map((key,i)=><label className="block" key={key}><span className="label">{i?'结束':'开始'}时间</span><input type="datetime-local" step={900} className="input w-full" value={form[key]} onInput={e=>field(key,e.currentTarget.value)} onChange={e=>field(key,e.target.value)} /></label>)}</div>{dialog?.item?.source==='personal'&&<label className="block"><span className="label">可见范围</span><select className="input w-full" value={form.visibility} onChange={e=>field('visibility',e.target.value)}><option value="private">仅本人可见</option><option value="company">公司可见</option></select></label>}</>}</div>
    </Modal>
  </div>
}
