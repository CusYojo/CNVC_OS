import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

type Auth = { cookie: string; csrfToken: string }
type Fixture = { adminId: string; ordinaryUserId: string; email: string; password: string }
type State = {
  schemaVersion: '1.0'
  projectId: string
  projectName: string
  conversationId: string
  sourceDirectory: string
  uploaded: Array<{ id: string; name: string; sha256: string; parseStatus: string }>
}
type Task = {
  id: string
  type: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  errorId?: string | null
  errorMessage?: string | null
  retryable?: boolean | null
  conversationId?: string | null
  artifacts: Array<{ id: string; format: string; fileName: string; downloadUrl: string; metadata?: Record<string, unknown> }>
  sources: Array<{ sourceName: string }>
  complianceSupplement?: { snapshotId: string; missingItems: string[]; blockingIssues: string[] }
}

const apiBase = (process.env.DAYAN_AI_API_BASE || 'http://127.0.0.1:4100/api').replace(/\/$/, '')
const defaultSourceDirectory = 'C:\\Users\\21749\\Desktop\\大衍科技（txt版本）'
const secretFixturePath = path.resolve('.runtime/secrets/browser-ui-acceptance.json')
const resultDirectory = path.resolve('.runtime/acceptance/dayan-ai-skill-e2e')
const statePath = path.join(resultDirectory, 'state.json')
const importResultPath = path.join(resultDirectory, 'import-result.json')
const targetProjectId = process.env.DAYAN_TARGET_PROJECT_ID || 'fd52d39e-fb77-4e46-818e-cbdbdebd60c0'
const supportedSkills = [
  'free_chat',
  'generate-investment-compliance-note',
  'draft-investment-proposal',
  'investment-committee-ppt',
  'draft-due-diligence-report',
  'draft-investment-qa',
  'generate-document-from-template',
] as const

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function apiUrl(resource: string) {
  return `${apiBase}${resource.startsWith('/') ? resource : `/${resource}`}`
}

async function request<T>(resource: string, options: RequestInit = {}, auth?: Auth, expected = 200) {
  const method = (options.method || 'GET').toUpperCase()
  const response = await fetch(apiUrl(resource), {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth ? { Cookie: auth.cookie } : {}),
      ...(auth && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'X-CSRF-Token': auth.csrfToken } : {}),
      ...options.headers,
    },
  })
  const raw = await response.text()
  const data = raw ? JSON.parse(raw) as T : {} as T
  if (response.status !== expected) throw new Error(`${method} ${resource}: HTTP ${response.status} ${raw.slice(0, 500)}`)
  return data
}

