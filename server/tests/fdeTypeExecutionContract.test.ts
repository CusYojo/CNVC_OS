import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { compileTypeExecutionPlan, prepareTypeStageReview, decideTypeStageReview, typeStageConsequence, type TypeExecutionRoster, type TypeExecutionPlan } from '../src/contracts/fdeTypeExecutionContract.js'
import { FDE_NON_INVESTMENT_TYPES } from '../src/contracts/fdeTypePolicyContract.js'
import { typePolicyFixture } from '../src/scripts/fdeTypePolicyFixture.js'
import { prepareTypePlanReview, decideTypePlanReview } from '../src/contracts/fdeTypeExecutionContract.js'

const owner = randomUUID(), secretary = randomUUID(), leader = randomUUID(), secondLeader = randomUUID()
function fixture() {
  const roster: TypeExecutionRoster = { governanceVersion: 3, people: [
    { userId: owner, enabled: true, canReadProject: true, categories: ['project_lead'], roleCodes: [], duties: ['owner'] },
    { userId: secretary, enabled: true, canReadProject: true, categories: ['secretary'], roleCodes: [], duties: ['secretary'] },
    { userId: leader, enabled: true, canReadProject: true, categories: ['institution_leader'], roleCodes: [], duties: ['concerned_leader'] },
    { userId: secondLeader, enabled: true, canReadProject: true, categories: ['institution_leader'], roleCodes: [], duties: ['concerned_leader'] },
  ] }
  return { binding: { projectId: randomUUID(), policyVersionId: randomUUID(), policySha256: 'a'.repeat(64) },
    configuration: typePolicyFixture(), roster, cycleDays: 50, targetDate: '2026-10-30',
    selections: [{ actionKey: 'accept_delivery', userId: owner, dueTime: '18:07' }] }
}
function submission(plan: TypeExecutionPlan, stageKey = plan.configuration.stages[0].key, requesterUserId = secretary) {
  return { requestId: randomUUID(), stageKey, expectedGovernanceVersion: 3, requesterUserId,
    result: '合成阶段成果已逐项核对',
    tasks: plan.actions.filter(a => a.stageKey === stageKey).map(a => ({ taskId: randomUUID(), version: 2,
      actionKey: a.key, ownerUserId: a.ownerUserId, status: '已完成' as const,
      acceptedByUserId: a.ownerUserId === owner ? leader : owner, acceptedFeedbackId: randomUUID(),
      evidence: [{ fileId: randomUUID(), version: 1, sha256: 'b'.repeat(64) }] })),
    materials: plan.configuration.stages.find(s => s.key === stageKey)!.materials.map(m => ({ requirementKey: m.key, kind: 'file' as const,
      evidence: { fileId: randomUUID(), version: 1, sha256: 'c'.repeat(64) } })),
  }
}
const approve = (actorId: string) => ({ actorId, action: 'approve', reason: '独立核对通过' })

test('plan approval requires explicit independently versioned rules and cannot borrow stage approval', () => {
  const input = fixture(), plan = compileTypeExecutionPlan(input)
  assert.throws(() => prepareTypePlanReview(plan, input.roster, secretary, randomUUID()), errorCode('TYPE_EXECUTION_PLAN_POLICY_REQUIRED'))
  input.configuration.planApprovals = [{ duty: 'concerned_leader', name: '独立计划会签', mode: '会签' }]
  const prepared = compileTypeExecutionPlan(input), review = prepareTypePlanReview(prepared, input.roster, secretary, randomUUID())
  const partial = decideTypePlanReview(review, input.roster, approve(leader))
  assert.equal(partial.status, 'reviewing')
  const final = decideTypePlanReview(partial, input.roster, approve(secondLeader))
  assert.equal(final.status, 'approved'); assert.equal(final.kind, 'plan')
  assert.throws(() => decideTypePlanReview(review, input.roster, approve(secretary)), errorCode('TYPE_EXECUTION_REVIEW_FORBIDDEN'))
  assert.throws(() => prepareTypePlanReview(prepared, { ...input.roster, governanceVersion: 4 }, secretary, randomUUID()), errorCode('TYPE_EXECUTION_GOVERNANCE_CHANGED'))
})

