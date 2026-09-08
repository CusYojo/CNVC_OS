import { realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { aiEvolutionService, getAiEvolutionCandidateForUser } from './aiEvolutionApplicationService.js'
import { aiEvolutionReleaseRegistry } from './aiEvolutionReleaseRegistry.js'
import { evolutionError } from './aiEvolutionPolicyService.js'
import { pool } from '../db/client.js'
import { withEvolutionReleaseLock } from './aiEvolutionReleaseLock.js'
import { coordinateEvolutionRelease, type EvolutionReleaseReceipt } from '../runtime/evolution/evolutionReleaseCoordinator.js'
import { createLocalEvolutionReleaseAdapter } from '../runtime/evolution/evolutionLocalReleaseAdapter.js'
import { MySqlAiEvolutionCandidateRepository } from '../repositories/mysql/mysqlAiEvolutionCandidateRepository.js'
import { MySqlAiEvolutionReleaseJobRepository, type EvolutionReleaseJob, type EvolutionReleaseJobLease } from '../repositories/mysql/mysqlAiEvolutionReleaseJobRepository.js'
import { coordinateRequestedEvolutionRollback } from '../runtime/evolution/evolutionRequestedRollback.js'

const command = promisify(execFile)

export type EvolutionPublisherLifecycle = {
  healthUrl: string; fetchImpl?: typeof fetch; stop: (signal: AbortSignal) => Promise<void>;
  activateBuild: (signal: AbortSignal) => Promise<void>; rollbackBuild: (signal: AbortSignal) => Promise<void>;
  start: (signal: AbortSignal) => Promise<void>;
}

/** Trusted publisher entry. Lifecycle commands are host configuration and never candidate/request fields. */
export async function dispatchAiEvolutionReleaseJob(job: EvolutionReleaseJob, receipt: EvolutionReleaseReceipt,
  control: { identity: EvolutionReleaseJobLease; signal: AbortSignal; assertHeld: () => Promise<void> },
  lifecycleFactory: (target: { id: string; label: string; repositoryId: string; root: string; baseRef: string },
    receipt: EvolutionReleaseReceipt) => Promise<EvolutionPublisherLifecycle>) {
  const initialCandidate = await getAiEvolutionCandidateForUser(job.actorUserId, job.candidateId)
  const initialRun = await aiEvolutionService.authorizeRun(job.actorUserId, initialCandidate.runId)
  if (initialRun.frozenSpec.target.type !== 'code' || initialCandidate.kind !== 'code' || initialCandidate.contentHash !== receipt.candidateHash) {
    throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布任务、候选和暂存凭据不一致')
  }
  const repositoryId = initialRun.frozenSpec.target.repositoryId
  const configured = await aiEvolutionReleaseRegistry.resolve(job.actorUserId, repositoryId, job.environment)
  const root = await realpath(configured.root)
  const candidateRepository = new MySqlAiEvolutionCandidateRepository()
  const jobRepository = new MySqlAiEvolutionReleaseJobRepository()
  return withEvolutionReleaseLock(pool, root, async lock => {
    let currentBaseRef = ''
    const authorize = async () => {
      await control.assertHeld(); await lock.assertHeld()
      const candidate = await getAiEvolutionCandidateForUser(job.actorUserId, job.candidateId)
      const run = await aiEvolutionService.authorizeRun(job.actorUserId, candidate.runId)
      const target = run.frozenSpec.target.type === 'code'
        ? await aiEvolutionReleaseRegistry.resolve(job.actorUserId, run.frozenSpec.target.repositoryId, job.environment) : null
      if (!target || candidate.contentHash !== receipt.candidateHash || run.frozenSpec.target.type !== 'code'
        || run.frozenSpec.target.repositoryId !== repositoryId || await realpath(target.root) !== root) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布期间候选或目标授权发生变化')
      }
      const env: NodeJS.ProcessEnv = {}
      for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
      const options = { cwd: root, env, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }
      currentBaseRef = (await command('git', ['rev-parse', '--verify', '--end-of-options', `${target.baseRef}^{commit}`], options)).stdout.trim()
      if (currentBaseRef !== initialCandidate.baseRef || (await command('git', ['status', '--porcelain', '--untracked-files=normal'], options)).stdout.trim()) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_WORKTREE_DIRTY', '发布目标基线或工作区状态已变化')
      }
    }
    await authorize()
    const lifecycle = await lifecycleFactory({ ...configured, root }, receipt)
    const adapter = await createLocalEvolutionReleaseAdapter({ root, receipt, ...lifecycle })
    return coordinateEvolutionRelease({ candidateHash: receipt.candidateHash, authorize, prepare: async () => receipt,
      claim: async value => {
        await candidateRepository.claimRelease(job.approvalId, { actor: { userId: job.actorUserId, enabled: true, targetEnvironmentGrant: true },
          currentBaseRef, targetEnvironment: job.environment, receipt: value })
        await jobRepository.markActivating(control.identity)
      }, activate: value => adapter.activate(value, control.signal),
      inspect: value => adapter.inspect(value, control.signal),
      health: (value, version) => adapter.health(value, version, control.signal),
      rollback: value => adapter.rollback(value, control.signal),
      finish: async (value, outcome) => {
        await candidateRepository.completeRelease(job.approvalId, job.actorUserId, value, outcome)
        await jobRepository.completeByApproval(job.approvalId, value, outcome)
      } })
  })
}

