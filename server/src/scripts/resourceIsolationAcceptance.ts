import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { aiArtifacts, aiTasks, authSessions, auditLogs, knowledgeChunks, meetings, projectFiles, projectFileVersions, projects, risks, todos, users } from '../db/schema.js'
import { createAuthSession, hashPassword } from '../services/authService.js'
import { createConversation } from '../services/conversationService.js'
import { saveProjectFile } from '../services/projectFileStorageService.js'
import { formatShanghaiDateTimeInput } from '../utils/shanghaiTime.js'

const baseUrl = process.env.RESOURCE_ACCEPTANCE_URL || 'http://127.0.0.1:3100'

function cookie(session: { sessionToken: string; csrfToken: string }) {
  return `cybernaut_session=${encodeURIComponent(session.sessionToken)}; cybernaut_csrf=${encodeURIComponent(session.csrfToken)}`
}

async function request(url: string, session?: { sessionToken: string; csrfToken: string }, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (session) {
    headers.set('Cookie', cookie(session))
    if (!['GET', 'HEAD'].includes(String(init.method || 'GET').toUpperCase())) {
      headers.set('X-CSRF-Token', session.csrfToken)
    }
  }
  return fetch(`${baseUrl}${url}`, { ...init, headers })
}

function expectStatus(response: Response, expected: number, label: string) {
  if (response.status !== expected) throw new Error(`${label}: expected HTTP ${expected}, got ${response.status}`)
}

async function expectDeniedWithRequestId(response: Response, expected: number, label: string) {
  expectStatus(response, expected, label)
  const headerId = response.headers.get('x-request-id')
  const body = await response.json() as { code?: string; message?: string; details?: unknown; requestId?: string }
  if (!headerId || body.requestId !== headerId || !body.code || !body.message || body.details !== null) {
    throw new Error(`${label}: denial response/request ID contract is invalid`)
  }
}

async function expectRejectedWithoutSecret(response: Response, expected: number, label: string, secret: string) {
  expectStatus(response, expected, label)
  const body = await response.text()
  if (body.includes(secret)) throw new Error(`${label}: protected file content was disclosed`)
}

async function expectNoSensitiveDisclosure(
  response: Response,
  expected: number,
  label: string,
  forbidden: Array<string | undefined>,
  expectedCode?: string,
) {
  expectStatus(response, expected, label)
  const bodyText = await response.text()
  const lowered = bodyText.toLowerCase()
  for (const value of forbidden) {
    const token = value?.trim()
    if (token && token.length >= 3 && lowered.includes(token.toLowerCase())) {
      throw new Error(`${label}: response disclosed forbidden marker`)
    }
  }
  const body = JSON.parse(bodyText) as { code?: string; message?: string; details?: unknown; requestId?: string }
  if (expectedCode && body.code !== expectedCode) throw new Error(`${label}: expected safe code ${expectedCode}, got ${String(body.code)}`)
  if (response.headers.get('x-request-id') !== body.requestId) throw new Error(`${label}: request ID contract is invalid`)
  return body
}

