import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/client.js'
import { MySqlAiEvolutionReleaseJobRepository } from '../repositories/mysql/mysqlAiEvolutionReleaseJobRepository.js'
import { MySqlAiEvolutionCandidateRepository } from '../repositories/mysql/mysqlAiEvolutionCandidateRepository.js'
import { createEvolutionReleaseJobWorker } from '../runtime/evolution/evolutionReleaseJobWorker.js'
import { createEvolutionReleaseRecoveryWorker } from '../services/aiEvolutionReleaseRecoveryWorker.js'
import { prepareAiEvolutionReleaseJob } from '../services/aiEvolutionReleaseJobPreparationService.js'
import { dispatchAiEvolutionReleaseJob, dispatchAiEvolutionRollbackJob } from '../services/aiEvolutionReleaseJobDispatchService.js'
import { loadEvolutionPublisherLifecycle } from '../services/aiEvolutionPublisherLifecycleRegistry.js'
import { recoverAiEvolutionRelease } from '../services/aiEvolutionReleaseApplicationService.js'
import { createLocalEvolutionRecoveryAdapter } from '../runtime/evolution/evolutionLocalRecoveryAdapter.js'

if (process.env.AI_EVOLUTION_RELEASE_PUBLISHER_ENABLED !== 'true') throw Error('AI evolution release publisher is disabled')
const owner = `${hostname()}:${process.pid}:${randomUUID()}`.slice(0, 128)
const jobs = new MySqlAiEvolutionReleaseJobRepository()
const candidates = new MySqlAiEvolutionCandidateRepository()
const report = (level: 'info' | 'error', event: string, detail: unknown = {}) => {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'ai-evolution-release-publisher', event, detail })
  ;(level === 'error' ? console.error : console.log)(line)
}
const publisher = createEvolutionReleaseJobWorker({ leaseOwner: owner,
  claimNext: (leaseOwner, seconds) => jobs.claimNext(leaseOwner, seconds),
  renewLease: (identity, seconds) => jobs.renewLease(identity, seconds), savePrepared: (identity, receipt) => jobs.savePrepared(identity, receipt),
  releaseForRetry: (identity, error, retry) => jobs.releaseForRetry(identity, error, retry), prepare: prepareAiEvolutionReleaseJob,
  settleDispatchFailure: (identity, error, maxAttempts) => jobs.settleDispatchFailure(identity, error, maxAttempts),
  dispatch: (job, receipt, control) => (job.operation === 'rollback' ? dispatchAiEvolutionRollbackJob : dispatchAiEvolutionReleaseJob)(job, receipt, control,
    async target => loadEvolutionPublisherLifecycle(target.id, target.root)),
  onError: error => report('error', 'publisher_iteration_failed', { code: (error as { code?: string }).code,
    message: error instanceof Error ? error.message : String(error) }) })
const recovery = createEvolutionReleaseRecoveryWorker({ list: cursor => candidates.listClaimedReleases(cursor),
  recover: row => recoverAiEvolutionRelease(row.actorUserId, row.candidateId,
    { approvalId: row.approvalId, targetEnvironment: row.targetEnvironment }, async (target, claim) => {
      const lifecycle = await loadEvolutionPublisherLifecycle(target.id, target.root)
      return createLocalEvolutionRecoveryAdapter({ root: target.root, receipt: claim.receipt, ...lifecycle })
    }),
  onError: (error, row) => report('error', 'release_recovery_failed', { approvalId: row?.approvalId,
    code: (error as { code?: string }).code, message: error instanceof Error ? error.message : String(error) }) })

let stopping = false
let stopped!: () => void
const stoppedPromise = new Promise<void>(resolve => { stopped = resolve })
const stop = async (signal: string) => {
  if (stopping) return
  stopping = true; report('info', 'stopping', { signal })
  await Promise.allSettled([publisher.stop(), recovery.stop()]); await pool.end(); process.exitCode = 0; stopped()
}
process.once('SIGINT', () => { void stop('SIGINT') })
process.once('SIGTERM', () => { void stop('SIGTERM') })
await recovery.tick()
recovery.start(); publisher.start(); report('info', 'started', { owner })
await stoppedPromise
