import type { AuditRecord } from './identityRepository.js'

export type AiCustomTemplateAnalysis = {
  schemaVersion?: '1.0'
  analysisVersion?: string
  format: 'docx' | 'pptx'
  fileName: string
  formatProfile: {
    fonts: string[]
    primaryFont: string
    headingFont: string
    titleSizePt: number | null
    headingSizePt: number | null
    bodySizePt: number | null
    lineSpacing: string
    paragraphSpacing: string
    alignment: string[]
    pageSize: string
    margins: string
    orientation: string
    colors: string[]
    header: string
    footer: string
    hasPageNumbers: boolean
    tableCount: number
    imageCount: number
  }
  structures: Array<{
    order: number
    title: string
    level: number
    contentPurpose: string
    contentSummary: string
    contentRequirements: string[]
  }>
  summary: string
}

export type AiCustomTemplateRecord = {
  id: string
  userId: string
  projectId: string
  conversationId: string | null
  originalFileName: string
  format: string
  mimeType: string
  fileSize: number
  sha256: string
  storagePath: string
  analysis: AiCustomTemplateAnalysis
  skillName: string
  skillPath: string
  skillVersion: string
  status: string
  createdAt: Date
  updatedAt: Date
}

export type CreateAiCustomTemplateRecord = Omit<
  AiCustomTemplateRecord,
  'conversationId' | 'createdAt' | 'updatedAt'
> & {
  conversationId?: string
}

export type AiTemplateAnalysisProgressStatus = 'running' | 'succeeded' | 'failed'

export type AiTemplateAnalysisProgressRecord = {
  id: string
  userId: string
  projectId: string
  taskId: string | null
  fileName: string
  purpose: string
  status: AiTemplateAnalysisProgressStatus
  stage: string
  progress: number
  errorMessage: string | null
  result: unknown
  startedAt: Date
  updatedAt: Date
  expiresAt: Date
}

export type AiTaskRecord = {
  id: string
  userId: string
  projectId: string
  conversationId: string | null
  type: string
  parameters: Record<string, unknown>
  templateVersion: string
  status: string
  stage: string
  progress: number
  resultSummary: string | null
  errorId: string | null
  errorCode: string | null
  errorMessage: string | null
  retryable: boolean | null
  cancellationRequested: boolean
  executionAttempts: number
  modelCalls: number
  usageCalls: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  reasoningTokens: number
  totalTokens: number
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  idempotencyKey: string
  requestHash: string | null
  retryOfTaskId: string | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  updatedAt: Date
}

export type AiArtifactRecord = {
  id: string
  taskId: string
  userId: string
  projectId: string
  conversationId: string | null
  fileName: string
  format: string
  mimeType: string
  version: number
  storagePath: string
  editableLevel: string
  sourceCutoffDate: string | null
  templateVersion: string
  qualityStatus: string
  metadata: Record<string, unknown>
  archived: boolean
  createdAt: Date
}

export type AiTaskSourceRecord = {
  id: string
  taskId: string
  artifactId: string | null
  sourceType: string
  sourceId: string | null
  sourceName: string
  locator: string | null
  verificationStatus: string
  createdAt: Date
}

export type CreateAiTaskRecord = {
  id?: string
  userId: string
  projectId: string
  conversationId?: string
  type: string
  parameters: Record<string, unknown>
  templateVersion: string
  status?: string
  stage?: string
  progress?: number
  startedAt?: Date
  idempotencyKey: string
  requestHash: string
  retryOfTaskId?: string
  updatedAt?: Date
}

export type CreateAiArtifactRecord = Omit<AiArtifactRecord, 'createdAt'>
export type CreateAiTaskSourceRecord = Omit<AiTaskSourceRecord, 'createdAt'>

export type RecoverableAiTaskRecord = Pick<
  AiTaskRecord,
  'id' | 'status' | 'parameters' | 'cancellationRequested' | 'leaseExpiresAt' | 'updatedAt'
>

