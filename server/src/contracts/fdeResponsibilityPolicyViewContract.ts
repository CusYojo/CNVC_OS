import { z } from 'zod'
import { responsibilityPolicySchema } from './fdeResponsibilityPolicyContract.js'

const instant = z.string().datetime({ offset: true })
export const responsibilityPolicyHeadView = z.object({ code: z.literal('responsibility'), activeVersionId: z.string().uuid().nullable(), enabled: z.boolean(), nextRevision: z.number().int().positive(), version: z.number().int().positive() }).strict()
export const responsibilityPolicyCapabilities = z.object({ manage: z.boolean(), approve: z.boolean() }).strict()
export const responsibilityPolicyVersionView = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(), version: z.number().int().positive(), status: z.enum(['draft', 'approved', 'published']),
  configuration: responsibilityPolicySchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string(),
  createdBy: z.string().uuid(), lastEditedBy: z.string().uuid(), approvedBy: z.string().uuid().nullable(), publishedBy: z.string().uuid().nullable(),
  createdByName: z.string(), lastEditedByName: z.string(), approvedByName: z.string().nullable(), publishedByName: z.string().nullable(),
  createdAt: instant, approvedAt: instant.nullable(), publishedAt: instant.nullable(),
  capabilities: z.object({ save: z.boolean(), approve: z.boolean(), publish: z.boolean() }).strict(),
})
export const responsibilityPolicyCurrentView = z.object({
  policy: responsibilityPolicyHeadView.nullable(), capabilities: responsibilityPolicyCapabilities,
  activeVersion: responsibilityPolicyVersionView.nullable(),
}).strict()
export const responsibilityPolicyListView = responsibilityPolicyCurrentView.extend({
  versions: z.array(responsibilityPolicyVersionView),
  events: z.array(z.object({ id: z.string().uuid(), versionId: z.string().uuid().nullable(), actorId: z.string().uuid(), actorName: z.string(), commandId: z.string().uuid(), action: z.enum(['create', 'save', 'approve', 'publish', 'toggle']), reason: z.string(), createdAt: instant })),
  page: z.number().int().positive(), eventPage: z.number().int().positive(), hasMore: z.boolean(), eventsHaveMore: z.boolean(), productionScoringImplemented: z.literal(false),
})
export type ResponsibilityPolicyVersionView = z.infer<typeof responsibilityPolicyVersionView>
export type ResponsibilityPolicyListView = z.infer<typeof responsibilityPolicyListView>
export type ResponsibilityPolicyCurrentView = z.infer<typeof responsibilityPolicyCurrentView>

// Approval always targets the persisted version, never an unsaved form preview.
export function responsibilityPolicyFormMatches(value: unknown, persisted: unknown) {
  const form = responsibilityPolicySchema.safeParse(value), original = responsibilityPolicySchema.safeParse(persisted)
  return form.success && original.success && JSON.stringify(form.data) === JSON.stringify(original.data)
}