async function login(as: 'user' | 'admin' = 'user') {
  const fixture = JSON.parse(await readFile(secretFixturePath, 'utf8')) as Fixture
  const marker = fixture.email.match(/^browser-admin-(.+)@example\.invalid$/)?.[1]
  if (!marker) throw new Error('浏览器验收夹具账号格式无效')
  const email = as === 'admin' ? fixture.email : `browser-user-${marker}@example.invalid`
  const password = as === 'admin' ? fixture.password : `Browser-U8!-${marker}`
  const response = await fetch(apiUrl('/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const raw = await response.text()
  if (response.status !== 200) throw new Error(`验收账号登录失败：HTTP ${response.status} ${raw.slice(0, 300)}`)
  const body = JSON.parse(raw) as { csrfToken: string; user: { name: string } }
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const setCookies = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') || '']
  const cookie = setCookies.flatMap((line) => line.match(/(?:^|,\s*)(cybernaut_(?:session|csrf)=[^;,]+)/g) ?? [])
    .map((entry) => entry.replace(/^,\s*/, '')).join('; ')
  if (!cookie.includes('cybernaut_session=') || !body.csrfToken) throw new Error('验收账号缺少会话 Cookie/CSRF')
  return { auth: { cookie, csrfToken: body.csrfToken }, uploader: body.user.name, ownerUserId: fixture.ordinaryUserId }
}

async function discoverProjects() {
  const views = []
  for (const as of ['user', 'admin'] as const) {
    const { auth } = await login(as)
    const response = await request<{ list: Array<{
      id: string
      name: string
      companyName: string
      classification: string
      lifecycle: string
      stage: string
      workflowModel: string
      memberRole?: string | null
    }>; total: number }>(`/projects?keyword=${encodeURIComponent('大衍')}&scope=all&page=1&pageSize=100`, {}, auth)
    views.push({ as, total: response.total, projects: response.list.map((project) => ({
      id: project.id,
      name: project.name,
      companyName: project.companyName,
      classification: project.classification,
      lifecycle: project.lifecycle,
      stage: project.stage,
      workflowModel: project.workflowModel,
      memberRole: project.memberRole ?? null,
    })) })
  }
  await mkdir(resultDirectory, { recursive: true })
  await writeFile(path.join(resultDirectory, 'project-discovery.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), views }, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ views }, null, 2)}\n`)
}

async function inspectProjectRecords() {
  const [{ db }, schema, drizzle] = await Promise.all([
    import('../db/client.js'),
    import('../db/schema.js'),
    import('drizzle-orm'),
  ])
  const matches = await db.select({
    id: schema.projects.id,
    name: schema.projects.name,
    companyName: schema.projects.companyName,
    classification: schema.projects.classification,
    lifecycle: schema.projects.lifecycle,
    stage: schema.projects.stage,
    workflowModel: schema.projects.workflowModel,
    ownerUserId: schema.projects.ownerUserId,
    createdBy: schema.projects.createdBy,
    createdAt: schema.projects.createdAt,
    updatedAt: schema.projects.updatedAt,
  }).from(schema.projects).where(drizzle.or(
    drizzle.like(schema.projects.name, '%大衍%'),
    drizzle.like(schema.projects.companyName, '%大衍%'),
  )).orderBy(drizzle.desc(schema.projects.createdAt))
  const records = []
  for (const project of matches) {
    const [files, members, materials] = await Promise.all([
      db.select({ id: schema.projectFiles.id, name: schema.projectFiles.name, parseStatus: schema.projectFiles.parseStatus, lifecycle: schema.projectFiles.lifecycle, uploadedAt: schema.projectFiles.uploadedAt })
        .from(schema.projectFiles).where(drizzle.eq(schema.projectFiles.projectId, project.id)),
      db.select({ userId: schema.projectMembers.userId, role: schema.projectMembers.memberRole, name: schema.users.name, email: schema.users.email })
        .from(schema.projectMembers).innerJoin(schema.users, drizzle.eq(schema.projectMembers.userId, schema.users.id))
        .where(drizzle.eq(schema.projectMembers.projectId, project.id)),
      db.select({ stage: schema.projectStageMaterials.stage, requirementKey: schema.projectStageMaterials.requirementKey, fileId: schema.projectStageMaterials.fileId, version: schema.projectStageMaterials.version })
        .from(schema.projectStageMaterials).where(drizzle.eq(schema.projectStageMaterials.projectId, project.id)),
    ])
    records.push({
      ...project,
      fileSummary: {
        total: files.length,
        active: files.filter((file) => file.lifecycle === 'active').length,
        succeeded: files.filter((file) => file.parseStatus === '成功').length,
        failed: files.filter((file) => file.parseStatus === '失败').length,
        newestUploadAt: files.map((file) => file.uploadedAt).filter(Boolean).sort().at(-1) ?? null,
      },
      files: files.map(({ id, name, parseStatus, lifecycle }) => ({ id, name, parseStatus, lifecycle })),
      members: members.map(({ userId, role, name, email }) => ({ userId, role, name, emailDomain: email.split('@')[1] ?? '' })),
      materials,
    })
  }
  await mkdir(resultDirectory, { recursive: true })
  await writeFile(path.join(resultDirectory, 'project-records.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ records }, null, 2)}\n`)
}

async function withProjectOwnerAuth<T>(projectId: string, action: (auth: Auth, ownerName: string) => Promise<T>) {
  const [{ db }, schema, { eq }, authService] = await Promise.all([
    import('../db/client.js'), import('../db/schema.js'), import('drizzle-orm'), import('../services/authService.js'),
  ])
  const [project] = await db.select({ ownerUserId: schema.projects.ownerUserId }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)
  if (!project?.ownerUserId) throw new Error('目标项目没有有效负责人')
  const [owner] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, project.ownerUserId)).limit(1)
  if (!owner) throw new Error('目标项目负责人账号不存在')
  const session = await authService.createAuthSession({ userId: project.ownerUserId, userAgent: 'dayan-ai-skill-e2e', ipAddress: '127.0.0.1' })
  try {
    return await action({ cookie: `cybernaut_session=${session.sessionToken}; cybernaut_csrf=${session.csrfToken}`, csrfToken: session.csrfToken }, owner.name)
  } finally {
    await authService.revokeAuthSession(session.id)
  }
}

async function syncTargetProject(sourceDirectory: string) {
  await mkdir(resultDirectory, { recursive: true })
  const result = await withProjectOwnerAuth(targetProjectId, async (auth, uploader) => {
    const project = await request<{ id: string; name: string; lifecycle: string; classification: string }>(`/projects/${targetProjectId}`, {}, auth)
    if (project.lifecycle !== 'active' || !['normal', 'key'].includes(project.classification)) throw new Error('目标必须是活动中的普通或重点项目')
    const existing = await request<{ list: Array<{ id: string; name: string; parseStatus: string; lifecycle: string }> }>(`/projects/${targetProjectId}/files`, {}, auth)
    const existingNames = new Set(existing.list.filter((file) => file.lifecycle === 'active').map((file) => file.name))
    const entries = (await readdir(sourceDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name !== '.DS_Store').sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    const uploaded: Array<{ id: string; name: string }> = []
    const skipped: Array<{ name: string; reason: string }> = []
    const failed: Array<{ name: string; error: string }> = []
    for (const entry of entries) {
      if (existingNames.has(entry.name)) { skipped.push({ name: entry.name, reason: '同名文件已存在' }); continue }
      const bytes = await readFile(path.join(sourceDirectory, entry.name))
      const response = await fetch(apiUrl('/projects/files/upload'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: auth.cookie, 'X-CSRF-Token': auth.csrfToken },
        body: JSON.stringify({ projectId: targetProjectId, name: entry.name, type: path.extname(entry.name).slice(1).toUpperCase() || 'FILE', category: '大衍科技尽调资料', uploader, visibility: '项目成员', dataBase64: bytes.toString('base64') }),
      })
      const body = await response.json() as { file?: { id: string }; code?: string; message?: string }
      if (response.status === 201 && body.file) uploaded.push({ id: body.file.id, name: entry.name })
      else if (response.status === 409 && ['DUPLICATE', 'DUPLICATE_CONTENT'].includes(body.code || '')) skipped.push({ name: entry.name, reason: body.code || 'DUPLICATE' })
      else failed.push({ name: entry.name, error: `${response.status} ${body.code || body.message || 'UPLOAD_FAILED'}` })
      process.stderr.write(`[dayan target] ${uploaded.length + skipped.length + failed.length}/${entries.length} ${entry.name}\n`)
    }
    const deadline = Date.now() + Number(process.env.DAYAN_PARSE_TIMEOUT_MS || 600_000)
    let terminal = new Map<string, { parseStatus: string; parseError?: string }>()
    while (uploaded.length && Date.now() < deadline) {
      const files = await request<{ list: Array<{ id: string; parseStatus: string; parseError?: string }> }>(`/projects/${targetProjectId}/files`, {}, auth)
      terminal = new Map(files.list.filter((file) => uploaded.some((item) => item.id === file.id)).map((file) => [file.id, file]))
      if (terminal.size === uploaded.length && [...terminal.values()].every((file) => ['成功', '失败'].includes(file.parseStatus))) break
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    const materialRule = (name: string): { stage: string; requirementKey: string } | null => {
      if (/财务尽职调查|求真专审|财务制度/.test(name)) return { stage: '启动尽调', requirementKey: 'financial_dd' }
      if (/工商材料|营业执照|公司章程|股东协议|增资协议|股权转让|竞业协议|保密管理/.test(name)) return { stage: '启动尽调', requirementKey: 'legal_dd' }
      if (/访谈|花名册|采购|产品与技术|科研实力|杨林|刘岩鑫|王剑雄|董海巍|elsaddik|萨院士|白皮书/.test(name)) return { stage: '启动尽调', requirementKey: 'business_dd' }
      if (/交流纪要|交流笔记|CTO访谈会议纪要/.test(name)) return { stage: '立项', requirementKey: 'initial_meeting' }
      if (/项目介绍|科技介绍|空间智能解决方案|长期发展战略/.test(name)) return { stage: '立项', requirementKey: 'business_plan' }
      if (/尽调报告/.test(name)) return { stage: '内核', requirementKey: 'memo_draft' }
      if (/投资意向书/.test(name)) return { stage: '内核', requirementKey: 'loi_draft' }
      return null
    }
    const bindable = uploaded.filter((file) => terminal.get(file.id)?.parseStatus === '成功').map((file) => ({ ...file, target: materialRule(file.name) })).filter((file): file is typeof file & { target: { stage: string; requirementKey: string } } => Boolean(file.target))
    const bound: Array<{ fileId: string; name: string; stage: string; requirementKey: string }> = []
    const bindingFailed: Array<{ fileId: string; name: string; error: string }> = []
    for (const file of bindable) {
      try {
        await request(`/projects/${targetProjectId}/fde-materials`, { method: 'PUT', body: JSON.stringify({ ...file.target, fileId: file.id }) }, auth)
        bound.push({ fileId: file.id, name: file.name, ...file.target })
      } catch (error) {
        bindingFailed.push({ fileId: file.id, name: file.name, error: error instanceof Error ? error.message.slice(0, 300) : '材料绑定失败' })
      }
    }
    const conversation = await request<{ id: string }>('/conversations', { method: 'POST', body: JSON.stringify({ title: '大衍科技 AI 助手七项能力验收', scope: 'project', projectId: project.id, projectName: project.name }) }, auth, 201)
    const state: State = { schemaVersion: '1.0', projectId: project.id, projectName: project.name, conversationId: conversation.id, sourceDirectory, uploaded: [...existing.list.filter((file) => file.lifecycle === 'active').map((file) => ({ id: file.id, name: file.name, sha256: '', parseStatus: file.parseStatus })), ...uploaded.map((file) => ({ ...file, sha256: '', parseStatus: terminal.get(file.id)?.parseStatus || '解析中' }))] }
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return { generatedAt: new Date().toISOString(), projectId: project.id, projectName: project.name, sourceCount: entries.length, beforeCount: existing.list.length, uploaded: uploaded.map((file) => ({ ...file, parseStatus: terminal.get(file.id)?.parseStatus || '解析中' })), skipped, failed, bound, bindingFailed, conversationId: conversation.id }
  })
  await writeFile(path.join(resultDirectory, 'target-sync-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ projectId: result.projectId, beforeCount: result.beforeCount, uploaded: result.uploaded.length, skipped: result.skipped.length, failed: result.failed.length, parsed: result.uploaded.filter((file) => file.parseStatus === '成功').length, bound: result.bound.length, bindingFailed: result.bindingFailed.length }, null, 2)}\n`)
  if (result.failed.length || result.bindingFailed.length || result.uploaded.some((file) => file.parseStatus !== '成功')) process.exitCode = 1
}

function shanghaiDateKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

async function pollTask(auth: Auth, taskId: string) {
  const deadline = Date.now() + Number(process.env.DAYAN_TASK_TIMEOUT_MS || 7_200_000)
  while (Date.now() < deadline) {
    try {
      const task = await request<Task>(`/ai/tasks/${taskId}`, {}, auth)
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return task
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(message)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`AI 任务 ${taskId} 超时未进入终态`)
}

async function verifyArtifact(auth: Auth, artifact: Task['artifacts'][number]) {
  const response = await fetch(apiUrl(`/ai/artifacts/${artifact.id}/download`), { headers: { Cookie: auth.cookie } })
  const bytes = Buffer.from(await response.arrayBuffer())
  const result = { id: artifact.id, fileName: artifact.fileName, format: artifact.format, httpStatus: response.status, bytes: bytes.length, zipMagic: bytes.subarray(0, 2).toString('ascii') === 'PK', packageEntry: false }
  if (response.status === 200 && result.zipMagic && ['docx', 'pptx'].includes(artifact.format.toLowerCase())) {
    const zip = await JSZip.loadAsync(bytes)
    result.packageEntry = artifact.format.toLowerCase() === 'docx' ? Boolean(zip.file('word/document.xml')) : Boolean(zip.file('ppt/presentation.xml'))
  }
  return result
}

async function runDocumentSkills() {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as State
  if (state.projectId !== targetProjectId) throw new Error('状态文件未绑定真实大衍重点项目，请先执行 sync-target')
  const definitions = [
    { skillName: 'generate-investment-compliance-note', type: 'compliance_statement', parameters: { outputFormat: 'DOCX' } },
    { skillName: 'draft-investment-proposal', type: 'investment_proposal', parameters: { outputFormat: 'DOCX', userInstructions: '基于项目资料形成投资提案，所有缺失或冲突信息必须标记待核验。' } },
    { skillName: 'investment-committee-ppt', type: 'investment_recommendation_ppt', parameters: { outputFormat: 'PPTX', language: '中文', structureMode: 'standard' } },
    { skillName: 'draft-due-diligence-report', type: 'due_diligence_report', parameters: { outputFormat: 'DOCX', diligenceScope: '商业尽调' } },
    { skillName: 'draft-investment-qa', type: 'project_qa', parameters: { outputFormat: 'DOCX' } },
  ].filter((definition) => {
    const requested = (process.env.DAYAN_DOCUMENT_TYPES || '').split(',').map((item) => item.trim()).filter(Boolean)
    return requested.length === 0 || requested.includes(definition.type)
  })
  const results = await withProjectOwnerAuth(state.projectId, async (auth) => {
    const rows = []
    for (const definition of definitions) {
      const history = await request<{ list: Task[] }>(`/ai/tasks?projectId=${state.projectId}&limit=100`, {}, auth)
      const forceNew = process.env.DAYAN_FORCE_NEW_TASK === '1'
      const active = forceNew ? undefined
        : history.list.find((task) => task.type === definition.type && task.conversationId === state.conversationId && ['pending', 'running'].includes(task.status))
      const resumable = forceNew ? undefined
        : history.list.find((task) => task.type === definition.type && task.conversationId === state.conversationId && task.status === 'failed' && task.retryable)
      const created = active ?? (resumable
        ? await request<Task>(`/ai/tasks/${resumable.id}/retry`, { method: 'POST', body: JSON.stringify({ idempotencyKey: `dayan-retry-${definition.type}-${randomUUID()}` }) }, auth, 202)
        : await request<Task>('/ai/tasks', { method: 'POST', body: JSON.stringify({ type: definition.type, projectId: state.projectId, conversationId: state.conversationId, parameters: { ...definition.parameters, sourceCutoffDate: shanghaiDateKey() }, idempotencyKey: `dayan-${definition.type}-${randomUUID()}` }) }, auth, 202))
      let task = await pollTask(auth, created.id)
      if (definition.type === 'compliance_statement'
        && process.env.DAYAN_COMPLIANCE_CONTINUE_WITH_GAPS === '1'
        && task.status === 'failed' && task.complianceSupplement?.missingItems.length) {
        const continued = await request<Task>(`/ai/tasks/${task.id}/retry`, {
          method: 'POST', body: JSON.stringify({
            idempotencyKey: `dayan-consented-${definition.type}-${randomUUID()}`,
            complianceChoice: { action: 'continue_with_gaps', snapshotId: task.complianceSupplement.snapshotId },
          }),
        }, auth, 202)
        task = await pollTask(auth, continued.id)
      }
      const artifacts = []
      for (const artifact of task.artifacts || []) artifacts.push(await verifyArtifact(auth, artifact))
      rows.push({ skillName: definition.skillName, taskId: task.id, type: task.type, status: task.status, progress: task.progress, errorId: task.errorId ?? null, errorMessage: task.errorMessage ?? null, sourceCount: task.sources?.length ?? 0, sources: (task.sources || []).map((source) => source.sourceName), artifactCount: task.artifacts?.length ?? 0, artifacts })
      await writeFile(path.join(resultDirectory, 'skill-results.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), projectId: state.projectId, results: rows }, null, 2)}\n`, 'utf8')
      if (task.status !== 'succeeded') break
    }
    return rows
  })
  const closed = results.every((row) => row.status === 'succeeded' && row.sourceCount > 0 && row.artifactCount > 0 && row.artifacts.every((artifact) => artifact.httpStatus === 200 && artifact.bytes > 0 && artifact.zipMagic && artifact.packageEntry))
  process.stdout.write(`${JSON.stringify({ projectId: state.projectId, tested: results.length, closed, results: results.map(({ skillName, status, sourceCount, artifactCount, errorId }) => ({ skillName, status, sourceCount, artifactCount, errorId })) }, null, 2)}\n`)
  if (!closed) process.exitCode = 1
}

async function runTemplateSkill() {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as State
  if (state.projectId !== targetProjectId) throw new Error('状态文件未绑定真实大衍重点项目，请先执行 sync-target')
  const templatePath = path.resolve('server/workspace/.agents/skills/draft-investment-proposal/assets/primary-layout-authority.docx')
  const bytes = await readFile(templatePath)
  const result = await withProjectOwnerAuth(state.projectId, async (auth) => {
    const template = await request<{ id: string; originalFileName: string; format: string; status: string }>('/ai/templates/analyze', { method: 'POST', body: JSON.stringify({ projectId: state.projectId, conversationId: state.conversationId, name: path.basename(templatePath), dataBase64: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${bytes.toString('base64')}`, purpose: 'custom_template_document' }) }, auth, 201)
    const created = await request<Task>('/ai/tasks', { method: 'POST', body: JSON.stringify({ type: 'custom_template_document', projectId: state.projectId, conversationId: state.conversationId, parameters: { sourceCutoffDate: shanghaiDateKey(), outputFormat: 'DOCX', customTemplateId: template.id, customTemplateName: template.originalFileName }, idempotencyKey: `dayan-custom-template-${randomUUID()}` }) }, auth, 202)
    const task = await pollTask(auth, created.id)
    const artifacts = []
    for (const artifact of task.artifacts || []) artifacts.push(await verifyArtifact(auth, artifact))
    return { generatedAt: new Date().toISOString(), projectId: state.projectId, template: { id: template.id, fileName: template.originalFileName, format: template.format, status: template.status }, task: { id: task.id, status: task.status, progress: task.progress, errorId: task.errorId ?? null, errorMessage: task.errorMessage ?? null, sourceCount: task.sources?.length ?? 0, sources: (task.sources || []).map((source) => source.sourceName), artifacts } }
  })
  await writeFile(path.join(resultDirectory, 'template-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  const closed = result.task.status === 'succeeded' && result.task.sourceCount > 0 && result.task.artifacts.length > 0 && result.task.artifacts.every((artifact) => artifact.httpStatus === 200 && artifact.zipMagic && artifact.packageEntry)
  process.stdout.write(`${JSON.stringify({ projectId: result.projectId, status: result.task.status, sourceCount: result.task.sourceCount, artifactCount: result.task.artifacts.length, closed }, null, 2)}\n`)
  if (!closed) process.exitCode = 1
}

async function submitUploadedMaterials() {
  const sync = JSON.parse(await readFile(path.join(resultDirectory, 'target-sync-result.json'), 'utf8')) as {
    projectId: string
    uploaded: Array<{ id: string; name: string; parseStatus: string }>
  }
  if (sync.projectId !== targetProjectId) throw new Error('同步结果不属于真实大衍重点项目')
  const result = await withProjectOwnerAuth(sync.projectId, async (auth) => {
    const context = await request<{ canSubmit: boolean; projectVersion: number; governanceVersion: number; stage: string; recipients: Array<{ id: string; name: string }> }>(`/projects/${sync.projectId}/material-context`, {}, auth)
    if (!context.canSubmit || !context.recipients.length) throw new Error('当前项目没有合法材料送审人或接收人')
    const sent = await request<{ list: Array<{ file: { id: string } | null }>; total: number }>(`/projects/${sync.projectId}/material-submissions?view=sent&page=1&pageSize=50`, {}, auth)
    const alreadySubmitted = new Set(sent.list.map((item) => item.file?.id).filter((id): id is string => Boolean(id)))
    const files = await request<{ list: Array<{ id: string; name: string; version: number; accessVersion: number; hasOriginal: boolean }>; total: number }>(`/projects/${sync.projectId}/file-workspace?page=1&pageSize=50`, {}, auth)
    const byId = new Map(files.list.map((file) => [file.id, file]))
    const submitted: Array<{ id: string; fileId: string; name: string; recipientCount: number }> = []
    const skipped: Array<{ fileId: string; name: string; reason: string }> = []
    const failed: Array<{ fileId: string; name: string; error: string }> = []
    for (const uploaded of sync.uploaded.filter((file) => file.parseStatus === '成功')) {
      if (alreadySubmitted.has(uploaded.id)) { skipped.push({ fileId: uploaded.id, name: uploaded.name, reason: '已存在送审记录' }); continue }
      const file = byId.get(uploaded.id)
      if (!file?.hasOriginal) { failed.push({ fileId: uploaded.id, name: uploaded.name, error: '原始文件或版本信息不可用' }); continue }
      try {
        const created = await request<{ id: string }>(`/projects/${sync.projectId}/material-submissions`, { method: 'POST', body: JSON.stringify({ clientRequestId: randomUUID(), fileId: file.id, fileVersion: file.version, expectedAccessVersion: file.accessVersion, expectedProjectVersion: context.projectVersion, expectedGovernanceVersion: context.governanceVersion, title: `大衍科技补充资料：${file.name}`.slice(0, 100), note: `当前处于${context.stage}阶段并存在活动审批，本资料作为本轮新增补充材料送审，不直接改写冻结的阶段材料。`, recipientIds: context.recipients.map((person) => person.id) }) }, auth, 201)
        submitted.push({ id: created.id, fileId: file.id, name: file.name, recipientCount: context.recipients.length })
      } catch (error) {
        failed.push({ fileId: file.id, name: file.name, error: error instanceof Error ? error.message.slice(0, 400) : '送审失败' })
      }
    }
    return { generatedAt: new Date().toISOString(), projectId: sync.projectId, stage: context.stage, recipients: context.recipients, submitted, skipped, failed }
  })
  await writeFile(path.join(resultDirectory, 'material-submission-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ projectId: result.projectId, stage: result.stage, recipientCount: result.recipients.length, submitted: result.submitted.length, skipped: result.skipped.length, failed: result.failed.length }, null, 2)}\n`)
  if (result.failed.length) process.exitCode = 1
}

async function inspectConfiguredModels() {
  const [{ db }, schema, { eq }] = await Promise.all([import('../db/client.js'), import('../db/schema.js'), import('drizzle-orm')])
  const [providers, models, routes] = await Promise.all([
    db.select({ id: schema.aiModelProviders.id, name: schema.aiModelProviders.name, protocol: schema.aiModelProviders.protocol, enabled: schema.aiModelProviders.enabled, hasCredential: schema.aiModelProviders.credentialCiphertext, lastTestStatus: schema.aiModelProviders.lastTestStatus, lastTestError: schema.aiModelProviders.lastTestError, lastTestAt: schema.aiModelProviders.lastTestAt }).from(schema.aiModelProviders),
    db.select({ id: schema.aiModels.id, providerId: schema.aiModels.providerId, modelKey: schema.aiModels.modelKey, displayName: schema.aiModels.displayName, enabled: schema.aiModels.enabled, isDefault: schema.aiModels.isDefault }).from(schema.aiModels),
    db.select().from(schema.aiModelRoutes).where(eq(schema.aiModelRoutes.enabled, true)),
  ])
  const result = { providers: providers.map(({ hasCredential, lastTestError, ...provider }) => ({ ...provider, hasCredential: Boolean(hasCredential), lastTestError: lastTestError?.slice(0, 300) ?? null })), models, routes }
  await mkdir(resultDirectory, { recursive: true })
  await writeFile(path.join(resultDirectory, 'model-config.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}


async function inspectRecentTasks() {
  const [{ db }, schema, { desc, eq, inArray }] = await Promise.all([import('../db/client.js'), import('../db/schema.js'), import('drizzle-orm')])
  const tasks = await db.select({ id: schema.aiTasks.id, type: schema.aiTasks.type, status: schema.aiTasks.status, stage: schema.aiTasks.stage, progress: schema.aiTasks.progress, errorId: schema.aiTasks.errorId, errorCode: schema.aiTasks.errorCode, errorMessage: schema.aiTasks.errorMessage, retryable: schema.aiTasks.retryable, modelCalls: schema.aiTasks.modelCalls, idempotencyKey: schema.aiTasks.idempotencyKey, createdAt: schema.aiTasks.createdAt, updatedAt: schema.aiTasks.updatedAt }).from(schema.aiTasks).where(eq(schema.aiTasks.projectId, targetProjectId)).orderBy(desc(schema.aiTasks.createdAt)).limit(20)
  const ids = tasks.map((task) => task.id)
  const [sources, artifacts] = ids.length ? await Promise.all([
    db.select({ taskId: schema.aiTaskSources.taskId, id: schema.aiTaskSources.id }).from(schema.aiTaskSources).where(inArray(schema.aiTaskSources.taskId, ids)),
    db.select({ taskId: schema.aiArtifacts.taskId, id: schema.aiArtifacts.id, format: schema.aiArtifacts.format, fileName: schema.aiArtifacts.fileName }).from(schema.aiArtifacts).where(inArray(schema.aiArtifacts.taskId, ids)),
  ]) : [[], []]
  const result = tasks.map((task) => ({ ...task, errorMessage: task.errorMessage?.slice(0, 300) ?? null, sourceCount: sources.filter((source) => source.taskId === task.id).length, artifacts: artifacts.filter((artifact) => artifact.taskId === task.id).map(({ id, format, fileName }) => ({ id, format, fileName })) }))
  process.stdout.write(`${JSON.stringify({ tasks: result }, null, 2)}\n`)
}

async function cancelActiveDocumentTasks() {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as State
  const requestedTypes = new Set((process.env.DAYAN_CANCEL_TYPES || '').split(',').map((item) => item.trim()).filter(Boolean))
  const allProjectConversations = process.env.DAYAN_CANCEL_ALL_PROJECT_TASKS === '1'
  const cancelled = await withProjectOwnerAuth(state.projectId, async (auth) => {
    const history = await request<{ list: Task[] }>(`/ai/tasks?projectId=${state.projectId}&limit=100`, {}, auth)
    const active = history.list.filter((task) =>
      (allProjectConversations || task.conversationId === state.conversationId)
      && (requestedTypes.size === 0 || requestedTypes.has(task.type))
      && ['pending', 'running'].includes(task.status))
    const rows = []
    for (const task of active) {
      const result = await request<Task>(`/ai/tasks/${task.id}/cancel`, { method: 'POST', body: '{}' }, auth)
      rows.push({ id: result.id, type: result.type, status: result.status })
    }
    return rows
  })
  process.stdout.write(`${JSON.stringify({ projectId: state.projectId, cancelled }, null, 2)}\n`)
}

async function rollbackTargetSync() {
  const sync = JSON.parse(await readFile(path.join(resultDirectory, 'target-sync-result.json'), 'utf8')) as {
    projectId: string; uploaded: Array<{ id: string; name: string }>
  }
  if (sync.projectId !== targetProjectId) throw new Error('同步结果不属于当前目标项目，拒绝回滚')
  const uploadedIds = new Set(sync.uploaded.map((file) => file.id))
  const result = await withProjectOwnerAuth(sync.projectId, async (auth) => {
    const workflow = await request<{ materials: Array<{ id: string; fileId?: string | null; version: number }> }>(`/projects/${sync.projectId}/fde-workflow`, {}, auth)
    const removedBindings = []
    for (const binding of workflow.materials.filter((item) => item.fileId && uploadedIds.has(item.fileId))) {
      await request(`/projects/${sync.projectId}/fde-materials/${binding.id}?expectedVersion=${binding.version}`, { method: 'DELETE' }, auth)
      removedBindings.push(binding.id)
    }
    const recycled = []
    for (const file of sync.uploaded) {
      const detail = await request<{ file: { accessVersion: number; lifecycle: string } }>(`/projects/files/${file.id}/workspace`, {}, auth)
      if (detail.file.lifecycle !== 'active') continue
      await request(`/projects/files/${file.id}`, { method: 'DELETE', body: JSON.stringify({
        clientRequestId: randomUUID(), expectedVersion: detail.file.accessVersion,
        reason: '撤销误导入的桌面验收资料，仅保留项目原有资料。',
      }) }, auth)
      recycled.push({ id: file.id, name: file.name })
    }
    // The public file-list endpoint already excludes recycled records and does
    // not expose lifecycle on every response shape.
    const files = await request<{ list: Array<{ id: string; name: string; parseStatus: string }> }>(`/projects/${sync.projectId}/files`, {}, auth)
    return { removedBindings, recycled, active: files.list }
  })
  const state = JSON.parse(await readFile(statePath, 'utf8')) as State
  state.sourceDirectory = ''
  state.uploaded = result.active.map((file) => ({ id: file.id, name: file.name, sha256: '', parseStatus: file.parseStatus }))
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ projectId: sync.projectId, removedBindings: result.removedBindings.length, recycled: result.recycled.length, activeFiles: result.active.length }, null, 2)}\n`)
}

async function importData(sourceDirectory: string) {
  const { auth, uploader, ownerUserId: fixtureOwnerUserId } = await login()
  const roster = await request<{ people: Array<{ id: string; capabilities: { canOwn: boolean; canBoss: boolean; canProjectManager: boolean; canLegal: boolean; canFinance: boolean } }> }>('/projects/creation-roster', {}, auth)
  const ownerUserId = roster.people.find((person) => person.id === fixtureOwnerUserId && person.capabilities.canOwn)?.id
    ?? roster.people.find((person) => person.capabilities.canOwn)?.id
  if (!ownerUserId) throw new Error('项目创建名册中没有可用负责人')
  const dutyCapabilities = { boss: 'canBoss', project_manager: 'canProjectManager', legal: 'canLegal', finance: 'canFinance' } as const
  const assignments = Object.entries(dutyCapabilities).map(([duty, capability]) => {
    const userId = roster.people.find((person) => person.capabilities[capability])?.id
    if (!userId) throw new Error(`项目创建名册中没有可用职责：${duty}`)
    return { duty, userId }
  })
  const project = await request<{ id: string; name: string }>('/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: `大衍科技 AI Skill 验收-${new Date().toISOString().slice(0, 10)}`,
      companyName: '大衍科技（桐乡）有限公司', industry: '空间智能与人工智能', round: '待核验',
      stage: '尽调', owner: uploader, collaborators: [], source: '大衍科技专项验收',
      financing: '以导入资料为准', valuation: '待核验', riskLevel: '中',
      summary: '用于验证界面 AI 助手七项能力的专项项目。',
      businessModel: '以导入资料为准', market: '以导入资料为准', team: '以导入资料为准', tags: ['AI专项验收'],
      governance: {
        ownerUserId,
        assignments,
      },
    }),
  }, auth, 201)
  const conversation = await request<{ id: string }>('/conversations', {
    method: 'POST',
    body: JSON.stringify({ title: '大衍科技 AI 助手七项能力验收', scope: 'project', projectId: project.id, projectName: project.name }),
  }, auth, 201)
  await mkdir(resultDirectory, { recursive: true })
  const state: State = {
    schemaVersion: '1.0', projectId: project.id, projectName: project.name,
    conversationId: conversation.id, sourceDirectory, uploaded: [],
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  const entries = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== '.DS_Store')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const uploaded: State['uploaded'] = []
  for (const entry of entries) {
    const filePath = path.join(sourceDirectory, entry.name)
    const bytes = await readFile(filePath)
    const extension = path.extname(entry.name).slice(1).toUpperCase() || 'FILE'
    const response = await request<{ file: { id: string; parseStatus: string } }>('/projects/files/upload', {
      method: 'POST',
      body: JSON.stringify({
        projectId: project.id, name: entry.name, type: extension, category: '大衍科技尽调资料',
        uploader, visibility: '项目成员', dataBase64: bytes.toString('base64'),
      }),
    }, auth, 201)
    uploaded.push({ id: response.file.id, name: entry.name, sha256: createHash('sha256').update(bytes).digest('hex'), parseStatus: response.file.parseStatus })
    state.uploaded = uploaded
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    process.stderr.write(`[dayan import] ${uploaded.length}/${entries.length} ${entry.name}\n`)
  }
  await writeFile(importResultPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), projectId: project.id, projectName: project.name, sourceFileCount: entries.length, uploadedCount: uploaded.length, excluded: ['.DS_Store'], files: uploaded.map(({ name, sha256, parseStatus }) => ({ name, sha256, parseStatus })) }, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, phase: 'import', projectId: project.id, fileCount: uploaded.length })}\n`)
}

async function verifyImport() {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as State
  const { auth } = await login()
  const deadline = Date.now() + Number(process.env.DAYAN_PARSE_TIMEOUT_MS || 600_000)
  let list: Array<{ id: string; name: string; parseStatus: string; parseError?: string }> = []
  while (Date.now() < deadline) {
    const response = await request<{ list: typeof list }>(`/projects/${state.projectId}/files`, {}, auth)
    list = response.list.filter((file) => state.uploaded.some((item) => item.id === file.id))
    if (list.length === state.uploaded.length && list.every((file) => ['成功', '失败'].includes(file.parseStatus))) break
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  const pending = list.filter((file) => !['成功', '失败'].includes(file.parseStatus))
  const failed = list.filter((file) => file.parseStatus === '失败')
  const result = {
    generatedAt: new Date().toISOString(), projectId: state.projectId, expected: state.uploaded.length,
    observed: list.length, succeeded: list.filter((file) => file.parseStatus === '成功').length,
    failed: failed.map((file) => ({ name: file.name, error: file.parseError || '未提供错误摘要' })),
    pending: pending.map((file) => file.name), skillsPlanned: supportedSkills,
  }
  await writeFile(importResultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (pending.length || list.length !== state.uploaded.length) process.exitCode = 1
}

async function runFreeChat() {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as State
  if (state.projectId !== targetProjectId) throw new Error('状态文件未绑定真实大衍重点项目，请先执行 sync-target')
  const result = await withProjectOwnerAuth(state.projectId, async (auth) => {
    const conversation = await request<{ agentId: string; messages?: unknown[] }>(`/conversations/${state.conversationId}`, {}, auth)
    if (!conversation.agentId) throw new Error('项目会话未返回 Agent ID')
    const modelId = option('--model-id') || process.env.DAYAN_CHAT_MODEL_ID
    if (modelId) await request(`/agent/conversations/${encodeURIComponent(conversation.agentId)}/model`, { method: 'PATCH', body: JSON.stringify({ modelId }) }, auth)
    const before = await request<{ messages: unknown[] }>(`/agent/conversations/${encodeURIComponent(conversation.agentId)}`, {}, auth)
    await request(`/agent/conversations/${encodeURIComponent(conversation.agentId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: '请基于当前大衍科技项目资料，概括主营产品、核心团队与三项最需要核验的风险，并明确列出所依据的项目文件。不要使用项目外材料。' }),
    }, auth, 202)
    const deadline = Date.now() + Number(process.env.DAYAN_CHAT_TIMEOUT_MS || 900_000)
    let snapshot: { status: string; error: string | null; interaction: unknown; messages: unknown[] } | undefined
    while (Date.now() < deadline) {
      const current = await request<{ status: string; error: string | null; interaction: unknown; messages: unknown[] }>(`/agent/conversations/${encodeURIComponent(conversation.agentId)}`, {}, auth)
      snapshot = current
      if (current.interaction) throw new Error('自由对话出现待人工回答的问题，未形成自动闭环')
      if (current.status === 'error') break
      if (current.status === 'idle' && current.messages.length > before.messages.length) break
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    if (!snapshot || snapshot.status !== 'idle' || snapshot.messages.length <= before.messages.length) throw new Error(`自由对话未闭环：${snapshot?.status || 'timeout'} ${snapshot?.error || ''}`)
    const serialized = JSON.stringify(snapshot.messages.slice(before.messages.length))
    const citedFiles = state.uploaded.map((file) => file.name).filter((name) => serialized.includes(name))
    return { generatedAt: new Date().toISOString(), capability: 'free_chat', status: snapshot.status, newMessageCount: snapshot.messages.length - before.messages.length, citedFileCount: citedFiles.length, citedFiles, error: snapshot.error }
  })
  await writeFile(path.join(resultDirectory, 'free-chat-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.citedFiles.length) process.exitCode = 1
}

// 后续阶段使用同一状态文件执行 free_chat 与六项正式 Skill，避免重新导入资料。
// 固定能力清单：generate-investment-compliance-note / draft-investment-proposal /
// investment-committee-ppt / draft-due-diligence-report / draft-investment-qa /
// generate-document-from-template。每项必须记录来源、终态和可下载产物。
const phase = option('--phase') || 'import'
if (phase === 'import') await importData(option('--source') || defaultSourceDirectory)
else if (phase === 'verify-import') await verifyImport()
else if (phase === 'free-chat') await runFreeChat()
else if (phase === 'discover-projects') await discoverProjects()
else if (phase === 'inspect-project-records') await inspectProjectRecords()
else if (phase === 'sync-target') await syncTargetProject(option('--source') || defaultSourceDirectory)
else if (phase === 'document-skills') await runDocumentSkills()
else if (phase === 'template-skill') await runTemplateSkill()
else if (phase === 'submit-materials') await submitUploadedMaterials()
else if (phase === 'inspect-models') await inspectConfiguredModels()
else if (phase === 'inspect-tasks') await inspectRecentTasks()
else if (phase === 'cancel-active-document-tasks') await cancelActiveDocumentTasks()
else if (phase === 'rollback-target-sync') await rollbackTargetSync()
else throw new Error(`未知 phase：${phase}`)
