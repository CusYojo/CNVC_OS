import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  aiCustomTemplates,
  aiTasks,
  auditLogs,
  chatConversations,
  projects,
  users,
} from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import { createAiTask, recoverAiTasks, stopAiTaskWorker } from '../services/aiTaskService.js'
import {
  AI_TASK_TYPES,
  AI_TEMPLATE_CATALOG,
  listAiTaskTypes,
  type AiExecutableTaskType,
} from '../services/aiTemplateCatalog.js'

async function main() {
  const marker = randomUUID()
  const passwordHash = await hashPassword(randomUUID())
  const [owner] = await db.insert(users).values({
    email: `task-unified-${marker}@example.invalid`, name: '统一任务验收用户',
    role: '系统管理员', department: '验收部', passwordHash,
  }).$returningId()
  let projectId = ''
  let templateDirectory = ''
  try {
    const projectName = `统一任务验收项目-${marker}`
    const [project] = await db.insert(projects).values({
      name: projectName, owner: '统一任务验收用户', ownerUserId: owner.id,
      createdBy: owner.id, collaborators: [],
    }).$returningId()
    projectId = project.id
    const [conversation] = await db.insert(chatConversations).values({
      userId: owner.id, projectId: project.id, projectName,
      title: '六类统一任务验收', scope: 'project', agentId: `task-unified-${marker}`, messages: [],
    }).$returningId()
    templateDirectory = path.resolve(process.cwd(), 'server', 'ai-template-data', owner.id, project.id, marker)
    await mkdir(templateDirectory, { recursive: true })
    const templatePath = path.join(templateDirectory, 'template.docx')
    const templateBytes = Buffer.from(`unified-template-${marker}`)
    await writeFile(templatePath, templateBytes)
    const templateDigest = createHash('sha256').update(templateBytes).digest('hex')
    const [customTemplate] = await db.insert(aiCustomTemplates).values({
      userId: owner.id, projectId: project.id, conversationId: conversation.id,
      originalFileName: '统一任务验收模板.docx', format: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileSize: templateBytes.length, sha256: templateDigest, storagePath: templatePath,
      analysis: {
        schemaVersion: '1.0', analysisVersion: `sha256-${templateDigest.slice(0, 12)}`,
        format: 'docx', fileName: '统一任务验收模板.docx',
        formatProfile: {
          fonts: ['Songti SC'], primaryFont: 'Songti SC', headingFont: 'Heiti SC',
          titleSizePt: 18, headingSizePt: 14, bodySizePt: 10.5,
          lineSpacing: '1.5', paragraphSpacing: '6pt', alignment: ['left'],
          pageSize: 'A4', margins: '2.54cm', orientation: 'portrait', colors: ['#000000'],
          header: '', footer: '', hasPageNumbers: true, tableCount: 0, imageCount: 0,
        },
        structures: [{
          order: 1, title: '项目分析', level: 1, contentPurpose: '形成投资判断',
          contentSummary: '统一任务验收', contentRequirements: ['引用项目证据'],
        }],
        summary: '统一任务验收模板',
      },
      skillName: 'template-driven-editable-ppt', skillPath: '/managed/by/runtime',
      skillVersion: 'unified-acceptance-v1', status: 'succeeded',
    }).$returningId()

    await stopAiTaskWorker()
    const sourceCutoffDate = '2026-08-09'
    const taskInputs: Array<{ type: AiExecutableTaskType; parameters: Record<string, unknown> }> = [
      { type: 'compliance_statement', parameters: { sourceCutoffDate, outputFormat: 'DOCX' } },
      {
        type: 'investment_proposal',
        parameters: { sourceCutoffDate, outputFormat: 'DOCX', audience: '内部立项', length: '标准版' },
      },
      {
        type: 'investment_recommendation_ppt',
        parameters: { sourceCutoffDate, outputFormat: 'PPTX', language: '中文', structureMode: 'standard' },
      },
      {
        type: 'due_diligence_report',
        parameters: { sourceCutoffDate, outputFormat: 'DOCX', diligenceScope: '商业尽调' },
      },
      { type: 'project_qa', parameters: { sourceCutoffDate, outputFormat: 'DOCX' } },
      {
        type: 'custom_template_document',
        parameters: { sourceCutoffDate, outputFormat: 'DOCX', customTemplateId: customTemplate.id },
      },
    ]
    const created = []
    for (const [index, input] of taskInputs.entries()) {
      const task = await createAiTask(
        { uid: owner.id, name: '统一任务验收用户', role: '系统管理员' },
        {
          type: input.type, projectId: project.id, conversationId: conversation.id,
          parameters: input.parameters, idempotencyKey: `unified-${index}-${marker}`,
        },
      )
      if (!task) throw new Error(`unified task was not created: ${input.type}`)
      created.push(task)
    }

    const expectedTypes = [...AI_TASK_TYPES, 'custom_template_document']
    const catalogTypes = listAiTaskTypes().map((item) => item.type)
    const stored = await db.select().from(aiTasks).where(inArray(aiTasks.id, created.map((task) => task.id)))
    const customTask = stored.find((task) => task.type === 'custom_template_document')
    const registrationFailures = [
      JSON.stringify(catalogTypes) === JSON.stringify(expectedTypes) ? '' : 'catalog-types',
      stored.length === expectedTypes.length ? '' : `stored-count:${stored.length}`,
      ...expectedTypes
        .filter((type) => !stored.some((task) => task.type === type && task.status === 'pending'))
        .map((type) => `pending:${type}`),
      ...AI_TASK_TYPES
        .filter((type) => !stored.some((task) => (
          task.type === type && task.templateVersion === AI_TEMPLATE_CATALOG[type].templateVersion
        )))
        .map((type) => `template-version:${type}`),
      customTask?.parameters.customTemplateId === customTemplate.id ? '' : 'custom-template-id',
      /^.+\+sha256-[a-f0-9]{12}$/.test(customTask?.templateVersion ?? '') ? '' : 'custom-analysis-version',
      customTask?.templateVersion !== 'unified-acceptance-v1' ? '' : 'custom-stored-skill-version',
    ].filter(Boolean)
    if (registrationFailures.length) {
      throw new Error(`six task types are not uniformly registered and persisted: ${registrationFailures.join(', ')}`)
    }

    const expiredLeaseAt = new Date(Date.now() - 60_000)
    await db.update(aiTasks).set({
      status: 'running',
      stage: '统一 Worker 中断验收',
      progress: 37,
      leaseOwner: `dead-worker-${marker}`,
      leaseExpiresAt: expiredLeaseAt,
      updatedAt: new Date(),
    }).where(inArray(aiTasks.id, created.map((task) => task.id)))
    const [interruptedTemplatePreparation] = await db.insert(aiTasks).values({
      userId: owner.id,
      projectId: project.id,
      conversationId: conversation.id,
      type: 'investment_recommendation_ppt',
      parameters: { _templatePreparationPending: true },
      templateVersion: '模板上传与预检',
      status: 'running',
      stage: '模板分析中',
      progress: 5,
      idempotencyKey: `unified-template-preparation-${marker}`,
      leaseOwner: `dead-worker-${marker}`,
      leaseExpiresAt: expiredLeaseAt,
    }).$returningId()
    const recovery = await recoverAiTasks({
      schedule: false,
      taskIds: [...created.map((task) => task.id), interruptedTemplatePreparation.id],
    })
    const recovered = await db.select().from(aiTasks)
      .where(inArray(aiTasks.id, created.map((task) => task.id)))
    const [failedTemplatePreparation] = await db.select().from(aiTasks)
      .where(eq(aiTasks.id, interruptedTemplatePreparation.id))
      .limit(1)
    if (
      recovery.found !== expectedTypes.length + 1
      || recovery.recovered !== expectedTypes.length
      || recovery.templateFailed !== 1
      || recovery.cancelled !== 0
      || expectedTypes.some((type) => !recovered.some((task) => (
        task.type === type
        && task.status === 'pending'
        && task.stage === '等待恢复'
        && task.progress === 37
        && !task.leaseOwner
        && !task.leaseExpiresAt
      )))
      || failedTemplatePreparation?.status !== 'failed'
      || failedTemplatePreparation.errorCode !== 'TEMPLATE_REUPLOAD_REQUIRED'
      || failedTemplatePreparation.retryable !== false
      || failedTemplatePreparation.leaseOwner
      || failedTemplatePreparation.leaseExpiresAt
    ) throw new Error('six task types did not recover or fail explicitly after worker interruption')

    const [taskServiceSource, routeSource] = await Promise.all([
      readFile(path.resolve(process.cwd(), 'server/src/services/aiTaskService.ts'), 'utf8'),
      readFile(path.resolve(process.cwd(), 'server/src/routes/aiTasks.ts'), 'utf8'),
    ])
    for (const type of expectedTypes) {
      if (!routeSource.includes(`'${type}'`) || !taskServiceSource.includes(`'${type}'`)) {
        throw new Error(`route/worker source is missing unified task type ${type}`)
      }
    }
    for (const executionContract of [
      'composeComplianceStatement',
      'investmentProposalRuntime',
      'runDirectInvestmentCommitteePptAgent',
      'generateDueDiligenceReportWithSkill',
      'generateProjectQaWithSkill',
      'resolveAiCustomTemplateForTask',
    ]) {
      if (!taskServiceSource.includes(executionContract)) {
        throw new Error(`unified worker execution contract is missing ${executionContract}`)
      }
    }
    if (!taskServiceSource.includes('claimAiTaskForExecution') || !taskServiceSource.includes('scheduleTask(task.id)')) {
      throw new Error('six task types do not share the MySQL lease/scheduler entry')
    }

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'six-task-types-listed-by-one-catalog',
        'six-task-types-accepted-by-one-api-route',
        'six-task-types-created-by-one-service-entry',
        'six-task-types-persisted-in-one-ai-tasks-table',
        'five-built-in-tasks-use-registered-template-versions',
        'custom-template-task-uses-current-project-conversation-template',
        'six-task-types-share-one-mysql-lease-worker',
        'six-task-types-recover-after-expired-worker-lease',
        'unsafe-template-preparation-interruption-fails-explicitly',
        'compliance-execution-branch-bound',
        'investment-proposal-execution-branch-bound',
        'investment-ppt-execution-branch-bound',
        'due-diligence-execution-branch-bound',
        'project-qa-execution-branch-bound',
        'custom-template-execution-branch-bound',
      ],
    }))
  } finally {
    await db.delete(auditLogs).where(eq(auditLogs.userId, owner.id)).catch(() => {})
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {})
    await db.delete(users).where(eq(users.id, owner.id)).catch(() => {})
    if (templateDirectory) await rm(templateDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

await main().finally(async () => pool.end())
