import { z } from 'zod'

export const ADMIN_PERMANENT_DELETION_RISK_TEXT = '我已熟知删除项目的风险，我愿意承担责任。'
export const permanentDeletionResourceTypeSchema = z.enum(['lead', 'project', 'knowledge'])
export type PermanentDeletionResourceType = z.infer<typeof permanentDeletionResourceTypeSchema>

export const permanentDeletionSearchSchema = z.object({
  resourceType: permanentDeletionResourceTypeSchema,
  query: z.string().trim().min(1).max(50),
}).strict()

export const permanentDeletionPreviewSchema = z.object({
  resourceType: permanentDeletionResourceTypeSchema,
  resourceId: z.string().uuid(),
}).strict()

export const permanentDeletionExecuteSchema = z.object({
  resourceType: permanentDeletionResourceTypeSchema,
  resourceId: z.string().uuid(),
  previewToken: z.string().uuid(),
  resourceName: z.string().min(1).max(255),
  riskText: z.literal(ADMIN_PERMANENT_DELETION_RISK_TEXT),
}).strict()

export type PermanentDeletionTarget = {
  id: string
  name: string
  status: string
  createdAt: string
  source: string | null
}

export type PermanentDeletionImpact = {
  relatedRecords: number
  files: number
  sharedFiles: number
}

export type PermanentDeletionPreview = {
  previewToken: string
  expiresAt: string
  resourceType: PermanentDeletionResourceType
  resourceId: string
  resourceName: string
  impact: PermanentDeletionImpact
  blockers: string[]
}
