import { z } from 'zod'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const selection = z.object({ schemaVersion: z.literal(1), capabilityId: z.string().uuid(),
  scope: z.object({ type: z.enum(['user', 'project']), key: z.string().min(1).max(128) }).strict(),
  bindingId: z.string().uuid(), bindingRevision: z.number().int().positive(), versionId: z.string().uuid(),
  contentHash: hash, packageHash: hash, reason: z.enum(['active', 'trial_expired']),
  selectedAt: z.string().datetime(), trialExpiresAt: z.string().datetime().nullable(),
}).strict()
export const evolutionSkillTaskSnapshotSchema = z.object({ schemaVersion: z.literal(1),
  entries: z.array(z.discriminatedUnion('status', [
    z.object({ capabilityId: z.string().uuid(), status: z.literal('selected'), selection }).strict(),
    z.object({ capabilityId: z.string().uuid(), status: z.literal('baseline'), ownerUserId: z.string().uuid(),
      sourceTaskId: z.string().uuid(), contentHash: hash, packageHash: hash,
      artifact: z.object({ kind: z.literal('content'), storageKey: z.string().min(1).max(240), sha256: hash,
        bytes: z.number().int().positive().max(32 * 1024 * 1024) }).strict(),
    }).strict(),
    z.object({ capabilityId: z.string().uuid(), status: z.literal('unmatched'), reason: z.literal('no_binding') }).strict(),
  ])).max(100),
}).strict().superRefine((snapshot, ctx) => {
  if (new Set(snapshot.entries.map(entry => entry.capabilityId)).size !== snapshot.entries.length
    || snapshot.entries.some(entry => entry.status === 'selected' && entry.capabilityId !== entry.selection.capabilityId)) {
    ctx.addIssue({ code: 'custom', message: 'Skill snapshot capability bindings are inconsistent' })
  }
})
export type EvolutionSkillTaskSnapshot = z.infer<typeof evolutionSkillTaskSnapshotSchema>
