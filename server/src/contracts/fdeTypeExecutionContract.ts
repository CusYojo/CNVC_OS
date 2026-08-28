import { z } from 'zod'
import { approveNodeTransition } from './approvalNodeTransition.js'
import { FDE_PROJECT_DUTIES, FDE_LEADERSHIP_DUTIES } from './fdeGovernanceContract.js'
import { fdeDate, fdeDueTime } from './fdeTaskContract.js'
import { previewTypePlan, typeDuty, typePolicyDefinition } from './fdeTypePolicyContract.js'

// Deterministic execution kernel, not an authorization or persistence boundary.
// Its adapter must load the exact approved/bound policy and current project ACL,
// lock the instance, verify original files and accepted task evidence, and commit
// state + tasks + audit + command receipt atomically. Never accept these trusted
// snapshots directly from an HTTP body. No activation or project creation here.
const uuid = z.string().uuid(), key = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/)
const version = z.number().int().positive()
const fileEvidence = z.object({ fileId: uuid, version, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const person = z.object({
  userId: uuid, enabled: z.boolean(), canReadProject: z.boolean(),
  categories: z.array(z.string()), roleCodes: z.array(z.string()), duties: z.array(typeDuty),
}).strict()
export const typeExecutionRoster = z.object({ governanceVersion: version, people: z.array(person).max(500) }).strict().superRefine((value, ctx) => {
  if (new Set(value.people.map(p => p.userId)).size !== value.people.length) ctx.addIssue({ code: 'custom', message: '项目职责快照不能重复人员' })
  if (value.people.some(p => new Set(p.duties).size !== p.duties.length)) ctx.addIssue({ code: 'custom', message: '同一人员职责不能重复' })
  if (value.people.filter(p => p.duties.includes('owner')).length !== 1) ctx.addIssue({ code: 'custom', message: '项目必须有且只有一个负责人身份' })
})
export type TypeExecutionRoster = z.infer<typeof typeExecutionRoster>
type Duty = z.infer<typeof typeDuty>
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code, status: 409 }) }