async function main() {
  const marker = randomUUID()
  const passwordHash = await hashPassword(`resource-${marker}`)
  const [owner] = await db.insert(users).values({
    email: `resource-owner-${marker}@example.invalid`, name: `资源所有者-${marker.slice(0, 8)}`,
    role: '投资经理', department: '验收部', passwordHash,
  }).$returningId()
  const [outsider] = await db.insert(users).values({
    email: `resource-outsider-${marker}@example.invalid`, name: `资源外部用户-${marker.slice(0, 8)}`,
    role: '投资经理', department: '验收部', passwordHash,
  }).$returningId()
  const [admin] = await db.insert(users).values({
    email: `resource-admin-${marker}@example.invalid`, name: `资源管理员-${marker.slice(0, 8)}`,
    role: '系统管理员', department: '验收部', passwordHash,
  }).$returningId()
  const userIds = [owner.id, outsider.id, admin.id]
  let projectIds: string[] = []
  let workspaceConversationDir = ''
  let outsiderWorkspaceConversationDir = ''
  let generatedOwnerDir = ''
  let generatedOutsiderDir = ''
  let artifactStoragePath = ''
  const projectFileRoot = path.resolve(process.env.PROJECT_FILE_ROOT || path.join(process.cwd(), 'server', 'project-files'))

  try {
    const [ownerProject] = await db.insert(projects).values({
      name: `隔离项目A-${marker}`, owner: `资源所有者-${marker.slice(0, 8)}`,
      collaborators: [], createdBy: owner.id,
    }).$returningId()
    const [outsiderProject] = await db.insert(projects).values({
      name: `隔离项目B-${marker}`, owner: `资源外部用户-${marker.slice(0, 8)}`,
      collaborators: [], createdBy: outsider.id,
    }).$returningId()
    projectIds = [ownerProject.id, outsiderProject.id]

    const [file] = await db.insert(projectFiles).values({
      projectId: ownerProject.id, name: `owner-${marker}.txt`, type: 'TXT', category: '项目资料',
      uploader: '资源所有者', parseStatus: '成功', visibility: '项目成员',
    }).$returningId()
    const storagePath = await saveProjectFile(ownerProject.id, file.id, Buffer.from(`project-secret-${marker}`))
    await db.update(projectFiles).set({ storagePath }).where(eq(projectFiles.id, file.id))
    const [outsiderFile] = await db.insert(projectFiles).values({
      projectId: outsiderProject.id, name: `outsider-${marker}.txt`, type: 'TXT', category: '项目资料',
      uploader: '资源外部用户', parseStatus: '成功', visibility: '项目成员',
    }).$returningId()
    const outsiderStoragePath = await saveProjectFile(outsiderProject.id, outsiderFile.id, Buffer.from(`outsider-project-secret-${marker}`))
    await db.update(projectFiles).set({ storagePath: outsiderStoragePath }).where(eq(projectFiles.id, outsiderFile.id))
    const disclosureMarker = `internal-prompt-${marker}`
    const [invalidPathFile] = await db.insert(projectFiles).values({
      projectId: ownerProject.id, name: `disclosure-${marker}.txt`, type: 'TXT', category: '项目资料',
      uploader: '资源所有者', parseStatus: '成功', visibility: '项目成员',
      storagePath: `/private/${disclosureMarker}/system-prompt.txt`,
    }).$returningId()

    const conversation = await createConversation(owner.id, { title: '资源隔离验收', scope: 'global' })
    const artifactRoot = path.resolve(process.env.AI_ARTIFACT_ROOT || path.join(process.cwd(), 'server', 'ai-artifacts'))
    artifactStoragePath = path.resolve(artifactRoot, owner.id, `${marker}.md`)
    const artifactPayload = `ai-artifact-secret-${marker}`
    await mkdir(path.dirname(artifactStoragePath), { recursive: true })
    await writeFile(artifactStoragePath, artifactPayload)
    const [aiTask] = await db.insert(aiTasks).values({
      userId: owner.id, projectId: ownerProject.id, conversationId: conversation.id,
      type: 'compliance_statement', parameters: {}, templateVersion: 'security-acceptance-v1',
      status: 'succeeded', stage: '完成', progress: 100,
      idempotencyKey: `security-artifact-${marker}`, completedAt: new Date(),
    }).$returningId()
    const [aiArtifact] = await db.insert(aiArtifacts).values({
      taskId: aiTask.id, userId: owner.id, projectId: ownerProject.id, conversationId: conversation.id,
      fileName: `security-artifact-${marker}.md`, format: 'md', mimeType: 'text/markdown',
      storagePath: artifactStoragePath, templateVersion: 'security-acceptance-v1', qualityStatus: 'passed',
    }).$returningId()
    const configuredWorkspace = path.resolve(process.env.AGENT_WORKSPACE ?? '/data/cybernaut-assistant/workspace')
    const workspaceRoot = process.env.NODE_ENV !== 'production' && !existsSync(configuredWorkspace)
      ? path.resolve(process.cwd(), 'server/workspace')
      : configuredWorkspace
    workspaceConversationDir = path.resolve(workspaceRoot, conversation.id)
    const artifactName = `artifact-${marker}.md`
    await mkdir(workspaceConversationDir, { recursive: true })
    await writeFile(path.resolve(workspaceConversationDir, artifactName), `workspace-secret-${marker}`)
    const outsiderConversation = await createConversation(outsider.id, { title: '外部资源隔离验收', scope: 'global' })
    outsiderWorkspaceConversationDir = path.resolve(workspaceRoot, outsiderConversation.id)
    const outsiderArtifact = path.resolve(outsiderWorkspaceConversationDir, `outsider-${marker}.md`)
    await mkdir(outsiderWorkspaceConversationDir, { recursive: true })
    await writeFile(outsiderArtifact, `outsider-workspace-secret-${marker}`)
    const workspaceSymlinkName = `linked-${marker}.md`
    await symlink(outsiderArtifact, path.resolve(workspaceConversationDir, workspaceSymlinkName))

    generatedOwnerDir = path.resolve(process.cwd(), 'server/generated', owner.id)
    const generatedName = `generated-${marker}.txt`
    await mkdir(generatedOwnerDir, { recursive: true })
    await writeFile(path.resolve(generatedOwnerDir, generatedName), `generated-secret-${marker}`)
    generatedOutsiderDir = path.resolve(process.cwd(), 'server/generated', outsider.id)
    const outsiderGeneratedName = `outsider-generated-${marker}.txt`
    await mkdir(generatedOutsiderDir, { recursive: true })
    await writeFile(path.resolve(generatedOutsiderDir, outsiderGeneratedName), `outsider-generated-secret-${marker}`)
    const generatedSymlinkName = `linked-generated-${marker}.txt`
    await symlink(path.resolve(generatedOutsiderDir, outsiderGeneratedName), path.resolve(generatedOwnerDir, generatedSymlinkName))

    const ownerSession = await createAuthSession({ userId: owner.id })
    const outsiderSession = await createAuthSession({ userId: outsider.id })
    const adminSession = await createAuthSession({ userId: admin.id })

    expectStatus(await request(`/api/projects/${ownerProject.id}`, ownerSession), 200, 'owner project read')
    await expectDeniedWithRequestId(await request(`/api/projects/${ownerProject.id}`, outsiderSession), 403, 'cross-user project read')

    const ownerListResponse = await request('/api/projects?page=1&pageSize=100', ownerSession)
    expectStatus(ownerListResponse, 200, 'owner project list')
    const ownerList = await ownerListResponse.json() as { list: Array<{ id: string }> }
    if (!ownerList.list.some((item) => item.id === ownerProject.id) || ownerList.list.some((item) => item.id === outsiderProject.id)) {
      throw new Error('project list isolation failed')
    }

    const sqlInjectionPayload = `' OR 1=1 -- ${marker}`
    const keywordInjectionResponse = await request(
      `/api/projects?keyword=${encodeURIComponent(sqlInjectionPayload)}&page=1&pageSize=100`,
      ownerSession,
    )
    expectStatus(keywordInjectionResponse, 200, 'project keyword SQL injection rejection')
    const keywordInjectionResult = await keywordInjectionResponse.json() as { list: Array<{ id: string }>; total?: number }
    if (keywordInjectionResult.list.length !== 0 || keywordInjectionResult.total !== 0) {
      throw new Error('project keyword SQL injection changed query semantics')
    }
    const ownerInjectionResponse = await request(
      `/api/projects?owner=${encodeURIComponent(sqlInjectionPayload)}&page=1&pageSize=100`,
      adminSession,
    )
    expectStatus(ownerInjectionResponse, 200, 'project owner SQL injection rejection')
    const ownerInjectionResult = await ownerInjectionResponse.json() as { list: Array<{ id: string }>; total?: number }
    if (ownerInjectionResult.list.length !== 0 || ownerInjectionResult.total !== 0) {
      throw new Error('project owner SQL injection changed query semantics')
    }
    await expectDeniedWithRequestId(
      await request(`/api/projects/${encodeURIComponent(`${ownerProject.id}' OR '1'='1`)}`, ownerSession),
      403,
      'project route SQL injection rejection',
    )
    const projectsAfterInjection = await db.select({ id: projects.id, name: projects.name })
      .from(projects).where(inArray(projects.id, projectIds))
    if (
      projectsAfterInjection.length !== 2
      || projectsAfterInjection.find((item) => item.id === ownerProject.id)?.name !== `隔离项目A-${marker}`
      || projectsAfterInjection.find((item) => item.id === outsiderProject.id)?.name !== `隔离项目B-${marker}`
    ) throw new Error('SQL injection probes changed project data')

    const databaseFailureResponse = await request(`/api/projects/${ownerProject.id}`, ownerSession, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${disclosureMarker}-${'x'.repeat(300)}` }),
    })
    const databaseFailureBody = await expectNoSensitiveDisclosure(
      databaseFailureResponse,
      500,
      'database error disclosure rejection',
      [disclosureMarker, 'ER_DATA_TOO_LONG', 'Data too long', process.env.DB_DATABASE, process.env.DB_HOST, process.env.DB_FREFIX],
      'INTERNAL_ERROR',
    )
    if (databaseFailureBody.message !== '服务器内部错误' || databaseFailureBody.details !== null) {
      throw new Error('database error response is not generic')
    }
    const [projectAfterDatabaseFailure] = await db.select({ name: projects.name }).from(projects)
      .where(eq(projects.id, ownerProject.id)).limit(1)
    if (projectAfterDatabaseFailure?.name !== `隔离项目A-${marker}`) throw new Error('failed database write changed project data')

    await expectNoSensitiveDisclosure(
      await request('/api/projects', ownerSession, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: `{"name":"${disclosureMarker}","systemPrompt":"${process.cwd()} SELECT * FROM secret`,
      }),
      400,
      'malformed JSON disclosure rejection',
      [disclosureMarker, process.cwd(), 'SELECT * FROM secret', process.env.DB_DATABASE, process.env.DB_HOST],
      'BAD_BODY',
    )

    const fileFailureBody = await expectNoSensitiveDisclosure(
      await request(`/api/projects/files/${invalidPathFile.id}/download`, ownerSession),
      500,
      'filesystem error disclosure rejection',
      [disclosureMarker, '/private/', process.cwd(), projectFileRoot, 'INVALID_STORAGE_PATH'],
      'INTERNAL_ERROR',
    )
    if (fileFailureBody.message !== '服务器内部错误' || fileFailureBody.details !== null) {
      throw new Error('filesystem error response is not generic')
    }

    expectStatus(await request(`/api/projects/${ownerProject.id}/files`, outsiderSession), 403, 'cross-user file list')
    const uploadedPayload = Buffer.from(`uploaded-project-secret-${marker}`)
    const uploadResponse = await request('/api/projects/files/upload', ownerSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: ownerProject.id, name: `uploaded-${marker}.txt`, type: 'text/plain',
        category: '项目资料', uploader: '资源所有者', dataBase64: uploadedPayload.toString('base64'),
      }),
    })
    expectStatus(uploadResponse, 201, 'validated project-file upload')
    const uploadedSha = createHash('sha256').update(uploadedPayload).digest('hex')
    const uploaded = await uploadResponse.json() as {
      file: { id: string; hasOriginal?: boolean; byteSize?: number; sha256?: string; version?: number };
      ingest?: { async?: boolean };
    }
    if (
      !uploaded.file.hasOriginal || !uploaded.ingest?.async || uploaded.file.byteSize !== uploadedPayload.length
      || uploaded.file.sha256 !== uploadedSha || uploaded.file.version !== 1
    ) throw new Error('validated upload integrity contract mismatch')
    const uploadedDownload = await request(`/api/projects/files/${uploaded.file.id}/download`, ownerSession)
    expectStatus(uploadedDownload, 200, 'uploaded project-file download')
    const projectDownloadRequestId = uploadedDownload.headers.get('x-request-id')
    if (!Buffer.from(await uploadedDownload.arrayBuffer()).equals(uploadedPayload)) throw new Error('uploaded project-file payload mismatch')
    expectStatus(await request(`/api/projects/files/${uploaded.file.id}/download`, outsiderSession), 403, 'uploaded project-file cross-user download')
    const expiringDownloadSession = await createAuthSession({ userId: owner.id })
    expectStatus(
      await request(`/api/projects/files/${uploaded.file.id}/download`, expiringDownloadSession),
      200,
      'project-file download before session expiry',
    )
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(authSessions.id, expiringDownloadSession.id))
    expectStatus(
      await request(`/api/projects/files/${uploaded.file.id}/download`, expiringDownloadSession),
      401,
      'project-file download after session expiry',
    )
    expectStatus(await request('/api/projects/files/upload', ownerSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: ownerProject.id, name: `duplicate-content-${marker}.txt`, type: 'text/plain',
        category: '项目资料', uploader: '资源所有者', dataBase64: uploadedPayload.toString('base64'),
      }),
    }), 409, 'duplicate project-file content rejection')

    const replacementPayload = Buffer.from(`replacement-project-secret-${marker}`)
    const replacementSha = createHash('sha256').update(replacementPayload).digest('hex')
    const replacementResponse = await request(`/api/projects/files/${uploaded.file.id}/content`, ownerSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `uploaded-${marker}.txt`, type: 'text/plain', dataBase64: replacementPayload.toString('base64'),
      }),
    })
    expectStatus(replacementResponse, 200, 'project-file version replacement')
    const replacement = await replacementResponse.json() as { file: { version?: number; byteSize?: number; sha256?: string } }
    if (replacement.file.version !== 2 || replacement.file.byteSize !== replacementPayload.length || replacement.file.sha256 !== replacementSha) {
      throw new Error('project-file replacement metadata mismatch')
    }
    const currentDownload = await request(`/api/projects/files/${uploaded.file.id}/download`, ownerSession)
    expectStatus(currentDownload, 200, 'current project-file version download')
    if (!Buffer.from(await currentDownload.arrayBuffer()).equals(replacementPayload)) throw new Error('current project-file version mismatch')
    const previewResponse = await request(`/api/projects/files/${uploaded.file.id}/preview`, ownerSession)
    expectStatus(previewResponse, 200, 'project-file authorized preview')
    if (
      !Buffer.from(await previewResponse.arrayBuffer()).equals(replacementPayload)
      || previewResponse.headers.get('x-content-type-options') !== 'nosniff'
      || !previewResponse.headers.get('content-security-policy')?.includes('sandbox')
    ) throw new Error('project-file preview security/payload mismatch')
    expectStatus(await request(`/api/projects/files/${uploaded.file.id}/preview`, outsiderSession), 403, 'project-file preview cross-user rejection')
    const versionsResponse = await request(`/api/projects/files/${uploaded.file.id}/versions`, ownerSession)
    expectStatus(versionsResponse, 200, 'project-file version list')
    const versions = await versionsResponse.json() as { currentVersion: number; list: Array<{ version: number; sha256: string }> }
    if (versions.currentVersion !== 2 || versions.list.length !== 2 || versions.list[0]?.sha256 !== replacementSha || versions.list[1]?.sha256 !== uploadedSha) {
      throw new Error('project-file version list mismatch')
    }
    const firstVersionDownload = await request(`/api/projects/files/${uploaded.file.id}/versions/1/download`, ownerSession)
    expectStatus(firstVersionDownload, 200, 'historical project-file version download')
    if (!Buffer.from(await firstVersionDownload.arrayBuffer()).equals(uploadedPayload)) throw new Error('historical project-file version mismatch')
    expectStatus(await request(`/api/projects/files/${uploaded.file.id}/versions/1/download`, outsiderSession), 403, 'historical project-file cross-user download')
    expectStatus(await request('/api/projects/files/upload', ownerSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: ownerProject.id, name: `forged-${marker}.pdf`, type: 'application/pdf',
        category: '项目资料', uploader: '资源所有者', dataBase64: Buffer.from('not-a-pdf').toString('base64'),
      }),
    }), 415, 'forged project-file rejection')
    const ownerDownload = await request(`/api/projects/files/${file.id}/download`, ownerSession)
    expectStatus(ownerDownload, 200, 'owner file download')
    if ((await ownerDownload.text()) !== `project-secret-${marker}`) throw new Error('owner file payload mismatch')
    expectStatus(await request(`/api/projects/files/${file.id}/download`, outsiderSession), 403, 'cross-user file download')
    await rm(path.resolve(projectFileRoot, storagePath), { force: true })
    await symlink(path.resolve(projectFileRoot, outsiderStoragePath), path.resolve(projectFileRoot, storagePath))
    expectStatus(await request(`/api/projects/files/${file.id}/download`, ownerSession), 404, 'project-file symlink escape')

    expectStatus(await request(`/api/projects/${ownerProject.id}`, outsiderSession, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: 'unauthorized' }),
    }), 403, 'cross-user project mutation')

    expectStatus(await request('/api/ai/chat', outsiderSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '读取项目知识', projectName: '项目A', projectId: ownerProject.id, scope: 'project' }),
    }), 403, 'cross-user knowledge read')

    const ownerArtifactsResponse = await request('/api/workspace/artifacts', ownerSession)
    expectStatus(ownerArtifactsResponse, 200, 'owner workspace artifacts')
    const ownerArtifacts = await ownerArtifactsResponse.json() as { entries: Array<{ path: string }> }
    const artifactPath = `${conversation.id}/${artifactName}`
    if (!ownerArtifacts.entries.some((entry) => entry.path === artifactPath)) throw new Error('owner workspace artifact missing')
    const outsiderArtifactsResponse = await request('/api/workspace/artifacts', outsiderSession)
    expectStatus(outsiderArtifactsResponse, 200, 'outsider workspace artifacts')
    const outsiderArtifacts = await outsiderArtifactsResponse.json() as { entries: Array<{ path: string }> }
    if (outsiderArtifacts.entries.some((entry) => entry.path === artifactPath)) throw new Error('workspace artifact leaked in list')
    const ownerWorkspaceDownload = await request(
      `/api/workspace/file?path=${encodeURIComponent(artifactPath)}&download=1`, ownerSession,
    )
    expectStatus(ownerWorkspaceDownload, 200, 'owner workspace file download')
    const workspaceDownloadRequestId = ownerWorkspaceDownload.headers.get('x-request-id')
    if ((await ownerWorkspaceDownload.text()) !== `workspace-secret-${marker}`) throw new Error('workspace file payload mismatch')
    expectStatus(await request(`/api/workspace/file?path=${encodeURIComponent(artifactPath)}`, outsiderSession), 404, 'cross-user workspace file')
    expectStatus(await request(`/api/workspace/file?path=${encodeURIComponent(`${conversation.id}/${workspaceSymlinkName}`)}`, ownerSession), 404, 'workspace symlink escape')
    expectStatus(await request('/api/workspace/file?path=../package.json', ownerSession), 404, 'workspace traversal escape')
    await expectRejectedWithoutSecret(
      await request(`/api/workspace/file?path=${encodeURIComponent('/etc/passwd')}`, ownerSession),
      404,
      'workspace absolute-path arbitrary read rejection',
      'root:',
    )
    await expectRejectedWithoutSecret(
      await request('/api/workspace/file?path=%252e%252e%252fpackage.json', ownerSession),
      404,
      'workspace double-encoded traversal rejection',
      '"scripts"',
    )

    const ownerGenerated = await request(`/api/generated/${encodeURIComponent(generatedName)}`, ownerSession)
    expectStatus(ownerGenerated, 200, 'owner generated file')
    const generatedReadRequestId = ownerGenerated.headers.get('x-request-id')
    if ((await ownerGenerated.text()) !== `generated-secret-${marker}`) throw new Error('generated file payload mismatch')
    const aiArtifactDownload = await request(`/api/ai/artifacts/${aiArtifact.id}/download`, ownerSession)
    expectStatus(aiArtifactDownload, 200, 'owner AI artifact download')
    const aiArtifactDownloadRequestId = aiArtifactDownload.headers.get('x-request-id')
    if ((await aiArtifactDownload.text()) !== artifactPayload) throw new Error('AI artifact download payload mismatch')
    expectStatus(
      await request(`/api/ai/artifacts/${aiArtifact.id}/download`, outsiderSession), 404,
      'cross-user AI artifact download',
    )
    const protectedReadAudits = await db.select({
      action: auditLogs.action, target: auditLogs.target, result: auditLogs.result, requestId: auditLogs.requestId,
    }).from(auditLogs).where(and(
      eq(auditLogs.userId, owner.id),
      inArray(auditLogs.action, [
        '下载项目资料', '预览项目资料', '下载项目资料历史版本', '下载AI产物', '下载Agent产物', '读取生成产物',
      ]),
    ))
    const byRequestId = new Map(protectedReadAudits.map((row) => [row.requestId, row]))
    for (const [requestId, action] of [
      [projectDownloadRequestId, '下载项目资料'],
      [aiArtifactDownloadRequestId, '下载AI产物'],
      [workspaceDownloadRequestId, '下载Agent产物'],
      [generatedReadRequestId, '读取生成产物'],
    ] as const) {
      const row = requestId ? byRequestId.get(requestId) : undefined
      if (!row || row.action !== action || row.result !== 'success') {
        throw new Error(`${action} access audit/request ID contract mismatch`)
      }
    }
    const protectedTargets = protectedReadAudits.map((row) => row.target).join('\n')
    if (
      !protectedReadAudits.some((row) => row.action === '预览项目资料')
      || !protectedReadAudits.some((row) => row.action === '下载项目资料历史版本')
      || protectedTargets.includes(artifactName)
      || protectedTargets.includes(generatedName)
      || protectedTargets.includes('server/workspace')
    ) throw new Error('protected file access audit coverage or path-redaction contract mismatch')
    expectStatus(await request(`/api/generated/${encodeURIComponent(generatedName)}`, outsiderSession), 404, 'cross-user generated file')
    expectStatus(await request(`/api/generated/${encodeURIComponent(generatedSymlinkName)}`, ownerSession), 404, 'generated symlink escape')
    await expectRejectedWithoutSecret(
      await request(`/api/generated/${encodeURIComponent(`../${outsider.id}/${outsiderGeneratedName}`)}`, ownerSession),
      400,
      'generated traversal arbitrary read rejection',
      `outsider-generated-secret-${marker}`,
    )
    await expectRejectedWithoutSecret(
      await request(`/api/generated/${encodeURIComponent('/etc/passwd')}`, ownerSession),
      400,
      'generated absolute-path arbitrary read rejection',
      'root:',
    )
    expectStatus(await request(`/api/generated/${encodeURIComponent(generatedName)}`), 401, 'anonymous protected generated file')
    expectStatus(await request(`/generated/${encodeURIComponent(generatedName)}`), 404, 'legacy public generated file')

    const meetingCreate = await request('/api/meetings', ownerSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: ownerProject.id, projectName: `隔离项目A-${marker}`, title: `隔离会议-${marker}`,
        meetingTime: formatShanghaiDateTimeInput(new Date()), participants: [`资源所有者-${marker.slice(0, 8)}`], newTodos: [],
      }),
    })
    expectStatus(meetingCreate, 201, 'owner meeting create')
    const meeting = await meetingCreate.json() as { id: string }
    const meetingRequestId = meetingCreate.headers.get('x-request-id')
    const [meetingAudit] = await db.select({
      userId: auditLogs.userId, userName: auditLogs.userName, target: auditLogs.target,
      result: auditLogs.result, requestId: auditLogs.requestId, createdAt: auditLogs.createdAt,
    }).from(auditLogs).where(and(
      eq(auditLogs.userId, owner.id),
      eq(auditLogs.target, `隔离会议-${marker}`),
    )).limit(1)
    if (
      !meetingRequestId || !meetingAudit
      || meetingAudit.userId !== owner.id
      || meetingAudit.userName !== `资源所有者-${marker.slice(0, 8)}`
      || meetingAudit.target !== `隔离会议-${marker}`
      || meetingAudit.result !== 'success'
      || meetingAudit.requestId !== meetingRequestId
      || !(meetingAudit.createdAt instanceof Date)
    ) throw new Error('high-risk audit actor/time/target/result/request ID contract mismatch')
    expectStatus(await request('/api/meetings', outsiderSession), 200, 'outsider meeting list')
    const outsiderMeetingList = await (await request('/api/meetings', outsiderSession)).json() as { list: Array<{ id: string }> }
    if (outsiderMeetingList.list.some((item) => item.id === meeting.id)) throw new Error('meeting leaked in list')
    await expectDeniedWithRequestId(await request(`/api/meetings/${meeting.id}`, outsiderSession), 404, 'cross-user meeting read')
    await expectDeniedWithRequestId(await request(`/api/meetings/${meeting.id}`, outsiderSession, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'unauthorized' }),
    }), 404, 'cross-user meeting mutation')
    await expectDeniedWithRequestId(await request('/api/meetings', outsiderSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: ownerProject.id, projectName: '项目A', title: 'unauthorized',
        meetingTime: new Date().toISOString(), participants: ['外部用户'], newTodos: [],
      }),
    }), 403, 'cross-user meeting create')

    const todoCreate = await request('/api/todos', ownerSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: ownerProject.id, projectName: '项目A', title: `隔离待办-${marker}`, owner: `资源所有者-${marker.slice(0, 8)}` }),
    })
    expectStatus(todoCreate, 201, 'owner todo create')
    const todo = await todoCreate.json() as { id: string }
    const outsiderTodoList = await (await request('/api/todos', outsiderSession)).json() as { list: Array<{ id: string }> }
    if (outsiderTodoList.list.some((item) => item.id === todo.id)) throw new Error('todo leaked in list')
    await expectDeniedWithRequestId(await request(`/api/todos/${todo.id}`, outsiderSession, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: '已完成' }),
    }), 404, 'cross-user todo mutation')
    await expectDeniedWithRequestId(await request(`/api/todos/${todo.id}`, outsiderSession, { method: 'DELETE' }), 404, 'cross-user todo delete')

    const riskCreate = await request('/api/risks', ownerSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: ownerProject.id, projectName: '项目A', type: '合规',
        description: `隔离风险-${marker}`, owner: `资源所有者-${marker.slice(0, 8)}`,
        occurredAt: new Date().toISOString().slice(0, 10),
      }),
    })
    expectStatus(riskCreate, 201, 'owner risk create')
    const risk = await riskCreate.json() as { id: string }
    const outsiderRiskList = await (await request('/api/risks', outsiderSession)).json() as { list: Array<{ id: string }> }
    if (outsiderRiskList.list.some((item) => item.id === risk.id)) throw new Error('risk leaked in list')
    await expectDeniedWithRequestId(await request(`/api/risks/${risk.id}`, outsiderSession, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: '已解除' }),
    }), 404, 'cross-user risk mutation')

    const summaryCreate = await request('/api/ai-summaries', ownerSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: ownerProject.id, positioning: `隔离摘要-${marker}`, confidence: 50 }),
    })
    expectStatus(summaryCreate, 200, 'owner summary create')
    const outsiderSummaryList = await (await request('/api/ai-summaries', outsiderSession)).json() as { list: Array<{ projectId: string }> }
    if (outsiderSummaryList.list.some((item) => item.projectId === ownerProject.id)) throw new Error('AI summary leaked in list')
    expectStatus(await request(`/api/projects/${ownerProject.id}/ai-summary`, outsiderSession), 403, 'cross-user summary read')
    expectStatus(await request('/api/ai-summaries', outsiderSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: ownerProject.id, positioning: 'unauthorized' }),
    }), 403, 'cross-user summary mutation')

    await expectDeniedWithRequestId(await request('/api/users', ownerSession), 403, 'non-admin user directory')
    await expectDeniedWithRequestId(await request('/api/audit-logs', ownerSession), 403, 'non-admin audit logs')
    expectStatus(await request('/api/users', adminSession), 200, 'admin user directory')
    expectStatus(await request('/api/audit-logs', adminSession), 200, 'admin audit logs')

    const [protectedAudit] = await db.select({
      id: auditLogs.id, userId: auditLogs.userId, userName: auditLogs.userName,
      module: auditLogs.module, action: auditLogs.action, target: auditLogs.target, createdAt: auditLogs.createdAt,
    }).from(auditLogs).where(eq(auditLogs.userId, owner.id)).limit(1)
    if (!protectedAudit) throw new Error('resource acceptance audit fixture is missing')
    expectStatus(await request('/api/audit-logs', ownerSession, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'forged', target: marker }),
    }), 404, 'audit-log create mutation rejection')
    expectStatus(await request(`/api/audit-logs/${protectedAudit.id}`, ownerSession, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'forged', target: marker }),
    }), 404, 'audit-log update mutation rejection')
    expectStatus(await request(`/api/audit-logs/${protectedAudit.id}`, ownerSession, {
      method: 'DELETE',
    }), 404, 'audit-log delete mutation rejection')
    expectStatus(await request(`/api/audit-logs/${protectedAudit.id}`, adminSession, {
      method: 'DELETE',
    }), 404, 'admin audit-log delete mutation rejection')
    const [auditAfterMutationAttempts] = await db.select({
      id: auditLogs.id, userId: auditLogs.userId, userName: auditLogs.userName,
      module: auditLogs.module, action: auditLogs.action, target: auditLogs.target, createdAt: auditLogs.createdAt,
    }).from(auditLogs).where(eq(auditLogs.id, protectedAudit.id)).limit(1)
    if (!auditAfterMutationAttempts || JSON.stringify(auditAfterMutationAttempts) !== JSON.stringify(protectedAudit)) {
      throw new Error('audit log changed after HTTP mutation attempts')
    }

    await new Promise((resolve) => setTimeout(resolve, 200))
    const storedRevisions = await db.select({ storagePath: projectFileVersions.storagePath })
      .from(projectFileVersions).where(eq(projectFileVersions.fileId, uploaded.file.id))
    if (storedRevisions.length !== 2) throw new Error('project-file database version count mismatch before delete')
    expectStatus(await request(`/api/projects/files/${uploaded.file.id}`, ownerSession, { method: 'DELETE' }), 200, 'project-file delete with history')
    const remainingVersions = await db.select({ id: projectFileVersions.id }).from(projectFileVersions)
      .where(eq(projectFileVersions.fileId, uploaded.file.id))
    if (remainingVersions.length || storedRevisions.some((row) => existsSync(path.resolve(projectFileRoot, row.storagePath)))) {
      throw new Error('project-file delete left version metadata or original bytes')
    }
    expectStatus(await request(`/api/projects/files/${uploaded.file.id}/download`, ownerSession), 404, 'deleted project-file download')

    await new Promise((resolve) => setTimeout(resolve, 500))
    await db.delete(knowledgeChunks).where(inArray(knowledgeChunks.refId, projectIds))
    const remainingAcceptanceChunks = await db.select({ id: knowledgeChunks.id }).from(knowledgeChunks)
      .where(inArray(knowledgeChunks.refId, projectIds))
    if (remainingAcceptanceChunks.length) throw new Error('resource acceptance left knowledge chunks behind')

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'project-list-scope', 'project-read-scope', 'project-mutation-scope',
        'project-keyword-sql-injection-rejection', 'project-owner-sql-injection-rejection',
        'project-route-sql-injection-rejection', 'sql-injection-data-integrity',
        'database-error-response-disclosure-rejection', 'database-failed-write-rollback',
        'malformed-json-response-disclosure-rejection', 'filesystem-error-response-disclosure-rejection',
        'project-file-list-scope', 'project-file-validated-upload', 'project-file-upload-download-roundtrip',
        'project-file-upload-integrity-metadata', 'project-file-upload-cross-user-rejection', 'project-file-duplicate-content-rejection',
        'project-file-expired-session-download-rejection',
        'project-file-version-replacement', 'project-file-version-list', 'project-file-version-download',
        'project-file-version-cross-user-rejection', 'project-file-authorized-preview', 'project-file-preview-cross-user-rejection',
        'project-file-delete-history', 'project-file-forged-content-rejection',
        'project-file-download-scope', 'project-file-symlink-rejection', 'project-knowledge-scope',
        'workspace-list-scope', 'workspace-direct-read-scope', 'workspace-traversal-rejection', 'workspace-symlink-rejection',
        'workspace-absolute-path-rejection', 'workspace-double-encoded-traversal-rejection',
        'generated-owner-read', 'generated-cross-user-rejection', 'generated-symlink-rejection',
        'generated-traversal-arbitrary-read-rejection', 'generated-absolute-path-rejection',
        'generated-anonymous-rejection', 'legacy-generated-rejection',
        'ai-artifact-owner-download-audit', 'ai-artifact-cross-user-download-rejection',
        'project-workspace-generated-access-audit-without-storage-path',
        'meeting-list-read-write-scope', 'todo-list-write-delete-scope', 'risk-list-write-scope',
        'high-risk-audit-actor-time-target-result-request-id',
        'ai-summary-list-read-write-scope', 'admin-directory-role-guard', 'admin-audit-role-guard',
        'audit-log-create-mutation-rejection', 'audit-log-update-mutation-rejection',
        'audit-log-delete-mutation-rejection', 'audit-log-admin-delete-rejection', 'audit-log-row-immutability',
        'denial-request-id-contract', 'acceptance-knowledge-fixture-cleanup',
      ],
    }))
  } finally {
    // File and meeting indexing intentionally runs after the HTTP response. Give
    // the tiny text fixtures time to settle, then remove their non-FK RAG rows.
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (projectIds.length) await db.delete(knowledgeChunks).where(inArray(knowledgeChunks.refId, projectIds)).catch(() => {})
    await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds)).catch(() => {})
    await db.delete(todos).where(inArray(todos.createdBy, userIds)).catch(() => {})
    await db.delete(meetings).where(inArray(meetings.createdBy, userIds)).catch(() => {})
    await db.delete(risks).where(inArray(risks.createdBy, userIds)).catch(() => {})
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)).catch(() => {})
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {})
    if (workspaceConversationDir) await rm(workspaceConversationDir, { recursive: true, force: true })
    if (outsiderWorkspaceConversationDir) await rm(outsiderWorkspaceConversationDir, { recursive: true, force: true })
    if (generatedOwnerDir) await rm(generatedOwnerDir, { recursive: true, force: true })
    if (generatedOutsiderDir) await rm(generatedOutsiderDir, { recursive: true, force: true })
    if (artifactStoragePath) await rm(path.dirname(artifactStoragePath), { recursive: true, force: true })
    for (const projectId of projectIds) await rm(path.resolve(projectFileRoot, projectId), { recursive: true, force: true })
  }
}

await main().finally(async () => pool.end())