export async function dispatchAiEvolutionRollbackJob(job: EvolutionReleaseJob, receipt: EvolutionReleaseReceipt,
  control: { identity: EvolutionReleaseJobLease; signal: AbortSignal; assertHeld: () => Promise<void> },
  lifecycleFactory: (target: { id: string; label: string; repositoryId: string; root: string; baseRef: string },
    receipt: EvolutionReleaseReceipt) => Promise<EvolutionPublisherLifecycle>) {
  if (job.operation !== 'rollback' || !job.sourceReleaseJobId) throw evolutionError(409, 'EVOLUTION_ROLLBACK_BINDING', '回退任务缺少原发布记录')
  const initialCandidate = await getAiEvolutionCandidateForUser(job.actorUserId, job.candidateId)
  const initialRun = await aiEvolutionService.authorizeRun(job.actorUserId, initialCandidate.runId)
  if (initialRun.frozenSpec.target.type !== 'code' || initialCandidate.status !== 'active'
    || initialCandidate.contentHash !== receipt.candidateHash) throw evolutionError(409, 'EVOLUTION_ROLLBACK_BINDING', '回退任务与当前候选不一致')
  const repositoryId = initialRun.frozenSpec.target.repositoryId
  const configured = await aiEvolutionReleaseRegistry.resolve(job.actorUserId, repositoryId, job.environment)
  const root = await realpath(configured.root)
  const candidateRepository = new MySqlAiEvolutionCandidateRepository(), jobRepository = new MySqlAiEvolutionReleaseJobRepository()
  return withEvolutionReleaseLock(pool, root, async lock => {
    const authorize = async () => {
      await control.assertHeld(); await lock.assertHeld()
      const candidate = await getAiEvolutionCandidateForUser(job.actorUserId, job.candidateId)
      const run = await aiEvolutionService.authorizeRun(job.actorUserId, candidate.runId)
      const target = run.frozenSpec.target.type === 'code'
        ? await aiEvolutionReleaseRegistry.resolve(job.actorUserId, run.frozenSpec.target.repositoryId, job.environment) : null
      if (!target || !['active', 'activating'].includes(candidate.status) || candidate.contentHash !== receipt.candidateHash
        || await realpath(target.root) !== root) throw evolutionError(409, 'EVOLUTION_ROLLBACK_BINDING', '回退期间候选或目标授权发生变化')
    }
    await authorize()
    const lifecycle = await lifecycleFactory({ ...configured, root }, receipt)
    const adapter = await createLocalEvolutionReleaseAdapter({ root, receipt, ...lifecycle })
    return coordinateRequestedEvolutionRollback({ receipt, authorize,
      claim: async value => { await candidateRepository.claimRequestedRollback(job.approvalId, job.actorUserId, value); await jobRepository.markActivating(control.identity) },
      inspect: value => adapter.inspect(value, control.signal), rollback: value => adapter.rollback(value, control.signal),
      health: (value, version) => adapter.health(value, version, control.signal),
      finish: async value => { await candidateRepository.completeRequestedRollback(job.approvalId, job.actorUserId, value)
        await jobRepository.completeByApproval(job.approvalId, value, 'rolled_back') } })
  })
}
