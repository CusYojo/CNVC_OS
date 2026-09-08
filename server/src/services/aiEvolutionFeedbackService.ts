import { z } from 'zod'
import { MySqlAiEvolutionFeedbackRepository } from '../repositories/mysql/mysqlAiEvolutionFeedbackRepository.js'
import { getAiEvolutionCandidateForUser, getPersonalAiExperienceApplication } from './aiEvolutionApplicationService.js'
import { evolutionError } from './aiEvolutionPolicyService.js'

const uuid = z.string().uuid()
const subject = z.object({ candidateId: uuid.optional(), applicationId: uuid.optional() }).strict().refine(
  value => Number(Boolean(value.candidateId)) + Number(Boolean(value.applicationId)) === 1,
  '必须且只能指定一个反馈对象')
const evidence = z.object({ type: z.enum(['message', 'task', 'artifact', 'page']), id: z.string().trim().min(1).max(200) }).strict()
const createSchema = subject.extend({ feedbackType: z.enum(['helpful', 'incorrect', 'regression', 'suggestion']),
  comment: z.string().trim().min(1).max(4000), evidenceRefs: z.array(evidence).max(20).default([]) })
const listSchema = subject.extend({ limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(100000).default(0) })
const idempotency = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const repository = new MySqlAiEvolutionFeedbackRepository()
const dto = (row: Awaited<ReturnType<MySqlAiEvolutionFeedbackRepository['create']>>) => ({ id: row.id,
  candidateId: row.candidateId, applicationId: row.applicationId, feedbackType: row.feedbackType,
  comment: row.comment, evidenceRefs: row.evidenceRefs, contentHash: row.contentHash, createdAt: row.createdAt })

async function authorizeSubject(userId: string, input: { candidateId?: string; applicationId?: string }) {
  if (input.candidateId) await getAiEvolutionCandidateForUser(userId, input.candidateId)
  else {
    const subject = await repository.findApplicationSubject(userId, input.applicationId!)
    if (!subject) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '反馈应用记录不存在或不可访问')
    const result = await getPersonalAiExperienceApplication(userId, subject.taskId)
    if (!result.list.some(item => item.id === input.applicationId)) throw new Error('Experience application identity changed')
  }
}

export async function createAiEvolutionFeedback(userId: string, raw: unknown, key: unknown) {
  const input = createSchema.parse(raw)
  await authorizeSubject(userId, input)
  return dto(await repository.create(uuid.parse(userId), { ...input, idempotencyKey: idempotency.parse(key) }))
}

export async function listAiEvolutionFeedback(userId: string, raw: unknown) {
  const input = listSchema.parse(raw)
  await authorizeSubject(userId, input)
  return { list: (await repository.list(uuid.parse(userId), input, input.limit, input.offset)).map(dto) }
}
