import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

type Check = { name: string; passed: boolean; detail: string }
type Task = {
  id: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  retryOfTaskId?: string | null
  artifacts: Array<{
    id: string
    format: string
    fileName: string
    downloadUrl: string
    metadata?: Record<string, unknown>
  }>
  sources: Array<{ sourceName: string }>
}
type ProjectQaAnswer = {
  id: string
  projectId: string
  conversationId: string
  category: string
  question: string
  directAnswer: string
  keyPoints: Array<{
    text: string
    status: string
    citations: string[]
  }>
  risksOrUncertainties: string[]
  verificationActions: string[]
  sources: Array<{
    id: string
    title: string
    locator: string
    versionOrDate?: string
  }>
  evidenceCount: number
  confidenceStatus: string
  disclaimer: string
  skillName: string
  skillVersion: string
  skillSha256: string
  templateVersion: string
  referenceTemplates: string[]
  sourceCutoffDate: string
  createdAt: string
}

const apiBase = (process.env.AI_ACCEPTANCE_API_BASE || 'http://127.0.0.1:3100/api').replace(/\/$/, '')
const apiOrigin = new URL(apiBase).origin
const databaseUrl = process.env.DATABASE_URL
const reportPath = process.env.AI_API_ACCEPTANCE_REPORT
const acceptanceScope = process.env.AI_ACCEPTANCE_SCOPE === 'qa'
  ? 'qa'
  : process.env.AI_ACCEPTANCE_SCOPE === 'compliance'
    ? 'compliance'
    : 'all'
const checks: Check[] = []

