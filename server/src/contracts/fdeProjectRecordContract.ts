import { z } from 'zod'

export const projectRecordKinds = ['关键判断', '沟通结论', '风险处置', '会议结论'] as const
export const projectRecordCreate = z.object({ clientRequestId: z.string().uuid(), kind: z.enum(projectRecordKinds), title: z.string().trim().min(1).max(100), content: z.string().trim().min(1).max(600) }).strict()
export const projectRecordComment = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), content: z.string().trim().min(1).max(300) }).strict()
export const projectRecordAction = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), action: z.enum(['withdraw', 'archive']), reason: z.string().trim().min(5).max(600) }).strict()
export const projectRecordCommentWithdrawal = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(5).max(600) }).strict()
export const projectRecordQuery = z.object({ view: z.enum(['published', 'archived', 'withdrawn']).default('published'), keyword: z.string().trim().max(100).default(''), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict()
export const projectRecordDetailQuery = z.object({ page: z.coerce.number().int().min(1).default(1), historyPage: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict()
