import { createHash, randomUUID } from 'node:crypto'
import { db } from '../db/client.js'
import { auditLogs } from '../db/schema.js'

export const supervisedProcessTelemetryModule = '进程监督'

export const supervisedProcessTelemetryActions = {
  success: '子进程成功退出',
  failure: '子进程失败退出',
  timeout: '子进程超时终止',
  abort: '子进程取消终止',
  shutdown: '子进程停机终止',
  max_buffer: '子进程缓冲区终止',
} as const

export type SupervisedProcessExitReason = keyof typeof supervisedProcessTelemetryActions

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function supervisedProcessTelemetryExecutionKey(telemetryKey: string) {
  return digest(telemetryKey)
}

export function supervisedProcessTelemetryTarget(input: {
  telemetryKey: string
  executable: string
  reason: SupervisedProcessExitReason
  exitCode?: number | null
  signal?: string | null
  durationMs: number
  escalated: boolean
}) {
  const exitCode = Number.isSafeInteger(input.exitCode) ? String(input.exitCode) : 'null'
  const signal = /^[A-Z0-9]+$/.test(input.signal || '') ? input.signal : 'null'
  return [
    `execution=${supervisedProcessTelemetryExecutionKey(input.telemetryKey)}`,
    `executable=${digest(input.executable)}`,
    `reason=${input.reason}`,
    `exit_code=${exitCode}`,
    `signal=${signal}`,
    `duration_ms=${Math.max(0, Math.round(input.durationMs))}`,
    `escalated=${input.escalated ? 1 : 0}`,
  ].join(';')
}

export async function recordSupervisedProcessExit(input: {
  telemetryKey: string
  executable: string
  reason: SupervisedProcessExitReason
  exitCode?: number | null
  signal?: string | null
  durationMs: number
  escalated: boolean
}) {
  await db.insert(auditLogs).values({
    id: randomUUID(),
    userId: null,
    userName: '（系统）',
    module: supervisedProcessTelemetryModule,
    action: supervisedProcessTelemetryActions[input.reason],
    target: supervisedProcessTelemetryTarget(input),
    result: input.reason === 'success' ? 'success' : 'failed',
    requestId: randomUUID(),
  })
}

export function recordSupervisedProcessExitSafely(input: Parameters<typeof recordSupervisedProcessExit>[0]) {
  return recordSupervisedProcessExit(input).catch(() => {
    console.error(`[process-supervisor] failed to persist ${input.reason} exit event`)
  })
}
