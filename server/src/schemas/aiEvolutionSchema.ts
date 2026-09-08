import { z } from 'zod'
import { EVOLUTION_KINDS } from '../contracts/aiEvolutionContract.js'

const uuid = z.string().uuid()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const nonempty = (max: number) => z.string().trim().min(1).max(max)
const relativePath = nonempty(240).refine((value) => {
  if (value.startsWith('/') || value.includes('\\') || value.includes(':')) return false
  return value.split('/').every((part) => part !== '..' && part !== '.' && part !== '' && !part.startsWith('.'))
}, '必须是仓库内明确的相对路径')

export const evolutionBudgetSchema = z.object({
  maxDurationSeconds: z.number().int().min(30).max(7_200),
  maxModelTokens: z.number().int().min(1).max(1_000_000),
  maxRepairRounds: z.number().int().min(0).max(3),
}).strict()

export const evolutionSpecSchema = z.object({
  schemaVersion: z.literal(1), kind: z.enum(EVOLUTION_KINDS),
  title: nonempty(160), objective: nonempty(8_000),
  sourceRefs: z.array(z.object({
    type: z.enum(['message', 'task', 'feedback', 'page']), id: nonempty(200), conversationId: uuid.optional(), excerpt: nonempty(2_000).optional(),
  }).strict()).min(1).max(20),
  businessProjectId: uuid.optional(),
  scope: z.object({ type: z.enum(['user', 'project', 'department', 'organization']), key: nonempty(128) }).strict(),
  acceptanceCriteria: z.array(nonempty(2_000)).min(1).max(30),
  budget: evolutionBudgetSchema,
  questions: z.array(z.object({
    id: nonempty(80), question: nonempty(1_000), options: z.array(nonempty(500)).min(2).max(6), answer: nonempty(2_000).optional(),
  }).strict()).max(20),
  target: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('experience'), rule: nonempty(8_000), taskTypes: z.array(nonempty(100)).min(1).max(50),
      exceptions: z.array(nonempty(1_000)).max(20), expiresAt: z.string().datetime().optional(), replacesVersionIds: z.array(uuid).max(20),
    }).strict(),
    z.object({ type: z.literal('skill'), capabilityId: uuid, baseContentHash: sha256, sampleIds: z.array(uuid).min(1).max(100) }).strict(),
    z.object({
      type: z.literal('code'), repositoryId: uuid, baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
      allowedPaths: z.array(relativePath).min(1).max(50), databaseChange: z.boolean(), permissionChange: z.boolean(),
    }).strict(),
  ]),
}).strict().superRefine((spec, ctx) => {
  if (spec.kind !== spec.target.type) ctx.addIssue({ code: 'custom', path: ['target'], message: '进化类型与目标不一致' })
  if (spec.scope.type === 'project' && spec.scope.key !== spec.businessProjectId) {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: '项目作用域必须绑定同一业务项目' })
  }
  if (new Set(spec.questions.map((q) => q.id)).size !== spec.questions.length) {
    ctx.addIssue({ code: 'custom', path: ['questions'], message: '问题标识不能重复' })
  }
})

export const evolutionCreateSchema = z.object({ spec: evolutionSpecSchema }).strict()
export const evolutionEditSchema = z.object({ expectedRevision: z.number().int().positive(), spec: evolutionSpecSchema }).strict()
export const evolutionExecuteSchema = z.object({ expectedRevision: z.number().int().positive() }).strict()
export const evolutionProposalDecisionSchema = z.object({ expectedRevision: z.number().int().positive(),
  decision: z.enum(['rejected', 'deferred']) }).strict()
export const evolutionDecisionSchema = z.object({
  candidateHash: sha256, evaluationHash: sha256,
  scope: z.object({ type: z.enum(['user', 'project', 'department', 'organization']), key: nonempty(128) }).strict(),
  environment: nonempty(128), decision: z.enum(['approved', 'rejected']),
}).strict()
export const evolutionPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict()
