import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { users, todos, meetings, meetingParticipants, personalWeeklyReports } from '../db/schema.js'
import { identityRepositories } from '../repositories/index.js'
import { shanghaiToday, shiftDate, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { timeInstant } from '../contracts/fdeTimeContract.js'
import { writeCalendarEvent, cancelCalendarEvent } from '../services/fdeCalendarService.js'
import { createWeeklyReport, listWeeklyReports, actOnWeeklyReport, weeklyReportRecipients, readWeeklyReport } from '../services/fdeWeeklyReportService.js'

assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
const marker=randomUUID().slice(0,8),week=weekStartFor(shanghaiToday()),checks:string[]=[]
const people=['author','recipient','outsider'].map(kind=>({id:randomUUID(),name:`报告来源-${kind}-${marker}`,email:`report-source-${kind}-${marker}@example.invalid`,role:'投资经理',department:`来源-${marker}`,passwordHash:'not-for-login'}))
const [author,recipient,outsider]=people
const code=async(p:Promise<unknown>,expected:string)=>{const error=await p.then(()=>null,e=>e);assert.equal(error?.code,expected,`${expected}: ${error?.message??'unexpected success'}`)}
try {
  await db.insert(users).values(people)
  for(const p of people)await identityRepositories.users.synchronizeAdministrationBindings(p.id,p.role,p.department)
  const event=async(title:string,startsAt:string,endsAt:string,visibility='company')=>writeCalendarEvent(author.id,{clientRequestId:randomUUID(),definition:{title,detail:'不需要复制到报告的日历正文',startsAt,endsAt,visibility}})
  const boundary=await event('周开始前已结束',`${shiftDate(week,-1)}T22:00`,`${week}T00:00`)
  await cancelCalendarEvent(boundary.id,author.id,{clientRequestId:randomUUID(),expectedVersion:1,reason:'取消边界夹具释放占用'})
  const cross=await event('跨周公开安排',`${shiftDate(week,-1)}T23:45`,`${week}T00:15`)
  const hidden=await event('私人日历不可被默认报告泄露',`${week}T09:00`,`${week}T10:00`,'private')
  const cancelled=await event('本周已取消安排',`${week}T11:00`,`${week}T12:00`)
  await cancelCalendarEvent(cancelled.id,author.id,{clientRequestId:randomUUID(),expectedVersion:1,reason:'本次安排已取消'})
  const create=async(sourceOptions:Record<string,boolean>)=>createWeeklyReport(author.id,{clientRequestId:randomUUID(),weekStart:week,projectIds:[],sourceOptions})
  const row=async(id:string)=>(await listWeeklyReports(author.id,week)).reports.find(r=>r.id===id)!
  const act=async(id:string,action:string,recipientIds:string[]=[])=>actOnWeeklyReport(id,author.id,{clientRequestId:randomUUID(),expectedVersion:(await row(id)).version,action,recipientIds,reason:'隔离来源验收操作'})
  const shared=await create({calendar:true})
  let report=await row(shared.reportId)
  assert.deepEqual(report.facts?.calendar?.map(r=>r.id).sort(),[cross.id,cancelled.id].sort())
  assert.ok(!JSON.stringify(report).includes(hidden.id));assert.ok(!JSON.stringify(report).includes(boundary.id))
  assert.equal(report.facts?.calendar?.find(item=>item.id===cancelled.id)?.status,'cancelled')
  assert.ok(!report.body.includes('本周已取消安排'));assert.equal(report.facts?.metrics.completedInWeek,0)
  checks.push('FDE-CAL-003:explicit-calendar-only-source-cross-week-half-open-cancelled-and-private-default-exclusion')

  await writeCalendarEvent(author.id,{clientRequestId:randomUUID(),expectedVersion:1,definition:{title:'公开安排已改版',startsAt:`${shiftDate(week,-1)}T23:45`,endsAt:`${week}T00:15`,visibility:'company'}},cross.id)
  assert.equal((await row(shared.reportId)).sourceChanged,true)
  await code(act(shared.reportId,'publish',[recipient.id]),'REPORT_SOURCE_CHANGED')
  await act(shared.reportId,'regenerate')
  assert.equal((await row(shared.reportId)).facts?.calendar?.find(r=>r.id===cross.id)?.version,2)
  await act(shared.reportId,'publish',[recipient.id])
  assert.ok((await listWeeklyReports(recipient.id,week)).reports.some(r=>r.id===shared.reportId))
  await readWeeklyReport(shared.reportId,recipient.id)
  await writeCalendarEvent(author.id,{clientRequestId:randomUUID(),expectedVersion:2,definition:{title:'公开安排已改版',startsAt:`${shiftDate(week,-1)}T23:45`,endsAt:`${week}T00:15`,visibility:'private'}},cross.id)
  assert.ok(!(await listWeeklyReports(recipient.id,week)).reports.some(r=>r.id===shared.reportId))
  await code(readWeeklyReport(shared.reportId,recipient.id),'REPORT_SUPPLEMENT_SCOPE')
  checks.push('FDE-CAL-003/AUTH:source-version-blocks-stale-publish-and-current-privacy-revokes-list-and-read')

  const privateReport=await create({calendar:true,privateCalendar:true})
  assert.ok((await row(privateReport.reportId)).body.includes('私人日历不可被默认报告泄露'))
  assert.equal((await weeklyReportRecipients(privateReport.reportId,author.id)).recipients.length,0)
  await code(act(privateReport.reportId,'publish',[recipient.id]),'REPORT_SUPPLEMENT_SCOPE')
  await act(privateReport.reportId,'publish')
  // Changing the live source to public does not publish its earlier private report snapshot.
  for(const [id,title,startsAt,endsAt,version] of [[hidden.id,'私人日历不可被默认报告泄露',`${week}T09:00`,`${week}T10:00`,1],[cross.id,'公开安排已改版',`${shiftDate(week,-1)}T23:45`,`${week}T00:15`,3]] as const)
    await writeCalendarEvent(author.id,{clientRequestId:randomUUID(),expectedVersion:version,definition:{title,startsAt,endsAt,visibility:'company'}},id)
  assert.equal((await weeklyReportRecipients(privateReport.reportId,author.id)).recipients.length,0)
  assert.ok(!(await listWeeklyReports(outsider.id,week)).reports.some(r=>r.id===privateReport.reportId))
  checks.push('FDE-CAL-003/AUTH:private-opt-in-owner-only-and-snapshot-privacy-not-widened-by-later-public-source')

  const taskId=randomUUID(),meetingId=randomUUID()
  await db.insert(todos).values({id:taskId,title:'本人独立待办',owner:author.name,ownerUserId:author.id,dueDate:week,createdBy:author.id})
  await db.insert(meetings).values({id:meetingId,projectName:'非项目',title:'非项目会议去重',host:author.name,hostUserId:author.id,startedAt:timeInstant(`${week}T14:00`),endsAt:timeInstant(`${week}T15:00`),createdBy:author.id})
  await db.insert(meetingParticipants).values({meetingId,userId:recipient.id,sourceName:recipient.name})
  const independent=await create({calendar:true,independentWork:true})
  report=await row(independent.reportId)
  assert.ok(report.facts?.tasks.some(t=>t.id===taskId&&t.projectId===null))
  assert.equal(report.facts?.metrics.meetingRecords,1)
  assert.equal(report.body.split('非项目会议去重').length-1,1)
  assert.ok(report.facts?.calendar?.some(c=>c.id===meetingId))
  await code(act(independent.reportId,'publish',[recipient.id]),'REPORT_SUPPLEMENT_SCOPE')
  await act(independent.reportId,'discard')
  await db.update(todos).set({ownerUserId:outsider.id}).where(eq(todos.id,taskId))
  assert.equal((await row(independent.reportId)).restricted,true)
  const meetingOnly=await create({calendar:true,independentWork:true})
  assert.ok((await weeklyReportRecipients(meetingOnly.reportId,author.id)).recipients.some(r=>r.id===recipient.id))
  assert.ok(!(await weeklyReportRecipients(meetingOnly.reportId,author.id)).recipients.some(r=>r.id===outsider.id))
  await act(meetingOnly.reportId,'publish',[recipient.id])
  await db.delete(meetingParticipants).where(eq(meetingParticipants.meetingId,meetingId))
  await code(readWeeklyReport(meetingOnly.reportId,recipient.id),'REPORT_SUPPLEMENT_SCOPE')
  assert.ok(!(await listWeeklyReports(recipient.id,week)).reports.some(r=>r.id===meetingOnly.reportId))
  const [saved]=await db.select().from(personalWeeklyReports).where(eq(personalWeeklyReports.id,meetingOnly.reportId))
  assert.ok(saved.facts.sourceOptions?.independentWork)
  checks.push('FDE-CAL-003/AUTH:independent-tasks-nonproject-meetings-deduplicated-and-original-plus-current-source-access')
  console.log(JSON.stringify({ok:true,prefix:process.env.DB_FREFIX,passed:checks.length,checks}))
} finally {await pool.end()}