export type AiTaskTemplateRecord = {
  type: string
  label: string
  templateVersion: string
  skillName: string
  outputFormat: string
  status: string
  createdAt: Date
  updatedAt: Date
}

export interface AiTaskRepository {
  findTaskById(taskId: string): Promise<AiTaskRecord | null>
  findOwnedTask(userId: string, taskId: string): Promise<AiTaskRecord | null>
  findTaskByIdempotency(userId: string, idempotencyKey: string): Promise<AiTaskRecord | null>
  createTask(input: CreateAiTaskRecord): Promise<AiTaskRecord>
  listOwnedTasks(input: {
    userId: string
    projectId?: string
    conversationId?: string
    limit?: number
  }): Promise<AiTaskRecord[]>
  claimTask(input: {
    taskId: string
    leaseOwner: string
    leaseExpiresAt: Date
    updatedAt: Date
  }): Promise<boolean>
  getTaskCancellationState(taskId: string): Promise<{
    cancellationRequested: boolean
    status: string
    leaseOwner: string | null
  } | null>
  updateRunningStage(input: {
    taskId: string
    leaseOwner: string
    stage: string
    progress: number
    updatedAt: Date
  }): Promise<boolean>
  addTaskModelUsage(input: {
    taskId: string
    usage: {
      inputTokens: number
      outputTokens: number
      cacheCreationInputTokens: number
      cacheReadInputTokens: number
      reasoningTokens: number
      totalTokens: number
    } | null
    updatedAt: Date
  }): Promise<void>
  heartbeatTaskLease(input: {
    taskId: string
    leaseOwner: string
    leaseExpiresAt: Date
    updatedAt: Date
  }): Promise<boolean>
  markTaskStarted(input: {
    taskId: string
    leaseOwner: string
    stage: string
    progress: number
    startedAt: Date
    updatedAt: Date
  }): Promise<boolean>
  markTaskCancelledByLease(input: {
    taskId: string
    leaseOwner: string
    completedAt: Date
  }): Promise<boolean>
  releaseTaskLease(input: { taskId: string; leaseOwner: string; updatedAt: Date }): Promise<void>
  updatePreparationProgress(input: {
    taskId: string
    userId: string
    stage: string
    progress: number
    updatedAt: Date
  }): Promise<boolean>
  failPreparation(input: {
    taskId: string
    userId: string
    progress: number
    errorMessage: string
    completedAt: Date
  }): Promise<boolean>
  finishPreparation(input: {
    taskId: string
    userId: string
    parameters: Record<string, unknown>
    templateVersion: string
    updatedAt: Date
  }): Promise<boolean>
  cancelOwnedPreparation(input: { taskId: string; userId: string; completedAt: Date }): Promise<boolean>
  requestCancellation(input: {
    taskId: string
    userId: string
    cancelImmediately: boolean
    updatedAt: Date
  }): Promise<boolean>
  markEditableArtifactMissing(taskId: string, updatedAt: Date): Promise<void>
  isTaskTemplateRegistered(input: {
    type: string
    templateVersion: string
    skillName: string
    outputFormat: string
  }): Promise<boolean>
  listTaskTemplates(): Promise<AiTaskTemplateRecord[]>
  countArtifacts(input: { userId: string; projectId: string; format: string }): Promise<number>
  listTaskArtifacts(taskId: string): Promise<AiArtifactRecord[]>
  listTaskSources(taskId: string): Promise<AiTaskSourceRecord[]>
  listOwnedArtifacts(input: {
    userId: string
    projectId?: string
    limit?: number
  }): Promise<Array<{ artifact: AiArtifactRecord; taskType: string }>>
  findOwnedArtifactWithTaskType(input: {
    userId: string
    artifactId: string
  }): Promise<{ artifact: AiArtifactRecord; taskType: string } | null>
  findOwnedArtifact(userId: string, artifactId: string): Promise<AiArtifactRecord | null>
  findLatestImageDeck(taskId: string): Promise<AiArtifactRecord | null>
  findLatestMainArtifact(input: {
    taskId: string
    requireEditableStage: boolean
  }): Promise<Pick<AiArtifactRecord, 'id' | 'format'> | null>
  upsertImageDeck(input: {
    existingArtifactId?: string
    artifact: CreateAiArtifactRecord
    updatedAt: Date
  }): Promise<void>
  completeTaskWithArtifacts(input: {
    taskId: string
    leaseOwner: string
    stage: string
    resultSummary: string
    completedAt: Date
    artifacts: CreateAiArtifactRecord[]
    sources: CreateAiTaskSourceRecord[]
  }): Promise<boolean>
  markSucceededFromExistingArtifact(input: {
    taskId: string
    leaseOwner: string
    stage: string
    completedAt: Date
  }): Promise<boolean>
  resetTaskForAutomaticRecovery(input: {
    taskId: string
    leaseOwner: string
    stage: string
    progress: number
    parameters: Record<string, unknown>
    updatedAt: Date
  }): Promise<boolean>
  markTaskFailed(input: {
    taskId: string
    leaseOwner: string
    stage: string
    errorId: string
    errorCode: string
    errorMessage: string
    retryable: boolean
    completedAt: Date
  }): Promise<void>
  listRecoverableTasks(input: {
    taskIds?: string[]
    staleWithoutLeaseBefore: Date
    limit?: number
  }): Promise<RecoverableAiTaskRecord[]>
  markRecoverableCancelled(input: {
    taskId: string
    previousStatus: string
    completedAt: Date
  }): Promise<boolean>
  markRecoverableTemplateFailed(input: {
    taskId: string
    previousStatus: string
    completedAt: Date
  }): Promise<boolean>
  resetExpiredRunningTask(input: {
    taskId: string
    staleWithoutLeaseBefore: Date
    updatedAt: Date
  }): Promise<boolean>
  taskWorkerHealth(): Promise<{
    pending: number
    running: number
    failed: number
    liveLeases: number
    expiredLeases: number
  }>
  stopOwnedRunningTasks(input: {
    leaseOwner: string
    updatedAt: Date
  }): Promise<{ released: number; cancelled: number }>
  createCustomTemplateWithAudit(
    input: CreateAiCustomTemplateRecord,
    audit: AuditRecord,
  ): Promise<AiCustomTemplateRecord>
  listCustomTemplates(input: {
    userId: string
    projectId?: string
    conversationId?: string
    limit?: number
  }): Promise<AiCustomTemplateRecord[]>
  findCustomTemplateForOwner(userId: string, templateId: string): Promise<AiCustomTemplateRecord | null>
  findCustomTemplateForTask(input: {
    userId: string
    projectId: string
    templateId: string
  }): Promise<AiCustomTemplateRecord | null>
  findLatestInvestmentPptTemplate(input: {
    userId: string
    projectId: string
    conversationId: string
  }): Promise<AiCustomTemplateRecord | null>
  recoverInterruptedTemplateAnalysisProgress(input: {
    interruptedMessage: string
    completedTtlMinutes: number
  }): Promise<number>
  startTemplateAnalysisProgress(input: {
    id: string
    userId: string
    projectId: string
    taskId?: string
    fileName: string
    purpose: string
    runningTtlMinutes: number
  }): Promise<{ created: boolean; progress: AiTemplateAnalysisProgressRecord }>
  updateTemplateAnalysisProgress(input: {
    id: string
    stage: string
    progress: number
    runningTtlMinutes: number
  }): Promise<void>
  completeTemplateAnalysisProgress(input: {
    id: string
    result: unknown
    completedTtlMinutes: number
  }): Promise<void>
  failTemplateAnalysisProgress(input: {
    id: string
    message: string
    completedTtlMinutes: number
  }): Promise<void>
  getTemplateAnalysisProgress(input: {
    userId: string
    id: string
    interruptedMessage: string
    completedTtlMinutes: number
  }): Promise<AiTemplateAnalysisProgressRecord | null>
}
