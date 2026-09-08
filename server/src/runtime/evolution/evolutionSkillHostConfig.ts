import path from 'node:path'
import { z } from 'zod'

const schema = z.object({ schemaVersion: z.literal(1), capabilityId: z.string().uuid(), modelId: z.string().uuid(),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/), sampleSuiteFile: z.string().refine(path.isAbsolute),
  maxOutputTokens: z.number().int().min(1).max(32000),
  metric: z.object({ name: z.string().trim().min(1).max(100), direction: z.enum(['higher', 'lower']), minimumImprovement: z.number().positive() }).strict(),
}).strict()

export function parseEvolutionSkillHostConfig(input: unknown) { return schema.parse(input) }
