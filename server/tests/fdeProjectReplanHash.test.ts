import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { replanCanonicalJson, replanHash } from '../src/utils/fdeProjectReplanHash.js'
import { calculateProjectReplan, type ProjectReplanPolicy } from '../src/contracts/fdeProjectReplanContract.js'
import { buildAgentTimeline } from '../src/contracts/fdeAgentScheduleContract.js'

// Models only JSON key normalization, not a real MySQL round trip.
const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value
const policy: ProjectReplanPolicy = { schemaVersion: 1, timezone: 'Asia/Shanghai', calendarBasis: 'calendar', strategy: 'shift_remaining', requesterDuties: ['owner', 'secretary'], approvals: [
  { duty: 'chairman', name: '合成独立一审', mode: '或签' }, { duty: 'president', name: '合成独立二审', mode: '会签' },
], protectedConflict: 'block' }

test('nested policy keys can reorder without invalidating the saved configuration hash', () => {
  const stored = reorder(JSON.parse(JSON.stringify(policy)))
  assert.notEqual(JSON.stringify(stored), JSON.stringify(policy))
  assert.equal(replanHash(stored), replanHash(policy))
})
test('calculated impact, reviewer signature and full source fingerprint survive JSON key normalization', () => {
  const impact = calculateProjectReplan({ targetDate: '2026-11-09', previousTargetDate: '2026-10-30', today: '2026-08-28', currentStage: '立项', policy,
    stages: buildAgentTimeline('2026-10-30', 40, [], { 入库: '2026-08-27' }).map(s => ({ ...s, independent: false })), tasks: [], leaders: [] })
  const reviewers = policy.approvals.map((row, i) => ({ ...row, ids: [`person-${i}`], names: [`姓名-${i}`] }))
  const snapshot = { project: { updatedAt: new Date('2026-08-28T01:02:03.456Z'), actualDate: '2026-08-27', version: 3 }, policy, calculated: impact, approvers: reviewers }
  for (const value of [impact, reviewers, snapshot]) assert.equal(replanHash(value), replanHash(reorder(JSON.parse(JSON.stringify(value)))))
  assert.deepEqual(impact.blockers, [])
})
for (const [name, changed] of [
  ['approval sequence', { ...policy, approvals: [...policy.approvals].reverse() }],
  ['nested approver content', { ...policy, approvals: [{ ...policy.approvals[0], duty: 'president' }, policy.approvals[1]] }],
  ['requester array order', { ...policy, requesterDuties: [...policy.requesterDuties].reverse() }],
  ['calendar basis', { ...policy, calendarBasis: 'working' }],
]) test(`${name} changes are not normalized away`, () => assert.notEqual(replanHash(policy), replanHash(changed)))
test('nested evidence arrays preserve element order, length, types and changed content', () => {
  const evidence = { stages: [{ id: '入库', after: '2026-09-01' }, { id: '立项', after: '2026-09-10' }], version: 1 }
  for (const changed of [
    { ...evidence, stages: [...evidence.stages].reverse() },
    { ...evidence, stages: evidence.stages.slice(0, 1) },
    { ...evidence, stages: [evidence.stages[0], { ...evidence.stages[1], after: '2026-09-11' }] },
    { ...evidence, version: '1' },
    { ...evidence, version: 2 },
  ]) assert.notEqual(replanHash(evidence), replanHash(changed))
})
test('Date preserves its instant including milliseconds and is not an empty object', () => {
  const date = new Date('2026-08-28T09:02:03.456+08:00')
  assert.equal(replanCanonicalJson({ date }), '{"date":"2026-08-28T01:02:03.456Z"}')
  assert.equal(replanHash({ date }), replanHash({ date: '2026-08-28T01:02:03.456Z' }))
  assert.notEqual(replanHash({ date }), replanHash({ date: {} }))
  assert.notEqual(replanHash({ date }), replanHash({ date: new Date(date.getTime() + 1) }))
  assert.notEqual(replanHash({ date: '2026-08-28' }), replanHash({ date: '2026-08-29' }))
  assert.equal(date.toISOString(), '2026-08-28T01:02:03.456Z')
})
test('canonical JSON is locale independent, escapes keys and does not mutate input', () => {
  const input = { z: [3, 1], 'a"': { y: null, x: true }, '10': 'ten', '2': 'two' }, before = structuredClone(input)
  assert.equal(replanCanonicalJson(input), '{"10":"ten","2":"two","a\\\"":{"x":true,"y":null},"z":[3,1]}')
  assert.deepEqual(JSON.parse(replanCanonicalJson(input)), input)
  assert.deepEqual(input, before)
})
test('unsupported values and invalid dates cannot collapse into trusted JSON evidence', () => {
  for (const value of [new Date('invalid'), undefined, NaN, Infinity, new Map(), new Set(), 1n, () => 1, [undefined], Array(1), { field: undefined }]) {
    assert.throws(() => replanHash(value), /REPLAN_HASH_/)
  }
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  assert.throws(() => replanHash(cycle), /REPLAN_HASH_CIRCULAR_VALUE/)
  const shared = { a: 1 }
  assert.equal(replanHash([shared, shared]), replanHash([{ a: 1 }, { a: 1 }]))
})
test('replan writers, readers, historical sources and fixture use one scoped hash', () => {
  for (const path of ['services/fdeProjectReplanService.ts', 'services/fdeMilestoneSourcesService.ts', 'scripts/fdeProjectReplanAcceptance.ts']) {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
    assert.match(source, /fdeProjectReplanHash\.js/)
    assert.doesNotMatch(source, /\bagentHash\b|\bpolicyHash\b|\bcreateHash\b/)
    assert.match(source, /(?:impactHash|configurationHash)\s*(?:!==|===|:)\s*replanHash\(/)
  }
})
