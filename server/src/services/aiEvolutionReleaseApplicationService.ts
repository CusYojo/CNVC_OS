import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { aiEvolutionReleaseRegistry } from './aiEvolutionReleaseRegistry.js'
import { aiEvolutionService, aiEvolutionArtifactStore, getAiEvolutionCandidateForUser } from './aiEvolutionApplicationService.js'
import { MySqlAiEvolutionCandidateRepository } from '../repositories/mysql/mysqlAiEvolutionCandidateRepository.js'
import { MySqlAiEvolutionReleaseJobRepository } from '../repositories/mysql/mysqlAiEvolutionReleaseJobRepository.js'
import { evolutionError } from './aiEvolutionPolicyService.js'
import { realpath } from 'node:fs/promises'
import { pool } from '../db/client.js'
import { withEvolutionReleaseLock } from './aiEvolutionReleaseLock.js'
import { runEvolutionReleaseRecovery, type EvolutionRecoveryAdapter } from '../runtime/evolution/evolutionReleaseRecovery.js'

const command = promisify(execFile)

/** Host-only entry: adapter factory is trusted deployment code, never a request field. */
export async function recoverAiEvolutionRelease(userId: string, candidateId: string, input: unknown,
  adapterFactory: (target: Awaited<ReturnType<typeof aiEvolutionReleaseRegistry.resolve>>,
    claim: Awaited<ReturnType<MySqlAiEvolutionCandidateRepository['readClaimedRelease']>>) => Promise<EvolutionRecoveryAdapter>) {
  const request = z.object({ approvalId: z.string().uuid(), targetEnvironment: z.string().min(1).max(80) }).strict().parse(input)
  const initial = await context(userId, candidateId)
  const target = await aiEvolutionReleaseRegistry.resolve(userId, initial.repositoryId, request.targetEnvironment)
  const root = await realpath(target.root)
  const repository = new MySqlAiEvolutionCandidateRepository()
  return withEvolutionReleaseLock(pool, root, async control => {
    const authorize = async () => {
      const current = await context(userId, candidateId)
      const registered = await aiEvolutionReleaseRegistry.resolve(userId, current.repositoryId, request.targetEnvironment)
      if (current.repositoryId !== initial.repositoryId || await realpath(registered.root) !== root) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布目标配置已变化，需要重新核对')
      }
    }
    await authorize()
    const claim = await repository.readClaimedRelease(request.approvalId, userId, request.targetEnvironment)
    if (claim.candidateId !== candidateId || claim.kind !== 'code') throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布记录与代码候选不一致')
    await control.assertHeld()
    await authorize()
    let adapterPromise: Promise<EvolutionRecoveryAdapter> | undefined
    const getAdapter = () => adapterPromise ??= adapterFactory({ ...target, root }, claim)
    const adapter: EvolutionRecoveryAdapter = {
      inspect: async (receipt, signal) => (await getAdapter()).inspect(receipt, signal),
      health: async (receipt, version, signal) => (await getAdapter()).health(receipt, version, signal),
      rollback: async (receipt, signal) => (await getAdapter()).rollback(receipt, signal),
    }
    const result = await runEvolutionReleaseRecovery({ claim, control, authorize, adapter,
      finish: async (receipt, outcome) => {
        await repository.completeRelease(request.approvalId, userId, receipt, outcome)
        await new MySqlAiEvolutionReleaseJobRepository().completeByApproval(request.approvalId, receipt, outcome)
      } })
    if (result.duplicate) await new MySqlAiEvolutionReleaseJobRepository().completeByApproval(request.approvalId, result.receipt, result.outcome)
    return result
  })
}
async function context(userId: string, candidateId: string) {
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  const run = await aiEvolutionService.authorizeRun(userId, candidate.runId)
  if (run.frozenSpec.target.type !== 'code') throw evolutionError(409, 'EVOLUTION_RELEASE_KIND', '环境发布仅适用于代码候选')
  return { candidate, repositoryId: run.frozenSpec.target.repositoryId }
}

export async function listAiEvolutionReleaseTargets(userId: string, candidateId: string) {
  const { repositoryId } = await context(userId, candidateId)
  return { list: (await aiEvolutionReleaseRegistry.list(userId, repositoryId)).map(({ id, label }) => ({ id, label })) }
}

export async function approveAiEvolutionRelease(userId: string, candidateId: string, input: unknown) {
  const request = z.object({ targetEnvironment: z.string().min(1).max(80), candidateHash: z.string().regex(/^[a-f0-9]{64}$/), evaluationHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input)
  const { candidate, repositoryId } = await context(userId, candidateId)
  const target = await aiEvolutionReleaseRegistry.resolve(userId, repositoryId, request.targetEnvironment)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
  const options = { cwd: target.root, env, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }
  const head = (await command('git', ['rev-parse', '--verify', '--end-of-options', `${target.baseRef}^{commit}`], options)).stdout.trim()
  if (!/^[a-f0-9]{40}$/.test(head)) throw Error('Release target base is not a commit')
  if ((await command('git', ['status', '--porcelain', '--untracked-files=normal'], options)).stdout.trim()) throw evolutionError(409, 'EVOLUTION_RELEASE_WORKTREE_DIRTY', '目标工作区有未提交变更，需先整理基线再批准发布')
  await aiEvolutionArtifactStore.verifyManifest(candidate.runId, candidate.manifest)
  // resolve again after filesystem checks so a concurrent grant revocation is observed.
  await aiEvolutionReleaseRegistry.resolve(userId, repositoryId, request.targetEnvironment)
  await context(userId, candidateId)
  return new MySqlAiEvolutionCandidateRepository().recordReleaseApproval(candidateId, {
    actor: { userId, enabled: true, targetEnvironmentGrant: true }, currentBaseRef: head, ...request,
    scope: candidate.scope, expiresAt: new Date(Date.now() + 60 * 60_000),
  })
}

/** Request entry: persists work for the independent publisher; it never mutates the live runtime. */
export async function queueAiEvolutionRelease(userId: string, candidateId: string, input: unknown, idempotencyKey: unknown) {
  const request = z.object({ approvalId: z.string().uuid(), targetEnvironment: z.string().min(1).max(80) }).strict().parse(input)
  const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(idempotencyKey)
  const initial = await context(userId, candidateId)
  await aiEvolutionReleaseRegistry.resolve(userId, initial.repositoryId, request.targetEnvironment)
  const current = await context(userId, candidateId)
  if (current.repositoryId !== initial.repositoryId) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布目标配置已变化，需要重新核对')
  await aiEvolutionReleaseRegistry.resolve(userId, current.repositoryId, request.targetEnvironment)
  return publicReleaseJob(await new MySqlAiEvolutionReleaseJobRepository().enqueue({ actorUserId: userId, candidateId,
    approvalId: request.approvalId, targetEnvironment: request.targetEnvironment, idempotencyKey: key }))
}

const publicReleaseJob = (job: Awaited<ReturnType<MySqlAiEvolutionReleaseJobRepository['latestForOwner']>>) => job && ({
  id: job.id, candidateId: job.candidateId, environment: job.environment, status: job.status, attempt: job.attempt,
  error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
})

export async function getAiEvolutionReleaseJob(userId: string, candidateId: string) {
  await context(userId, candidateId)
  return publicReleaseJob(await new MySqlAiEvolutionReleaseJobRepository().latestForOwner(userId, candidateId))
}
