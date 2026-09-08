import type { MySqlAiEvolutionRepository } from '../../repositories/mysql/mysqlAiEvolutionRepository.js'
import type { EvolutionLeaseIdentity } from '../../services/aiEvolutionPolicyService.js'
import { evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { evolutionRunError } from './evolutionRunError.js'
import type { EvolutionKind } from '../../contracts/aiEvolutionContract.js'

type Repository = Pick<MySqlAiEvolutionRepository, 'claimNext' | 'heartbeat' | 'revokeRun' | 'revokeExpired' | 'listPendingTermination' | 'confirmTermination'>
export type ClaimedEvolutionRun = NonNullable<Awaited<ReturnType<Repository['claimNext']>>>
export type EvolutionExecutionControl = { signal: AbortSignal; identity: EvolutionLeaseIdentity; assertCanContinue: () => Promise<void> }
export type PreparedEvolutionResult = {
  /** Persist candidate/evaluation and success atomically, guarded by the still-current lease. */
  commit: () => Promise<void>
}

/** One bounded slot. Database leases coordinate other slots/processes; no in-memory task queue. */
export class EvolutionRunCoordinator {
  private active: AbortController | null = null
  private stopping = false
  private ticking = false
  constructor(private readonly repository: Repository, private readonly workerId: string,
    private readonly execute: (run: ClaimedEvolutionRun, control: EvolutionExecutionControl) => Promise<PreparedEvolutionResult>,
    private readonly terminate: (identity: EvolutionLeaseIdentity) => Promise<unknown>, private readonly kind?: EvolutionKind) {}

  stop() { this.stopping = true; this.active?.abort(evolutionError(503, 'EVOLUTION_SHUTDOWN', '服务正在关闭')) }

  async tick() {
    if (this.ticking || this.stopping) return
    this.ticking = true
    try {
      await this.repository.revokeExpired(new Date(), this.kind)
      for (const row of await this.repository.listPendingTermination(this.kind)) {
        await this.terminate({ runId: row.id, attempt: row.attempt, leaseToken: row.leaseToken - 1, inputHash: row.inputHash })
        await this.repository.confirmTermination(row.id, row.leaseToken)
      }
      if (this.stopping) return
      const run = await this.repository.claimNext(this.workerId, 60, new Date(), this.kind)
      if (!run) return
      const identity = { runId: run.id, attempt: run.attempt, leaseToken: run.leaseToken, inputHash: run.inputHash }
      const controller = new AbortController()
      this.active = controller
      const deadline = Date.now() + Math.max(0, run.budget.maxDurationSeconds - run.elapsedSeconds) * 1000
      let heartbeatBusy = false
      const assertCanContinue = async () => {
        controller.signal.throwIfAborted()
        if (Date.now() >= deadline) throw evolutionError(409, 'EVOLUTION_DURATION_EXCEEDED', '任务执行时间预算已耗尽')
        const state = await this.repository.heartbeat(identity)
        if (state.durationExceeded) throw evolutionError(409, 'EVOLUTION_DURATION_EXCEEDED', '任务累计执行时间预算已耗尽')
        if (state.cancelRequested) throw evolutionError(409, 'EVOLUTION_CANCEL_REQUESTED', '用户请求取消任务')
        controller.signal.throwIfAborted()
      }
      const timer = setInterval(() => {
        if (heartbeatBusy) return
        heartbeatBusy = true
        void assertCanContinue().catch((error) => controller.abort(error)).finally(() => { heartbeatBusy = false })
      }, 10_000)
      let abortListener: (() => void) | undefined
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', abortListener, { once: true })
      })
      try {
        await Promise.race([(async () => {
          await assertCanContinue()
          const prepared = await this.execute(run, { signal: controller.signal, identity, assertCanContinue })
          await assertCanContinue()
          await this.terminate(identity)
          // Cancellation and lease expiry during Docker cleanup must still prevent success.
          await assertCanContinue()
          await prepared.commit()
        })(), aborted])
      } catch (error) {
        controller.abort(error)
        // Raw model/process errors may contain sensitive content; persist a bounded generic failure message.
        try {
          const revoked = await this.repository.revokeRun(identity, evolutionRunError(error))
          await this.terminate(identity)
          await this.repository.confirmTermination(run.id, revoked.leaseToken)
        } catch (cleanupError) {
          // An expired/revoked lease may be owned by recovery; its durable terminating record remains authoritative.
          if ((cleanupError as { code?: string }).code !== 'EVOLUTION_STALE_EXECUTOR') throw cleanupError
        }
      } finally {
        clearInterval(timer)
        if (abortListener) controller.signal.removeEventListener('abort', abortListener)
        this.active = null
      }
    } finally { this.ticking = false }
  }
}
