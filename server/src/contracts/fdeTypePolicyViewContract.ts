import { z } from 'zod'
import { typePolicyDefinition } from './fdeTypePolicyContract.js'

const capability = z.object({ manage: z.boolean(), approve: z.boolean() })
const head = z.object({ id: z.string().uuid(), code: z.string(), name: z.string(), enabled: z.boolean(), version: z.number().int().positive(), activeVersionId: z.string().uuid().nullable(), nextRevision: z.number().int().positive() })
export const typePolicyVersionView = z.object({ id: z.string().uuid(), policyId: z.string().uuid(), revision: z.number().int().positive(), version: z.number().int().positive(), status: z.enum(['draft', 'approved', 'published']), configuration: typePolicyDefinition, sha256: z.string().length(64), reason: z.string(), createdByName: z.string(), approvedByName: z.string().nullable(), publishedByName: z.string().nullable(), publishedAt: z.string().nullable(), capabilities: z.object({ save: z.boolean(), approve: z.boolean(), publish: z.boolean(), activate: z.boolean(), deactivate: z.boolean() }) })
export type TypePolicyVersionView = z.infer<typeof typePolicyVersionView>
export const typePolicyListView = z.object({ capabilities: capability, policies: z.array(head), page: z.number(), total: z.number(), hasMore: z.boolean(), executionAvailable: z.boolean() })
export type TypePolicyListView = z.infer<typeof typePolicyListView>
export const typePolicyDetailView = z.object({ capabilities: capability, policy: head, versions: z.array(typePolicyVersionView), events: z.array(z.object({ id: z.string().uuid(), action: z.enum(['create', 'save', 'approve', 'publish', 'activate', 'deactivate']), versionId: z.string().uuid(), actorId: z.string().uuid(), reason: z.string(), createdAt: z.string() })), page: z.number(), eventPage: z.number(), hasMore: z.boolean(), eventsHaveMore: z.boolean(), boundProjects: z.number(), executionAvailable: z.boolean() })
export type TypePolicyDetailView = z.infer<typeof typePolicyDetailView>
