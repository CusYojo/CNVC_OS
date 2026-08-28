import type { ChildProcess } from 'node:child_process'

// Keep both listeners until the entire cleanup has completed. Terminal process
// groups and npm can deliver more than one signal; `once` or removing listeners
// immediately after child exit can terminate the parent during async cleanup.
export async function withFdeAcceptanceSignals<T>(work: (control: {
  track(child: ChildProcess): void
  checkpoint(): void
}) => Promise<T>, graceMs = 10_000): Promise<T> {
  if (!Number.isInteger(graceMs) || graceMs < 10 || graceMs > 60_000) throw new Error('隔离子进程退出宽限无效')
  let stopping = false, child: ChildProcess | undefined, forwarded: ChildProcess | undefined
  let forcedStop: ReturnType<typeof setTimeout> | undefined
  const forward = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null || forwarded === child) return
    const target = child
    forwarded = target; target.kill('SIGTERM')
    forcedStop = setTimeout(() => {
      if (target.exitCode === null && target.signalCode === null) {
        console.error(JSON.stringify({ acceptanceChildDrainTimedOut: true, childPid: target.pid, cleanupAfterExitOnly: true }))
        target.kill('SIGKILL')
      }
    }, graceMs)
    forcedStop.unref()
  }
  const stop = (signal: string) => {
    stopping = true
    console.log(JSON.stringify({ acceptanceSignal: signal, childPid: child?.pid ?? null, cleanupMustComplete: true }))
    forward()
  }
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM')
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
  try {
    return await work({
      track: next => { child = next; next.once('exit', () => { if (child === next) { child = undefined; clearTimeout(forcedStop) } }); if (stopping) forward() },
      checkpoint: () => { if (stopping) throw new Error('隔离验收已请求停止，禁止启动下一项；先完成本次清理') },
    })
  } finally {
    clearTimeout(forcedStop)
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate)
  }
}
