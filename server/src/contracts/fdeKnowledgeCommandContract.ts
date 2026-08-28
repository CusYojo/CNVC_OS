import { z } from 'zod'

export const knowledgeCommandTarget = z.object({
  id: z.string().uuid(),
  action: z.enum(['save', 'publish', 'archive', 'comment', 'withdraw-comment', 'rate']),
  clientRequestId: z.string().uuid(),
  commentId: z.string().uuid().optional(),
}).strict().refine(value => (value.action === 'withdraw-comment') === Boolean(value.commentId), '仅撤回批注需要批注编号')
export const knowledgeReceipt = z.object({ id: z.string().uuid(), version: z.number().int().positive() }).strict()
export const knowledgeResolution = z.discriminatedUnion('state', [
  z.object({ state: z.literal('committed'), receipt: knowledgeReceipt }).strict(),
  z.object({ state: z.literal('not_applied') }).strict(),
])
export type KnowledgeCommandTarget = z.infer<typeof knowledgeCommandTarget>
export type KnowledgeReceipt = z.infer<typeof knowledgeReceipt>
export function knowledgeCommandPath(value: KnowledgeCommandTarget) {
  const marker = knowledgeCommandTarget.parse(value)
  const suffix = marker.action === 'save' ? 'save' : marker.action === 'comment' ? 'comments' : marker.action === 'withdraw-comment' ? `comments/${marker.commentId}/withdraw` : marker.action === 'rate' ? 'rating' : 'actions'
  return `/company-knowledge/${marker.id}/${suffix}`
}
