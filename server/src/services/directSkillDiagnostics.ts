import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue => value && typeof value === 'object' ? value as RecordValue : {}

// Do not persist SDK text, tool inputs, document content or arbitrary upstream
// errors. Classify known infrastructure errors and retain a correlation hash.
export function directSkillErrorSummary(value: unknown): RecordValue {
  const code = value instanceof Error ? String((value as Error & { code?: unknown }).code ?? '') : ''
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const diagnostic = /unknown skill/i.test(text) ? 'unknown_skill'
    : /quota|insufficient|余额|额度/i.test(text) ? 'quota_exhausted'
      : /(?:API Error|HTTP|status)[: =]+403/i.test(text) ? 'gateway_403'
        : /permission|denied|not allowed/i.test(text) ? 'permission_denied'
        : /ENAMETOOLONG/i.test(text) ? 'filename_too_long'
          : /timeout|timed out|超时/i.test(text) ? 'timeout'
            : /sandbox/i.test(text) ? 'sandbox_error'
              : /not found|ENOENT|不存在/i.test(text) ? 'not_found'
                : 'unclassified'
  const exitCode = text.match(/(?:exit(?:ed)?(?:\s+code)?|code)\s*[=:]?\s*(-?\d+)/i)?.[1]
  return {
    ...(/^(?:DIRECT_SKILL_[A-Z_]+|AI_TASK_CANCELLED|E[A-Z]+)$/.test(code) ? { code } : {}),
    diagnostic,
    ...(exitCode ? { exitCode: Number(exitCode) } : {}),
    errorBytes: Buffer.byteLength(text),
    errorSha256: createHash('sha256').update(text).digest('hex'),
  }
}

export function createDirectSkillDiagnostics(
  directory: string,
  context: { taskId: string; skill: string; model: string },
  sink: (record: RecordValue) => void = (record) => {
    if (record.level === 'error') console.error(JSON.stringify(record))
    else console.info(JSON.stringify(record))
  },
) {
  const calls = new Map<string, { name: string; started: number }>()
  let sequence = 0
  async function record(event: string, fields: RecordValue = {}, level = 'info') {
    const entry = { ...fields, ...context, event, level, sequence: ++sequence, time: new Date().toISOString(), pid: process.pid }
    // Await persistence so a reported event is already on disk.
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await appendFile(path.join(directory, 'agent.jsonl'), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 })
    sink(entry)
  }
  async function observe(raw: unknown) {
    const message = object(raw)
    const content = object(message.message).content
    if (Array.isArray(content)) {
      for (const value of content) {
        const block = object(value)
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          calls.set(block.id, { name: block.name, started: Date.now() })
          await record('skill.tool.started', { toolUseId: block.id, toolName: block.name })
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const call = calls.get(block.tool_use_id)
          calls.delete(block.tool_use_id)
          await record('skill.tool.finished', {
            toolUseId: block.tool_use_id, toolName: call?.name ?? 'unknown',
            durationMs: call ? Date.now() - call.started : null,
            success: !block.is_error,
            ...(block.is_error ? directSkillErrorSummary(block.content) : {}),
          }, block.is_error ? 'error' : 'info')
        }
      }
    }
    if (message.type === 'result') {
      const failed = Boolean(message.is_error) || message.subtype !== 'success'
      await record('skill.agent.result', {
        subtype: message.subtype, numTurns: message.num_turns,
        ...(failed ? directSkillErrorSummary(message.errors ?? message.result) : {}),
      }, failed ? 'error' : 'info')
    }
  }
  return { record, observe }
}
