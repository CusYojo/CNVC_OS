import { z } from 'zod'

const command = { clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(5).max(600) }
export const fileGrant = z.object({ userId: z.string().uuid(), canView: z.boolean(), canDownload: z.boolean() }).strict()
export const filePermissionCommand = z.object({ ...command, grants: z.array(fileGrant).max(200) }).strict()
  .refine(value => new Set(value.grants.map(item => item.userId)).size === value.grants.length, '不能重复指定成员')
export const fileLifecycleCommand = z.object({ ...command, action: z.enum(['trash', 'restore']) }).strict()
export const fileWorkspaceQuery = z.object({ view: z.enum(['active', 'deleted']).default('active'), keyword: z.string().trim().max(100).default(''), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict()
export const fileHistoryQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict()

// Match the FDE matrix: selecting download also selects view, never the converse.
export function normalizeFileGrants(grants: z.infer<typeof fileGrant>[]) {
  return grants.map(item => ({ ...item, canView: item.canView || item.canDownload })).sort((a, b) => a.userId.localeCompare(b.userId))
}
// Reference window, no automatic byte purge. Production retention remains an approval gate.
export const FDE_FILE_TRASH_DAYS = 30
