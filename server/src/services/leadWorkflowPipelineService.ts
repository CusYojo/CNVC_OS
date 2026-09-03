import {
  finishLeadPipelineRun,
  findLeadPipelineDecisionByIdempotencyKey,
  recordLeadPipelineDecision,
  registerLeadPipelinePromptVersion,
  startLeadPipelineRun,
  type LeadPipelineDecisionOutcome,
  type LeadPipelineEvidenceInput,
} from './leadPipelineAuditService.js'
import {
  leadWorkflowAgentContract,
  leadWorkflowAgentRuntime,
  runLeadWorkflowAgent,
  type LeadWorkflowAgentExecution,
  type LeadWorkflowAgentProfile,
  type LeadWorkflowAgentQueryFactory,
} from './leadWorkflowAgentService.js'

export const SUBMIT_LEAD_DECISION_TOOL = 'submit_lead_decision'

// Host-only staging tool: it can append a validated decision/evidence package, but it cannot
// create or update a formal lead. Formal writes remain in the separate host transaction path.
export async function submitLeadDecision(
  input: Parameters<typeof recordLeadPipelineDecision>[0],
) {
  return await recordLeadPipelineDecision(input)
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function objectArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

function text(value: unknown) {
  return String(value ?? '').normalize('NFKC').trim()
}

function evidenceFor(profile: LeadWorkflowAgentProfile, output: Record<string, unknown>): LeadPipelineEvidenceInput[] {
  const rows = profile === 'lead-research-agent'
    ? objectArray(output.facts)
    : profile === 'lead-screening-agent'
      ? objectArray(output.evidence)
      : objectArray(output.patches)
  return rows.map((item) => ({
    sourceId: text(item.sourceId) || null,
    sourceType: 'agent-input',
    locator: text(item.sourceId) || null,
    claim: text(item.claim) || `Agent proposed ${text(item.field) || 'workflow output'}`,
    quote: text(item.quote) || null,
    sourceUrl: text(item.sourceUrl) || null,
    reliability: text(item.reliability) || null,
    verificationStatus: profile === 'lead-enrichment-agent'
      ? 'verified'
      : item.verificationStatus === 'conflicted'
        ? 'conflicted'
        : item.verificationStatus === 'verified'
          ? 'verified'
          : 'unverified',
    metadata: profile === 'lead-enrichment-agent'
      ? { field: item.field, operation: item.operation }
      : {},
  }))
}

function decisionFor(profile: LeadWorkflowAgentProfile, output: Record<string, unknown>) {
  const evidence = evidenceFor(profile, output)
  if (profile === 'lead-screening-agent') {
    return {
      outcome: (['accept', 'reject', 'review'].includes(text(output.decision))
        ? text(output.decision)
        : 'review') as LeadPipelineDecisionOutcome,
      confidence: Number(output.confidence || 0),
      reason: text(output.reason) || 'screening Agent returned no reason',
      evidence,
    }
  }
  if (profile === 'lead-research-agent') {
    const conflicts = objectArray(output.conflicts)
    return {
      outcome: (evidence.length && !conflicts.length ? 'accept' : 'review') as LeadPipelineDecisionOutcome,
      confidence: evidence.length ? 80 : 0,
      reason: text(output.summary) || 'research Agent produced a fact package',
      evidence,
    }
  }
  const conflicts = objectArray(output.conflicts)
  return {
    outcome: (evidence.length && !conflicts.length ? 'accept' : 'review') as LeadPipelineDecisionOutcome,
    confidence: evidence.length ? 80 : 0,
    reason: evidence.length
      ? `enrichment Agent proposed ${evidence.length} evidence-bound patches`
      : 'enrichment Agent found no safe patch',
    evidence,
  }
}

export async function executeLeadWorkflowStage(input: {
  profile: LeadWorkflowAgentProfile
  eventId: string
  idempotencyKey: string
  prompt: string
  subjectType: 'company' | 'project' | 'team' | 'lab' | 'paper'
  subjectName: string
  legalName?: string
  model?: string
  attempt?: number
  hostToolCalls?: number
}, options: {
  queryFactory?: LeadWorkflowAgentQueryFactory
  workDir?: string
  timeoutMs?: number
} = {}) {
  const contract = leadWorkflowAgentContract(input.profile)
  const model = input.model || process.env.LLM_MODEL || 'gpt-5.6-sol'
  const runtime = leadWorkflowAgentRuntime(model, Boolean(options.queryFactory))
  const auditPromptVersion = runtime === 'codex-cli'
    ? `${contract.promptVersion}-codex-v1`
    : contract.promptVersion
  const promptVersion = await registerLeadPipelinePromptVersion({
    agentProfile: input.profile,
    promptVersion: auditPromptVersion,
    schemaVersion: contract.schemaVersion,
    skillVersion: contract.skillVersion,
    toolsetVersion: contract.toolsetVersion,
    prompt: contract.systemPrompt,
    configuration: {
      profileVersion: contract.profileVersion,
      maxTurns: 2,
      outputSchema: contract.outputSchema,
      builtInTools: [],
      hostInputOnly: true,
      runtime,
    },
  })
  const run = await startLeadPipelineRun({
    runKey: input.idempotencyKey,
    eventIds: [input.eventId],
    runtime,
    agentProfile: input.profile,
    promptVersionId: promptVersion.id,
    model,
    attempt: input.attempt ?? 1,
    metadata: {
      profileVersion: contract.profileVersion,
      schemaVersion: contract.schemaVersion,
      skillVersion: contract.skillVersion,
      toolsetVersion: contract.toolsetVersion,
      hostInputOnly: true,
      transport: runtime,
      hostToolCalls: Math.max(0, Math.round(input.hostToolCalls || 0)),
    },
  })
  if (run.status === 'succeeded') {
    const decision = await findLeadPipelineDecisionByIdempotencyKey(`${input.idempotencyKey}:success`)
    if (!decision) throw new Error('completed workflow Agent run is missing its staged decision')
    return { execution: null, promptVersion, run, decision, replayed: true }
  }
  if (run.status === 'failed') {
    const previous = await findLeadPipelineDecisionByIdempotencyKey(`${input.idempotencyKey}:failed`)
    throw Object.assign(new Error('workflow Agent run already failed; retry requires a new attempt idempotency key'), {
      code: 'LEAD_WORKFLOW_RETRY_KEY_REQUIRED',
      retryable: true,
      decisionId: previous?.id,
    })
  }
  try {
    const execution = await runLeadWorkflowAgent({
      profile: input.profile,
      prompt: input.prompt,
      model,
    }, options)
    await finishLeadPipelineRun(run.id, {
      status: 'succeeded',
      inputTokens: execution.usage.inputTokens,
      outputTokens: execution.usage.outputTokens,
      totalTokens: execution.usage.totalTokens,
      toolCalls: execution.toolCalls + Math.max(0, Math.round(input.hostToolCalls || 0)),
      durationMs: execution.durationMs,
      costMicrousd: execution.costMicrousd,
    })
    const output = objectValue(execution.output)
    const normalized = decisionFor(input.profile, output)
    const decision = await submitLeadDecision({
      idempotencyKey: `${input.idempotencyKey}:success`,
      eventId: input.eventId,
      runId: run.id,
      decisionType: input.profile.replace(/^lead-|\-agent$/g, ''),
      outcome: normalized.outcome,
      subjectType: input.subjectType,
      subjectName: input.subjectName,
      legalName: input.legalName,
      confidence: normalized.confidence,
      reason: normalized.reason,
      output,
      actorType: 'agent',
      actorId: model,
      evidence: normalized.evidence,
    })
    return { execution, promptVersion, run, decision, replayed: false }
  } catch (error) {
    const metrics = (error as Error & { leadRunMetrics?: Partial<LeadWorkflowAgentExecution> }).leadRunMetrics
    await finishLeadPipelineRun(run.id, {
      status: 'failed',
      inputTokens: metrics?.usage?.inputTokens,
      outputTokens: metrics?.usage?.outputTokens,
      totalTokens: metrics?.usage?.totalTokens,
      toolCalls: metrics?.toolCalls ?? 0,
      durationMs: metrics?.durationMs,
      costMicrousd: metrics?.costMicrousd,
      error,
    })
    await submitLeadDecision({
      idempotencyKey: `${input.idempotencyKey}:failed`,
      eventId: input.eventId,
      runId: run.id,
      decisionType: input.profile.replace(/^lead-|\-agent$/g, ''),
      outcome: 'failed',
      subjectType: input.subjectType,
      subjectName: input.subjectName,
      legalName: input.legalName,
      confidence: 0,
      reason: `${input.profile} execution failed`,
      output: { retryable: (error as Error & { retryable?: boolean }).retryable === true },
      actorType: 'agent',
      actorId: model,
    })
    throw error
  }
}
