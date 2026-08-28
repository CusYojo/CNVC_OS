import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateProjectReplan, projectReplanPolicy, projectReplanSubmit, type ProjectReplanPolicy, type ReplanTask } from '../src/contracts/fdeProjectReplanContract.js'
import { buildAgentTimeline } from '../src/contracts/fdeAgentScheduleContract.js'

const policy: ProjectReplanPolicy = { schemaVersion: 1, timezone: 'Asia/Shanghai', calendarBasis: 'calendar', strategy: 'shift_remaining', requesterDuties: ['owner', 'secretary'], approvals: [{ duty: 'president', name: '合成独立审核', mode: '会签' }], protectedConflict: 'block' }
const base = () => ({ previousTargetDate: '2026-10-30', targetDate: '2026-11-09', today: '2026-08-28', currentStage: '立项', policy,
  stages: buildAgentTimeline('2026-10-30', 40, [], { 入库: '2026-08-27' }).map(s => ({ ...s, independent: false })), tasks: [] as ReplanTask[], leaders: [] as Array<{ id: string; taskId: string; status: string; version: number; sourceVersion: number; automatic: boolean }> })
const task = (patch: Partial<ReplanTask> = {}): ReplanTask => ({ id: 'task', stage: '立项', title: '准备材料', status: '未开始', version: 1, dueDate: '2026-09-23', dueTime: '18:00', ownerUserId: 'owner', baseline: { dueDate: '2026-09-23', dueTime: '18:00', ownerUserId: 'owner' }, retired: false, pendingExtension: false, planActionId: null, ...patch })
const codes = (value: ReturnType<typeof base>) => calculateProjectReplan(value).blockers.map(b => b.code)

test('natural-day shift preserves actual/history, stable task ID and relative offset', () => {
  const input = base(); input.tasks.push(task())
  const before = structuredClone(input), out = calculateProjectReplan(input)
  assert.deepEqual(input, before)
  assert.deepEqual(out.blockers, [])
  assert.equal(out.stages[0].action, 'keep'); assert.equal(out.stages[0].after, out.stages[0].before)
  assert.equal(out.stages.at(-1)?.after, '2026-11-09')
  assert.equal(out.tasks[0].id, 'task'); assert.equal(out.tasks[0].after, '2026-10-03')
})
for (const status of ['已完成', '已关闭', '已取消', '已归档', '待验收', '待确认']) test(`does not rewrite ${status} task fact`, () => {
  const input = base(); input.tasks.push(task({ status }))
  const out = calculateProjectReplan(input); assert.equal(out.tasks[0].action, 'keep'); assert.equal(out.tasks[0].after, input.tasks[0].dueDate)
})
for (const patch of [{ dueDate: '2026-10-01' }, { dueTime: '16:00' }, { ownerUserId: 'other' }, { pendingExtension: true }]) test(`independent task change blocks: ${JSON.stringify(patch)}`, () => {
  const input = base(); input.tasks.push(task(patch)); assert.ok(codes(input).includes('REPLAN_PROTECTED_TASK'))
  assert.equal(calculateProjectReplan(input).tasks[0].action, 'keep')
})
test('independent node approval cannot authorize overall replacement', () => {
  const input = base(); input.stages[2].independent = true
  assert.ok(codes(input).includes('REPLAN_INDEPENDENT_STAGE')); assert.equal(calculateProjectReplan(input).stages[2].action, 'keep')
})
test('unconfigured policy cannot silently choose a calendar', () => {
  const out = calculateProjectReplan({ ...base(), policy: null })
  assert.ok(out.blockers.some(b => b.code === 'REPLAN_POLICY_REQUIRED')); assert.equal(out.stages.length, 0)
})
test('working day policy cannot silently execute calendar-day algorithm', () => {
  const input = base(); input.policy = { ...policy, calendarBasis: 'working' }
  const out = calculateProjectReplan(input); assert.equal(out.stages.length, 0); assert.ok(codes(input).includes('REPLAN_CALENDAR_UNSUPPORTED'))
})
for (const status of ['pending', 'confirmed', 'rejected', 'withdrawn', 'cancelled']) test(`protect ${status} leader arrangement`, () => {
  const input = base(); input.tasks.push(task()); input.leaders.push({ id: 'leader', taskId: 'task', status, version: 1, sourceVersion: 1, automatic: true })
  assert.ok(codes(input).includes('REPLAN_PROTECTED_LEADER')); assert.equal(calculateProjectReplan(input).leaders[0].action, 'keep')
})
test('untouched source leader requirement moves but never confirms', () => {
  const input = base(); input.tasks.push(task()); input.leaders.push({ id: 'leader', taskId: 'task', status: 'requested', version: 1, sourceVersion: 1, automatic: true })
  const out = calculateProjectReplan(input); assert.equal(out.leaders[0].action, 'move'); assert.deepEqual(out.blockers, [])
  input.leaders[0].version = 2; assert.ok(codes(input).includes('REPLAN_PROTECTED_LEADER'))
})
test('independent plan actions and unmanaged tasks are not silently reanchored', () => {
  const input = base(); input.tasks.push(task({ baseline: null, stage: null, planActionId: 'plan-action' }))
  assert.ok(codes(input).includes('REPLAN_PLAN_ACTION_UNSUPPORTED')); assert.equal(calculateProjectReplan(input).tasks[0].action, 'keep')
})
test('earlier target does not clip deadlines or reorder stage facts', () => {
  const input = base(); input.targetDate = '2026-08-29'; input.tasks.push(task({ baseline: null, stage: null }))
  assert.ok(codes(input).includes('REPLAN_TASK_AFTER_TARGET')); assert.ok(codes(input).includes('REPLAN_STAGE_PAST'))
})
test('leap/year crossings retain exact calendar offsets', () => {
  const input = base(); input.previousTargetDate = '2028-02-29'; input.targetDate = '2028-03-10'; input.stages = buildAgentTimeline(input.previousTargetDate, 40, []).map(s => ({ ...s, independent: false }))
  assert.equal(calculateProjectReplan(input).stages.at(-1)?.after, '2028-03-10')
})
test('a completed final milestone cannot be relabelled by changing only project target', () => {
  const input = base(); input.stages.at(-1)!.actualDate = '2026-10-30'
  assert.ok(codes(input).includes('REPLAN_TARGET_INCONSISTENT'))
  assert.equal(calculateProjectReplan(input).stages.at(-1)?.action, 'keep')
})
test('strict request rejects injected policy, actor and invalid dates', () => {
  const input = { clientRequestId: '11111111-1111-4111-8111-111111111111', targetDate: '2026-10-01', fingerprint: 'a'.repeat(64), reason: '经过核对的重排原因' }
  assert.equal(projectReplanSubmit.safeParse(input).success, true)
  for (const extra of [{ policy }, { actorId: 'admin' }, { targetDate: '2026-02-30' }, { reason: '短' }]) assert.equal(projectReplanSubmit.safeParse({ ...input, ...extra }).success, false)
  assert.equal(projectReplanPolicy.safeParse({ ...policy, requesterDuties: ['owner', 'owner'] }).success, false)
})
