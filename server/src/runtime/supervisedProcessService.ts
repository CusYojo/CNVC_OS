import {
  spawn,
  type ChildProcess,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  recordSupervisedProcessExitSafely,
  type SupervisedProcessExitReason,
} from './supervisedProcessTelemetry.js'

export type SupervisedExecFileOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  windowsHide?: boolean
  uid?: number
  gid?: number
  encoding?: BufferEncoding
  timeout?: number
  signal?: AbortSignal
  maxBuffer?: number
  terminationGraceMs?: number
  telemetryKey?: string
}

type TerminationReason = 'timeout' | 'abort' | 'shutdown' | 'max_buffer'

type ActiveProcess = {
  id: number
  executable: string
  label: string
  startedAt: number
  child: ChildProcess
  terminate: (reason: TerminationReason) => void
  completion: Promise<unknown>
}

const active = new Map<number, ActiveProcess>()
let accepting = true
let sequence = 0

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // 进程可能在 detached 生效前退出，回退到直接 kill。
    }
  }
  try { child.kill(signal) } catch { /* 已退出 */ }
}

function processError(
  original: Error | null,
  input: { executable: string; reason?: TerminationReason; stdout: string; stderr: string },
) {
  const reasonText = input.reason === 'timeout'
    ? '执行超时'
    : input.reason === 'max_buffer'
      ? '输出超过缓冲区上限'
    : input.reason === 'shutdown'
      ? '因服务停机被终止'
      : input.reason === 'abort'
        ? '已取消'
        : '执行失败'
  const error = original ?? new Error(`${path.basename(input.executable)} ${reasonText}`)
  if (input.reason) error.message = `${path.basename(input.executable)} ${reasonText}: ${error.message}`
  return Object.assign(error, {
    code: input.reason === 'timeout'
      ? 'SUPERVISED_PROCESS_TIMEOUT'
      : input.reason === 'max_buffer'
        ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      : input.reason
        ? 'SUPERVISED_PROCESS_ABORTED'
        : (error as Error & { code?: unknown }).code,
    killed: Boolean(input.reason) || (error as Error & { killed?: boolean }).killed,
    stdout: input.stdout,
    stderr: input.stderr,
    command: input.executable,
  })
}

export async function execFileSupervised(
  executable: string,
  args: readonly string[] = [],
  options: SupervisedExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  if (!accepting) {
    throw Object.assign(new Error('服务正在停止，不再接受新的子进程任务'), {
      code: 'SUPERVISED_PROCESS_SHUTTING_DOWN',
    })
  }
  if (options.signal?.aborted) {
    throw Object.assign(new Error('子进程任务已取消'), { code: 'SUPERVISED_PROCESS_ABORTED' })
  }

  const id = ++sequence
  const timeoutMs = Math.max(1, Number(options.timeout || 120_000))
  const terminationGraceMs = Math.max(100, Number(options.terminationGraceMs || 3_000))
  const maxBuffer = Math.max(1, Number(options.maxBuffer || 1024 * 1024))
  const encoding = options.encoding || 'utf8'
  const signal = options.signal
  const telemetryKey = options.telemetryKey || randomUUID()
  const startedAt = Date.now()
  let reason: TerminationReason | undefined
  let escalated = false
  let timeout: NodeJS.Timeout | undefined
  let escalation: NodeJS.Timeout | undefined
  let settled = false
  let stdoutBytes = 0
  let stderrBytes = 0
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide,
    uid: options.uid,
    gid: options.gid,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let resolveCompletion: (value: { stdout: string; stderr: string }) => void
  let rejectCompletion: (reason: unknown) => void
  const completion = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })

  const output = () => ({
    stdout: Buffer.concat(stdoutChunks).toString(encoding),
    stderr: Buffer.concat(stderrChunks).toString(encoding),
  })
  const finish = (error: Error | null, exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (escalation) clearTimeout(escalation)
      signal?.removeEventListener('abort', abortListener)
      active.delete(id)
      const captured = output()
      const exitReason: SupervisedProcessExitReason = reason || (error ? 'failure' : 'success')
      void recordSupervisedProcessExitSafely({
        telemetryKey,
        executable,
        reason: exitReason,
        exitCode,
        signal: exitSignal,
        durationMs: Date.now() - startedAt,
        escalated,
      }).finally(() => {
        if (error || reason) rejectCompletion(processError(error, { executable, reason, ...captured }))
        else resolveCompletion(captured)
      })
  }
  const terminate = (nextReason: TerminationReason) => {
    if (reason || child.exitCode !== null || child.signalCode !== null) return
    reason = nextReason
    signalProcessTree(child, 'SIGTERM')
    escalation = setTimeout(() => {
      escalated = true
      signalProcessTree(child, 'SIGKILL')
    }, terminationGraceMs)
    escalation.unref()
  }
  const capture = (target: Buffer[], kind: 'stdout' | 'stderr', chunk: Buffer) => {
    if (kind === 'stdout') stdoutBytes += chunk.length
    else stderrBytes += chunk.length
    const total = kind === 'stdout' ? stdoutBytes : stderrBytes
    if (total <= maxBuffer) target.push(chunk)
    if (total > maxBuffer) terminate('max_buffer')
  }
  child.stdout?.on('data', (chunk: Buffer) => capture(stdoutChunks, 'stdout', chunk))
  child.stderr?.on('data', (chunk: Buffer) => capture(stderrChunks, 'stderr', chunk))
  child.once('error', (error) => finish(error))
  child.once('close', (code, exitSignal) => {
    if (code === 0 && !exitSignal) finish(null, code, exitSignal)
    else {
      finish(Object.assign(
        new Error(`${path.basename(executable)} exited code=${String(code)} signal=${String(exitSignal)}`),
        { code, signal: exitSignal },
      ), code, exitSignal)
    }
  })
  const abortListener = () => terminate('abort')
  signal?.addEventListener('abort', abortListener, { once: true })
  timeout = setTimeout(() => terminate('timeout'), timeoutMs)
  timeout.unref()
  const activeEntry: ActiveProcess = {
    id,
    executable,
    label: path.basename(executable),
    startedAt,
    child,
    terminate,
    completion,
  }
  active.set(id, activeEntry)
  return completion
}

export function supervisedProcessHealth() {
  const now = Date.now()
  return {
    name: 'supervised-child-processes',
    ok: true,
    inProcess: true,
    accepting,
    active: active.size,
    processes: [...active.values()].map((entry) => ({
      id: entry.id,
      label: entry.label,
      pid: entry.child.pid ?? null,
      elapsedMs: now - entry.startedAt,
    })),
  }
}

export async function shutdownSupervisedProcesses(graceMs = 10_000): Promise<{ terminated: number; remaining: number }> {
  accepting = false
  const entries = [...active.values()]
  for (const entry of entries) entry.terminate('shutdown')
  if (entries.length) {
    await Promise.race([
      Promise.allSettled(entries.map((entry) => entry.completion)),
      new Promise((resolve) => setTimeout(resolve, Math.max(100, graceMs))),
    ])
  }
  for (const entry of active.values()) signalProcessTree(entry.child, 'SIGKILL')
  return { terminated: entries.length, remaining: active.size }
}
