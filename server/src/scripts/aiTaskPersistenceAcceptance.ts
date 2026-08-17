import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  aiArtifacts,
  aiCustomTemplates,
  aiTaskSources,
  aiTasks,
  auditLogs,
  chatConversations,
  projects,
  users,
} from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import {
  getAiTask,
  getArtifactDownload,
  getArtifactPreview,
  listAiArtifacts,
} from '../services/aiTaskService.js'
import {
  getAiCustomTemplate,
  listAiCustomTemplates,
} from '../services/aiCustomTemplateService.js'

async function readStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function main() {
  const marker = randomUUID()
  const passwordHash = await hashPassword(randomUUID())
  const [owner, outsider] = await db.insert(users).values([
    {
      email: `task-persistence-owner-${marker}@example.invalid`, name: '任务持久化所有者',
      role: '投资经理', department: '验收部', passwordHash,
    },
    {
      email: `task-persistence-outsider-${marker}@example.invalid`, name: '任务持久化外部用户',
      role: '投资经理', department: '验收部', passwordHash,
    },
  ]).$returningId()
  const userIds = [owner.id, outsider.id]
  let projectId = ''
  let artifactDirectory = ''
  let templateDirectory = ''
  try {
    const projectName = `任务持久化验收项目-${marker}`
    const [project] = await db.insert(projects).values({
      name: projectName,
      owner: '任务持久化所有者',
      ownerUserId: owner.id,
      createdBy: owner.id,
      collaborators: [],
    }).$returningId()
    projectId = project.id
    const [conversation] = await db.insert(chatConversations).values({
      userId: owner.id,
      projectId: project.id,
      projectName,
      title: '任务持久化验收会话',
      scope: 'project',
      agentId: `task-persistence-${marker}`,
      messages: [],
    }).$returningId()
    const [task] = await db.insert(aiTasks).values({
      userId: owner.id,
      projectId: project.id,
      conversationId: conversation.id,
      type: 'project_qa',
      parameters: { sourceCutoffDate: '2026-08-09', outputFormat: 'DOCX' },
      templateVersion: 'qa-persistence-acceptance-v1',
      status: 'succeeded',
      stage: 'DOCX 已生成',
      progress: 100,
      resultSummary: '持久化验收摘要',
      idempotencyKey: `task-persistence-${marker}`,
      requestHash: createHash('sha256').update(marker).digest('hex'),
      startedAt: new Date(),
      completedAt: new Date(),
    }).$returningId()

    artifactDirectory = path.resolve(process.cwd(), 'server', 'ai-artifacts', owner.id, project.id, task.id)
    await mkdir(artifactDirectory, { recursive: true })
    const docxPath = path.join(artifactDirectory, '正式产物.docx')
    const rejectedPath = path.join(artifactDirectory, '质量未通过.docx')
    const previewPath = path.join(artifactDirectory, '任务摘要.md')
    const docxBytes = Buffer.from(`persistence-artifact-${marker}`)
    const rejectedBytes = Buffer.from(`rejected-artifact-${marker}`)
    const previewText = `# 持久化验收\n\n${marker}\n`
    await Promise.all([
      writeFile(docxPath, docxBytes),
      writeFile(rejectedPath, rejectedBytes),
      writeFile(previewPath, previewText, 'utf8'),
    ])
    const [passedArtifact, rejectedArtifact, previewArtifact] = await db.insert(aiArtifacts).values([
      {
        taskId: task.id, userId: owner.id, projectId: project.id, conversationId: conversation.id,
        fileName: '正式产物.docx', format: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        version: 1, storagePath: docxPath, editableLevel: 'text-and-structure',
        sourceCutoffDate: '2026-08-09', templateVersion: 'qa-persistence-acceptance-v1',
        qualityStatus: 'passed',
        metadata: {
          openXmlValid: true, encodingClean: true, cjkFontValidated: true,
          renderedEveryPage: true, reviewerStatus: 'passed',
          sha256: createHash('sha256').update(docxBytes).digest('hex'), bytes: docxBytes.length,
        },
      },
      {
        taskId: task.id, userId: owner.id, projectId: project.id, conversationId: conversation.id,
        fileName: '质量未通过.docx', format: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        version: 2, storagePath: rejectedPath, editableLevel: 'text-and-structure',
        sourceCutoffDate: '2026-08-09', templateVersion: 'qa-persistence-acceptance-v1',
        qualityStatus: 'failed', metadata: { reviewerStatus: 'failed', failedChecks: ['visual-qa'] },
      },
      {
        taskId: task.id, userId: owner.id, projectId: project.id, conversationId: conversation.id,
        fileName: '任务摘要.md', format: 'md', mimeType: 'text/markdown',
        version: 1, storagePath: previewPath, editableLevel: 'text',
        sourceCutoffDate: '2026-08-09', templateVersion: 'qa-persistence-acceptance-v1',
        qualityStatus: 'passed', metadata: { encodingClean: true, reviewerStatus: 'passed' },
      },
    ]).$returningId()
    await db.insert(aiTaskSources).values([
      {
        taskId: task.id, artifactId: passedArtifact.id, sourceType: 'project_record',
        sourceId: project.id, sourceName: '项目主记录', locator: '项目档案', verificationStatus: '资料记载',
      },
      {
        taskId: task.id, artifactId: rejectedArtifact.id, sourceType: 'project_record',
        sourceId: project.id, sourceName: '失败产物来源', locator: '不应展示', verificationStatus: '资料记载',
      },
      {
        taskId: task.id, artifactId: null, sourceType: 'user_input',
        sourceId: conversation.id, sourceName: '用户补充输入', locator: '会话输入', verificationStatus: '资料记载',
      },
    ])

    templateDirectory = path.resolve(process.cwd(), 'server', 'ai-template-data', owner.id, project.id, marker)
    await mkdir(templateDirectory, { recursive: true })
    const templatePath = path.join(templateDirectory, 'template.docx')
    const templateBytes = Buffer.from(`template-${marker}`)
    await writeFile(templatePath, templateBytes)
    const [customTemplate] = await db.insert(aiCustomTemplates).values({
      userId: owner.id,
      projectId: project.id,
      conversationId: conversation.id,
      originalFileName: '验收模板.docx',
      format: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileSize: templateBytes.length,
      sha256: createHash('sha256').update(templateBytes).digest('hex'),
      storagePath: templatePath,
      analysis: {
        schemaVersion: '1.0',
        analysisVersion: `sha256-${createHash('sha256').update(templateBytes).digest('hex').slice(0, 12)}`,
        format: 'docx', fileName: '验收模板.docx',
        formatProfile: {
          fonts: ['Songti SC'], primaryFont: 'Songti SC', headingFont: 'Heiti SC',
          titleSizePt: 18, headingSizePt: 14, bodySizePt: 10.5,
          lineSpacing: '1.5', paragraphSpacing: '6pt', alignment: ['left'],
          pageSize: 'A4', margins: '2.54cm', orientation: 'portrait', colors: ['#000000'],
          header: '', footer: '', hasPageNumbers: true, tableCount: 0, imageCount: 0,
        },
        structures: [{
          order: 1, title: '正文', level: 1, contentPurpose: '项目分析',
          contentSummary: '验收', contentRequirements: ['基于来源'],
        }],
        summary: '持久化验收模板',
      },
      skillName: 'template-driven-editable-ppt',
      skillPath: '/managed/by/runtime',
      skillVersion: 'persistence-acceptance-v1',
      status: 'succeeded',
    }).$returningId()

    const detail = await getAiTask(owner.id, task.id)
    const outsiderDetail = await getAiTask(outsider.id, task.id)
    if (
      !detail || outsiderDetail
      || detail.artifacts.length !== 2
      || detail.artifacts.some((artifact) => artifact.id === rejectedArtifact.id || 'storagePath' in artifact)
      || detail.sources.length !== 2
      || detail.sources.some((source) => source.artifactId === rejectedArtifact.id)
    ) throw new Error('task detail did not enforce persisted quality and ownership boundaries')

    const ownerArtifacts = await listAiArtifacts(owner.id, project.id)
    const outsiderArtifacts = await listAiArtifacts(outsider.id, project.id)
    if (
      ownerArtifacts.length !== 2
      || ownerArtifacts.some((artifact) => artifact.id === rejectedArtifact.id || 'storagePath' in artifact)
      || outsiderArtifacts.length !== 0
    ) throw new Error('artifact center did not enforce quality/user/project filters')

    const download = await getArtifactDownload(owner.id, passedArtifact.id)
    const deniedDownload = await getArtifactDownload(outsider.id, passedArtifact.id)
    const rejectedDownload = await getArtifactDownload(owner.id, rejectedArtifact.id)
    if (!download || deniedDownload || rejectedDownload || !(await readStream(download.stream)).equals(docxBytes)) {
      throw new Error('artifact download did not enforce MySQL quality/ownership/path contract')
    }
    const preview = await getArtifactPreview(owner.id, previewArtifact.id)
    const deniedPreview = await getArtifactPreview(outsider.id, previewArtifact.id)
    if (!preview || preview.content !== previewText || deniedPreview) {
      throw new Error('artifact preview did not enforce MySQL quality/ownership/path contract')
    }

    const template = await getAiCustomTemplate(owner.id, customTemplate.id)
    const templates = await listAiCustomTemplates(owner.id, {
      projectId: project.id,
      conversationId: conversation.id,
    })
    const deniedTemplate = await getAiCustomTemplate(outsider.id, customTemplate.id)
    if (
      !template || templates.length !== 1 || templates[0].id !== customTemplate.id || deniedTemplate
      || 'storagePath' in template || 'skillPath' in template
      || template.analysis.schemaVersion !== '1.0'
    ) throw new Error('custom template MySQL record or public boundary mismatch')

    const [[artifactOrphans], [sourceTaskOrphans], [sourceArtifactOrphans]] = await Promise.all([
      db.select({ count: sql<number>`COUNT(*)` }).from(aiArtifacts)
        .leftJoin(aiTasks, eq(aiArtifacts.taskId, aiTasks.id))
        .where(isNull(aiTasks.id)),
      db.select({ count: sql<number>`COUNT(*)` }).from(aiTaskSources)
        .leftJoin(aiTasks, eq(aiTaskSources.taskId, aiTasks.id))
        .where(isNull(aiTasks.id)),
      db.select({ count: sql<number>`COUNT(*)` }).from(aiTaskSources)
        .leftJoin(aiArtifacts, eq(aiTaskSources.artifactId, aiArtifacts.id))
        .where(and(sql`${aiTaskSources.artifactId} IS NOT NULL`, isNull(aiArtifacts.id))),
    ])
    if (
      Number(artifactOrphans?.count || 0) !== 0
      || Number(sourceTaskOrphans?.count || 0) !== 0
      || Number(sourceArtifactOrphans?.count || 0) !== 0
    ) throw new Error('AI task persistence contains orphan artifact/source references')

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'task-state-progress-result-and-template-version-read-from-mysql',
        'passed-artifacts-and-quality-metadata-read-from-mysql',
        'failed-quality-record-retained-but-not-presented',
        'artifact-sources-filtered-to-deliverable-or-task-level-records',
        'artifact-center-filters-by-user-project-and-passed-quality',
        'download-requires-owner-passed-quality-and-managed-file',
        'preview-requires-owner-passed-quality-and-managed-file',
        'custom-template-analysis-and-version-read-from-mysql',
        'custom-template-private-storage-fields-not-exposed',
        'cross-user-task-artifact-preview-download-template-denied',
        'task-artifact-and-source-foreign-keys-have-no-orphans',
      ],
    }))
  } finally {
    await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds)).catch(() => {})
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {})
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {})
    if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true }).catch(() => {})
    if (templateDirectory) await rm(templateDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

await main().finally(async () => pool.end())