function apiUrl(resourcePath: string) {
  if (/^https?:\/\//.test(resourcePath)) return resourcePath
  return resourcePath.startsWith('/api/') ? `${apiOrigin}${resourcePath}` : `${apiBase}${resourcePath}`
}

function assert(name: string, condition: boolean, detail: string) {
  checks.push({ name, passed: condition, detail })
  if (!condition) throw new Error(`${name}：${detail}`)
}

async function outputReport(note: string) {
  const report = {
    generatedAt: new Date().toISOString(),
    apiBase,
    scope: acceptanceScope,
    passed: checks.every((check) => check.passed),
    checks,
    note,
  }
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
  expectedStatus = 200,
): Promise<{ data: T; response: Response }> {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const raw = await response.text()
  let data: T
  try {
    data = raw ? JSON.parse(raw) as T : {} as T
  } catch {
    data = raw as T
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${options.method || 'GET'} ${path} 预期 ${expectedStatus}，实际 ${response.status}：${raw.slice(0, 500)}`)
  }
  return { data, response }
}

async function login(email: string) {
  const { data } = await request<{ token: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: '123456' }),
  })
  return data.token
}

async function pollTask(token: string, taskId: string, timeoutMs = 30_000): Promise<Task> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { data } = await request<Task>(`/ai/tasks/${taskId}`, {}, token)
    if (['succeeded', 'failed', 'cancelled'].includes(data.status)) return data
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`任务 ${taskId} 在 ${timeoutMs}ms 内未进入终态`)
}

async function main() {
  const anonymousTaskTypes = await fetch(apiUrl('/ai/task-types'))
  assert('未登录用户不能读取任务配置', anonymousTaskTypes.status === 401, `HTTP ${anonymousTaskTypes.status}`)

  const adminToken = await login('admin@cybernaut.com')
  const userToken = await login('lin@cybernaut.com')
  const suffix = randomUUID().slice(0, 8)
  const cutoff = new Date().toISOString().slice(0, 10)

  const { data: skillCatalog } = await request<{
    list: Array<{ name: string; version: string; sha256: string }>
  }>('/ai/skills', {}, adminToken)
  assert('API 注册五个业务 Skill', skillCatalog.list.length === 5, `${skillCatalog.list.length} 个`)
  assert(
    'API Skill 版本可审计',
    skillCatalog.list.every((skill) =>
      /^sha256-[a-f0-9]{12}$/.test(skill.version) && /^[a-f0-9]{64}$/.test(skill.sha256)),
    skillCatalog.list.map((skill) => `${skill.name}:${skill.version}`).join(', '),
  )
  if (acceptanceScope === 'all') {
    const { data: taskTypes } = await request<{
      list: Array<{ type: string; skillName: string }>
    }>('/ai/task-types', {}, adminToken)
    assert(
      '四类文档任务配置均暴露 Skill 绑定',
      taskTypes.list.length === 4 && taskTypes.list.every((item) => Boolean(item.skillName)),
      taskTypes.list.map((item) => `${item.type}:${item.skillName}`).join(', '),
    )
  }

  const { data: project } = await request<{ id: string; name: string }>('/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: `AI API 验收项目-${suffix}`,
      companyName: '杭州脱敏验收科技有限公司',
      industry: '企业服务与人工智能',
      round: 'A轮',
      stage: '尽调',
      owner: '系统管理员',
      collaborators: [],
      source: '自动验收',
      financing: '金额及用途待正式交易文件核验',
      valuation: '待核验',
      riskLevel: '中',
      summary: '用于隔离测试环境的脱敏虚构项目。',
      businessModel: '软件订阅与实施服务，收入质量待核验。',
      market: '市场规模与竞争格局待第三方资料核验。',
      team: '团队履历待背调。',
      tags: ['自动验收'],
    }),
  }, adminToken, 201)
  assert('API 创建隔离验收项目', Boolean(project.id), project.id)

  const { data: conversation } = await request<{ id: string }>('/conversations', {
    method: 'POST',
    body: JSON.stringify({
      title: acceptanceScope === 'qa' ? 'AI-011 Q&A API 验收' : 'AI-007～AI-011 API 验收',
      scope: 'project',
      projectId: project.id,
      projectName: project.name,
    }),
  }, adminToken, 201)
  assert('API 创建项目会话', Boolean(conversation.id), conversation.id)

  if (acceptanceScope !== 'compliance') {
  const qaQuestion = '该项目当前最需要优先核验的核心风险是什么？'
  const { data: qaAnswer } = await request<ProjectQaAnswer>('/ai/qa', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      conversationId: conversation.id,
      category: '核心风险',
      question: qaQuestion,
      sourceCutoffDate: cutoff,
    }),
  }, adminToken, 201)
  assert(
    'AI-011 Q&A 返回持久化结构',
    qaAnswer.projectId === project.id
      && qaAnswer.conversationId === conversation.id
      && qaAnswer.category === '核心风险'
      && qaAnswer.question === qaQuestion
      && Boolean(qaAnswer.directAnswer)
      && Array.isArray(qaAnswer.keyPoints)
      && Array.isArray(qaAnswer.risksOrUncertainties)
      && Array.isArray(qaAnswer.verificationActions),
    `${qaAnswer.id} / ${qaAnswer.category}`,
  )
  assert(
    'AI-011 确定性记录 Q&A Skill 版本',
    qaAnswer.skillName === 'answer-project-qa'
      && /^sha256-[a-f0-9]{12}$/.test(qaAnswer.skillVersion)
      && /^[a-f0-9]{64}$/.test(qaAnswer.skillSha256),
    `${qaAnswer.skillName}:${qaAnswer.skillVersion}`,
  )
  assert(
    'AI-011 记录 docs Q&A 模板版本',
    qaAnswer.templateVersion === 'qa-core-rules-20260726-v5'
      && qaAnswer.referenceTemplates.length === 5
      && qaAnswer.referenceTemplates.every((item) => item.toLowerCase().endsWith('.pdf')),
    `${qaAnswer.templateVersion} / ${qaAnswer.referenceTemplates.join('、')}`,
  )
  assert(
    'AI-011 Q&A 使用模板一致的连续分维度编号',
    qaAnswer.keyPoints.length >= 1
      && qaAnswer.keyPoints.every((point, index) =>
        point.text.startsWith(`（${index + 1}）`)),
    qaAnswer.keyPoints.map((point) => point.text.slice(0, 20)).join(' | '),
  )
  assert(
    'AI-011 Q&A 返回去重来源及定位',
    qaAnswer.evidenceCount >= 1
      && qaAnswer.evidenceCount === qaAnswer.sources.length
      && new Set(qaAnswer.sources.map((source) => source.id)).size === qaAnswer.sources.length
      && qaAnswer.sources.every((source) => Boolean(source.title) && Boolean(source.locator)),
    `${qaAnswer.evidenceCount} 条 / ${qaAnswer.sources.map((source) => source.id).join(',')}`,
  )
  assert(
    'AI-011 Q&A 保留责任声明',
    qaAnswer.disclaimer.includes('仅供内部研究与辅助判断')
      && qaAnswer.disclaimer.includes('不构成正式法律意见')
      && qaAnswer.disclaimer.includes('最终投资决策'),
    qaAnswer.disclaimer,
  )

  const { data: restoredQa } = await request<{ list: ProjectQaAnswer[] }>(
    `/ai/qa?conversationId=${encodeURIComponent(conversation.id)}`,
    {},
    adminToken,
  )
  assert(
    'AI-011 刷新后可按会话恢复回答',
    restoredQa.list.some((answer) =>
      answer.id === qaAnswer.id
      && answer.skillSha256 === qaAnswer.skillSha256
      && answer.sources.length === qaAnswer.sources.length),
    `${restoredQa.list.length} 条`,
  )

  const otherQaRead = await fetch(
    apiUrl(`/ai/qa?conversationId=${encodeURIComponent(conversation.id)}`),
    { headers: { Authorization: `Bearer ${userToken}` } },
  )
  assert('其他用户不能恢复 Q&A 回答', otherQaRead.status === 404, `HTTP ${otherQaRead.status}`)

  const otherQaCreate = await fetch(apiUrl('/ai/qa'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: project.id,
      conversationId: conversation.id,
      category: '核心风险',
      question: qaQuestion,
      sourceCutoffDate: cutoff,
    }),
  })
  assert('无项目权限用户不能创建 Q&A 回答', otherQaCreate.status === 403, `HTTP ${otherQaCreate.status}`)

  const qaAnswerRecord = qaAnswer as unknown as Record<string, unknown>
  assert(
    'AI-011 兼容单题接口不误创建文档',
    !('artifacts' in qaAnswerRecord)
      && !('outputFormat' in qaAnswerRecord)
      && !('downloadUrl' in qaAnswerRecord)
      && qaAnswer.referenceTemplates.every((item) => item.toLowerCase().endsWith('.pdf')),
    '兼容结构化单题回答 / 5 份 PDF 输入模板 / 无 artifacts',
  )

  const qaTaskKey = `accept-project-qa-${suffix}`
  const { data: qaTaskCreated } = await request<Task>('/ai/tasks', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      conversationId: conversation.id,
      type: 'project_qa',
      parameters: {
        sourceCutoffDate: cutoff,
        qaMode: '投资委员会 Q&A',
        questionDepth: '标准版',
        outputFormat: 'DOCX+PDF',
      },
      idempotencyKey: qaTaskKey,
    }),
  }, adminToken, 202)
  const qaTask = await pollTask(adminToken, qaTaskCreated.id, 180_000)
  assert(
    'AI-011 正式 Q&A 文档任务完成',
    qaTask.status === 'succeeded' && qaTask.progress === 100,
    `${qaTask.status} / ${qaTask.progress}`,
  )
  assert(
    'AI-011 同时输出 Word 与 PDF',
    ['docx', 'pdf'].every((format) =>
      qaTask.artifacts.some((artifact) => artifact.format === format)),
    qaTask.artifacts.map((artifact) => artifact.format).join(','),
  )
  assert(
    'AI-011 记录 Generator、Reviewer、模板和 Skill 审计信息',
    qaTask.artifacts.every((artifact) =>
      artifact.metadata?.skillName === 'answer-project-qa'
      && artifact.metadata?.questionCount === 15
      && artifact.metadata?.categoryCount === 15
      && Boolean(artifact.metadata?.templateCorpusSha256)
      && Boolean(artifact.metadata?.reviewerChecks)),
    qaTask.artifacts.map((artifact) => JSON.stringify(artifact.metadata)).join(' | '),
  )

  if (acceptanceScope === 'qa') {
    await outputReport('Q&A 专项验收覆盖兼容单题接口及正式 project_qa 文档任务，验证 Word/PDF 双产物。')
    return
  }
  }

  const basePayload = {
    projectId: project.id,
    conversationId: conversation.id,
  }
  const complianceKey = `accept-compliance-${suffix}`
  const compliancePayload = {
    ...basePayload,
    type: 'compliance_statement',
    parameters: { sourceCutoffDate: cutoff, outputFormat: 'DOCX' },
    idempotencyKey: complianceKey,
  }
  const { data: complianceCreated } = await request<Task>('/ai/tasks', {
    method: 'POST',
    body: JSON.stringify(compliancePayload),
  }, adminToken, 202)
  const { data: complianceDuplicate } = await request<Task>('/ai/tasks', {
    method: 'POST',
    body: JSON.stringify(compliancePayload),
  }, adminToken, 202)
  assert('相同幂等键返回原任务', complianceCreated.id === complianceDuplicate.id, complianceCreated.id)

  const conflict = await fetch(apiUrl('/ai/tasks'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...compliancePayload,
      parameters: { ...compliancePayload.parameters, acceptanceVariant: 'conflict' },
    }),
  })
  assert('相同幂等键不同参数返回 409', conflict.status === 409, `HTTP ${conflict.status}`)

  const compliance = await pollTask(adminToken, complianceCreated.id)
  assert(
    'AI-007 API 任务成功并完成进度',
    compliance.status === 'succeeded' && compliance.progress === 100,
    `${compliance.status} / ${compliance.progress}%`,
  )
  assert(
    'AI-007 同时登记 DOCX、PDF 与 Markdown',
    ['docx', 'pdf', 'md'].every((format) =>
      compliance.artifacts.some((artifact) => artifact.format === format)),
    compliance.artifacts.map((artifact) => artifact.format).join(','),
  )
  assert('AI-007 登记项目来源', compliance.sources.length >= 1, `${compliance.sources.length} 条`)
  assert(
    'AI-007 产物记录 Skill 版本',
    compliance.artifacts.every((artifact) =>
      artifact.metadata?.skillName === 'generate-compliance-statement'
      && typeof artifact.metadata?.skillSha256 === 'string'),
    compliance.artifacts.map((artifact) => String(artifact.metadata?.skillName)).join(','),
  )

  const docx = compliance.artifacts.find((artifact) => artifact.format === 'docx')!
  const compliancePdf = compliance.artifacts.find((artifact) => artifact.format === 'pdf')!
  const complianceMarkdown = compliance.artifacts.find((artifact) => artifact.format === 'md')!
  assert(
    'AI-007 PDF 由最终 Word 同源生成并通过 Reviewer',
    compliancePdf.metadata?.derivedFromArtifactId === docx.id
      && compliancePdf.metadata?.pdfReviewerPassed === true
      && compliancePdf.metadata?.visibleNumberingValidated === true,
    JSON.stringify(compliancePdf.metadata),
  )
  const download = await fetch(apiUrl(docx.downloadUrl), {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  const downloadBytes = (await download.arrayBuffer()).byteLength
  assert(
    '鉴权下载返回有效 DOCX',
    download.status === 200
      && downloadBytes > 1000
      && (download.headers.get('content-disposition') || '').includes('filename*=UTF-8'),
    `HTTP ${download.status}，${downloadBytes} bytes`,
  )
  const markdownDownload = await fetch(apiUrl(complianceMarkdown.downloadUrl), {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  const markdownText = await markdownDownload.text()
  assert(
    'AI-007 Markdown 遵循核心正文结构且不泄露审计元数据',
    markdownDownload.status === 200
      && ['一、公司情况介绍', '二、投资理由', '三、投资计划', '四、投资情形分析']
        .every((title) => markdownText.includes(`## ${title}`))
      && ['## 摘要', '## 风险提示', '## 资料缺口', '## 免责声明', '## 引用资料', '[S1]']
        .every((term) => !markdownText.includes(term)),
    `${markdownDownload.status} / ${markdownText.slice(0, 120)}`,
  )

  const otherTask = await fetch(apiUrl(`/ai/tasks/${compliance.id}`), {
    headers: { Authorization: `Bearer ${userToken}` },
  })
  const otherDownload = await fetch(apiUrl(docx.downloadUrl), {
    headers: { Authorization: `Bearer ${userToken}` },
  })
  assert('其他用户不能读取任务', otherTask.status === 404, `HTTP ${otherTask.status}`)
  assert('其他用户不能下载产物', otherDownload.status === 404, `HTTP ${otherDownload.status}`)

  const unauthorizedCreate = await fetch(apiUrl('/ai/tasks'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...compliancePayload,
      conversationId: undefined,
      idempotencyKey: `accept-denied-${suffix}`,
    }),
  })
  assert('无项目权限用户不能创建任务', unauthorizedCreate.status === 403, `HTTP ${unauthorizedCreate.status}`)
  const { data: otherArtifacts } = await request<{ list: Array<{ id: string }> }>(
    `/ai/artifacts?projectId=${encodeURIComponent(project.id)}`,
    {},
    userToken,
  )
  assert('其他用户的交付物中心不泄露项目产物', otherArtifacts.list.length === 0, `${otherArtifacts.list.length} 个`)

  if (acceptanceScope === 'compliance') {
    await outputReport('合规性说明专项 API 验收覆盖任务生成、DOCX/PDF/Markdown 登记、下载鉴权与审计元数据。')
    return
  }

  const taskInputs = [
    {
      type: 'investment_proposal',
      parameters: {
        sourceCutoffDate: cutoff,
        outputFormat: 'DOCX',
        audience: '内部立项',
        length: '标准版',
        userInstructions: '重点说明本轮拟议交易安排；如与项目证据冲突，请标记为待核验。',
      },
      formats: ['docx'],
      skillName: 'draft-investment-proposal',
    },
    {
      type: 'investment_recommendation_ppt',
      parameters: {
        sourceCutoffDate: cutoff,
        outputFormat: 'PPTX',
        template: '公司标准模板',
        pageCount: '12-15页',
        language: '中文',
      },
      formats: ['pptx', 'png'],
      skillName: 'build-investment-recommendation-ppt',
    },
    {
      type: 'due_diligence_report',
      parameters: { sourceCutoffDate: cutoff, outputFormat: 'DOCX', diligenceScope: '商业尽调' },
      formats: ['docx'],
      skillName: 'write-due-diligence-report',
    },
  ]
  for (const item of taskInputs) {
    const { data: created } = await request<Task>('/ai/tasks', {
      method: 'POST',
      body: JSON.stringify({
        ...basePayload,
        type: item.type,
        parameters: item.parameters,
        idempotencyKey: `accept-${item.type}-${suffix}`,
      }),
    }, adminToken, 202)
    const completed = await pollTask(adminToken, created.id)
    assert(
      `${item.type} API 任务成功并完成进度`,
      completed.status === 'succeeded' && completed.progress === 100,
      `${completed.status} / ${completed.progress}%`,
    )
    assert(
      `${item.type} 产物格式完整`,
      item.formats.every((format) => completed.artifacts.some((artifact) => artifact.format === format)),
      completed.artifacts.map((artifact) => artifact.format).join(','),
    )
    assert(`${item.type} 有来源记录`, completed.sources.length >= 1, `${completed.sources.length} 条`)
    assert(
      `${item.type} 产物记录 Skill 版本`,
      completed.artifacts.every((artifact) =>
        artifact.metadata?.skillName === item.skillName
        && typeof artifact.metadata?.skillVersion === 'string'
        && typeof artifact.metadata?.skillSha256 === 'string'),
      completed.artifacts.map((artifact) => String(artifact.metadata?.skillName)).join(','),
    )
  }

  const unsupportedLanguage = await fetch(apiUrl('/ai/tasks'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...basePayload,
      type: 'investment_recommendation_ppt',
      parameters: {
        sourceCutoffDate: cutoff,
        outputFormat: 'PPTX',
        template: '公司标准模板',
        pageCount: '12-15页',
        language: '英文',
      },
      idempotencyKey: `accept-invalid-ppt-${suffix}`,
    }),
  })
  assert('AI-009 首期拒绝非中文参数', unsupportedLanguage.status === 400, `HTTP ${unsupportedLanguage.status}`)

  const unsupportedDiligence = await fetch(apiUrl('/ai/tasks'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...basePayload,
      type: 'due_diligence_report',
      parameters: {
        sourceCutoffDate: cutoff,
        outputFormat: 'DOCX',
        diligenceScope: '法律尽调',
      },
      idempotencyKey: `accept-invalid-dd-${suffix}`,
    }),
  })
  assert('AI-010 首期拒绝未开放尽调类型', unsupportedDiligence.status === 400, `HTTP ${unsupportedDiligence.status}`)

  if (databaseUrl) {
    const pool = new pg.Pool({ connectionString: databaseUrl })
    try {
      const cancelId = randomUUID()
      const failedId = randomUUID()
      await pool.query(
        `INSERT INTO ai_tasks
          (id, user_id, project_id, conversation_id, type, parameters, template_version, status, stage, progress, idempotency_key, completed_at)
         SELECT $1, user_id, $2, $3::varchar, 'due_diligence_report', $4::jsonb, 'dd-jialiang-202606-v1', 'pending', '等待执行', 0, $5, NULL
         FROM chat_conversations WHERE id=$3::uuid`,
        [
          cancelId,
          project.id,
          conversation.id,
          JSON.stringify({ sourceCutoffDate: cutoff, outputFormat: 'DOCX', diligenceScope: '商业尽调' }),
          `accept-cancel-${suffix}`,
        ],
      )
      const { data: cancelled } = await request<Task>(`/ai/tasks/${cancelId}/cancel`, { method: 'POST' }, adminToken)
      assert('待执行任务可取消', cancelled.status === 'cancelled', cancelled.status)

      await pool.query(
        `INSERT INTO ai_tasks
          (id, user_id, project_id, conversation_id, type, parameters, template_version, status, stage, progress, idempotency_key, error_id, error_message, completed_at)
         SELECT $1, user_id, $2, $3::varchar, 'investment_proposal', $4::jsonb, 'proposal-jialiang-20260622-v1', 'failed', '生成失败', 40, $5, 'AI-ACCEPTANCE-FAILURE', '验收注入的失败任务', NOW()
         FROM chat_conversations WHERE id=$3::uuid`,
        [
          failedId,
          project.id,
          conversation.id,
          JSON.stringify({ sourceCutoffDate: cutoff, outputFormat: 'DOCX', audience: '内部立项', length: '标准版' }),
          `accept-failed-${suffix}`,
        ],
      )
      const { data: retried } = await request<Task>(`/ai/tasks/${failedId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: `accept-retry-${suffix}` }),
      }, adminToken, 202)
      const retryCompleted = await pollTask(adminToken, retried.id)
      assert('失败任务创建新重试运行', retryCompleted.status === 'succeeded' && retryCompleted.retryOfTaskId === failedId, retryCompleted.id)
    } finally {
      await pool.end()
    }
  }

  const { data: artifacts } = await request<{ list: Array<{ id: string }> }>(
    `/ai/artifacts?projectId=${encodeURIComponent(project.id)}`,
    {},
    adminToken,
  )
  assert('交付物中心按项目返回正式产物', artifacts.list.length >= 6, `${artifacts.list.length} 个`)

  await outputReport('全量验收必须对隔离测试数据库运行；会创建脱敏项目、会话和任务记录。')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
