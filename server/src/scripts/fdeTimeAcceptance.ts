import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { users, projects, leaderTimeRequests, leaderTimeEvents, leaderTimeNotices, leaderTimeBatches, personalCalendarHistory, todos, meetings, meetingWorkflowEvents, meetingWorkflowNotices } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { createProject, classifyProject } from '../services/projectService.js'
import { proposeFdeGovernance } from '../services/fdeGovernanceService.js'
import { createLeaderTime, saveLeaderTime, actOnLeaderTime, listLeaderTimes, readLeaderTimeNotice } from '../services/fdeLeaderTimeService.js'
import { writeCalendarEvent, cancelCalendarEvent, listCalendar } from '../services/fdeCalendarService.js'
import { createFdeDirective, actOnFdeDirective, getFdeDirectives } from '../services/fdeDirectiveService.js'
import { closeProjectDirectiveSchedules } from '../services/fdeDirectiveLinksService.js'
import { shiftDate, shanghaiToday, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { applyAutoSchedule, previewAutoSchedule } from '../services/fdeAutoScheduleService.js'
import { actOnFdeFridayMeeting, createFdeFridayMeeting, saveFdeFridayMeeting } from '../services/fdeFridayMeetingService.js'
import { createMeeting, updateMeeting } from '../services/meetingService.js'
import { timeInstant } from '../contracts/fdeTimeContract.js'
import { collectWeeklyReportFacts } from '../services/fdeWeeklyReportService.js'

assert.match(process.env.DB_FREFIX??'',/^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.FDE_ACCEPTANCE_PREFIX,process.env.DB_FREFIX)
const week=weekStartFor(shiftDate(shanghaiToday(),7)), day=shiftDate(week,1), checks:string[]=[], marker=randomUUID().slice(0,8)
// Exercise the owner-before-leader lock order instead of depending on random UUID order.
const accountIds=Array.from({length:6},()=>randomUUID()).sort()
const accounts=['投资经理','投资经理','投资经理','董事长','时间协调人','投资经理'].map((role,i)=>({id:accountIds[i],name:`时间-${marker}-${i}`,role,department:`时间隔离-${marker}`,email:`time-${marker}-${i}@example.invalid`,passwordHash:'not-for-login'}))
const [owner,secretary,member,leader,coordinator,outsider]=accounts
async function code(p:Promise<unknown>,expected:string){const error=await p.then(()=>null,e=>e);assert.equal(error?.code,expected,`${expected}: ${error?.message??'unexpected success'}`)}
const requestDefinition={title:`客户沟通-${marker}`,reason:'需由领导确认关键沟通方向',outcome:'明确下一步安排',impact:'延后会影响客户确认',latestFinish:`${day}T20:00`,preferredStart:`${day}T10:00`,alternativeStart:`${day}T14:00`,durationMinutes:60,location:'线上会议'}
try {
  await db.insert(users).values(accounts)
  for(const a of accounts)await identityRepositories.users.synchronizeAdministrationBindings(a.id,a.role,a.department)
  let project=await createProject({name:`时间闭环-${marker}`,owner:owner.name,ownerUserId:owner.id,collaborators:[],targetDate:shiftDate(week,90)},owner.id)
  project=await classifyProject({projectId:project.id,userId:owner.id,expectedVersion:project.version,toClassification:'normal',reason:'完成时间验收初筛'})
  await proposeFdeGovernance({projectId:project.id,userId:owner.id,ownerUserId:owner.id,expectedVersion:project.governanceVersion,reason:'配置时间职责与执行人员',assignments:[{duty:'secretary',userId:secretary.id},{duty:'member',userId:member.id},{duty:'concerned_leader',userId:leader.id},{duty:'coordinator',userId:coordinator.id}]})
  const board=(uid=owner.id)=>listLeaderTimes(uid,week)
  const row=async(id:string)=>(await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.id,id)))[0]
  const boardRow=async(id:string)=>(await board()).list.find(r=>r.id===id)!
  const act=async(id:string,uid:string,action:string,extra:Record<string,unknown>={})=>actOnLeaderTime(id,uid,{clientRequestId:randomUUID(),expectedVersion:(await row(id)).version,action,reason:'隔离验收确认该操作',...extra})
  const createInput={clientRequestId:randomUUID(),projectId:project.id,leaderId:leader.id,...requestDefinition}
  await code(createLeaderTime(member.id,createInput),'TIME_REQUESTOR_REQUIRED')
  const request=await createLeaderTime(owner.id,createInput),id=request.id
  assert.deepEqual(await createLeaderTime(owner.id,createInput),request)
  assert.equal((await board(coordinator.id)).list.some(r=>r.id===id),false)
  assert.equal((await board(member.id)).list.some(r=>r.id===id),false)
  checks.push('FDE-TIME-001/003:stable-roles-complete-draft-replay-and-draft-privacy')

  const busy=await writeCalendarEvent(leader.id,{clientRequestId:randomUUID(),definition:{title:`私密安排-${marker}`,detail:'不能出现在其他人日历',startsAt:`${day}T09:30`,endsAt:`${day}T10:30`,visibility:'private'}})
  await act(id,owner.id,'submit')
  assert.equal((await row(id)).status,'requested');assert.equal((await boardRow(id)).conflicts.length,1)
  const otherCalendar=await listCalendar(outsider.id,week,'company')
  assert.ok(otherCalendar.items.some(i=>i.title==='已占用'))
  assert.ok(!JSON.stringify(otherCalendar).includes(`私密安排-${marker}`));assert.ok(!JSON.stringify(otherCalendar).includes(busy.id))
  await code(act(id,leader.id,'confirm'),'TIME_CONFLICT')
  await code(act(id,coordinator.id,'confirm'),'TIME_ACTION_FORBIDDEN')
  checks.push('FDE-TIME-004/005:private-busy-slot-blocks-confirmation-without-content-or-id-leak')

  await act(id,coordinator.id,'coordinate',{scheduledStart:`${day}T11:00`,durationMinutes:60,method:'drag'})
  assert.equal((await row(id)).status,'pending')
  const version=(await row(id)).version
  const decisions=await Promise.allSettled([1,2].map(()=>actOnLeaderTime(id,leader.id,{clientRequestId:randomUUID(),expectedVersion:version,action:'confirm',reason:'领导本人确认安排'})))
  assert.equal(decisions.filter(r=>r.status==='fulfilled').length,1)
  assert.equal((await row(id)).status,'confirmed')
  assert.ok((await listCalendar(leader.id,week,'personal')).items.some(i=>i.id===id&&!i.editable))
  const confirmedReport=await collectWeeklyReportFacts(db,owner.id,[project.id],week,{calendar:true,privateCalendar:false,independentWork:false})
  assert.ok(confirmedReport.calendar?.some(i=>i.id===id&&i.source==='leader'&&i.status==='confirmed'))
  assert.ok(!JSON.stringify(await listCalendar(outsider.id,week,'company')).includes(requestDefinition.title))
  await code(writeCalendarEvent(leader.id,{clientRequestId:randomUUID(),definition:{title:'冲突的个人安排',startsAt:`${day}T11:15`,endsAt:`${day}T11:45`}}),'CALENDAR_CONFLICT')
  checks.push('FDE-TIME-004/005:coordinator-proposal-independent-leader-confirm-concurrency-and-calendar-projection')

  let secondProject=await createProject({name:`另一个时间项目-${marker}`,owner:owner.name,ownerUserId:owner.id,collaborators:[],targetDate:shiftDate(week,90)},owner.id)
  secondProject=await classifyProject({projectId:secondProject.id,userId:owner.id,expectedVersion:secondProject.version,toClassification:'normal',reason:'第二项目时间冲突验收'})
  const second=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),projectId:secondProject.id,preferredStart:`${day}T11:00`,alternativeStart:`${day}T14:00`})
  await act(second.id,owner.id,'submit')
  await code(act(second.id,leader.id,'confirm'),'TIME_CONFLICT')
  await act(second.id,coordinator.id,'coordinate',{scheduledStart:`${day}T12:00`,durationMinutes:60,method:'resize'})
  await act(second.id,leader.id,'confirm')
  assert.equal((await row(id)).status,'confirmed');assert.equal((await row(second.id)).status,'confirmed')
  await act(second.id,owner.id,'cancel')
  checks.push('FDE-TIME-004:cross-project-conflict-checked-by-stable-leader-and-adjacent-slots-allowed')

  const notice=(await board(owner.id)).list.find(r=>r.id===id)!.notices[0]
  await readLeaderTimeNotice(notice.id,owner.id);const readAt=(await boardRow(id)).notices[0].readAt
  await readLeaderTimeNotice(notice.id,owner.id);assert.deepEqual((await boardRow(id)).notices[0].readAt,readAt)
  await code(readLeaderTimeNotice(notice.id,outsider.id),'TIME_NOTICE_NOT_FOUND')
  await act(id,coordinator.id,'coordinate',{scheduledStart:`${day}T11:15`,durationMinutes:45,method:'keyboard'})
  assert.equal((await row(id)).confirmedAt,null);assert.equal((await row(id)).status,'pending')
  assert.ok(!(await listCalendar(leader.id,week,'personal')).items.some(i=>i.id===id))
  await act(id,leader.id,'supplement')
  await code(act(id,leader.id,'confirm'),'TIME_STATE_INVALID')
  await saveLeaderTime(id,secretary.id,{clientRequestId:randomUUID(),expectedVersion:(await row(id)).version,...requestDefinition,preferredStart:`${day}T15:00`,alternativeStart:`${day}T16:00`,impact:'补充明确延后的实际影响'})
  await act(id,leader.id,'confirm')
  assert.equal((await row(id)).status,'confirmed')
  assert.equal((await db.select().from(projects).where(eq(projects.id,project.id)))[0].targetDate,project.targetDate)
  checks.push('FDE-TIME-006/007/008:reschedule-reconfirmation-supplement-history-read-receipt-and-project-date-unchanged')

  await code(writeCalendarEvent(owner.id,{clientRequestId:randomUUID(),expectedVersion:1,definition:{title:'不能编辑别人的安排',startsAt:`${day}T08:00`,endsAt:`${day}T09:00`}},busy.id),'CALENDAR_FORBIDDEN')
  await writeCalendarEvent(leader.id,{clientRequestId:randomUUID(),expectedVersion:1,definition:{title:`私密安排-${marker}`,detail:'已调整',startsAt:`${day}T09:45`,endsAt:`${day}T10:45`,visibility:'private'}},busy.id)
  await cancelCalendarEvent(busy.id,leader.id,{clientRequestId:randomUUID(),expectedVersion:2,reason:'本人取消独立安排'})
  assert.ok(!(await listCalendar(leader.id,week,'personal')).items.some(i=>i.id===busy.id))
  assert.equal((await db.select().from(personalCalendarHistory).where(eq(personalCalendarHistory.eventId,busy.id))).length,3)
  await act(id,owner.id,'cancel')
  assert.ok(!(await listCalendar(leader.id,week,'personal')).items.some(i=>i.id===id))
  const cancelledReport=await collectWeeklyReportFacts(db,owner.id,[project.id],week,{calendar:true,privateCalendar:false,independentWork:false})
  assert.ok(cancelledReport.calendar?.some(i=>i.id===id&&i.status==='cancelled'))
  checks.push('FDE-COLLAB-002/003:personal-event-owner-only-edit-cancel-history-and-readonly-business-projection')

  const friday=shiftDate(week,4), meetingBody={title:'跨入口冲突会议',startsAt:`${friday}T11:00`,endsAt:`${friday}T12:00`,hostUserId:owner.id,participantIds:[owner.id,leader.id],minutes:{agenda:'真实排期冲突检查',nextActions:[]}}
  const fixed=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),preferredStart:`${friday}T11:00`,alternativeStart:`${friday}T16:00`})
  await act(fixed.id,owner.id,'submit');await act(fixed.id,leader.id,'confirm')
  const fridayDraft=await createFdeFridayMeeting(project.id,owner.id,{...meetingBody,clientRequestId:randomUUID()})
  const meetingRow=async(mid:string)=>(await db.select().from(meetings).where(eq(meetings.id,mid)))[0]
  const meetingAction=async(mid:string,action:string)=>actOnFdeFridayMeeting(project.id,mid,owner.id,{clientRequestId:randomUUID(),expectedVersion:(await meetingRow(mid)).version,action,reason:'隔离验收排期或取消'})
  await code(meetingAction(fridayDraft.meetingId,'schedule'),'MEETING_TIME_CONFLICT')
  assert.equal((await meetingRow(fridayDraft.meetingId)).version,1)
  const noon={...meetingBody,startsAt:`${friday}T12:00`,endsAt:`${friday}T13:00`}
  await saveFdeFridayMeeting(project.id,fridayDraft.meetingId,owner.id,{...noon,clientRequestId:randomUUID(),expectedVersion:1,reason:'改为相邻不重叠时段'})
  await meetingAction(fridayDraft.meetingId,'schedule')
  await code(saveFdeFridayMeeting(project.id,fridayDraft.meetingId,owner.id,{...meetingBody,clientRequestId:randomUUID(),expectedVersion:3,reason:'禁止覆盖领导确认时间'}),'MEETING_TIME_CONFLICT')
  assert.equal((await meetingRow(fridayDraft.meetingId)).version,3)
  await code(writeCalendarEvent(leader.id,{clientRequestId:randomUUID(),definition:{title:'不能覆盖例会时间',startsAt:`${friday}T12:15`,endsAt:`${friday}T12:45`}}),'CALENDAR_CONFLICT')
  const legacyInput={projectId:project.id,projectName:project.name,title:'有真实结束时间的会议',host:leader.name,attendees:[leader.name,owner.name],startedAt:timeInstant(`${friday}T11:00`),endsAt:timeInstant(`${friday}T12:00`)}
  const meetingCount=(await db.select().from(meetings)).length
  await code(createMeeting(legacyInput,[],owner.id),'MEETING_TIME_CONFLICT')
  assert.equal((await db.select().from(meetings)).length,meetingCount)
  const legacy=await createMeeting({...legacyInput,startedAt:timeInstant(`${friday}T13:00`),endsAt:timeInstant(`${friday}T14:00`)},[],owner.id)
  await code(updateMeeting(legacy.id,{startedAt:timeInstant(`${friday}T11:00`)},legacy.version),'MEETING_TIME_CONFLICT')
  assert.equal((await meetingRow(legacy.id)).startedAt.toISOString(),legacy.startedAt.toISOString())
  const againstLegacy=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),preferredStart:`${friday}T13:00`,alternativeStart:`${friday}T16:00`})
  await act(againstLegacy.id,owner.id,'submit');await code(act(againstLegacy.id,leader.id,'confirm'),'TIME_CONFLICT')
  await act(againstLegacy.id,owner.id,'withdraw');await act(fixed.id,owner.id,'cancel');await meetingAction(fridayDraft.meetingId,'cancel')
  checks.push('FDE-TIME-010:meeting-calendar-leader-bidirectional-conflicts-legacy-identity-and-atomic-failure')

  for(let iteration=0;iteration<8;iteration++) {
  const race=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),projectId:secondProject.id,preferredStart:`${friday}T15:00`,alternativeStart:`${friday}T16:00`})
  await act(race.id,owner.id,'submit')
  const racingMeeting=await createFdeFridayMeeting(project.id,owner.id,{...meetingBody,startsAt:`${friday}T15:00`,endsAt:`${friday}T16:00`,clientRequestId:randomUUID()})
  const confirmInput={clientRequestId:randomUUID(),expectedVersion:2,action:'confirm',reason:'并发领导确认'}
  const scheduleInput={clientRequestId:randomUUID(),expectedVersion:1,action:'schedule',reason:'并发会议预约'}
  const racing=await Promise.allSettled([actOnLeaderTime(race.id,leader.id,confirmInput),actOnFdeFridayMeeting(project.id,racingMeeting.meetingId,owner.id,scheduleInput)])
  assert.equal(racing.filter(value=>value.status==='fulfilled').length,1)
  assert.ok(racing.some(value=>value.status==='rejected'&&['TIME_CONFLICT','MEETING_TIME_CONFLICT'].includes(value.reason.code)), JSON.stringify(racing.map(value=>value.status==='fulfilled'?{status:value.status}:{status:value.status,code:value.reason.code,cause:value.reason.cause?.code,message:value.reason.message})))
  const timeWon=racing[0].status==='fulfilled',meetingWon=racing[1].status==='fulfilled'
  assert.equal((await row(race.id)).version,timeWon?3:2)
  assert.equal((await meetingRow(racingMeeting.meetingId)).version,meetingWon?2:1)
  assert.equal((await row(race.id)).status,timeWon?'confirmed':'requested')
  assert.equal((await meetingRow(racingMeeting.meetingId)).workflowStatus,meetingWon?'scheduled':'draft')
  assert.equal((await db.select().from(leaderTimeEvents).where(eq(leaderTimeEvents.requestId,confirmInput.clientRequestId))).length,timeWon?1:0)
  assert.equal((await db.select().from(meetingWorkflowEvents).where(eq(meetingWorkflowEvents.requestId,scheduleInput.clientRequestId))).length,meetingWon?1:0)
  const timeNotices=await db.select().from(leaderTimeNotices).where(and(eq(leaderTimeNotices.timeRequestId,race.id),eq(leaderTimeNotices.version,3)))
  assert.equal(timeNotices.length>0,timeWon)
  assert.equal(new Set(timeNotices.map(value=>value.recipientId)).size,timeNotices.length)
  assert.equal((await db.select().from(meetingWorkflowNotices).where(and(eq(meetingWorkflowNotices.meetingId,racingMeeting.meetingId),eq(meetingWorkflowNotices.version,2)))).length,meetingWon?2:0)
  if(timeWon) await actOnLeaderTime(race.id,leader.id,confirmInput)
  else await actOnFdeFridayMeeting(project.id,racingMeeting.meetingId,owner.id,scheduleInput)
  assert.equal((await row(race.id)).version,timeWon?3:2)
  assert.equal((await meetingRow(racingMeeting.meetingId)).version,meetingWon?2:1)
  await act(race.id,owner.id,(await row(race.id)).status==='confirmed'?'cancel':'withdraw');await meetingAction(racingMeeting.meetingId,'cancel')
  }
  checks.push('FDE-TIME-010:concurrent-cross-project-meeting-and-leader-confirm-have-one-winner')

  const keep=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),preferredStart:`${day}T17:00`,alternativeStart:`${day}T16:00`,priority:'P1'})
  await act(keep.id,owner.id,'submit');await act(keep.id,leader.id,'confirm')
  const autos:string[]=[]
  for(const priority of ['P3','P0']){const created=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),title:`自动排程-${priority}`,preferredStart:`${day}T18:00`,alternativeStart:`${day}T19:00`,priority});await act(created.id,owner.id,'submit');autos.push(created.id)}
  const selection={weekStart:week,requests:[...autos,keep.id].map((rid,index)=>({id:rid,expectedVersion:index===2?3:2}))}
  await code(previewAutoSchedule(owner.id,selection),'TIME_BATCH_FORBIDDEN')
  const preview=await previewAutoSchedule(coordinator.id,selection)
  assert.equal(preview.arranged,2);assert.equal(preview.skipped,1)
  assert.equal(preview.items.find(r=>r.id===autos[1])!.scheduledStart,timeInstant(`${day}T18:00`).toISOString())
  assert.equal((await row(autos[1])).version,2)
  const changedBusy=await writeCalendarEvent(leader.id,{clientRequestId:randomUUID(),definition:{title:'预览之后新增的占用',startsAt:`${day}T18:15`,endsAt:`${day}T18:45`}})
  await code(applyAutoSchedule(coordinator.id,{clientRequestId:randomUUID(),selection,fingerprint:preview.fingerprint}),'TIME_BATCH_STALE')
  assert.equal((await row(autos[1])).version,2)
  const currentPreview=await previewAutoSchedule(coordinator.id,selection),batch={clientRequestId:randomUUID(),selection,fingerprint:currentPreview.fingerprint}
  const applied=await Promise.all([applyAutoSchedule(coordinator.id,batch),applyAutoSchedule(coordinator.id,batch)])
  assert.deepEqual(applied[0],applied[1]);assert.equal((await row(autos[1])).version,3)
  assert.equal((await db.select().from(leaderTimeBatches).where(eq(leaderTimeBatches.id,batch.clientRequestId))).length,1)
  assert.equal((await row(keep.id)).version,3);assert.equal((await row(keep.id)).status,'confirmed')
  await code(applyAutoSchedule(coordinator.id,{...batch,fingerprint:'0'.repeat(64)}),'TIME_BATCH_REQUEST_REUSED')
  for(const rid of autos){await act(rid,leader.id,'confirm');await act(rid,owner.id,'cancel')}
  await act(keep.id,owner.id,'cancel');await cancelCalendarEvent(changedBusy.id,leader.id,{clientRequestId:randomUUID(),expectedVersion:1,reason:'完成预览失效验收'})
  checks.push('FDE-TIME-009/010:automatic-priority-preview-stale-occupancy-blocked-idempotent-batch-keeps-confirmed-slots')

  // Create later deadline first: FDE ordering must not follow creation time.
  const late=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),priority:'P2',latestFinish:`${day}T20:00`})
  const early=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),priority:'P2',latestFinish:`${day}T11:00`})
  await act(late.id,owner.id,'submit');await act(early.id,owner.id,'submit')
  assert.equal((await row(early.id)).latestFinish?.toISOString(),timeInstant(`${day}T11:00`).toISOString())
  const deadlineSelection={weekStart:week,requests:[{id:late.id,expectedVersion:2},{id:early.id,expectedVersion:2}]}
  const deadlinePreview=await previewAutoSchedule(coordinator.id,deadlineSelection)
  assert.equal(deadlinePreview.rulesVersion,'fde-priority-deadline-v2')
  assert.equal(deadlinePreview.items.find(r=>r.id===early.id)?.scheduledStart,timeInstant(`${day}T10:00`).toISOString())
  assert.equal(deadlinePreview.items.find(r=>r.id===late.id)?.scheduledStart,timeInstant(`${day}T14:00`).toISOString())
  await saveLeaderTime(late.id,owner.id,{clientRequestId:randomUUID(),expectedVersion:2,...requestDefinition,priority:'P2',latestFinish:`${day}T09:59`})
  await code(applyAutoSchedule(coordinator.id,{clientRequestId:randomUUID(),selection:deadlineSelection,fingerprint:deadlinePreview.fingerprint}),'VERSION_CONFLICT')
  const revisedSelection={...deadlineSelection,requests:[{id:late.id,expectedVersion:3},{id:early.id,expectedVersion:2}]}
  await code(applyAutoSchedule(coordinator.id,{clientRequestId:randomUUID(),selection:revisedSelection,fingerprint:deadlinePreview.fingerprint}),'TIME_BATCH_STALE')
  const revisedPreview=await previewAutoSchedule(coordinator.id,revisedSelection)
  assert.equal(revisedPreview.items.find(r=>r.id===late.id)?.scheduledStart,timeInstant(`${day}T10:00`).toISOString())
  assert.ok(revisedPreview.items.find(r=>r.id===late.id)?.reason.includes('晚于最晚完成时间'))
  await applyAutoSchedule(coordinator.id,{clientRequestId:randomUUID(),selection:revisedSelection,fingerprint:revisedPreview.fingerprint})
  for(const rid of [late.id,early.id]){await act(rid,leader.id,'confirm');assert.equal((await row(rid)).scheduleNote,null);await act(rid,owner.id,'cancel')}
  const savedHistory=(await db.select().from(leaderTimeEvents).where(and(eq(leaderTimeEvents.timeRequestId,late.id),eq(leaderTimeEvents.action,'save'))))[0]
  assert.ok(JSON.stringify(savedHistory.snapshot).includes(timeInstant(`${day}T09:59`).toISOString()))
  checks.push('FDE-TIME-003/009:deadline-persistence-history-priority-order-not-created-at-stale-preview-and-confirmation-note')

  const fullWeek=shiftDate(week,14)
  for(let offset=0;offset<7;offset++)await writeCalendarEvent(leader.id,{clientRequestId:randomUUID(),definition:{title:'整周占用夹具',startsAt:`${shiftDate(fullWeek,offset)}T07:00`,endsAt:`${shiftDate(fullWeek,offset)}T20:00`}})
  const overflow=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),preferredStart:`${fullWeek}T10:00`,alternativeStart:`${fullWeek}T14:00`,priority:'P0'})
  await actOnLeaderTime(overflow.id,owner.id,{clientRequestId:randomUUID(),expectedVersion:1,action:'submit',reason:'准备无空档验收'})
  const fullSelection={weekStart:fullWeek,requests:[{id:overflow.id,expectedVersion:2}]},fullPreview=await previewAutoSchedule(coordinator.id,fullSelection)
  assert.equal(fullPreview.overflow,1);assert.equal(fullPreview.items[0].scheduledStart,null)
  await applyAutoSchedule(coordinator.id,{clientRequestId:randomUUID(),fingerprint:fullPreview.fingerprint,selection:fullSelection})
  const [overflowRow]=await db.select().from(leaderTimeRequests).where(eq(leaderTimeRequests.id,overflow.id))
  assert.equal(overflowRow.status,'requested');assert.equal(overflowRow.scheduledStart,null);assert.ok(overflowRow.scheduleNote?.includes('无可用时段'))
  checks.push('FDE-TIME-009:no-available-slot-persists-unscheduled-reason-without-shortening-or-confirming')

  const cross=await writeCalendarEvent(owner.id,{clientRequestId:randomUUID(),definition:{title:'跨周个人安排',startsAt:`${shiftDate(week,-1)}T23:45`,endsAt:`${week}T00:15`}})
  assert.ok((await listCalendar(owner.id,week,'personal')).items.some(r=>r.id===cross.id))
  assert.ok((await listCalendar(owner.id,shiftDate(week,-7),'personal')).items.some(r=>r.id===cross.id))
  await cancelCalendarEvent(cross.id,owner.id,{clientRequestId:randomUUID(),expectedVersion:1,reason:'释放跨周日程夹具'})
  const boundary=await writeCalendarEvent(owner.id,{clientRequestId:randomUUID(),definition:{title:'恰在周开始结束的安排',startsAt:`${shiftDate(week,-1)}T23:45`,endsAt:`${week}T00:00`}})
  assert.ok(!(await listCalendar(owner.id,week,'personal')).items.some(r=>r.id===boundary.id))
  await cancelCalendarEvent(boundary.id,owner.id,{clientRequestId:randomUUID(),expectedVersion:1,reason:'释放周边界测试安排'})
  const crossMeeting=await createMeeting({title:'跨周非项目会议',projectName:'非项目',host:owner.name,attendees:[owner.name,member.name],startedAt:timeInstant(`${shiftDate(week,-1)}T23:45`),endsAt:timeInstant(`${week}T00:15`)},[],owner.id)
  assert.ok((await listCalendar(member.id,week,'personal')).items.some(r=>r.id===crossMeeting.id&&r.title==='跨周非项目会议'&&!r.editable))
  assert.ok(!JSON.stringify(await listCalendar(outsider.id,week,'company')).includes('跨周非项目会议'))
  checks.push('FDE-CAL-001/002:cross-week-half-open-calendar-and-nonproject-participant-visibility')

  const derived=await createFdeDirective(project.id,leader.id,{clientRequestId:randomUUID(),content:'时间申请由批示派生',ownerUserId:member.id,dueAt:`${day}T17:00`,conversion:'leadership',requiresReceipt:true})
  const directive=(await getFdeDirectives(project.id,owner.id)).list.find(r=>r.id===derived.directiveId)!,timeId=directive.schedules[0].id
  await assert.rejects(act(timeId,leader.id,'submit'),(error:unknown)=>error instanceof ZodError)
  await saveLeaderTime(timeId,leader.id,{clientRequestId:randomUUID(),expectedVersion:1,...requestDefinition,preferredStart:`${day}T17:00`,alternativeStart:`${day}T18:00`,durationMinutes:30})
  await act(timeId,leader.id,'submit');await act(timeId,leader.id,'confirm')
  const [unchangedTask]=await db.select().from(todos).where(eq(todos.id,directive.task.id));assert.equal(unchangedTask.dueTime,'17:00');assert.equal(unchangedTask.status,'未开始')
  await actOnFdeDirective(project.id,derived.directiveId,leader.id,{clientRequestId:randomUUID(),expectedVersion:1,action:'withdraw',reason:'批示撤回同步取消已确认安排'})
  assert.equal((await row(timeId)).status,'cancelled')
  assert.ok((await boardRow(timeId)).events.some(e=>e.action==='directive-withdraw'))
  checks.push('FDE-COLLAB-010:directive-draft-requires-completion-and-confirmation-withdrawal-cancels-schedule-not-task-deadline')

  const last=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),preferredStart:`${day}T08:00`,alternativeStart:`${day}T09:00`})
  await act(last.id,owner.id,'submit');await act(last.id,leader.id,'reject')
  await code(act(last.id,owner.id,'submit'),'TIME_CLOSED')
  const closing=await createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID(),preferredStart:`${day}T08:00`,alternativeStart:`${day}T09:00`})
  await act(closing.id,owner.id,'submit');await act(closing.id,leader.id,'confirm')
  await db.transaction(async tx=>{await tx.update(projects).set({lifecycle:'closed'}).where(eq(projects.id,project.id));await closeProjectDirectiveSchedules(tx,project.id,owner.id,'项目关闭取消有效日程')})
  assert.equal((await row(closing.id)).status,'cancelled')
  await code(createLeaderTime(owner.id,{...createInput,clientRequestId:randomUUID()}),'TIME_PROJECT_INACTIVE')
  await db.update(users).set({status:'停用'}).where(eq(users.id,outsider.id))
  await code(listCalendar(outsider.id,week,'company'),'TIME_ACTOR_UNAVAILABLE')
  assert.ok((await db.select().from(leaderTimeEvents).where(eq(leaderTimeEvents.timeRequestId,id))).length>=8)
  checks.push('FDE-TIME/LIFE:reject-disabled-actor-project-close-and-retained-history')
  console.log(JSON.stringify({ok:true,prefix:process.env.DB_FREFIX,passed:checks.length,checks}))
} finally {await pool.end()}