test('only current readable applicant can withdraw; terminal history cannot be replayed or forged', () => {
  const input = fixture(), plan = compileTypeExecutionPlan(input)
  const review = prepareTypeStageReview(plan, plan.configuration.stages[0].key, input.roster, submission(plan))
  assert.throws(() => decideTypeStageReview(review, input.roster, { actorId: owner, action: 'withdraw', reason: '不是原申请人' }), errorCode('TYPE_EXECUTION_WITHDRAW_FORBIDDEN'))
  const withdrawn = decideTypeStageReview(review, input.roster, { actorId: secretary, action: 'withdraw', reason: '申请人重新核对材料' })
  assert.equal(withdrawn.status, 'withdrawn'); assert.equal(withdrawn.decisions.length, 1)
  assert.throws(() => decideTypeStageReview(withdrawn, input.roster, approve(owner)), errorCode('TYPE_EXECUTION_REVIEW_TERMINAL'))
  assert.throws(() => decideTypeStageReview({ ...withdrawn, decisions: [] }, input.roster, approve(owner)), errorCode('TYPE_EXECUTION_REVIEW_CORRUPT'))
})
function errorCode(code: string) { return (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === code) }

test('all candidate types compile their independent ordered stages, 50-day plan and stable source identities', () => {
  for (const type of FDE_NON_INVESTMENT_TYPES) {
    const input = fixture(); input.configuration.type = type.code
    input.configuration.stages[0].name = type.name.slice(0, 8) + '准备'
    const before = JSON.stringify(input), plan = compileTypeExecutionPlan(input)
    assert.equal(plan.configuration.type, type.code)
    assert.equal(plan.configuration.stages.length, 2)
    assert.equal(plan.startDate, '2026-09-10')
    assert.equal(plan.actions[0].dueDate, '2026-10-05')
    assert.equal(plan.actions[1].dueDate, '2026-10-30')
    assert.equal(plan.actions[1].dueTime, '18:07')
    assert.equal(plan.actions[0].ownerUserId, secretary)
    assert.equal(plan.actions[1].sourceKey, `type:${input.binding.policyVersionId}:accept_delivery`)
    assert.deepEqual(plan.leaderUserIds, [leader, secondLeader].sort())
    plan.configuration.stages[0].name = '修改返回值'
    assert.equal(JSON.stringify(input), before, 'compiler must not mutate policy or roster')
  }
})
test('compiler retains exact working calendar, phase identity and final-day checks', () => {
  const input = fixture(); input.cycleDays = 15; input.targetDate = '2026-08-31'
  input.configuration.calendar = { basis: 'working', workingWeekdays: [1, 2, 3, 4, 5], holidays: ['2026-08-28'], extraWorkingDates: ['2026-08-29'] }
  const plan = compileTypeExecutionPlan(input)
  assert.equal(plan.startDate, '2026-08-10'); assert.equal(plan.actions.at(-1)!.dueDate, input.targetDate)
  assert.throws(() => compileTypeExecutionPlan({ ...input, targetDate: '2026-08-30' }))
  assert.throws(() => compileTypeExecutionPlan({ ...input, cycleDays: 20 }))
  input.configuration.stages.reverse(); assert.throws(() => compileTypeExecutionPlan(input))
})
test('ambiguous duty needs explicit assignee; unknown, duplicated, out-of-scope and disabled choices fail', () => {
  const input = fixture(), other = randomUUID()
  input.roster.people.push({ ...input.roster.people[1], userId: other })
  assert.throws(() => compileTypeExecutionPlan(input), errorCode('TYPE_EXECUTION_ASSIGNEE_REQUIRED'))
  input.selections.push({ actionKey: 'confirm_objective', userId: other, dueTime: '09:15' })
  assert.equal(compileTypeExecutionPlan(input).actions[0].ownerUserId, other)
  assert.throws(() => compileTypeExecutionPlan({ ...input, selections: [...input.selections, input.selections[0]] }), errorCode('TYPE_EXECUTION_SELECTION_INVALID'))
  assert.throws(() => compileTypeExecutionPlan({ ...input, selections: [...input.selections, { actionKey: 'unknown_action', userId: other, dueTime: null }] }), errorCode('TYPE_EXECUTION_SELECTION_INVALID'))
  input.roster.people.at(-1)!.canReadProject = false
  assert.throws(() => compileTypeExecutionPlan(input), errorCode('TYPE_EXECUTION_ASSIGNEE_INVALID'))
  input.roster.people.at(-1)!.canReadProject = true; input.roster.people.at(-1)!.enabled = false
  assert.throws(() => compileTypeExecutionPlan(input), errorCode('TYPE_EXECUTION_ASSIGNEE_INVALID'))
})
test('organization roles, admin status, display name and missing executive roles never create project authority', () => {
  const input = fixture()
  input.roster.people[1].duties = []
  assert.throws(() => compileTypeExecutionPlan(input), errorCode('TYPE_EXECUTION_DUTY_MISSING'))
  input.roster.people[1].duties = ['secretary']; input.roster.people[1].categories = ['system_admin']
  assert.throws(() => compileTypeExecutionPlan(input), errorCode('TYPE_EXECUTION_DUTY_MISSING'))
  const executive = fixture(); executive.configuration.stages[1].approvals[0].duty = 'chairman'
  executive.roster.people[2].duties.push('chairman')
  assert.throws(() => compileTypeExecutionPlan(executive), errorCode('TYPE_EXECUTION_REVIEW_DUTY_MISSING'))
  executive.roster.people[2].roleCodes.push('FDE_CHAIRMAN'); assert.ok(compileTypeExecutionPlan(executive))
  assert.throws(() => compileTypeExecutionPlan({ ...executive, enabled: true }))
})
test('leader action needs exact time and real eligible project leaders; duplicate identities are rejected', () => {
  const input = fixture()
  assert.throws(() => compileTypeExecutionPlan({ ...input, selections: [] }), errorCode('TYPE_EXECUTION_TIME_REQUIRED'))
  assert.throws(() => compileTypeExecutionPlan({ ...input, selections: [{ ...input.selections[0], dueTime: '25:00' }] }))
  input.configuration.stages[1].approvals[0].duty = 'owner'
  input.roster.people[2].duties = []; input.roster.people[3].duties = []
  assert.throws(() => compileTypeExecutionPlan(input), errorCode('TYPE_EXECUTION_LEADER_MISSING'))
  input.roster.people.push(input.roster.people[0]); assert.throws(() => compileTypeExecutionPlan(input))
})
test('stage submission freezes exact policy, current roster, original-file and accepted-task versions', () => {
  const input = fixture(), plan = compileTypeExecutionPlan(input), command = submission(plan)
  const review = prepareTypeStageReview(plan, 'objectives', input.roster, command)
  assert.equal(review.governanceVersion, 3); assert.deepEqual(review.binding, input.binding)
  assert.deepEqual(review.nodes[0].approverUserIds, [owner])
  command.tasks[0].version = 9; command.materials[0].evidence.version = 5
  assert.equal(review.tasks[0].version, 2); assert.equal(review.materials[0].kind, 'file')
  if (review.materials[0].kind === 'file') assert.equal(review.materials[0].evidence.version, 1)
  assert.equal(review.status, 'reviewing')
})
test('incomplete, duplicate and unaccepted stage tasks or self-accepted results cannot submit', () => {
  const input = fixture(), plan = compileTypeExecutionPlan(input), base = submission(plan)
  assert.throws(() => prepareTypeStageReview(plan, 'objectives', input.roster, { ...base, tasks: [] }))
  assert.throws(() => prepareTypeStageReview(plan, 'objectives', input.roster, { ...base, tasks: [base.tasks[0], base.tasks[0]] }))
  for (const patch of [{ status: '待验收' }, { status: '进行中' }, { acceptedByUserId: base.tasks[0].ownerUserId }, { evidence: [] }, { actionKey: 'accept_delivery' }]) {
    assert.throws(() => prepareTypeStageReview(plan, 'objectives', input.roster, { ...base, tasks: [{ ...base.tasks[0], ...patch }] }))
  }
})
test('stage materials cannot be omitted, substituted or waived without the bound rule and current owner', () => {
  const input = fixture(), plan = compileTypeExecutionPlan(input), command = submission(plan)
  assert.throws(() => prepareTypeStageReview(plan, 'objectives', input.roster, { ...command, materials: [] }), errorCode('TYPE_EXECUTION_MATERIALS_INCOMPLETE'))
  const waiver = { requirementKey: 'objective_evidence', kind: 'waiver', reason: '隔离材料免传说明', authorizedByUserId: owner }
  assert.throws(() => prepareTypeStageReview(plan, 'objectives', input.roster, { ...command, materials: [waiver] }), errorCode('TYPE_EXECUTION_WAIVER_FORBIDDEN'))
  input.configuration.stages[0].allowWaiver = true
  const allowed = compileTypeExecutionPlan(input)
  assert.ok(prepareTypeStageReview(allowed, 'objectives', input.roster, { ...command, materials: [waiver] }))
  assert.throws(() => prepareTypeStageReview(allowed, 'objectives', input.roster, { ...command, materials: [{ ...waiver, authorizedByUserId: leader }] }), errorCode('TYPE_EXECUTION_WAIVER_FORBIDDEN'))
})
test('submission rejects skipped phase, stale governance, unauthorized sender and self-only approval', () => {
  const input = fixture(), plan = compileTypeExecutionPlan(input), base = submission(plan)
  assert.throws(() => prepareTypeStageReview(plan, 'delivery', input.roster, base), errorCode('TYPE_EXECUTION_STAGE_CHANGED'))
  assert.throws(() => prepareTypeStageReview(plan, 'objectives', input.roster, { ...base, expectedGovernanceVersion: 2 }), errorCode('TYPE_EXECUTION_GOVERNANCE_CHANGED'))
  assert.throws(() => prepareTypeStageReview(plan, 'objectives', input.roster, { ...base, requesterUserId: leader }), errorCode('TYPE_EXECUTION_SUBMIT_FORBIDDEN'))
  assert.throws(() => prepareTypeStageReview(plan, 'objectives', input.roster, { ...base, requesterUserId: owner }), errorCode('TYPE_EXECUTION_INDEPENDENT_REVIEW_REQUIRED'))
})
test('sequential approval and co-sign do not advance early; duplicate decisions and self-approval fail', () => {
  const input = fixture()
  input.configuration.stages[0].approvals.push({ duty: 'concerned_leader', name: '双领导会签', mode: '会签' })
  const plan = compileTypeExecutionPlan(input), original = prepareTypeStageReview(plan, 'objectives', input.roster, submission(plan))
  assert.throws(() => decideTypeStageReview(original, input.roster, approve(secretary)), errorCode('TYPE_EXECUTION_REVIEW_FORBIDDEN'))
  assert.throws(() => decideTypeStageReview(original, input.roster, approve(leader)), errorCode('TYPE_EXECUTION_REVIEW_FORBIDDEN'))
  const first = decideTypeStageReview(original, input.roster, approve(owner))
  assert.equal(first.currentNodeIndex, 1); assert.equal(first.status, 'reviewing')
  const partial = decideTypeStageReview(first, input.roster, approve(leader))
  assert.equal(partial.status, 'reviewing')
  assert.throws(() => typeStageConsequence(plan, 'objectives', partial), errorCode('TYPE_EXECUTION_APPROVAL_REQUIRED'))
  assert.throws(() => decideTypeStageReview(partial, input.roster, approve(leader)), errorCode('TYPE_EXECUTION_ALREADY_DECIDED'))
  const approved = decideTypeStageReview(partial, input.roster, approve(secondLeader))
  assert.equal(approved.status, 'approved'); assert.equal(original.nodes[0].approvedByUserIds.length, 0)
  assert.equal(typeStageConsequence(plan, 'objectives', approved).nextStageKey, 'delivery')
  assert.throws(() => decideTypeStageReview(approved, input.roster, approve(owner)), errorCode('TYPE_EXECUTION_REVIEW_TERMINAL'))
})
test('revoked co-signer blocks approval without shrinking frozen set; valid reviewer can return for new revision', () => {
  const input = fixture(), plan = compileTypeExecutionPlan(input)
  const review = prepareTypeStageReview(plan, 'delivery', input.roster, submission(plan, 'delivery', owner))
  const changed = structuredClone(input.roster); changed.governanceVersion++
  changed.people[3].enabled = false
  assert.throws(() => decideTypeStageReview(review, changed, approve(leader)), errorCode('TYPE_EXECUTION_REVIEWER_UNAVAILABLE'))
  assert.throws(() => decideTypeStageReview(review, changed, approve(secondLeader)), errorCode('TYPE_EXECUTION_REVIEW_FORBIDDEN'))
  const newLeader = randomUUID(); changed.people.push({ ...changed.people[2], userId: newLeader })
  assert.throws(() => decideTypeStageReview(review, changed, approve(newLeader)), errorCode('TYPE_EXECUTION_REVIEW_FORBIDDEN'))
  const returned = decideTypeStageReview(review, changed, { actorId: leader, action: 'return', reason: '职责变化退回修订' })
  assert.equal(returned.status, 'returned'); assert.equal(review.status, 'reviewing')
  assert.throws(() => typeStageConsequence(plan, 'delivery', returned), errorCode('TYPE_EXECUTION_APPROVAL_REQUIRED'))
  const again = prepareTypeStageReview(plan, 'delivery', changed, { ...submission(plan, 'delivery', owner), expectedGovernanceVersion: 4 })
  assert.notEqual(again.requestId, returned.requestId)
  assert.deepEqual(again.nodes[0].approverUserIds, [leader, newLeader].sort())
})
test('any-sign closes only final configured stage and binds consequence to exact project and policy', () => {
  const input = fixture(); input.configuration.stages[1].approvals[0].mode = '或签'
  const plan = compileTypeExecutionPlan(input), review = prepareTypeStageReview(plan, 'delivery', input.roster, submission(plan, 'delivery', owner))
  const final = decideTypeStageReview(review, input.roster, approve(leader))
  assert.deepEqual(typeStageConsequence(plan, 'delivery', final), { fromStageKey: 'delivery', nextStageKey: null, nextStageName: null, lifecycle: 'closed', approvalRequestId: review.requestId })
  for (const patch of [{ projectId: randomUUID() }, { policyVersionId: randomUUID() }, { policySha256: 'd'.repeat(64) }]) {
    assert.throws(() => typeStageConsequence({ ...plan, binding: { ...plan.binding, ...patch } }, 'delivery', final), errorCode('TYPE_EXECUTION_BINDING_CHANGED'))
  }
  assert.throws(() => typeStageConsequence(plan, 'objectives', final), errorCode('TYPE_EXECUTION_BINDING_CHANGED'))
})
test('corrupt progress, forged completion, altered frozen rules and injected override fail closed', () => {
  const input = fixture(), plan = compileTypeExecutionPlan(input), review = prepareTypeStageReview(plan, 'objectives', input.roster, submission(plan))
  assert.throws(() => decideTypeStageReview(review, input.roster, { ...approve(owner), override: true }))
  assert.throws(() => decideTypeStageReview({ ...review, currentNodeIndex: 5 }, input.roster, approve(owner)), errorCode('TYPE_EXECUTION_REVIEW_CORRUPT'))
  const final = decideTypeStageReview(review, input.roster, approve(owner))
  assert.throws(() => typeStageConsequence(plan, 'objectives', { ...final, decisions: [] }), errorCode('TYPE_EXECUTION_REVIEW_CORRUPT'))
  assert.throws(() => typeStageConsequence(plan, 'objectives', { ...final, tasks: [] }), errorCode('TYPE_EXECUTION_TASKS_INCOMPLETE'))
  assert.throws(() => typeStageConsequence(plan, 'objectives', { ...final, materials: [] }), errorCode('TYPE_EXECUTION_MATERIALS_INCOMPLETE'))
  const changed = structuredClone(final); changed.nodes[0].name = '替换审核规则'
  assert.throws(() => typeStageConsequence(plan, 'objectives', changed), errorCode('TYPE_EXECUTION_BINDING_CHANGED'))
})
