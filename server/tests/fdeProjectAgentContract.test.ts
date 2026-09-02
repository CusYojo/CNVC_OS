import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { agentConfigInput, agentDate, agentDecisionInput, agentRunInput, agentSourcesStillCurrent, agentReceiptSchema, agentResolutionSchema, defaultProjectAgentConfig, evaluateProjectAgentRules, mergeProjectAgentModel, projectedAgentStageDate, projectAgentModelPacket, type ProjectAgentFacts } from '../src/contracts/fdeProjectAgentContract.js'

const fact = (extra: Partial<ProjectAgentFacts> = {}): ProjectAgentFacts => ({ projectId: 'p1', projectVersion: 1, asOfDate: '2026-08-28', stage: '内核', lifecycle: 'active', targetDate: '2026-09-30', currentDate: '2026-09-20', dateBasis: 'cycle_projection', gateKnown: true, gateMissing: [], incomplete: false, tasks: [], activeApprovalIds: [], pendingExtensionIds: [], evidence: [{ id: 'p1', kind: 'project', label: '项目', version: 1, fingerprint: 'p' }], observations: [], ...extra })
test('agent commands reject auto-apply, client facts and unsupported configuration', () => {
  const id = randomUUID()
  assert.ok(agentConfigInput.safeParse({ clientRequestId: id, expectedVersion: 0, configuration: defaultProjectAgentConfig }).success)
  assert.equal(agentConfigInput.safeParse({ clientRequestId: id, expectedVersion: 0, configuration: { ...defaultProjectAgentConfig, autoApply: true } }).success, false)
  assert.equal(agentRunInput.safeParse({ clientRequestId: id, expectedConfigVersion: 0, facts: fact() }).success, false)
  assert.equal(defaultProjectAgentConfig.modelEnabled, true)
})
test('dates are real calendar dates and reference cycle projection never fabricates history', () => {
  assert.equal(agentDate.safeParse('2026-02-30').success, false)
  assert.equal(projectedAgentStageDate('内核', '2026-09-30', 40), '2026-09-20')
  assert.equal(projectedAgentStageDate('投决', '2026-09-30', 30), '2026-09-27')
  assert.equal(projectedAgentStageDate('未知类型', '2026-09-30', 30), null)
  assert.equal(projectedAgentStageDate('投决', null, 30), null)
})
test('closed, unknown or partial sources cannot be judged ready', () => {
  for (const extra of [{ gateKnown: false }, { incomplete: true }, { lifecycle: 'closed' }]) assert.equal(evaluateProjectAgentRules(fact(extra)).health, 'needs_information')
})
test('material preparation is tolerant before the node date and warns when the node is near', () => {
  const overdue = [{ id: 't1', title: '待交付', status: '进行中', overdue: true, blocked: false }]
  const preparing = evaluateProjectAgentRules(fact({ gateMissing: ['商业计划书'] }))
  assert.equal(preparing.health, 'on_track'); assert.equal(preparing.action, 'keep')
  assert.equal(evaluateProjectAgentRules(fact({ gateMissing: ['商业计划书'], currentDate: '2026-08-30', tasks: overdue })).action, 'pause')
  for (const extra of [{ activeApprovalIds: ['a1'] }, { pendingExtensionIds: ['a1'] }]) {
    const result = evaluateProjectAgentRules(fact({ ...extra, tasks: overdue }))
    assert.equal(result.health, 'waiting_approval'); assert.equal(result.suggestedDate, null)
  }
})
test('delay, overdue and advance derive only from provided current facts', () => {
  const tasks = [{ id: 't1', title: '阻塞行动', status: '待验收', overdue: true, blocked: true }]
  const result = evaluateProjectAgentRules(fact({ tasks }))
  assert.equal(result.action, 'delay'); assert.equal(result.suggestedDate, '2026-09-23')
  assert.equal(evaluateProjectAgentRules(fact({ tasks, currentDate: null })).suggestedDate, null)
  assert.equal(evaluateProjectAgentRules(fact({ targetDate: '2026-08-01' })).health, 'overdue')
  assert.equal(evaluateProjectAgentRules(fact()).suggestedDate, '2026-08-30')
})
test('model packet honors document and communication switches without relaxing near-date hard gates', () => {
  const files = ['file', 'material', 'record', 'leadership', 'approval'] as const
  const facts = fact({ gateMissing: ['材料缺失'], evidence: [...fact().evidence, ...files.map(kind => ({ id: kind, kind, label: '敏感来源', version: 1, fingerprint: kind }))], observations: files.map(id => ({ id, text: '不应发送的内容' })) })
  const config = { ...defaultProjectAgentConfig, analyzeDocuments: false, analyzeCommunications: false }
  const packet = projectAgentModelPacket(facts, config)
  assert.deepEqual(packet.evidence.map(e => e.id), ['p1']); assert.deepEqual(packet.observations, [])
  assert.equal(evaluateProjectAgentRules({ ...facts, currentDate: '2026-08-30' }).action, 'pause')
})
test('unknown, suppressed and forged model evidence cause complete fallback', () => {
  const facts = fact(), good = evaluateProjectAgentRules(facts)
  assert.equal(mergeProjectAgentModel(facts, defaultProjectAgentConfig, good).usedModel, true)
  for (const id of ['missing', 'private-file']) assert.equal(mergeProjectAgentModel(facts, defaultProjectAgentConfig, { ...good, evidenceIds: ['p1', id] }).fallbackReason, 'MODEL_EVIDENCE_INVALID')
  assert.equal(mergeProjectAgentModel(facts, defaultProjectAgentConfig, { ...good, confidence: .2 }).fallbackReason, 'MODEL_CONFIDENCE_LOW')
  assert.equal(mergeProjectAgentModel(facts, defaultProjectAgentConfig, { ...good, extra: 'execute' }).fallbackReason, 'MODEL_SCHEMA_INVALID')
})
test('model cannot override deterministic blocks or forge baseline dates', () => {
  const good = evaluateProjectAgentRules(fact())
  assert.equal(mergeProjectAgentModel(fact({ gateMissing: ['材料'], currentDate: '2026-08-30' }), defaultProjectAgentConfig, good).fallbackReason, 'DETERMINISTIC_GATE_PREVAILS')
  assert.equal(mergeProjectAgentModel(fact(), defaultProjectAgentConfig, { ...good, currentDate: '2026-09-21' }).fallbackReason, 'MODEL_DATE_INVALID')
  assert.equal(mergeProjectAgentModel(fact(), defaultProjectAgentConfig, { ...good, suggestedDate: '2026-10-01' }).fallbackReason, 'MODEL_DATE_INVALID')
})
test('decision requires reasons and a distinct explicit modified date field', () => {
  const base = { clientRequestId: randomUUID(), expectedVersion: 1 }
  assert.ok(agentDecisionInput.safeParse({ ...base, decision: 'accepted' }).success)
  assert.equal(agentDecisionInput.safeParse({ ...base, decision: 'rejected', note: '否' }).success, false)
  assert.equal(agentDecisionInput.safeParse({ ...base, decision: 'accepted_with_changes', note: '需要等待补齐材料' }).success, false)
  assert.equal(agentDecisionInput.safeParse({ ...base, decision: 'accepted', suggestedDate: '2026-09-20' }).success, false)
})
test('deterministic and model date suggestions stay inside adjacent stage boundaries', () => {
  const facts = fact({ dateWindow: { minimum: '2026-09-18', maximum: '2026-09-22', available: true } })
  assert.equal(evaluateProjectAgentRules(facts).suggestedDate, '2026-09-18')
  assert.equal(mergeProjectAgentModel(facts, defaultProjectAgentConfig, { ...evaluateProjectAgentRules(facts), suggestedDate: '2026-09-01' }).fallbackReason, 'MODEL_DATE_INVALID')
  const delayed = evaluateProjectAgentRules({ ...facts, tasks: [{ id: 't', title: '阻塞', status: '进行中', overdue: true, blocked: true }] })
  assert.equal(delayed.action, 'escalate'); assert.equal(delayed.suggestedDate, null)
})
test('every snapshot input must remain readable and current, not only cited inputs', () => {
  const original = [...fact().evidence, { id: 'secret', kind: 'file' as const, label: '原件', version: 1, fingerprint: 'old' }]
  assert.equal(agentSourcesStillCurrent(original, original), true)
  assert.equal(agentSourcesStillCurrent(original, fact().evidence), false)
  assert.equal(agentSourcesStillCurrent(original, [original[0], { ...original[1], fingerprint: 'changed' }]), false)
})
test('malformed success and ambiguous missing result cannot release a pending command', () => {
  assert.equal(agentReceiptSchema.safeParse({ ok: true }).success, false)
  assert.equal(agentResolutionSchema.safeParse({ state: 'committed', receipt: null }).success, false)
  assert.equal(agentResolutionSchema.safeParse({ found: false }).success, false)
  assert.equal(agentResolutionSchema.safeParse({ state: 'closed', receipt: null }).success, true)
  assert.equal(agentResolutionSchema.safeParse({ state: 'committed', receipt: { kind: 'run', id: randomUUID(), version: 1 } }).success, true)
})