export function eligibleTypeExecutionPerson(p: TypeExecutionRoster['people'][number], duty: Duty) {
  if (!p.enabled || !p.canReadProject || !p.duties.includes(duty)) return false
  const categories: readonly string[] = duty === 'owner' ? ['institution_leader', 'project_lead', 'member'] : FDE_PROJECT_DUTIES.find(d => d.code === duty)!.eligible
  if (!p.categories.some(c => categories.includes(c))) return false
  if (duty === 'chairman' && !p.roleCodes.includes('FDE_CHAIRMAN')) return false
  if (duty === 'president' && !p.roleCodes.includes('FDE_PRESIDENT')) return false
  return true
}
const eligible = eligibleTypeExecutionPerson
function candidates(roster: TypeExecutionRoster, duty: Duty) {
  return roster.people.filter(p => eligible(p, duty)).map(p => p.userId).sort()
}
const actionSelection = z.object({ actionKey: key, userId: uuid, dueTime: fdeDueTime.nullable() }).strict()
const binding = z.object({ projectId: uuid, policyVersionId: uuid, policySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const compileInput = z.object({ binding, configuration: typePolicyDefinition, roster: typeExecutionRoster,
  cycleDays: z.number().int(), targetDate: fdeDate, selections: z.array(actionSelection).max(80),
}).strict()

export function compileTypeExecutionPlan(raw: unknown) {
  const input = compileInput.parse(raw), { configuration, roster } = input
  const dates = previewTypePlan({ configuration, cycleDays: input.cycleDays, targetDate: input.targetDate })
  const selections = new Map(input.selections.map(s => [s.actionKey, s]))
  if (selections.size !== input.selections.length || input.selections.some(s => !configuration.actions.some(a => a.key === s.actionKey))) return fail('TYPE_EXECUTION_SELECTION_INVALID', '行动人员选择重复或引用不存在的行动')
  const actions = dates.actions.map(action => {
    const possible = candidates(roster, action.duty), selected = selections.get(action.key)
    if (!possible.length) return fail('TYPE_EXECUTION_DUTY_MISSING', `行动“${action.title}”缺少有效职责人员`)
    if (!selected && possible.length > 1) return fail('TYPE_EXECUTION_ASSIGNEE_REQUIRED', `行动“${action.title}”有多位有效人员，须明确选择负责人`)
    const ownerUserId = selected?.userId ?? possible[0]
    if (!possible.includes(ownerUserId)) return fail('TYPE_EXECUTION_ASSIGNEE_INVALID', '所选负责人不属于该项目当前有效职责')
    if (action.needLeader && !selected?.dueTime) return fail('TYPE_EXECUTION_TIME_REQUIRED', '需要领导参与的行动必须填写精确截止时刻')
    return { ...action, ownerUserId, dueTime: selected?.dueTime ?? null,
      sourceKey: `type:${input.binding.policyVersionId}:${action.key}` }
  })
  // Fail before instantiation for missing review duties, without guessing names
  // or borrowing organization-wide roles as project grants.
  for (const stage of configuration.stages) for (const node of stage.approvals) {
    if (!candidates(roster, node.duty).length) return fail('TYPE_EXECUTION_REVIEW_DUTY_MISSING', `阶段“${stage.name}”缺少有效审核职责`)
  }
  const leaderUserIds = [...new Set(FDE_LEADERSHIP_DUTIES.flatMap(duty => candidates(roster, duty)))].sort()
  if (actions.some(a => a.needLeader) && !leaderUserIds.length) return fail('TYPE_EXECUTION_LEADER_MISSING', '需领导行动缺少项目有效领导，不能伪称时间需求已生成')
  return { binding: input.binding, configuration, governanceVersion: roster.governanceVersion,
    cycleDays: input.cycleDays, targetDate: dates.targetDate, startDate: dates.startDate, actions, leaderUserIds }
}
export type TypeExecutionPlan = ReturnType<typeof compileTypeExecutionPlan>

const taskEvidence = z.object({ taskId: uuid, version, actionKey: key, ownerUserId: uuid,
  status: z.literal('已完成'), acceptedByUserId: uuid, acceptedFeedbackId: uuid,
  evidence: z.array(fileEvidence).min(1).max(20),
}).strict().superRefine((v, ctx) => {
  if (v.ownerUserId === v.acceptedByUserId) ctx.addIssue({ code: 'custom', message: '任务成果必须经非执行人验收' })
  if (new Set(v.evidence.map(e => e.fileId)).size !== v.evidence.length) ctx.addIssue({ code: 'custom', message: '成果文件证据不能重复' })
})
const materialEvidence = z.discriminatedUnion('kind', [
  z.object({ requirementKey: key, kind: z.literal('file'), evidence: fileEvidence }).strict(),
  z.object({ requirementKey: key, kind: z.literal('waiver'), reason: z.string().trim().min(5).max(2000), authorizedByUserId: uuid }).strict(),
])
const submission = z.object({
  requestId: uuid, stageKey: key, expectedGovernanceVersion: version, requesterUserId: uuid,
  result: z.string().trim().min(5).max(8000), tasks: z.array(taskEvidence).min(1).max(80),
  materials: z.array(materialEvidence).max(30),
}).strict()
const node = z.object({ key, name: z.string(), duty: typeDuty, mode: z.enum(['会签', '或签']), approverUserIds: z.array(uuid).min(1), approvedByUserIds: z.array(uuid) }).strict()
const reviewCore = z.object({
  binding, governanceVersion: version, requestId: uuid, requesterUserId: uuid,
  nodes: z.array(node).min(1).max(12), currentNodeIndex: z.number().int().nonnegative(),
  status: z.enum(['reviewing', 'returned', 'approved', 'withdrawn']),
  decisions: z.array(z.object({ nodeKey: key, actorId: uuid, action: z.enum(['approve', 'return', 'withdraw']), reason: z.string().trim().min(2).max(4000) }).strict()),
}).strict()
const reviewSchema = reviewCore.extend({ stageKey: key, result: z.string(), tasks: z.array(taskEvidence), materials: z.array(materialEvidence) }).strict()
const planReviewSchema = reviewCore.extend({ kind: z.literal('plan') }).strict()
export type TypeStageReview = z.infer<typeof reviewSchema>
export type TypePlanReview = z.infer<typeof planReviewSchema>
type ReviewCore = z.infer<typeof reviewCore>

export function prepareTypePlanReview(plan: TypeExecutionPlan, rawRoster: unknown, requesterUserId: string, requestId: string): TypePlanReview {
  const roster = typeExecutionRoster.parse(rawRoster), actor = roster.people.find(p => p.userId === requesterUserId)
  if (!actor || !(['owner', 'secretary'] as const).some(d => eligible(actor, d))) return fail('TYPE_EXECUTION_SUBMIT_FORBIDDEN', '仅当前负责人或推进秘书可提交计划')
  if (plan.governanceVersion !== roster.governanceVersion) return fail('TYPE_EXECUTION_GOVERNANCE_CHANGED', '计划职责版本已变化，请重新保存计划')
  if (!plan.configuration.planApprovals?.length) return fail('TYPE_EXECUTION_PLAN_POLICY_REQUIRED', '绑定模板未明确计划审核规则，请批准新模板版本，不借用投资或阶段审核规则')
  const nodes = plan.configuration.planApprovals.map((definition, i) => {
    const approverUserIds = candidates(roster, definition.duty).filter(id => id !== requesterUserId)
    if (!approverUserIds.length) return fail('TYPE_EXECUTION_INDEPENDENT_REVIEW_REQUIRED', '计划缺少非申请人的有效审核人')
    return { ...definition, key: `node_${i + 1}`, approverUserIds, approvedByUserIds: [] }
  })
  return planReviewSchema.parse({ kind: 'plan', binding: plan.binding, governanceVersion: roster.governanceVersion, requesterUserId, requestId, nodes, currentNodeIndex: 0, status: 'reviewing', decisions: [] })
}

function validateStageEvidence(plan: TypeExecutionPlan, stageKey: string, input: Pick<TypeStageReview, 'tasks' | 'materials'>) {
  const stage = plan.configuration.stages.find(s => s.key === stageKey)
  if (!stage) return fail('TYPE_EXECUTION_STAGE_INVALID', '当前阶段不属于绑定模板')
  const expected = plan.actions.filter(a => a.stageKey === stage.key)
  if (input.tasks.length !== expected.length || new Set(input.tasks.map(t => t.taskId)).size !== input.tasks.length
    || new Set(input.tasks.map(t => t.acceptedFeedbackId)).size !== input.tasks.length
    || new Set(input.tasks.map(t => t.actionKey)).size !== input.tasks.length
    || input.tasks.some(t => !expected.some(a => a.key === t.actionKey))) return fail('TYPE_EXECUTION_TASKS_INCOMPLETE', '必须核对本阶段每项行动的唯一正式任务和已验收成果')
  const requirements = new Map(stage.materials.map(m => [m.key, m]))
  if (input.materials.length !== requirements.size || new Set(input.materials.map(m => m.requirementKey)).size !== input.materials.length
    || input.materials.some(m => !requirements.has(m.requirementKey))) return fail('TYPE_EXECUTION_MATERIALS_INCOMPLETE', '阶段材料必须完整且与绑定要求逐项对应')
  if (!stage.allowWaiver && input.materials.some(m => m.kind === 'waiver')) return fail('TYPE_EXECUTION_WAIVER_FORBIDDEN', '绑定规则不允许材料免传')
  return stage
}

export function prepareTypeStageReview(plan: TypeExecutionPlan, currentStageKey: string, rawRoster: unknown, raw: unknown): TypeStageReview {
  const roster = typeExecutionRoster.parse(rawRoster), input = submission.parse(raw)
  if (input.stageKey !== currentStageKey) return fail('TYPE_EXECUTION_STAGE_CHANGED', '只能提交当前阶段，不能跳阶段或重放旧阶段')
  if (input.expectedGovernanceVersion !== roster.governanceVersion) return fail('TYPE_EXECUTION_GOVERNANCE_CHANGED', '项目职责已变化，请重新核对')
  const requester = roster.people.find(p => p.userId === input.requesterUserId)
  if (!requester || !(['owner', 'secretary'] as const).some(d => eligible(requester, d))) return fail('TYPE_EXECUTION_SUBMIT_FORBIDDEN', '仅当前负责人或推进秘书可提交阶段成果')
  const stage = validateStageEvidence(plan, currentStageKey, input)
  // Ownership may have changed through an authorized handover: use the current
  // persisted task snapshot, not the historical planned owner, for self-review.
  for (const material of input.materials) if (material.kind === 'waiver') {
    const author = roster.people.find(p => p.userId === material.authorizedByUserId)
    if (!stage.allowWaiver || !author || !eligible(author, 'owner')) return fail('TYPE_EXECUTION_WAIVER_FORBIDDEN', '该材料免传未满足绑定规则及当前负责人授权')
  }
  const nodes = stage.approvals.map((definition, i) => {
    const approverUserIds = candidates(roster, definition.duty).filter(id => id !== input.requesterUserId)
    if (!approverUserIds.length) return fail('TYPE_EXECUTION_INDEPENDENT_REVIEW_REQUIRED', `审核节点“${definition.name}”没有非申请人的有效审核人`)
    return { ...definition, key: `node_${i + 1}`, approverUserIds, approvedByUserIds: [] as string[] }
  })
  return reviewSchema.parse({ binding: plan.binding, stageKey: stage.key, governanceVersion: roster.governanceVersion,
    requestId: input.requestId, requesterUserId: input.requesterUserId, result: input.result,
    tasks: input.tasks, materials: input.materials, nodes, currentNodeIndex: 0, status: 'reviewing', decisions: [] })
}

function validateReviewProgress(review: ReviewCore) {
  if (review.currentNodeIndex >= review.nodes.length) return fail('TYPE_EXECUTION_REVIEW_CORRUPT', '当前审核节点越界')
  if (new Set(review.nodes.map(n => n.key)).size !== review.nodes.length) return fail('TYPE_EXECUTION_REVIEW_CORRUPT', '审核节点键重复')
  const decisionKeys = new Set<string>()
  let lastIndex = 0, returned = false, withdrawn = false
  for (const d of review.decisions) {
    const i = review.nodes.findIndex(n => n.key === d.nodeKey), identity = `${d.nodeKey}:${d.actorId}`
    if (returned || withdrawn || i < lastIndex || i < 0 || i > review.currentNodeIndex || decisionKeys.has(identity)
      || (d.action === 'withdraw' ? d.actorId !== review.requesterUserId : !review.nodes[i].approverUserIds.includes(d.actorId))) return fail('TYPE_EXECUTION_REVIEW_CORRUPT', '审核决定历史不一致')
    lastIndex = i; decisionKeys.add(identity); returned = d.action === 'return'; withdrawn = d.action === 'withdraw'
  }
  if ((review.status === 'returned') !== returned) return fail('TYPE_EXECUTION_REVIEW_CORRUPT', '退回状态缺少一致的决定记录')
  if ((review.status === 'withdrawn') !== withdrawn) return fail('TYPE_EXECUTION_REVIEW_CORRUPT', '撤回状态缺少一致的决定记录')
  for (let i = 0; i < review.nodes.length; i++) {
    const n = review.nodes[i], approved = new Set(n.approvedByUserIds)
    const recorded = review.decisions.filter(d => d.nodeKey === n.key && d.action === 'approve').map(d => d.actorId)
    if (new Set(n.approverUserIds).size !== n.approverUserIds.length || approved.size !== n.approvedByUserIds.length
      || n.mode === '或签' && approved.size > 1 || recorded.length !== approved.size || recorded.some(id => !approved.has(id))
      || n.approverUserIds.includes(review.requesterUserId) || n.approvedByUserIds.some(id => !n.approverUserIds.includes(id))) return fail('TYPE_EXECUTION_REVIEW_CORRUPT', '冻结审核名单或决定不一致')
    const complete = n.mode === '或签' ? approved.size > 0 : n.approverUserIds.every(id => approved.has(id))
    if (i < review.currentNodeIndex && !complete || i > review.currentNodeIndex && approved.size
      || review.status === 'reviewing' && i === review.currentNodeIndex && complete
      || review.status === 'approved' && !complete) return fail('TYPE_EXECUTION_REVIEW_CORRUPT', '审核顺序或终态不一致')
  }
  if (review.status === 'approved' && review.currentNodeIndex !== review.nodes.length - 1) return fail('TYPE_EXECUTION_REVIEW_CORRUPT', '非末节点不能产生最终批准')
}

export function decideTypeStageReview(rawReview: unknown, rawRoster: unknown, rawDecision: unknown): TypeStageReview {
  return decideReview(reviewSchema.parse(rawReview), rawRoster, rawDecision)
}
export function decideTypePlanReview(rawReview: unknown, rawRoster: unknown, rawDecision: unknown): TypePlanReview {
  return decideReview(planReviewSchema.parse(rawReview), rawRoster, rawDecision)
}
function decideReview<T extends ReviewCore>(review: T, rawRoster: unknown, rawDecision: unknown): T {
  const roster = typeExecutionRoster.parse(rawRoster)
  const decision = z.object({ actorId: uuid, action: z.enum(['approve', 'return', 'withdraw']), reason: z.string().trim().min(2).max(4000) }).strict().parse(rawDecision)
  validateReviewProgress(review)
  if (review.status !== 'reviewing') return fail('TYPE_EXECUTION_REVIEW_TERMINAL', '阶段申请已结束，不能重复决定')
  const current = review.nodes[review.currentNodeIndex], actor = roster.people.find(p => p.userId === decision.actorId)
  if (decision.action === 'withdraw') {
    if (decision.actorId !== review.requesterUserId || !actor || !actor.enabled || !actor.canReadProject) return fail('TYPE_EXECUTION_WITHDRAW_FORBIDDEN', '仅仍有项目权限的原申请人可撤回')
    return { ...review, status: 'withdrawn', decisions: [...review.decisions, { ...decision, nodeKey: current.key }] }
  }
  if (decision.actorId === review.requesterUserId || !current.approverUserIds.includes(decision.actorId)
    || !actor || !eligible(actor, current.duty)) return fail('TYPE_EXECUTION_REVIEW_FORBIDDEN', '仅当前节点仍有资格的冻结审核人可决定，申请人不能自批')
  if (current.approvedByUserIds.includes(decision.actorId)) return fail('TYPE_EXECUTION_ALREADY_DECIDED', '已提交该节点决定，不能重复或以退回改写旧决定')
  const decisions = [...review.decisions, { ...decision, nodeKey: current.key }]
  if (decision.action === 'return') return { ...review, decisions, status: 'returned' }
  // Any missing remaining co-signer blocks progress; do not shrink the frozen
  // electorate after role loss or silently substitute newly assigned people.
  if (current.mode === '会签' && current.approverUserIds.some(id => !current.approvedByUserIds.includes(id)
    && !roster.people.some(p => p.userId === id && eligible(p, current.duty)))) return fail('TYPE_EXECUTION_REVIEWER_UNAVAILABLE', '当前会签存在失效审核人，须受控退回修订，不能缩减名单')
  const transition = approveNodeTransition({ ...current, actorId: decision.actorId })
  const nodes = review.nodes.map((n, i) => i === review.currentNodeIndex ? { ...n, approvedByUserIds: transition.approvedIds } : n)
  const final = transition.completed && review.currentNodeIndex === review.nodes.length - 1
  return { ...review, nodes, decisions, status: final ? 'approved' : 'reviewing',
    currentNodeIndex: transition.completed && !final ? review.currentNodeIndex + 1 : review.currentNodeIndex }
}

export function typeStageConsequence(plan: TypeExecutionPlan, currentStageKey: string, rawReview: unknown) {
  const review = reviewSchema.parse(rawReview)
  validateReviewProgress(review)
  if (review.status !== 'approved') return fail('TYPE_EXECUTION_APPROVAL_REQUIRED', '只有全部节点批准才可推进阶段')
  if (review.stageKey !== currentStageKey || review.binding.projectId !== plan.binding.projectId
    || review.binding.policyVersionId !== plan.binding.policyVersionId || review.binding.policySha256 !== plan.binding.policySha256) return fail('TYPE_EXECUTION_BINDING_CHANGED', '阶段或项目绑定版本不一致')
  const index = plan.configuration.stages.findIndex(s => s.key === currentStageKey)
  if (index < 0) return fail('TYPE_EXECUTION_STAGE_INVALID', '阶段不存在')
  const stage = validateStageEvidence(plan, currentStageKey, review)
  if (stage.approvals.length !== review.nodes.length || review.nodes.some((n, i) => {
    const required = stage.approvals[i]
    return n.key !== `node_${i + 1}` || n.duty !== required.duty || n.mode !== required.mode || n.name !== required.name
  })) return fail('TYPE_EXECUTION_BINDING_CHANGED', '冻结审核节点与绑定阶段规则不一致')
  const next = plan.configuration.stages[index + 1]
  return { fromStageKey: currentStageKey, nextStageKey: next?.key ?? null,
    nextStageName: next?.name ?? null, lifecycle: next ? 'active' as const : 'closed' as const,
    approvalRequestId: review.requestId }
}
