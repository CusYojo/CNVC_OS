import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { knowledgeChunks } from '../db/schema.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { scoreWithAgentDetailed } from './inProcessAiWorkflowService.js'
import { prepareProjectScoringAuditContext } from './leadScoringPipelineService.js'
import { getProject, listProjects, saveProjectScoring } from './projectService.js'
import type { ProjectScoreExecutionResult } from './projectScoreJobService.js'

const maxAttempts = readIntegerEnv('PROJECT_SCORE_MAX_ATTEMPTS', 3, 1, 10)
const retryBaseMs = readIntegerEnv('PROJECT_SCORE_RETRY_BASE_MS', 60_000, 1_000, 3_600_000)

function readIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 8_000)
}

function retryable(error: unknown): boolean {
  return (error as Error & { retryable?: boolean }).retryable !== false
}

export async function scoreProjectAndPersist(projectId: string, executionAttempt = 1): Promise<void> {
  const project = await getProject(projectId)
  if (!project) {
    const error = new Error('项目不存在') as Error & { retryable?: boolean }
    error.retryable = false
    throw error
  }

  // 项目上传资料必须进入评分证据；上限避免单次模型输入无界增长。
  const chunks = await db.select().from(knowledgeChunks).where(and(
    eq(knowledgeChunks.scope, 'project'),
    eq(knowledgeChunks.refId, projectId),
  ))
  const knowledgeText = chunks.map((chunk) => chunk.content).join('\n').slice(0, 24_000)
  const knowledgeSources = [...new Set(chunks.map((chunk) => chunk.sourceName).filter(Boolean))]
  const summary = [
    project.summary ?? '',
    knowledgeText ? `\n\n=== 知识库资料（项目已上传文档/纪要，评分请以此为准）===\n${knowledgeText}` : '',
  ].filter(Boolean).join('')
  const scoringInput = {
    projectName: project.name,
    industry: project.industry ?? undefined,
    round: project.round ?? undefined,
    valuation: project.valuation ?? undefined,
    financing: project.financing ?? undefined,
    summary: summary || undefined,
    team: project.team ?? undefined,
    sources: knowledgeSources.length ? knowledgeSources : undefined,
  }
  const audit = await prepareProjectScoringAuditContext({
    projectId,
    scoringInput,
    queueAttempt: executionAttempt,
  })
  const detailed = await scoreWithAgentDetailed('score-project', scoringInput, { audit })
  const result = detailed.result

  const all = await listProjects({ page: 1, pageSize: 500 })
  const peers = (all.list as Array<{ industry?: string; id: string; scoring?: { total?: number } }>)
    .filter((candidate) => (
      candidate.industry === project.industry
      && candidate.id !== projectId
      && candidate.scoring?.total != null
    ))
    .map((candidate) => candidate.scoring!.total as number)
  const allScores = [...peers, result.total].sort((a, b) => b - a)
  const rankIndex = allScores.indexOf(result.total)
  const percentile = allScores.length > 1
    ? Math.round((1 - rankIndex / (allScores.length - 1)) * 100)
    : 100
  await saveProjectScoring(projectId, {
    ...result,
    rank: {
      peers_count: allScores.length,
      position: rankIndex + 1,
      percentile,
      industry: project.industry ?? '未分类',
    },
    scored_at: new Date().toISOString(),
    provenance: 'agent-run',
    evidenceChain: detailed.audit,
  }, result.total)
}

export async function executeProjectScoring(
  projectId: string,
  executionAttempt: number,
): Promise<ProjectScoreExecutionResult> {
  try {
    await scoreProjectAndPersist(projectId, executionAttempt)
    return { status: 'done' }
  } catch (error) {
    const message = safeError(error)
    if (retryable(error) && executionAttempt < maxAttempts) {
      const delayMs = Math.min(retryBaseMs * 2 ** Math.max(0, executionAttempt - 1), 3_600_000)
      return { status: 'retrying', nextAttemptAt: new Date(Date.now() + delayMs), error: message }
    }
    return { status: 'dead_letter', error: message }
  }
}
