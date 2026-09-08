import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const schema = z.object({ schemaVersion: z.literal(1), baseCommit: z.string().regex(/^[a-f0-9]{40}$/), patchHash: hash, lockHash: hash }).strict()
export type EvolutionRuntimeIdentity = z.infer<typeof schema> & { serverEntrySha256: string; webEntrySha256: string }

/** Capture once at process startup. Reading live files on each health request would misidentify an old process after a file switch. */
export async function captureEvolutionRuntimeIdentity(entry: string): Promise<EvolutionRuntimeIdentity | null> {
  const file = path.resolve(entry)
  if (path.basename(file) !== 'index.js' || path.basename(path.dirname(file)) !== 'server-dist') return null
  try {
    const bytes = await readFile(path.join(path.dirname(file), 'evolution-build.json'))
    if (bytes.length > 4096) return null
    const identity = schema.parse(JSON.parse(bytes.toString('utf8')))
    const [server, web] = await Promise.all([readFile(file), readFile(path.join(path.dirname(file), '..', 'dist', 'index.html'))])
    return Object.freeze({ ...identity, serverEntrySha256: createHash('sha256').update(server).digest('hex'), webEntrySha256: createHash('sha256').update(web).digest('hex') })
  } catch { return null }
}
