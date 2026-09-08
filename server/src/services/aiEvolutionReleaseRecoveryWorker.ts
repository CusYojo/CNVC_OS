export type PendingEvolutionRelease = {
  approvalId: string; candidateId: string; actorUserId: string; targetEnvironment: string
}

export function createEvolutionReleaseRecoveryWorker(deps: {
  list: (afterApprovalId?: string) => Promise<PendingEvolutionRelease[]>;
  recover: (row: PendingEvolutionRelease) => Promise<unknown>;
  onError: (error: unknown, row?: PendingEvolutionRelease) => void;
}, intervalMs = 30_000) {
  let timer: ReturnType<typeof setInterval> | undefined
  let pending: Promise<void> | undefined
  let cursor: string | undefined
  let stopped = false
  const tick = () => {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      const rows = await deps.list(cursor)
      for (const row of rows) {
        if (stopped) break
        try { await deps.recover(row) } catch (error) { deps.onError(error, row) }
        cursor = row.approvalId
      }
      // Failed records are retried on the next scan, while one failure cannot starve this page.
      if (rows.length < 100) cursor = undefined
    })().catch(error => deps.onError(error)).finally(() => { pending = undefined })
    return pending
  }
  return {
    tick,
    start() {
      if (stopped || timer) return
      timer = setInterval(() => { void tick() }, intervalMs); timer.unref(); void tick()
    },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; await pending },
  }
}
