import { parseEvolutionReleaseReceipt, type EvolutionReleaseReceipt } from './evolutionReleaseCoordinator.js'
import type { EvolutionReleaseJob, EvolutionReleaseJobLease } from '../../repositories/mysql/mysqlAiEvolutionReleaseJobRepository.js'

type LeaseControl = { identity: EvolutionReleaseJobLease; signal: AbortSignal; assertHeld: () => Promise<void> }

function safeError(error: unknown) {
  const value = error as { code?: unknown; message?: unknown }
  return { code: typeof value?.code === 'string' ? value.code.slice(0, 80) : 'EVOLUTION_RELEASE_PREPARE_FAILED',
    message: typeof value?.message === 'string' ? value.message.slice(0, 1000) : '发布准备失败' }
}

/** One publisher iteration. Deployment dispatch owns all state after a receipt is durable. */
export async function processNextEvolutionReleaseJob(deps: {
  leaseOwner: string; leaseSeconds?: number; maxPrepareAttempts?: number;
  claimNext: (owner: string, seconds: number) => Promise<EvolutionReleaseJob | null>;
  renewLease: (identity: EvolutionReleaseJobLease, seconds: number) => Promise<unknown>;
  savePrepared: (identity: EvolutionReleaseJobLease, receipt: EvolutionReleaseReceipt) => Promise<EvolutionReleaseJob>;
  releaseForRetry: (identity: EvolutionReleaseJobLease, error: { code: string; message: string }, retry: boolean) => Promise<void>;
  settleDispatchFailure: (identity: EvolutionReleaseJobLease, error: { code: string; message: string }, maxAttempts: number) => Promise<unknown>;
  prepare: (job: EvolutionReleaseJob, control: LeaseControl) => Promise<EvolutionReleaseReceipt>;
  dispatch: (job: EvolutionReleaseJob, receipt: EvolutionReleaseReceipt, control: LeaseControl) => Promise<unknown>;
}) {
  const leaseSeconds = deps.leaseSeconds ?? 120
  const maxAttempts = deps.maxPrepareAttempts ?? 3
  const job = await deps.claimNext(deps.leaseOwner, leaseSeconds)
  if (!job) return null
  const identity = { jobId: job.id, leaseOwner: deps.leaseOwner, leaseToken: job.leaseToken }
  const abort = new AbortController()
  let leaseFailure: unknown
  let renewal: Promise<unknown> = Promise.resolve()
  const renew = () => renewal = renewal.then(() => deps.renewLease(identity, leaseSeconds)).catch(error => {
    leaseFailure = error; abort.abort(error); throw error
  })
  const timer = setInterval(() => { void renew().catch(() => undefined) }, Math.max(10_000, Math.floor(leaseSeconds * 1000 / 3)))
  timer.unref()
  const control: LeaseControl = { identity, signal: abort.signal, assertHeld: async () => {
    if (leaseFailure) throw leaseFailure
    await renew()
    if (leaseFailure) throw leaseFailure
  } }
  try {
    let prepared = job
    let receipt: EvolutionReleaseReceipt
    if (job.status === 'prepared') {
      receipt = parseEvolutionReleaseReceipt(job.receipt)
    } else {
      try {
        receipt = parseEvolutionReleaseReceipt(await deps.prepare(job, control))
        await control.assertHeld()
        prepared = await deps.savePrepared(identity, receipt)
      } catch (error) {
        if (!leaseFailure) await deps.releaseForRetry(identity, safeError(error), job.attempt < maxAttempts)
        throw error
      }
    }
    await control.assertHeld()
    try { await deps.dispatch(prepared, receipt, control) }
    catch (error) {
      if (!leaseFailure) await deps.settleDispatchFailure(identity, safeError(error), maxAttempts)
      throw error
    }
    return { jobId: job.id, dispatched: true as const }
  } finally {
    clearInterval(timer)
    await renewal.catch(() => undefined)
  }
}

export function createEvolutionReleaseJobWorker(deps: Parameters<typeof processNextEvolutionReleaseJob>[0] & {
  onError: (error: unknown) => void
}, intervalMs = 5_000) {
  let timer: ReturnType<typeof setInterval> | undefined
  let pending: Promise<unknown> | undefined
  let stopped = false
  const tick = () => {
    if (stopped) return Promise.resolve(null)
    if (pending) return pending
    pending = processNextEvolutionReleaseJob(deps).catch(error => { deps.onError(error); return null })
      .finally(() => { pending = undefined })
    return pending
  }
  return { tick, start() { if (timer || stopped) return; timer = setInterval(() => { void tick() }, intervalMs); timer.unref(); void tick() },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; await pending } }
}
