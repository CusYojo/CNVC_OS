import { z } from 'zod'

export const knowledgeKinds = ['行业资讯', '方法论', '新闻链接', '共享文档'] as const
export function safeKnowledgeLink(value: string) {
  if (!value.trim()) return ''
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
const ids = z.array(z.string().uuid()).max(100).transform(values => [...new Set(values)].sort())
export const knowledgeDefinition = z.object({
  kind: z.enum(knowledgeKinds), title: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(500),
  link: z.string().trim().max(2000).default('').refine(value => safeKnowledgeLink(value) !== null, '仅允许无凭据的 HTTP/HTTPS 链接').transform(value => safeKnowledgeLink(value)!),
  audience: z.enum(['selected', 'company']), readerIds: ids, editorIds: ids,
  fileId: z.string().uuid().nullable(), fileVersion: z.number().int().positive().nullable(),
}).strict().refine(value => Boolean(value.fileId) === Boolean(value.fileVersion), '文件与版本必须同时提供')
export const knowledgeSave = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), definition: knowledgeDefinition }).strict()
export const knowledgeAction = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), action: z.enum(['publish', 'archive']), reason: z.string().trim().min(5).max(500) }).strict()
export const knowledgeCommentCommand = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), content: z.string().trim().min(1).max(300) }).strict()
export const knowledgeRatingCommand = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), score: z.number().int().min(2).max(5).nullable() }).strict()
export const knowledgeCommentWithdrawal = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(5).max(300) }).strict()
export const knowledgeQuery = z.object({ view: z.enum(['published', 'draft', 'archived']).default('published'), keyword: z.string().trim().max(100).default(''), kind: z.enum(knowledgeKinds).optional(), page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict()
export const knowledgeDetailQuery = z.object({ page: z.coerce.number().int().positive().default(1), historyPage: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict()
