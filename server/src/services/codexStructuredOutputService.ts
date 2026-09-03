import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { redactSensitiveText } from '../security/redactSecrets.js'

export type CodexStructuredOutputExecution = {
  output: unknown
  runtime: 'codex-cli'
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  durationMs: number
  costMicrousd: 0
  toolCalls: 0
  numTurns: 1
  sessionId: null
}

type CodexExecutionError = Error & {
  retryable?: boolean
  leadRunMetrics?: Partial<CodexStructuredOutputExecution>
}

function parseJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '')
  const parsed = JSON.parse(cleaned)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex CLI did not return a JSON object')
  }
  return parsed
}

function codexUsage(stdout: string) {
  let inputTokens = 0
  let outputTokens = 0
  for (const line of stdout.split('\n')) {
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    const stack: unknown[] = [value]
    while (stack.length) {
      const current = stack.pop()
      if (!current || typeof current !== 'object') continue
      const data = current as Record<string, unknown>
      const usage = data.usage && typeof data.usage === 'object'
        ? data.usage as Record<string, unknown>
        : null
      if (usage) {
        inputTokens = Math.max(inputTokens, Number(usage.input_tokens ?? usage.inputTokens) || 0)
        outputTokens = Math.max(outputTokens, Number(usage.output_tokens ?? usage.outputTokens) || 0)
      }
      stack.push(...Object.values(data))
    }
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

export async function runCodexStructuredOutput(input: {
  profile: string
  systemPrompt: string
  prompt: string
  outputSchema: Record<string, unknown>
  model: string
  timeoutMs: number
  workDir?: string
}): Promise<CodexStructuredOutputExecution> {
  const ownsWorkDir = !input.workDir
  const workDir = input.workDir
    ? path.resolve(input.workDir)
    : await mkdtemp(path.join(tmpdir(), `cybernaut-${input.profile}-codex-`))
  if (!ownsWorkDir) await mkdir(workDir, { recursive: true, mode: 0o700 })
  const nonce = `${process.pid}-${Date.now()}`
  const schemaPath = path.join(workDir, `output-schema-${nonce}.json`)
  const outputPath = path.join(workDir, `output-${nonce}.json`)
  await writeFile(schemaPath, `${JSON.stringify(input.outputSchema)}\n`, { mode: 0o600 })
  const startedAt = Date.now()
  let timeout: NodeJS.Timeout | undefined
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.env.CODEX_BIN?.trim() || 'codex', [
        'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--json', '-m', input.model, '-s', 'read-only', '-C', workDir,
        '--output-schema', schemaPath, '--output-last-message', outputPath, '-',
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000) })
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000) })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      timeout = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      }, Math.max(30_000, input.timeoutMs))
      child.stdin.end([
        input.systemPrompt,
        input.prompt,
        '不得调用工具、读取文件或联网。严格按输出 Schema 返回 JSON，不要输出 Markdown 或额外解释。',
      ].join('\n\n'))
    })
    let output: unknown
    try { output = parseJsonObject(await readFile(outputPath, 'utf8')) } catch { output = undefined }
    const usage = codexUsage(result.stdout)
    const metrics: CodexStructuredOutputExecution = {
      output,
      runtime: 'codex-cli',
      usage,
      durationMs: Date.now() - startedAt,
      costMicrousd: 0,
      toolCalls: 0,
      numTurns: 1,
      sessionId: null,
    }
    if (result.code !== 0 || !output) {
      const error = new Error(redactSensitiveText(
        `${input.profile} Codex CLI exited ${result.code}; stdout=${result.stdout.slice(-4_000)}; stderr=${result.stderr.slice(-2_000)}`,
      ).slice(0, 8_000)) as CodexExecutionError
      error.retryable = true
      error.leadRunMetrics = metrics
      throw error
    }
    return metrics
  } finally {
    if (timeout) clearTimeout(timeout)
    if (ownsWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
