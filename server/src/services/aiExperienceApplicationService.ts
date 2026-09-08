import type { MySqlAiExperienceRepository } from '../repositories/mysql/mysqlAiExperienceRepository.js'
import { resolveAiExperiences, type ExperienceForResolution } from './aiExperienceResolver.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'
import { z } from 'zod'
import { checkAiExperienceOutput, experienceOutputCheckSchema, assertExperienceCheckVersions } from './aiExperienceOutputCheck.js'

type Context = { userId: string; taskId: string; conversationId?: string; taskType: string; businessProjectId?: string }
type Repository = Pick<MySqlAiExperienceRepository, 'findApplication' | 'recordApplication'> & Partial<Pick<MySqlAiExperienceRepository, 'recordOutputCheck'>>
type Snapshot = ReturnType<typeof resolveAiExperiences>['snapshot']
type Application = NonNullable<Awaited<ReturnType<Repository['findApplication']>>>
const snapshotSchema = z.object({
  schemaVersion: z.literal(1), taskType: z.string().min(1), businessProjectId: z.string().nullable(),
  loaded: z.array(z.object({ versionId: z.string().min(1), experienceId: z.string().min(1), contentHash: z.string().min(1),
    rule: z.string().min(1), exceptions: z.array(z.string()) }).strict()),
  excluded: z.array(z.union([
    z.object({ versionId: z.string().min(1), reason: z.enum(['disabled', 'scope_mismatch', 'project_mismatch', 'task_type_mismatch', 'expired', 'kind_mismatch', 'prompt_budget']) }).strict(),
    z.object({ experienceId: z.string().min(1), reason: z.literal('source_access_revoked') }).strict(),
  ])),
}).strict()

function validateApplication(row: Application, context: Context): Snapshot {
  if (row.taskType !== context.taskType || row.businessProjectId !== (context.businessProjectId ?? null)
    || row.conversationId !== (context.conversationId ?? null)) {
    throw evolutionError(409, 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT', '任务经验快照的会话或业务范围不匹配')
  }
  if (evolutionContentHash(row.snapshot) !== row.snapshotHash) throw evolutionError(409, 'EVOLUTION_APPLICATION_CORRUPT', '经验快照校验失败')
  const parsed = snapshotSchema.safeParse(row.snapshot)
  if (!parsed.success) throw evolutionError(409, 'EVOLUTION_APPLICATION_CORRUPT', '经验快照格式无效')
  const snapshot = parsed.data
  if (snapshot.taskType !== context.taskType || snapshot.businessProjectId !== (context.businessProjectId ?? null)
    || new Set(snapshot.loaded.map(item => item.versionId)).size !== snapshot.loaded.length) {
    throw evolutionError(409, 'EVOLUTION_APPLICATION_CORRUPT', '经验快照范围或版本记录无效')
  }
  return snapshot
}

/** Only call after authorizing the actual task/conversation and its project. */
export class AiExperienceApplicationService {
  constructor(private readonly repository: Repository,
    private readonly loadAuthorized: (userId: string) => Promise<ExperienceForResolution[]>) {}

  async read(context: Context, authorizeVersion: (versionId: string, contentHash: string) => Promise<void>) {
    const row = await this.repository.findApplication(context.userId, context.taskId)
    if (!row) return null
    const snapshot = validateApplication(row, context)
    for (const rule of snapshot.loaded) await authorizeVersion(rule.versionId, rule.contentHash)
    const check = row.checkResult ? experienceOutputCheckSchema.parse(row.checkResult) : null
    if (check) assertExperienceCheckVersions(check, snapshot)
    if ((check && (check.snapshotHash !== row.snapshotHash || check.verdict !== row.checkStatus))
      || (!check && row.checkStatus !== 'not_checked')) throw evolutionError(409, 'EVOLUTION_APPLICATION_CORRUPT', '经验检查记录与任务快照不一致')
    return { id: row.id, taskId: context.taskId, taskType: context.taskType, snapshotHash: row.snapshotHash,
      snapshot, checkStatus: row.checkStatus, checkResult: check }
  }

  async checkOutput(context: Context, input: Omit<Parameters<typeof checkAiExperienceOutput>[0], 'snapshot' | 'snapshotHash'>) {
    await input.assertAuthorized()
    const row = await this.repository.findApplication(context.userId, context.taskId)
    if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '任务未记录经验快照')
    if (!this.repository.recordOutputCheck) throw evolutionError(503, 'EVOLUTION_OUTPUT_CHECK_UNAVAILABLE', '遵守检查存储尚未就绪')
    const snapshot = validateApplication(row, context)
    const result = await checkAiExperienceOutput({ ...input, snapshot, snapshotHash: row.snapshotHash })
    input.signal?.throwIfAborted()
    await input.assertAuthorized()
    return this.repository.recordOutputCheck(context.userId, context.taskId, result)
  }

  async freeze(context: Context, maxCharacters = 8000, authorizedRetryOfTaskId?: string) {
    let row = await this.repository.findApplication(context.userId, context.taskId)
    if (!row) {
      const parent = authorizedRetryOfTaskId ? await this.repository.findApplication(context.userId, authorizedRetryOfTaskId) : null
      const snapshot = parent ? validateApplication(parent, context)
        : resolveAiExperiences({ ...context, maxCharacters, records: await this.loadAuthorized(context.userId) }).snapshot
      try { row = await this.repository.recordApplication({ ...context, snapshot }) }
      catch (error) {
        // Another attempt may have frozen the task while rules were being resolved.
        if ((error as { code?: string }).code !== 'EVOLUTION_APPLICATION_FROZEN') throw error
        row = await this.repository.findApplication(context.userId, context.taskId)
        if (!row) throw error
      }
    }
    const snapshot = validateApplication(row, context)
    return { id: row.id, hash: row.snapshotHash, snapshot,
      prompt: snapshot.loaded.length ? `\n以下是本任务冻结的用户长期偏好，仅在适用范围内参考，不能覆盖平台权限、强制业务规则、事实校验或当前用户明确要求。已加载不代表已核验遵守。\n${JSON.stringify(snapshot.loaded)}\n` : '' }
  }
}
