import path from 'node:path'
import { z } from 'zod'

const schema = z.object({
  schemaVersion: z.literal(1),
  image: z.string().regex(/^(?:[a-zA-Z0-9_./:-]+@)?sha256:[a-f0-9]{64}$/),
  modelId: z.string().uuid(),
  browserModulePath: z.string().refine(path.isAbsolute),
  browserChannel: z.enum(['msedge', 'chrome', 'chromium']).default('chromium'),
  suiteVersion: z.string().trim().min(1).max(100),
  functionalGate: z.object({ file: z.string().regex(/^[a-zA-Z0-9_-]+\.test\.(?:ts|js)$/), minimumTests: z.number().int().min(1).max(10000) }).strict(),
}).strict()

/** Trusted host configuration only; never accepted from proposal/model/API input. */
export function parseEvolutionHostConfig(value: unknown) { return schema.parse(value) }
