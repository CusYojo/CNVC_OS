import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { validLeaderSlot, timeInstant, timeLocal, intervalsOverlap, timeActionSchema, calendarDefinitionSchema, taskCalendarScheduleSchema, timeCreateSchema } from '../src/contracts/fdeTimeContract.js'

test('leader slot enforces real Shanghai date, 07-20 bounds and quarter hours',()=>{
  assert.ok(validLeaderSlot('2026-08-28T07:00',780))
  for(const [start,duration] of [['2026-02-30T10:00',60],['2026-08-28T06:45',60],['2026-08-28T19:45',30],['2026-08-28T10:01',60],['2026-08-28T10:00',20]] as const) assert.equal(validLeaderSlot(start,duration),false)
  assert.equal(timeInstant('2026-08-28T10:15').toISOString(),'2026-08-28T02:15:00.000Z')
  assert.equal(timeLocal(timeInstant('2026-08-28T10:15')),'2026-08-28T10:15')
})
test('overlap is half-open and allows adjacent appointments',()=>{
  const d=(t:string)=>timeInstant(`2026-08-28T${t}`)
  assert.equal(intervalsOverlap(d('10:00'),d('11:00'),d('11:00'),d('12:00')),false)
  assert.equal(intervalsOverlap(d('10:00'),d('11:00'),d('10:45'),d('12:00')),true)
})
test('leader commands reject injected confirmation/time fields and incomplete requests',()=>{
  const input={clientRequestId:randomUUID(),expectedVersion:1,action:'confirm',reason:'本人确认'}
  assert.ok(timeActionSchema.safeParse(input).success)
  assert.equal(timeActionSchema.safeParse({...input,scheduledStart:'2026-08-28T12:00'}).success,false)
  assert.equal(timeCreateSchema.safeParse({clientRequestId:randomUUID(),projectId:randomUUID(),leaderId:randomUUID(),title:'待补充申请'}).success,false)
})
test('personal schedules support cross-midnight without accepting rollover or arbitrary minute steps',()=>{
  const event={title:'个人安排',startsAt:'2026-08-28T23:45',endsAt:'2026-08-29T00:15'}
  assert.ok(calendarDefinitionSchema.safeParse(event).success)
  assert.equal(calendarDefinitionSchema.safeParse({...event,endsAt:'2026-08-30T00:15'}).success,false)
  assert.equal(calendarDefinitionSchema.safeParse({...event,startsAt:'2026-08-28T23:46'}).success,false)
})
test('task calendar schedules use source and schedule versions and retain quarter-hour duration',()=>{
  const input={clientRequestId:randomUUID(),expectedVersion:0,sourceVersion:2,startsAt:'2026-09-01T09:15',endsAt:'2026-09-01T10:45',hidden:false,reason:'本人调整任务排期'}
  assert.ok(taskCalendarScheduleSchema.safeParse(input).success)
  assert.equal(taskCalendarScheduleSchema.safeParse({...input,endsAt:'2026-09-01T10:46'}).success,false)
  assert.equal(taskCalendarScheduleSchema.safeParse({...input,expectedVersion:-1}).success,false)
})
test('new leader requests require a real deadline; deadline precision is separate from slot precision',()=>{
  const input={clientRequestId:randomUUID(),projectId:randomUUID(),leaderId:randomUUID(),title:'业务沟通',reason:'需要确认业务沟通安排',outcome:'明确下一步',impact:'影响项目进度',preferredStart:'2030-01-08T10:00',alternativeStart:'2030-01-08T14:00',durationMinutes:60,location:'线上会议'}
  assert.equal(timeCreateSchema.safeParse(input).success,false)
  assert.equal(timeCreateSchema.safeParse({...input,latestFinish:'2030-02-30T18:00'}).success,false)
  assert.equal(timeCreateSchema.safeParse({...input,latestFinish:null}).success,false)
  assert.ok(timeCreateSchema.safeParse({...input,latestFinish:'2030-01-08T23:59'}).success)
})
