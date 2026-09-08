export function createSkillExpiryWorker(deps: {
  listExpired: (now: Date, afterId?: string) => Promise<Array<{ id: string }>>
  expire: (id: string, now: Date) => Promise<unknown>
  onError: (error: unknown) => void
}, intervalMs = 30000) {
  let cursor: string | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let pending: Promise<void> | undefined
  let stopped = false
  const tick = () => {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      const now = new Date()
      const rows = await deps.listExpired(now, cursor)
      for (const row of rows) {
        if (stopped) break
        try { await deps.expire(row.id, now) } catch (error) { deps.onError(error) }
        cursor = row.id
      }
      // Advance past failed entries so they cannot starve later pages.
      if (rows.length < 100) cursor = undefined
    })().catch(deps.onError).finally(() => { pending = undefined })
    return pending
  }
  return {
    tick,
    start() {
      if (stopped || timer) return
      timer = setInterval(() => { void tick() }, intervalMs)
      timer.unref()
      void tick()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
      await pending
    },
  }
}

let worker: ReturnType<typeof createSkillExpiryWorker> | undefined
let starting: Promise<void> | undefined
let stopping = false
export function startAiEvolutionSkillExpiry() {
  if (stopping || process.env.AI_EVOLUTION_ENABLED !== 'true' || worker) return Promise.resolve()
  if (starting) return starting
  starting = initialize().finally(() => { starting = undefined })
  return starting
}

async function initialize() {
  const { MySqlAiEvolutionSkillBindingRepository } = await import('../repositories/mysql/mysqlAiEvolutionSkillBindingRepository.js')
  const { aiEvolutionArtifactStore } = await import('./aiEvolutionApplicationService.js')
  if (stopping) return
  const repository = new MySqlAiEvolutionSkillBindingRepository()
  worker = createSkillExpiryWorker({ listExpired: (now, cursor) => repository.listExpired(now, cursor),
    expire: (id, now) => repository.expireTrial(id, aiEvolutionArtifactStore, now),
    onError: () => console.error('[ai-evolution-skill-expiry] expiry failed; retained binding will be retried') })
  worker.start()
}

export async function stopAiEvolutionSkillExpiry() {
  stopping = true
  await starting?.catch(() => {})
  const active = worker
  worker = undefined
  await active?.stop()
}
