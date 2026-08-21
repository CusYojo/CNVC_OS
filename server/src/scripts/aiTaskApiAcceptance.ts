import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import PptxGenJS from 'pptxgenjs'
import { pool as mysqlPool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { hashPassword } from '../services/authService.js'
import { AI_BUSINESS_SKILLS } from '../services/aiSkillService.js'
import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'

type Check = { name: string; passed: boolean; detail: string }
type AcceptanceAuth = { cookie: string; csrfToken: string }
type AcceptanceCleanupState = {
  adminAuth?: AcceptanceAuth
  project?: { id: string; name: string }
  conversationId?: string
  userIds: string[]
  templateDirectories: string[]
}
type Task = {
  id: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  retryOfTaskId?: string | null
  errorId?: string | null
  errorMessage?: string | null
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

const apiBase = (process.env.AI_ACCEPTANCE_API_BASE || 'http://127.0.0.1:4100/api').replace(/\/$/, '')
const apiOrigin = new URL(apiBase).origin
const reportPath = process.env.AI_API_ACCEPTANCE_REPORT
// 真实 14 页视觉 PPT 会包含逐页生成、文字清理、PDF 与可编辑化审计；
// 网关繁忙时 30 分钟不足以区分慢任务和失联任务。
const configuredTaskTimeoutMs = Number(process.env.AI_API_ACCEPTANCE_TASK_TIMEOUT_MS || 7_200_000)
const acceptanceTaskTimeoutMs = Number.isFinite(configuredTaskTimeoutMs) && configuredTaskTimeoutMs >= 60_000
  ? configuredTaskTimeoutMs
  : 7_200_000
const configuredPollIntervalMs = Number(process.env.AI_API_ACCEPTANCE_POLL_INTERVAL_MS || 2_000)
const acceptancePollIntervalMs = Number.isFinite(configuredPollIntervalMs) && configuredPollIntervalMs >= 250
  ? configuredPollIntervalMs
  : 2_000
const acceptanceScope = ['qa', 'compliance', 'remaining'].includes(process.env.AI_ACCEPTANCE_SCOPE || '')
  ? process.env.AI_ACCEPTANCE_SCOPE as 'qa' | 'compliance' | 'remaining'
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
  auth?: AcceptanceAuth,
  expectedStatus = 200,
): Promise<{ data: T; response: Response }> {
  const method = (options.method || 'GET').toUpperCase()
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth ? { Cookie: auth.cookie } : {}),
      ...(auth && !['GET', 'HEAD', 'OPTIONS'].includes(method)
        ? { 'X-CSRF-Token': auth.csrfToken }
        : {}),
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

async function createInvestmentTemplateUpload(suffix: string) {
  const fileName = `AI-009-上传模板-${suffix}.pptx`
  const filePath = path.join(tmpdir(), fileName)
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.theme = {
    headFontFace: 'Microsoft YaHei',
    bodyFontFace: 'Microsoft YaHei',
  }
  const pages = [
    ['投资建议书模板', '封面：项目名称、截止日期和内部使用说明'],
    ['项目概览', '公司定位、发展阶段和融资安排'],
    ['投资判断', '投资逻辑、亮点和推进建议'],
    ['风险与核验', '风险触发条件、资料缺口和后续动作'],
  ]
  pages.forEach(([title, body], index) => {
    const slide = pptx.addSlide()
    slide.background = { color: index === 0 ? '16233A' : 'F3F3FA' }
    slide.addText(title, {
      x: 0.7,
      y: 0.7,
      w: 11.8,
      h: 0.7,
      fontFace: 'Microsoft YaHei',
      fontSize: index === 0 ? 30 : 24,
      bold: true,
      color: index === 0 ? 'FFFFFF' : '3E3AAE',
      margin: 0,
    })
    slide.addText(body, {
      x: 0.72,
      y: 1.65,
      w: 11.2,
      h: 0.7,
      fontFace: 'Microsoft YaHei',
      fontSize: 15,
      color: index === 0 ? 'DDE6F1' : '252532',
      margin: 0,
    })
  })
  await pptx.writeFile({ fileName: filePath })
  return {
    fileName,
    dataBase64: `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${
      (await readFile(filePath)).toString('base64')
    }`,
  }
}

function createDueDiligenceAcceptanceFixture(suffix: string) {
  const fileName = `商业尽调验收主档-${suffix}.txt`
  const content = `
商业尽调自动化验收主档

使用边界：本资料仅用于隔离验收环境。以下主体、合同、金额和结论均为验收夹具值，构成本次测试场景的已核验主档，不得外推至任何真实企业。本主档由营业执照、已签合同、验收单、发票、银行回单和管理台账逐项转录；相应原始凭证在本测试场景中视为已核对一致。

[entity.basic_registry｜来源等级 primary_document｜营业执照转录]
legal_name：杭州知行验收科技有限公司
unified_social_credit_code：91330100MA2TEST001
incorporation_date：2021-03-15
registered_capital：人民币1,000万元
legal_representative：张知行
registered_address：浙江省杭州市滨江区验收路100号A座8层
business_scope：企业管理软件、人工智能应用软件的研发、销售、实施和技术服务。

[ownership.public_ownership｜来源等级 public_authoritative｜企业登记公示转录]
1. shareholder：张知行；ownership_pct：70%；subscribed_capital：人民币700万元。
2. shareholder：杭州知行员工持股平台（有限合伙）；ownership_pct：30%；subscribed_capital：人民币300万元。

[team.core_people｜来源等级 management_record｜人事档案与任职文件转录]
1. name：张知行；role：创始人、法定代表人兼总经理；resume：曾任制造业软件产品负责人10年，2021年全职创办公司；employment_status：全职，劳动合同有效。
2. name：李明远；role：技术负责人；resume：曾负责企业SaaS平台研发8年，2022年加入公司；employment_status：全职，劳动合同有效。

[product.product_matrix｜来源等级 management_record]
1. product：知行业务协同SaaS；buyer：年营收1亿至20亿元的制造企业；pricing：标准订阅30万元/年；delivery：专有云部署加远程实施；maturity：正式商用V3.2；evidence：三份合同均已交付验收并回款。
2. product：知行智能分析模块；buyer：既有SaaS客户；pricing：增购10万元/年；delivery：作为SaaS插件在线开通；maturity：正式商用V2.1；evidence：华东精工已完成续费增购。

[business.customer_closed_loop｜来源等级 primary_document｜合同、验收、发票、银行回单转录]
1. customer：华东精工有限公司；contract：ZX-2025-001，2025-01-10签署；amount：人民币30万元；delivery：2025-02-15完成专有云部署；acceptance：2025-03-01验收单签署；revenue：2025年度确认30万元；invoice：2025-03-05开具30万元增值税发票；cash：2025-03-20银行到账30万元；renewal：2026-01-08续签SaaS并增购智能分析模块，合同40万元。
2. customer：南方智造有限公司；contract：ZX-2025-006，2025-04-02签署；amount：人民币45万元；delivery：2025-05-20完成系统上线；acceptance：2025-06-01验收单签署；revenue：2025年度确认45万元；invoice：2025-06-03开具45万元增值税发票；cash：2025-06-25银行到账45万元；renewal：2026-04-01续签，合同45万元。
3. customer：北辰设备有限公司；contract：ZX-2025-011，2025-07-12签署；amount：人民币25万元；delivery：2025-08-18完成标准版部署；acceptance：2025-09-01验收单签署；revenue：2025年度确认25万元；invoice：2025-09-05开具25万元增值税发票；cash：2025-09-28银行到账25万元；renewal：截至资料截止日尚未到续约期。

[business.revenue_breakdown｜来源等级 management_record｜2025年度收入台账]
1. period：2025年度；legal_entity：杭州知行验收科技有限公司；product：知行业务协同SaaS；customer：华东精工有限公司；revenue：人民币30万元。
2. period：2025年度；legal_entity：杭州知行验收科技有限公司；product：知行业务协同SaaS；customer：南方智造有限公司；revenue：人民币45万元。
3. period：2025年度；legal_entity：杭州知行验收科技有限公司；product：知行业务协同SaaS；customer：北辰设备有限公司；revenue：人民币25万元。
合计：2025年度营业收入人民币100万元，与三份合同收入确认合计一致；按法人、产品、客户和期间可逐项勾稽。

[business.public_customer_cases｜来源等级 third_party_primary｜客户书面确认转录]
1. customer：华东精工有限公司；date：2026-01-08；deliverable：业务协同SaaS续签并增购智能分析模块；source：客户盖章续签确认函。
2. customer：南方智造有限公司；date：2026-04-01；deliverable：业务协同SaaS第二年度续签；source：客户盖章续签确认函。

[market.competitor_matrix｜来源等级 third_party_primary｜客户访谈纪要]
1. competitor：杭州甲云协同科技有限公司；product：甲云通用协同SaaS；customer：中小制造企业；pricing：20万元/年；strength：标准化程度高、上线快；weakness：制造业流程适配深度较弱。
2. competitor：上海乙数智科技有限公司；product：乙数智制造执行与数据平台；customer：大型制造集团；pricing：80万元起/项目；strength：行业方案完整；weakness：价格高、实施周期长。
3. competitor：北京丙智能科技有限公司；product：丙智能BI与分析平台；customer：跨行业企业；pricing：15万元/年；strength：分析组件丰富；weakness：缺少业务协同闭环。

[legal.public_compliance｜来源等级 public_authoritative｜主管机关公开查询转录]
1. matter：经营许可；finding：登记经营范围覆盖现有软件研发、销售和技术服务，未见需要而未取得的专项许可；source：企业登记主管机关公开查询结果，查询日为资料截止日。
2. matter：诉讼与行政处罚；finding：未检索到生效重大诉讼、被执行或行政处罚记录；source：裁判文书、执行信息及信用公示主管机关公开查询结果，查询日为资料截止日。
3. matter：数据与劳动合规；finding：未检索到公开的数据安全、个人信息保护或劳动监察处罚记录；source：网信及人社主管机关公开查询结果，查询日为资料截止日。

[decision.recommendation｜来源等级 analyst_model]
action：defer
rationale：三条客户合同—交付—验收—收入—开票—回款闭环已验证，产品具备商业可用性；但样本规模仅三家，客户集中度和跨年度续费稳定性尚不足以支持立即投资。
conditions：新增至少五家非关联付费客户；最大单一客户收入占比降至30%以下；连续两个季度订阅续费率不低于85%；提供可复核的月度管理报表。
walk_away_triggers：发现合同、验收、发票或银行回单重大不一致；核心产品知识产权权属存在无法补救的争议；新增客户目标在六个月内未达成。
`.trim()
  return { fileName, dataBase64: Buffer.from(content, 'utf8').toString('base64') }
}

async function uploadAndWaitForDueDiligenceFixture(
  auth: AcceptanceAuth,
  project: { id: string },
  uploader: string,
  suffix: string,
) {
  const fixture = createDueDiligenceAcceptanceFixture(suffix)
  const { data: uploaded } = await request<{ file: { id: string; parseStatus: string } }>(
    '/projects/files/upload',
    {
      method: 'POST',
      body: JSON.stringify({
        projectId: project.id,
        name: fixture.fileName,
        type: 'text/plain',
        category: '尽调主档',
        uploader,
        visibility: '项目成员',
        dataBase64: fixture.dataBase64,
      }),
    },
    auth,
    201,
  )
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const { data } = await request<{ list: Array<{ id: string; parseStatus: string; parseError?: string }> }>(
      `/projects/${project.id}/files`,
      {},
      auth,
    )
    const file = data.list.find((item) => item.id === uploaded.file.id)
    if (file?.parseStatus === '成功') return file
    if (file?.parseStatus === '失败') {
      throw new Error(`商业尽调验收主档解析失败：${file.parseError || '未知错误'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('商业尽调验收主档在 60000ms 内未完成解析')
}

async function login(email: string, password: string) {
  const { data, response } = await request<{ csrfToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const setCookie = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') || '']
  const cookie = setCookie.flatMap((line) => {
    const match = line.match(/(?:^|,\s*)(cybernaut_(?:session|csrf)=([^;,]+))/g)
    return match?.map((entry) => entry.replace(/^,\s*/, '')) ?? []
  }).join('; ')
  if (!cookie.includes('cybernaut_session=') || !data.csrfToken) {
    throw new Error('登录成功但未返回完整的会话 Cookie/CSRF 凭据')
  }
  return { cookie, csrfToken: data.csrfToken }
}

async function createAcceptanceUsers(suffix: string, cleanupState: AcceptanceCleanupState) {
  const userTable = quoteMysqlIdentifier(mysqlTableName('users'))
  const admin = {
    id: randomUUID(), email: `ai-api-admin-${suffix}@example.invalid`, name: `AI API 验收管理员-${suffix}`,
    password: `Aa!${randomUUID()}9`, role: '系统管理员',
  }
  const user = {
    id: randomUUID(), email: `ai-api-user-${suffix}@example.invalid`, name: `AI API 验收用户-${suffix}`,
    password: `Bb!${randomUUID()}8`, role: '投资经理',
  }
  for (const account of [admin, user]) {
    await mysqlPool.query(
      `INSERT INTO ${userTable} (id,email,name,role,department,password_hash,status,created_at)
       VALUES (?,?,?,?,?,?, '启用', NOW(3))`,
      [account.id, account.email, account.name, account.role, '自动验收', await hashPassword(account.password)],
    )
    cleanupState.userIds.push(account.id)
  }
  return { admin, user }
}

async function cleanupAcceptanceUsers(userIds: string[]) {
  if (!userIds.length) return
  const userTable = quoteMysqlIdentifier(mysqlTableName('users'))
  const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
  const placeholders = userIds.map(() => '?').join(',')
  await mysqlPool.query(`DELETE FROM ${auditTable} WHERE user_id IN (${placeholders})`, userIds)
  await mysqlPool.query(`DELETE FROM ${userTable} WHERE id IN (${placeholders})`, userIds)
  const [rows] = await mysqlPool.query(`SELECT id FROM ${userTable} WHERE id IN (${placeholders})`, userIds)
  if ((rows as unknown[]).length) throw new Error('AI API 验收随机用户清理失败')
}

async function cleanupAcceptanceProject(
  auth: AcceptanceAuth,
  project: { id: string; name: string },
) {
  const response = await fetch(apiUrl(`/projects/${project.id}`), {
    method: 'DELETE',
    headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrfToken },
  })
  const raw = await response.text()
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(`清理验收项目 ${project.name} 失败：HTTP ${response.status} ${raw.slice(0, 500)}`)
  }
  process.stderr.write(
    response.status === 404
      ? `验收项目已不存在，无需清理：${project.name}\n`
      : `已自动清理验收项目：${project.name}\n`,
  )
}

async function cleanupAcceptanceConversation(auth: AcceptanceAuth, conversationId: string) {
  const response = await fetch(apiUrl(`/conversations/${conversationId}`), {
    method: 'DELETE',
    headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrfToken },
  })
  const raw = await response.text()
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(`清理验收会话 ${conversationId} 失败：HTTP ${response.status} ${raw.slice(0, 500)}`)
  }
  process.stderr.write(
    response.status === 404
      ? `验收会话已不存在，无需清理：${conversationId}\n`
      : `已自动清理验收会话：${conversationId}\n`,
  )
}

async function cleanupAcceptanceResources(state: AcceptanceCleanupState) {
  const cleanupErrors: unknown[] = []
  for (const directory of state.templateDirectories) {
    try {
      const templateDataRoot = path.resolve(
        process.env.AI_CUSTOM_TEMPLATE_DATA_ROOT || process.env.AI_CUSTOM_TEMPLATE_ROOT || 'server/ai-template-data',
      )
      const relative = path.relative(templateDataRoot, directory)
      const segments = relative.split(path.sep)
      if (
        relative === ''
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
        || segments.length !== 4
        || segments.some((segment) => !/^[0-9a-f-]{36}$/i.test(segment))
      ) {
        throw new Error('拒绝清理不在验收模板四级 UUID 目录中的路径')
      }
      const metadata = await lstat(directory).catch(() => null)
      if (metadata?.isSymbolicLink()) throw new Error('拒绝清理符号链接模板目录')
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (state.adminAuth && state.conversationId) {
    try {
      await cleanupAcceptanceConversation(state.adminAuth, state.conversationId)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (state.adminAuth && state.project) {
    try {
      await cleanupAcceptanceProject(state.adminAuth, state.project)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    await cleanupAcceptanceUsers(state.userIds)
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length > 0) {
    process.exitCode = 1
    cleanupErrors.forEach((error) => console.error(error))
  }
}

async function pollTask(auth: AcceptanceAuth, taskId: string, timeoutMs = acceptanceTaskTimeoutMs): Promise<Task> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { data } = await request<Task>(`/ai/tasks/${taskId}`, {}, auth)
    if (['succeeded', 'failed', 'cancelled'].includes(data.status)) return data
    await new Promise((resolve) => setTimeout(resolve, acceptancePollIntervalMs))
  }
  throw new Error(`任务 ${taskId} 在 ${timeoutMs}ms 内未进入终态`)
}

async function main(cleanupState: AcceptanceCleanupState) {
  const anonymousTaskTypes = await fetch(apiUrl('/ai/task-types'))
  assert('未登录用户不能读取任务配置', anonymousTaskTypes.status === 401, `HTTP ${anonymousTaskTypes.status}`)

  const suffix = randomUUID().slice(0, 8)
  const accounts = await createAcceptanceUsers(suffix, cleanupState)
  const adminAuth = await login(accounts.admin.email, accounts.admin.password)
  cleanupState.adminAuth = adminAuth
  const userAuth = await login(accounts.user.email, accounts.user.password)
  // 服务按 Asia/Shanghai 判断项目资料版本；UTC 零点前后不能把当天新建的
  // 验收项目误判为“晚于截止日”，否则任务虽生成成功却没有可审计来源。
  const cutoff = formatShanghaiDateKey(new Date())
  const selectedRemainingTypes = new Set(
    String(process.env.AI_ACCEPTANCE_REMAINING_TYPES || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
  const includesDueDiligence = !['qa', 'compliance'].includes(acceptanceScope)
    && (selectedRemainingTypes.size === 0 || selectedRemainingTypes.has('due_diligence_report'))

  const { data: skillCatalog } = await request<{
    list: Array<{ name: string; version: string; sha256: string }>
  }>('/ai/skills', {}, adminAuth)
  const requiredBusinessSkills = AI_BUSINESS_SKILLS.map((skill) => skill.name)
  assert(
    'API 注册全部必需业务 Skill',
    requiredBusinessSkills.every((name) =>
      skillCatalog.list.some((skill) => skill.name === name)),
    skillCatalog.list.map((skill) => skill.name).join(', '),
  )
  assert(
    'API Skill 版本可审计',
    skillCatalog.list.every((skill) =>
      /^sha256-[a-f0-9]{12}$/.test(skill.version) && /^[a-f0-9]{64}$/.test(skill.sha256)),
    skillCatalog.list.map((skill) => `${skill.name}:${skill.version}`).join(', '),
  )
  if (acceptanceScope === 'all') {
    const { data: taskTypes } = await request<{
      list: Array<{ type: string; skillName: string }>
    }>('/ai/task-types', {}, adminAuth)
    assert(
      '六类文档任务配置均暴露 Skill 绑定',
      taskTypes.list.length === 6 && taskTypes.list.every((item) => Boolean(item.skillName)),
      taskTypes.list.map((item) => `${item.type}:${item.skillName}`).join(', '),
    )
  }

  const { data: project } = await request<{ id: string; name: string }>('/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: `AI API 验收项目-${suffix}`,
      companyName: includesDueDiligence
        ? '杭州知行验收科技有限公司'
        : '杭州脱敏验收科技有限公司',
      industry: '企业服务与人工智能',
      round: 'A轮',
      stage: '尽调',
      owner: accounts.admin.name,
      collaborators: [],
      source: '自动验收',
      financing: '金额及用途待正式交易文件核验',
      valuation: '待核验',
      riskLevel: '中',
      summary: includesDueDiligence
        ? '自动化验收夹具项目；本次测试事实以已上传并解析成功的商业尽调主档为准。'
        : '用于隔离测试环境的脱敏项目。',
      businessModel: includesDueDiligence
        ? '向制造企业提供业务协同SaaS订阅和实施服务，2025年度三家客户收入合计100万元。'
        : '软件订阅与实施服务，收入质量待核验。',
      market: includesDueDiligence
        ? '制造业协同SaaS市场，验收主档列示三家直接或替代竞争者。'
        : '市场规模与竞争格局待第三方资料核验。',
      team: '团队信息不属于本次商业专项尽调的P0范围。',
      tags: ['自动验收'],
    }),
  }, adminAuth, 201)
  cleanupState.project = project
  assert('API 创建隔离验收项目', Boolean(project.id), project.id)

  const { data: conversation } = await request<{ id: string }>('/conversations', {
    method: 'POST',
    body: JSON.stringify({
      title: acceptanceScope === 'qa' ? 'AI-011 Q&A API 验收' : 'AI-007～AI-011 API 验收',
      scope: 'project',
      projectId: project.id,
      projectName: project.name,
    }),
  }, adminAuth, 201)
  cleanupState.conversationId = conversation.id
  assert('API 创建项目会话', Boolean(conversation.id), conversation.id)

  if (includesDueDiligence) {
    const parsedFixture = await uploadAndWaitForDueDiligenceFixture(
      adminAuth,
      project,
      accounts.admin.name,
      suffix,
    )
    assert(
      'AI-010 商业尽调主档通过真实上传与异步解析链路',
      parsedFixture.parseStatus === '成功',
      parsedFixture.parseStatus,
    )
  }

  if (!['compliance', 'remaining'].includes(acceptanceScope)) {
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
  }, adminAuth, 201)
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
    qaAnswer.skillName === 'draft-investment-qa'
      && /^sha256-[a-f0-9]{12}$/.test(qaAnswer.skillVersion)
      && /^[a-f0-9]{64}$/.test(qaAnswer.skillSha256),
    `${qaAnswer.skillName}:${qaAnswer.skillVersion}`,
  )
  assert(
    'AI-011 记录 docs Q&A 模板版本',
    qaAnswer.templateVersion === 'draft-investment-qa-20260806-v1'
      && qaAnswer.referenceTemplates.length === 5
      && qaAnswer.referenceTemplates.every((item) => item.toLowerCase().endsWith('.md')),
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
    qaAnswer.disclaimer.includes('仅供投资团队内部分析与后续核验')
      && qaAnswer.disclaimer.includes('不构成正式法律、财务意见')
      && qaAnswer.disclaimer.includes('最终投资决策'),
    qaAnswer.disclaimer,
  )

  const { data: restoredQa } = await request<{ list: ProjectQaAnswer[] }>(
    `/ai/qa?conversationId=${encodeURIComponent(conversation.id)}`,
    {},
    adminAuth,
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
    { headers: { Cookie: userAuth.cookie } },
  )
  assert('其他用户不能恢复 Q&A 回答', otherQaRead.status === 404, `HTTP ${otherQaRead.status}`)

  const otherQaCreate = await fetch(apiUrl('/ai/qa'), {
    method: 'POST',
    headers: {
      Cookie: userAuth.cookie,
      'X-CSRF-Token': userAuth.csrfToken,
      'Content-Type': 'application/json',
    },
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
      && qaAnswer.referenceTemplates.length === 5
      && qaAnswer.referenceTemplates.every((item) => item.toLowerCase().endsWith('.md')),
    '兼容结构化单题回答 / draft-investment-qa 的 5 份 Markdown 规范 / 无 artifacts',
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
        outputFormat: 'DOCX',
      },
      idempotencyKey: qaTaskKey,
    }),
  }, adminAuth, 202)
  const qaTask = await pollTask(adminAuth, qaTaskCreated.id)
  assert(
    'AI-011 正式 Q&A 文档任务完成',
    qaTask.status === 'succeeded' && qaTask.progress === 100,
    `${qaTask.status} / ${qaTask.progress}${qaTask.errorMessage ? ` / ${qaTask.errorMessage}` : ''}`,
  )
  assert(
    'AI-011 只输出正式 DOCX',
    qaTask.artifacts.length === 1
      && qaTask.artifacts[0]?.format === 'docx',
    qaTask.artifacts.map((artifact) => artifact.format).join(','),
  )
  assert(
    'AI-011 记录 Agent/Skill 验收和下载交付信息',
    qaTask.artifacts.every((artifact) =>
      artifact.metadata?.skillName === 'draft-investment-qa'
      && artifact.metadata?.questionCount === 8
      && artifact.metadata?.categoryCount === 15
      && Boolean(artifact.metadata?.templateCorpusSha256)
      && Boolean(artifact.metadata?.reviewerChecks)
      && artifact.metadata?.evidencePolicy === 'project_knowledge_primary_model_network_supplement'
      && artifact.metadata?.skillExecutionMode === 'skill-deta-content-rendered'
      && artifact.metadata?.acceptanceAuthority === 'agent-and-current-skill'
      && artifact.metadata?.programmaticBusinessAcceptance === false
      && artifact.metadata?.deliveryValidation === 'file-integrity-and-authorization-only'
      && artifact.metadata?.visibleReferencesIncluded === false
      && artifact.metadata?.visibleReviewerIncluded === false
      && Array.isArray(artifact.metadata?.downloadableFormats)
      && artifact.metadata?.downloadableFormats.join(',') === 'docx'),
    qaTask.artifacts.map((artifact) => JSON.stringify(artifact.metadata)).join(' | '),
  )

  if (acceptanceScope === 'qa') {
    await outputReport('Q&A 专项验收覆盖兼容单题接口及正式 project_qa 文档任务，验证 draft-investment-qa、内部证据审阅与 DOCX 单产物。')
    return
  }
  }

  const basePayload = {
    projectId: project.id,
    conversationId: conversation.id,
  }
  if (acceptanceScope !== 'remaining') {
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
  }, adminAuth, 202)
  const { data: complianceDuplicate } = await request<Task>('/ai/tasks', {
    method: 'POST',
    body: JSON.stringify(compliancePayload),
  }, adminAuth, 202)
  assert('相同幂等键返回原任务', complianceCreated.id === complianceDuplicate.id, complianceCreated.id)

  const conflict = await fetch(apiUrl('/ai/tasks'), {
    method: 'POST',
    headers: {
      Cookie: adminAuth.cookie,
      'X-CSRF-Token': adminAuth.csrfToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...compliancePayload,
      parameters: { ...compliancePayload.parameters, acceptanceVariant: 'conflict' },
    }),
  })
  assert('相同幂等键不同参数返回 409', conflict.status === 409, `HTTP ${conflict.status}`)

  const compliance = await pollTask(adminAuth, complianceCreated.id)
  assert(
    'AI-007 API 任务成功并完成进度',
    compliance.status === 'succeeded' && compliance.progress === 100,
    `${compliance.status} / ${compliance.progress}%`,
  )
  assert(
    'AI-007 只登记一份 DOCX',
    compliance.artifacts.length === 1
      && compliance.artifacts[0]?.format === 'docx',
    compliance.artifacts.map((artifact) => artifact.format).join(','),
  )
  assert('AI-007 登记项目来源', compliance.sources.length >= 1, `${compliance.sources.length} 条`)
  assert(
    'AI-007 产物记录 Skill 版本',
    compliance.artifacts.every((artifact) =>
      artifact.metadata?.skillName === 'generate-investment-compliance-note'
      && typeof artifact.metadata?.skillSha256 === 'string'),
    compliance.artifacts.map((artifact) => String(artifact.metadata?.skillName)).join(','),
  )

  const docx = compliance.artifacts.find((artifact) => artifact.format === 'docx')!
  assert(
    'AI-007 以项目资料库为主并使用项目大模型网络补全',
    docx.metadata?.evidencePolicy === 'project_knowledge_primary_model_network_supplement'
      && docx.metadata?.publicWebResearch === undefined
      && typeof docx.metadata?.projectModelNetworkSupplement === 'object',
    JSON.stringify({
      evidencePolicy: docx.metadata?.evidencePolicy,
      publicWebResearch: docx.metadata?.publicWebResearch,
      projectModelNetworkSupplement: docx.metadata?.projectModelNetworkSupplement,
    }),
  )
  const download = await fetch(apiUrl(docx.downloadUrl), {
    headers: { Cookie: adminAuth.cookie },
  })
  const downloadBytes = (await download.arrayBuffer()).byteLength
  assert(
    '鉴权下载返回有效 DOCX',
    download.status === 200
      && downloadBytes > 1000
      && (download.headers.get('content-disposition') || '').includes('filename*=UTF-8'),
    `HTTP ${download.status}，${downloadBytes} bytes`,
  )
  const downloadRequestId = download.headers.get('x-request-id')
  const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
  const [downloadAuditRows] = await mysqlPool.query(
    `SELECT action,target,result,request_id AS requestId FROM ${auditTable}
     WHERE user_id=? AND action='下载AI产物' AND target LIKE ? ORDER BY created_at DESC LIMIT 1`,
    [accounts.admin.id, `ai-artifact:${docx.id};%`],
  )
  const downloadAudit = (downloadAuditRows as Array<{
    action: string; target: string; result: string; requestId: string
  }>)[0]
  assert(
    'AI 产物下载写入无路径审计并绑定请求 ID',
    Boolean(
      downloadRequestId && downloadAudit
      && downloadAudit.action === '下载AI产物'
      && downloadAudit.result === 'success'
      && downloadAudit.requestId === downloadRequestId
      && !downloadAudit.target.includes(docx.fileName)
      && !downloadAudit.target.includes('ai-artifacts'),
    ),
    downloadAudit ? `${downloadAudit.action} / ${downloadAudit.requestId === downloadRequestId}` : '未找到审计',
  )

  const otherTask = await fetch(apiUrl(`/ai/tasks/${compliance.id}`), {
    headers: { Cookie: userAuth.cookie },
  })
  const otherDownload = await fetch(apiUrl(docx.downloadUrl), {
    headers: { Cookie: userAuth.cookie },
  })
  assert('其他用户不能读取任务', otherTask.status === 404, `HTTP ${otherTask.status}`)
  assert('其他用户不能下载产物', otherDownload.status === 404, `HTTP ${otherDownload.status}`)

  const unauthorizedCreate = await fetch(apiUrl('/ai/tasks'), {
    method: 'POST',
    headers: {
      Cookie: userAuth.cookie,
      'X-CSRF-Token': userAuth.csrfToken,
      'Content-Type': 'application/json',
    },
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
    userAuth,
  )
  assert('其他用户的交付物中心不泄露项目产物', otherArtifacts.list.length === 0, `${otherArtifacts.list.length} 个`)

  if (acceptanceScope === 'compliance') {
    await outputReport('合规性说明专项 API 验收覆盖项目资料库优先、项目大模型网络补全、DOCX 单产物、下载鉴权与审计元数据。')
    return
  }
  }

  const investmentTemplateUpload = await createInvestmentTemplateUpload(suffix)
  const { data: customDocumentTemplate } = await request<{
    id: string
    originalFileName: string
    format: string
    analysis: { structures: Array<{ title: string }> }
  }>('/ai/templates/analyze', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      conversationId: conversation.id,
      name: investmentTemplateUpload.fileName,
      dataBase64: investmentTemplateUpload.dataBase64,
      purpose: 'custom_template_document',
    }),
  }, adminAuth, 201)
  cleanupState.templateDirectories.push(path.resolve(
    process.env.AI_CUSTOM_TEMPLATE_DATA_ROOT || process.env.AI_CUSTOM_TEMPLATE_ROOT || 'server/ai-template-data',
    accounts.admin.id,
    project.id,
    conversation.id,
    customDocumentTemplate.id,
  ))
  assert(
    'AI-012 接受用户上传模板并完成通用文档结构分析',
    customDocumentTemplate.format === 'pptx'
      && customDocumentTemplate.analysis.structures.length === 4,
    `${customDocumentTemplate.originalFileName} / ${customDocumentTemplate.analysis.structures.length} 页`,
  )
  const { data: investmentTemplate } = await request<{
    id: string
    originalFileName: string
    format: string
    analysis: { structures: Array<{ title: string }> }
  }>('/ai/templates/analyze', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      conversationId: conversation.id,
      name: investmentTemplateUpload.fileName,
      dataBase64: investmentTemplateUpload.dataBase64,
      purpose: 'investment_recommendation_ppt',
    }),
  }, adminAuth, 201)
  cleanupState.templateDirectories.push(path.resolve(
    process.env.AI_CUSTOM_TEMPLATE_DATA_ROOT || process.env.AI_CUSTOM_TEMPLATE_ROOT || 'server/ai-template-data',
    accounts.admin.id,
    project.id,
    conversation.id,
    investmentTemplate.id,
  ))
  assert(
    'AI-009 接受用户上传 PPTX 模板并完成结构分析',
    investmentTemplate.format === 'pptx'
      && investmentTemplate.analysis.structures.length === 4,
    `${investmentTemplate.originalFileName} / ${investmentTemplate.analysis.structures.length} 页`,
  )

  const taskInputs = [
    {
      type: 'custom_template_document',
      parameters: {
        sourceCutoffDate: cutoff,
        outputFormat: 'PPTX',
        customTemplateId: customDocumentTemplate.id,
        customTemplateName: customDocumentTemplate.originalFileName,
      },
      formats: ['pptx'],
      skillName: 'generate-document-from-template',
    },
    {
      type: 'investment_proposal',
      parameters: {
        sourceCutoffDate: cutoff,
        outputFormat: 'DOCX',
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
        customTemplateId: investmentTemplate.id,
        customTemplateName: investmentTemplate.originalFileName,
        language: '中文',
        structureMode: 'strict-template',
      },
      formats: ['pptx', 'png'],
      skillName: 'create-reference-driven-editable-ppt',
    },
    {
      type: 'due_diligence_report',
      parameters: { sourceCutoffDate: cutoff, outputFormat: 'DOCX', diligenceScope: '商业尽调' },
      formats: ['docx'],
      skillName: 'draft-due-diligence-report',
    },
  ]
  const selectedTaskInputs = selectedRemainingTypes.size > 0
    ? taskInputs.filter((item) => selectedRemainingTypes.has(item.type))
    : taskInputs
  const validateProposalRetry = selectedRemainingTypes.size === 0
    || selectedRemainingTypes.has('investment_proposal')
  if (selectedRemainingTypes.size > 0) {
    assert(
      '剩余任务过滤器全部匹配已支持任务类型',
      selectedTaskInputs.length === selectedRemainingTypes.size,
      [...selectedRemainingTypes].join(','),
    )
  }
  for (const item of selectedTaskInputs) {
    const { data: created } = await request<Task>('/ai/tasks', {
      method: 'POST',
      body: JSON.stringify({
        ...basePayload,
        type: item.type,
        parameters: item.parameters,
        idempotencyKey: `accept-${item.type}-${suffix}`,
      }),
    }, adminAuth, 202)
    const completed = await pollTask(adminAuth, created.id)
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
    if (item.type === 'investment_proposal') {
      assert(
        'investment_proposal 只交付一份 DOCX',
        completed.artifacts.length === 1 && completed.artifacts[0]?.format === 'docx',
        completed.artifacts.map((artifact) => artifact.format).join(','),
      )
    }
    if (item.type === 'due_diligence_report') {
      assert(
        'due_diligence_report 保持商业专项模式并由 Agent/Skill 验收后交付',
        completed.artifacts.every((artifact) =>
          artifact.metadata?.reportMode === 'business_dd'
          && artifact.metadata?.acceptanceAuthority === 'agent-and-current-skill'
          && artifact.metadata?.programmaticBusinessAcceptance === false
          && artifact.metadata?.deliveryValidation === 'file-integrity-and-authorization-only'
          && artifact.metadata?.openXmlReadable === true),
        completed.artifacts.map((artifact) => JSON.stringify({
          reportMode: artifact.metadata?.reportMode,
          acceptanceAuthority: artifact.metadata?.acceptanceAuthority,
          deliveryValidation: artifact.metadata?.deliveryValidation,
        })).join(' | '),
      )
    }
    assert(`${item.type} 有来源记录`, completed.sources.length >= 1, `${completed.sources.length} 条`)
    assert(
      `${item.type} 产物记录 Skill 版本`,
      completed.artifacts.every((artifact) =>
        artifact.metadata?.skillName === item.skillName
        && typeof artifact.metadata?.skillVersion === 'string'
        && typeof artifact.metadata?.skillSha256 === 'string'),
      completed.artifacts.map((artifact) => String(artifact.metadata?.skillName)).join(','),
    )
    const downloadedFormats: string[] = []
    for (const artifact of completed.artifacts) {
      const response = await fetch(apiUrl(artifact.downloadUrl), {
        headers: { Cookie: adminAuth.cookie },
      })
      const byteLength = (await response.arrayBuffer()).byteLength
      if (
        response.status !== 200
        || byteLength <= 1_000
        || !(response.headers.get('content-disposition') || '').includes('filename*=UTF-8')
      ) {
        throw new Error(
          `${item.type} ${artifact.format} 下载校验失败：HTTP ${response.status} / ${byteLength} bytes`,
        )
      }
      downloadedFormats.push(artifact.format)
    }
    assert(
      `${item.type} 全部正式产物可鉴权下载`,
      downloadedFormats.length === completed.artifacts.length,
      downloadedFormats.join(','),
    )
  }

  const unsupportedLanguage = await fetch(apiUrl('/ai/tasks'), {
    method: 'POST',
    headers: {
      Cookie: adminAuth.cookie,
      'X-CSRF-Token': adminAuth.csrfToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...basePayload,
      type: 'investment_recommendation_ppt',
      parameters: {
        sourceCutoffDate: cutoff,
        outputFormat: 'PPTX',
        customTemplateId: investmentTemplate.id,
        customTemplateName: investmentTemplate.originalFileName,
        language: '英文',
        structureMode: 'strict-template',
      },
      idempotencyKey: `accept-invalid-ppt-${suffix}`,
    }),
  })
  assert('AI-009 首期拒绝非中文参数', unsupportedLanguage.status === 400, `HTTP ${unsupportedLanguage.status}`)

  const unsupportedDiligence = await fetch(apiUrl('/ai/tasks'), {
    method: 'POST',
    headers: {
      Cookie: adminAuth.cookie,
      'X-CSRF-Token': adminAuth.csrfToken,
      'Content-Type': 'application/json',
    },
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

  if (process.env.DB_HOST) {
    const taskTable = quoteMysqlIdentifier(mysqlTableName('ai_tasks'))
    const conversationTable = quoteMysqlIdentifier(mysqlTableName('chat_conversations'))
    {
      const cancelId = randomUUID()
      const failedId = randomUUID()
      await mysqlPool.query(
        `INSERT INTO ${taskTable}
          (id, user_id, project_id, conversation_id, type, parameters, template_version, status, stage, progress, idempotency_key, completed_at)
         SELECT ?, user_id, ?, ?, 'due_diligence_report', CAST(? AS JSON), 'dd-jialiang-202606-v1', 'pending', '等待执行', 0, ?, NULL
         FROM ${conversationTable} WHERE id=?`,
        [
          cancelId,
          project.id,
          conversation.id,
          JSON.stringify({ sourceCutoffDate: cutoff, outputFormat: 'DOCX', diligenceScope: '商业尽调' }),
          `accept-cancel-${suffix}`,
          conversation.id,
        ],
      )
      const { data: cancelled } = await request<Task>(`/ai/tasks/${cancelId}/cancel`, { method: 'POST' }, adminAuth)
      assert('待执行任务可取消', cancelled.status === 'cancelled', cancelled.status)

      if (validateProposalRetry) {
        await mysqlPool.query(
          `INSERT INTO ${taskTable}
            (id, user_id, project_id, conversation_id, type, parameters, template_version, status, stage, progress, idempotency_key, error_id, error_message, completed_at)
           SELECT ?, user_id, ?, ?, 'investment_proposal', CAST(? AS JSON), 'proposal-jialiang-20260622-v1', 'failed', '生成失败', 40, ?, 'AI-ACCEPTANCE-FAILURE', '验收注入的失败任务', NOW(3)
           FROM ${conversationTable} WHERE id=?`,
          [
            failedId,
            project.id,
            conversation.id,
            JSON.stringify({ sourceCutoffDate: cutoff, outputFormat: 'DOCX', audience: '内部立项', length: '标准版' }),
            `accept-failed-${suffix}`,
            conversation.id,
          ],
        )
        const { data: retried } = await request<Task>(`/ai/tasks/${failedId}/retry`, {
          method: 'POST',
          body: JSON.stringify({ idempotencyKey: `accept-retry-${suffix}` }),
        }, adminAuth, 202)
        const retryCompleted = await pollTask(adminAuth, retried.id)
        assert('失败任务创建新重试运行', retryCompleted.status === 'succeeded' && retryCompleted.retryOfTaskId === failedId, retryCompleted.id)
      }
    }
  }

  const { data: artifacts } = await request<{ list: Array<{ id: string }> }>(
    `/ai/artifacts?projectId=${encodeURIComponent(project.id)}`,
    {},
    adminAuth,
  )
  const expectedArtifactCount = selectedTaskInputs
    .reduce((sum, item) => sum + item.formats.length, 0)
    + (validateProposalRetry ? 1 : 0) // 投资建议书专项额外验证失败任务重试产物
  assert(
    '交付物中心按项目返回正式产物',
    artifacts.list.length >= expectedArtifactCount,
    `${artifacts.list.length} 个 / 至少 ${expectedArtifactCount} 个`,
  )

  const artifactToDelete = artifacts.list[0]
  if (artifactToDelete) {
    await request(`/ai/artifacts/${artifactToDelete.id}`, { method: 'DELETE' }, adminAuth, 204)
    const { data: afterDelete } = await request<{ list: Array<{ id: string }> }>(
      `/ai/artifacts?projectId=${encodeURIComponent(project.id)}`,
      {},
      adminAuth,
    )
    assert(
      '删除正式交付物后列表立即隐藏',
      !afterDelete.list.some((artifact) => artifact.id === artifactToDelete.id),
      artifactToDelete.id,
    )
    await request(
      `/ai/artifacts/${artifactToDelete.id}/download`,
      {},
      adminAuth,
      404,
    )
    assert('已删除正式交付物不可继续下载', true, artifactToDelete.id)
  }

  await outputReport('全量验收必须对隔离测试数据库运行；脱敏项目、会话和任务记录会在验收结束时自动清理。')
}

const cleanupState: AcceptanceCleanupState = { userIds: [], templateDirectories: [] }

async function run() {
  try {
    await main(cleanupState)
  } finally {
    await cleanupAcceptanceResources(cleanupState)
    await mysqlPool.end()
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
