import { evolutionCreateSchema, evolutionEditSchema, evolutionExecuteSchema, evolutionPaginationSchema } from '../schemas/aiEvolutionSchema.js'
import { assertEvolutionSpecAccess, evolutionError, type EvolutionActor, type EvolutionPolicyDependencies } from './aiEvolutionPolicyService.js'
import type { MySqlAiEvolutionRepository } from '../repositories/mysql/mysqlAiEvolutionRepository.js'
import type { EvolutionProposal, EvolutionRun, EvolutionEvent } from '../contracts/aiEvolutionContract.js'
import { aiEvolutionExecutorRegistry, type AiEvolutionExecutorRegistry } from './aiEvolutionExecutorRegistry.js'

type ProposalRow = NonNullable<Awaited<ReturnType<MySqlAiEvolutionRepository['findProposal']>>>
type RunRow = NonNullable<Awaited<ReturnType<MySqlAiEvolutionRepository['findRun']>>>
type Repository = Pick<MySqlAiEvolutionRepository, 'findProposal' | 'listProposals' | 'listProposalActivity' | 'createProposal' | 'editProposal' | 'enqueue' | 'findRun' | 'listEvents' | 'requestCancel' | 'resumeInterrupted'>

function proposalDto(row: ProposalRow): EvolutionProposal {
  return { id: row.id, ownerUserId: row.ownerUserId, spec: row.spec, specHash: row.specHash,
    status: row.status as EvolutionProposal['status'], revision: row.revision,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

function runDto(row: RunRow): EvolutionRun {
  return { id: row.id, proposalId: row.proposalId, inputHash: row.inputHash, status: row.status as EvolutionRun['status'],
    stage: row.stage, attempt: row.attempt, budget: row.budget,
    usage: { modelTokens: row.modelTokens, elapsedSeconds: row.elapsedSeconds, repairRounds: row.repairRounds },
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null, error: row.error,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

function idempotency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw evolutionError(400, 'EVOLUTION_IDEMPOTENCY_REQUIRED', '请提供有效 Idempotency-Key')
  }
  return value
}

export class AiEvolutionService {
  constructor(private readonly repository: Repository, private readonly policy: EvolutionPolicyDependencies,
    private readonly resolveActor: (userId: string) => Promise<EvolutionActor>,
    private readonly executors: Pick<AiEvolutionExecutorRegistry, 'assertReady'> = aiEvolutionExecutorRegistry) {}

  private async actor(userId: string) {
    const actor = await this.resolveActor(userId)
    if (!actor.enabled || actor.userId !== userId) throw evolutionError(403, 'EVOLUTION_USER_DISABLED', '当前账号不可用')
    return actor
  }

  async authorizeSpec(userId: string, spec: EvolutionProposal['spec']) {
    await assertEvolutionSpecAccess(await this.actor(userId), spec, this.policy)
  }

  async create(userId: string, input: unknown, key: unknown) {
    const actor = await this.actor(userId)
    const { spec } = evolutionCreateSchema.parse(input)
    const idem = idempotency(key)
    await assertEvolutionSpecAccess(actor, spec, this.policy)
    return proposalDto(await this.repository.createProposal(userId, spec, idem))
  }

  async list(userId: string, query: unknown) {
    const actor = await this.actor(userId)
    const { limit, offset } = evolutionPaginationSchema.parse(query)
    const rows = await this.repository.listProposals(userId, limit, offset)
    const visible: EvolutionProposal[] = []
    for (const row of rows) {
      try { await assertEvolutionSpecAccess(actor, row.spec, this.policy); visible.push(proposalDto(row)) }
      catch (error) { if ((error as { status?: number }).status !== 403) throw error }
    }
    const activity = await this.repository.listProposalActivity(userId, visible.map(item => item.id))
    return { list: visible, activity, nextOffset: rows.length === limit ? offset + limit : null }
  }

  async get(userId: string, id: string) {
    const actor = await this.actor(userId)
    const row = await this.repository.findProposal(userId, id)
    if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '进化提案不存在或无权访问')
    await assertEvolutionSpecAccess(actor, row.spec, this.policy)
    return proposalDto(row)
  }

  async edit(userId: string, id: string, input: unknown) {
    await this.get(userId, id)
    const actor = await this.actor(userId)
    const { spec, expectedRevision } = evolutionEditSchema.parse(input)
    await assertEvolutionSpecAccess(actor, spec, this.policy)
    return proposalDto(await this.repository.editProposal(userId, id, expectedRevision, spec))
  }

  async execute(userId: string, id: string, input: unknown, key: unknown) {
    const actor = await this.actor(userId)
    const proposal = await this.get(userId, id)
    const { expectedRevision } = evolutionExecuteSchema.parse(input)
    const idem = idempotency(key)
    await assertEvolutionSpecAccess(actor, proposal.spec, this.policy, true)
    await this.executors.assertReady(proposal.spec.kind)
    return runDto(await this.repository.enqueue(userId, id, expectedRevision, proposal.specHash, idem))
  }

  async run(userId: string, id: string) {
    return runDto(await this.authorizeRun(userId, id))
  }

  /** Internal access check uses the immutable run snapshot even after the proposal is edited. */
  async authorizeRun(userId: string, id: string, execute = false) {
    const actor = await this.actor(userId)
    const row = await this.repository.findRun(userId, id)
    if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '进化任务不存在或无权访问')
    await this.get(userId, row.proposalId)
    await assertEvolutionSpecAccess(actor, row.frozenSpec, this.policy, execute)
    return row
  }

  async events(userId: string, id: string, afterSequence: number): Promise<{ list: EvolutionEvent[] }> {
    await this.run(userId, id)
    const rows = await this.repository.listEvents(userId, id, afterSequence)
    return { list: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) }
  }

  async cancel(userId: string, id: string) {
    // Ownership is enough to stop one's own task even after source/project access is revoked.
    await this.actor(userId)
    return runDto(await this.repository.requestCancel(userId, id))
  }

  async resume(userId: string, id: string, expectedAttempt: number) {
    if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 1) throw evolutionError(400, 'EVOLUTION_INVALID_ATTEMPT', '执行轮次无效')
    const row = await this.authorizeRun(userId, id, true)
    await this.executors.assertReady(row.frozenSpec.kind)
    return runDto(await this.repository.resumeInterrupted(userId, id, expectedAttempt))
  }
}
