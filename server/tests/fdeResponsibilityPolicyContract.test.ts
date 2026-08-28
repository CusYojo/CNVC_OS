import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { responsibilityEvents, responsibilityPolicyCommand, responsibilityPolicySchema, responsibilityBusinessDate, responsibilityWorkingDaysBetween, isResponsibilityWorkingDate, type ResponsibilityPolicy } from '../src/contracts/fdeResponsibilityPolicyContract.js'

const fixture = (): ResponsibilityPolicy => ({
  rules: responsibilityEvents.map(event => ({ code: event.code, mode: event.mode, enabled: false, points: null })),
  timezone: 'Asia/Shanghai', calendar: { workingWeekdays: [1, 2, 3, 4, 5], holidays: [], extraWorkingDates: [] },
  earlyWorkingDays: null, graceMinutes: null, appealLimit: 1, appealAggregation: 'exclude_pending',
  allowAdjustment: false, allowExemption: false, completionAggregation: 'one_per_task', feedbackAggregation: 'one_per_actor_task_business_day',
  missingReviewer: 'retain_pending_assignment', history: 'append_only_no_automatic_rescore',
})

test('all eight rules must be explicit, unique and no default demo points are injected', () => {
  const config = fixture()
  assert.deepEqual(responsibilityPolicySchema.parse(config), config)
  assert.equal(responsibilityEvents.length, 8)
  assert.equal(responsibilityPolicySchema.safeParse({}).success, false)
  config.rules[7] = { ...config.rules[0] }
  assert.equal(responsibilityPolicySchema.safeParse(config).success, false)
  assert.equal(responsibilityPolicySchema.safeParse({ ...fixture(), timezone: 'UTC' }).success, false)
})

test('all eight enabled rules enforce direction, manual boundary and required timing policy', () => {
  for (const definition of responsibilityEvents) {
    const config = fixture(), rule = config.rules.find(value => value.code === definition.code)!
    rule.enabled = true
    assert.equal(responsibilityPolicySchema.safeParse(config).success, false)
    rule.points = definition.positive ? -1 : 1
    assert.equal(responsibilityPolicySchema.safeParse(config).success, false)
    rule.points = definition.positive ? 1 : -1
    config.earlyWorkingDays = 1; config.graceMinutes = 0
    assert.equal(responsibilityPolicySchema.safeParse(config).success, true)
    rule.mode = definition.mode === 'manual' ? 'automatic' : 'manual'
    assert.equal(responsibilityPolicySchema.safeParse(config).success, false)
  }
  const early = fixture(); early.rules[1] = { ...early.rules[1], enabled: true, points: 1 }
  assert.equal(responsibilityPolicySchema.safeParse(early).success, false)
  const late = fixture(); late.rules[5] = { ...late.rules[5], enabled: true, points: -1 }
  assert.equal(responsibilityPolicySchema.safeParse(late).success, false)
})

test('calendar uses Shanghai business dates and explicitly configured holidays and make-up days', () => {
  const calendar = fixture().calendar
  assert.equal(responsibilityBusinessDate(new Date('2026-08-27T15:59:59.999Z')), '2026-08-27')
  assert.equal(responsibilityBusinessDate(new Date('2026-08-27T16:00:00.000Z')), '2026-08-28')
  assert.equal(responsibilityWorkingDaysBetween('2026-08-27', '2026-08-31', calendar), 2)
  calendar.holidays = ['2026-08-28']; calendar.extraWorkingDates = ['2026-08-29']
  assert.equal(isResponsibilityWorkingDate('2026-08-28', calendar), false)
  assert.equal(isResponsibilityWorkingDate('2026-08-29', calendar), true)
  assert.equal(responsibilityWorkingDaysBetween('2026-08-27', '2026-08-31', calendar), 2)
  assert.throws(() => responsibilityWorkingDaysBetween('2026-08-31', '2026-08-27', calendar))
  assert.throws(() => responsibilityWorkingDaysBetween('2026-01-01', '2040-01-01', calendar))
  assert.throws(() => responsibilityBusinessDate(new Date('invalid')))
})

test('invalid and conflicting calendar entries are rejected', () => {
  for (const calendar of [
    { workingWeekdays: [1, 1], holidays: [], extraWorkingDates: [] },
    { workingWeekdays: [1], holidays: ['2026-02-30'], extraWorkingDates: [] },
    { workingWeekdays: [1], holidays: ['2026-08-28'], extraWorkingDates: ['2026-08-28'] },
  ]) assert.equal(responsibilityPolicySchema.safeParse({ ...fixture(), calendar }).success, false)
})

test('commands require stable ids, expected versions, reason, and forbid actor injection', () => {
  const input = { commandId: randomUUID(), action: 'create', configuration: fixture(), expectedPolicyVersion: 0, reason: '仅用于隔离契约验收' }
  assert.equal(responsibilityPolicyCommand.safeParse(input).success, true)
  for (const invalid of [{ ...input, commandId: 'bad' }, { ...input, reason: '短' }, { ...input, actorId: randomUUID() }, { ...input, action: 'publish' }, { ...input, expectedPolicyVersion: -1 }]) assert.equal(responsibilityPolicyCommand.safeParse(invalid).success, false)
})
