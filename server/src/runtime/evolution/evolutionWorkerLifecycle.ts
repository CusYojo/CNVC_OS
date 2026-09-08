/** One process-owned scheduler; the coordinator/database remain the authority for work ownership. */
export class EvolutionWorkerLifecycle {
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | undefined
  private running = false
  private healthy = false
  private state: 'new' | 'starting' | 'running' | 'stopped' = 'new'
  constructor(private readonly coordinator: { tick(): Promise<void>; stop(): void },
    private readonly probe: () => Promise<boolean>, private readonly onError: (error: unknown) => void,
    private readonly intervalMs = 2000) {
    if (!Number.isInteger(intervalMs) || intervalMs < 10) throw Error('Invalid evolution worker interval')
  }

  async available() { return this.running && this.healthy && await this.probe() && this.running }

  async start() {
    if (this.state !== 'new') throw Error('Evolution worker already started or stopped')
    this.state = 'starting'
    try {
      if (!await this.probe()) throw Error('Evolution worker environment unavailable')
      if (this.state !== 'starting') throw Error('Evolution worker stopped during startup')
    } catch (error) { this.state = 'stopped'; throw error }
    this.state = 'running'
    this.running = true
    this.healthy = true
    this.schedule(0)
  }

  private schedule(delay: number) {
    if (!this.running) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.active = (async () => {
        try { await this.coordinator.tick(); this.healthy = true }
        catch (error) {
          this.healthy = false
          // Observability must not turn a handled worker failure into an unhandled rejection.
          try { this.onError(error) } catch { /* Readiness remains false until a successful tick. */ }
        }
      })().finally(() => { this.active = undefined; this.schedule(this.intervalMs) })
    }, delay)
    this.timer.unref()
  }

  async stop() {
    this.state = 'stopped'
    this.running = false
    this.healthy = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.coordinator.stop()
    await this.active
  }
}
