import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { EvolutionPublisherLifecycle } from './aiEvolutionReleaseJobDispatchService.js'

const run = promisify(execFile)
const commandSchema = z.object({ file: z.string().refine(path.isAbsolute), args: z.array(z.string().max(500)).max(30).default([]) }).strict()
const schema = z.object({ schemaVersion: z.literal(1), targets: z.array(z.object({ targetId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  healthUrl: z.string().url().refine(value => { const url = new URL(value); return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) }),
  stop: commandSchema, start: commandSchema }).strict()).max(20) }).strict()
export function parseEvolutionPublisherLifecycleConfig(value: unknown) { return schema.parse(value) }

export async function loadEvolutionPublisherLifecycleConfig() {
  const configFile = process.env.AI_EVOLUTION_PUBLISHER_LIFECYCLE_FILE?.trim()
  if (!configFile || !path.isAbsolute(configFile)) throw Error('AI_EVOLUTION_PUBLISHER_LIFECYCLE_FILE must be an absolute trusted config path')
  const bytes = await readFile(configFile)
  if (bytes.length > 128 * 1024) throw Error('Publisher lifecycle config is too large')
  return parseEvolutionPublisherLifecycleConfig(JSON.parse(bytes.toString('utf8')))
}

async function execute(command: z.infer<typeof commandSchema>, cwd: string, signal: AbortSignal) {
  const file = await realpath(command.file)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
  await run(file, command.args, { cwd, env, signal, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 })
}

export async function loadEvolutionPublisherLifecycle(targetId: string, rootInput: string): Promise<EvolutionPublisherLifecycle> {
  const config = await loadEvolutionPublisherLifecycleConfig()
  if (new Set(config.targets.map(item => item.targetId)).size !== config.targets.length) throw Error('Publisher lifecycle target is duplicated')
  const selected = config.targets.find(item => item.targetId === targetId)
  if (!selected) throw Error('Publisher lifecycle target is not configured')
  const root = await realpath(rootInput)
  const buildScript = await realpath(path.join(root, 'server/scripts/build-platform.mjs'))
  if (!buildScript.startsWith(root + path.sep)) throw Error('Build activation script escaped target root')
  const build = (operation: '--activate' | '--rollback', signal: AbortSignal) => execute({ file: process.execPath,
    args: [buildScript, operation] }, root, signal)
  return { healthUrl: selected.healthUrl, stop: signal => execute(selected.stop, root, signal),
    start: signal => execute(selected.start, root, signal), activateBuild: signal => build('--activate', signal),
    rollbackBuild: signal => build('--rollback', signal) }
}
