import { z } from 'zod'

export const officePolicyCommandTarget = z.object({
  id: z.string().uuid(), action: z.enum(['save', 'publish', 'enabled']), clientRequestId: z.string().uuid(),
}).strict()
export type OfficePolicyCommandTarget = z.infer<typeof officePolicyCommandTarget>
export const officePolicyReceipt = z.object({
  id: z.string().uuid(), action: z.enum(['save', 'publish', 'enabled']), policyId: z.string().uuid(),
  version: z.number().int().positive(), policyVersion: z.number().int().positive(),
  status: z.enum(['draft', 'published']).optional(), enabled: z.boolean(),
}).strict()
export type OfficePolicyReceipt = z.infer<typeof officePolicyReceipt>
export const officePolicyResolution = z.discriminatedUnion('state', [
  z.object({ state: z.literal('committed'), receipt: officePolicyReceipt }).strict(),
  z.object({ state: z.literal('not_applied') }).strict(),
])
