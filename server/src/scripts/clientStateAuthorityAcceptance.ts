import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type JsonValue = Record<string, unknown>

const checks: string[] = []
function check(name: string, assertion: () => void) {
  assertion()
  checks.push(name)
}

const appStoreSource = await readFile(path.resolve('src/store/useAppStore.ts'), 'utf8')
const auditServiceSource = await readFile(path.resolve('server/src/services/auditService.ts'), 'utf8')
const appRoutesSource = await readFile(path.resolve('src/App.tsx'), 'utf8')
const appLayoutSource = await readFile(path.resolve('src/layout/AppLayout.tsx'), 'utf8')
const loginPageSource = await readFile(path.resolve('src/pages/LoginPage.tsx'), 'utf8')
const systemPageSource = await readFile(path.resolve('src/pages/SystemPage.tsx'), 'utf8')
const operationsOverviewSource = await readFile(path.resolve('src/components/OperationsOverview.tsx'), 'utf8')
const dashboardPageSource = await readFile(path.resolve('src/pages/DashboardPage.tsx'), 'utf8')
const projectsPageSource = await readFile(path.resolve('src/pages/ProjectsPage.tsx'), 'utf8')
const meetingsPageSource = await readFile(path.resolve('src/pages/MeetingsPage.tsx'), 'utf8')
const sourcingPageSource = await readFile(path.resolve('src/pages/SourcingPage.tsx'), 'utf8')
const projectModalSource = await readFile(path.resolve('src/components/ProjectModal.tsx'), 'utf8')
const meetingRoutesSource = await readFile(path.resolve('server/src/routes/meetings.ts'), 'utf8')
const aiServiceSource = await readFile(path.resolve('server/src/services/aiService.ts'), 'utf8')
const apiRoutesSource = await readFile(path.resolve('server/src/routes/index.ts'), 'utf8')
const risksPageSource = await readFile(path.resolve('src/pages/RisksPage.tsx'), 'utf8')
const projectDetailSource = await readFile(path.resolve('src/pages/ProjectDetailPage.tsx'), 'utf8')
const knowledgePageSource = await readFile(path.resolve('src/pages/KnowledgePage.tsx'), 'utf8')
const projectRoutesSource = await readFile(path.resolve('server/src/routes/projects.ts'), 'utf8')
const leadIntakeRoutesSource = await readFile(path.resolve('server/src/routes/leadIntake.ts'), 'utf8')
const leadIntakeServiceSource = await readFile(path.resolve('server/src/services/leadIntakeService.ts'), 'utf8')
// Resolve frontend modules only when this acceptance script executes. A static
// import would pull the Vite source tree into the server production rootDir.
const appStoreModuleUrl = pathToFileURL(path.resolve('src/store/useAppStore.ts')).href
const authStoreModuleUrl = pathToFileURL(path.resolve('src/store/useAuthStore.ts')).href
const { useAppStore } = await import(appStoreModuleUrl)
const { useAuthStore } = await import(authStoreModuleUrl)

check('store-does-not-import-demo-business-data', () => {
  assert.doesNotMatch(appStoreSource, /(?:\.\.\/mock\/data|src\/mock\/data)/)
  assert.doesNotMatch(appStoreSource, /auditLogs:\s*\[log,\s*\.\.\.state\.auditLogs\]/)
})
check('store-does-not-persist-business-state-in-browser-storage', () => {
  assert.doesNotMatch(
    appStoreSource,
    /from\s+['"]zustand\/middleware['"]|\bpersist\s*\(\s*\(|\b(?:localStorage|sessionStorage)\s*\./,
  )
})
check('server-audit-writes-to-mysql-not-process-memory', () => {
  assert.match(auditServiceSource, /db\.insert\(auditLogs\)/)
  assert.doesNotMatch(auditServiceSource, /mockAuditLogs|new Map|new Set/)
})
check('unmigrated-local-only-pages-are-not-directly-reachable', () => {
  assert.match(appRoutesSource, /path="\/materials" element=\{<Navigate to="\/ai" replace \/>\}/)
  assert.match(appRoutesSource, /path="\/post-investment" element=\{<Navigate to="\/projects" replace \/>\}/)
  assert.doesNotMatch(appRoutesSource, /import \{ (?:MaterialsPage|PostInvestmentPage) \}/)
})
check('retired-local-domains-are-removed-from-project-ui-and-store', () => {
  assert.doesNotMatch(projectDetailSource, /materialJobs|postUpdates|id: 'materials'|id: 'post'|\/materials\?/)
  assert.doesNotMatch(appStoreSource, /materialJobs|postUpdates|addMaterialJob|updateMaterialJob|addPostUpdate/)
  assert.doesNotMatch(projectDetailSource, /生成 AI 摘要|>生成摘要</)
})
check('system-page-writes-only-through-audited-mysql-admin-apis', () => {
  assert.match(systemPageSource, /MySQL 权威数据/)
  for (const domain of ['users', 'org', 'roles', 'dicts', 'templates', 'audit']) {
    assert.match(systemPageSource, new RegExp(`id: '${domain}'`))
  }
  for (const endpoint of [
    '/system-administration', '/system-administration/departments', '/system-administration/roles',
    '/system-administration/dictionaries', '/reset-password',
  ]) assert.match(systemPageSource, new RegExp(endpoint.replaceAll('/', '\\/')))
  assert.doesNotMatch(systemPageSource, /addAudit|toggleUserStatus|演示版本|用户已创建并分配默认权限/)
})
check('system-migration-operations-view-is-admin-read-only-and-fails-closed', () => {
  assert.match(systemPageSource, /id: 'operations'/)
  assert.match(systemPageSource, /<OperationsOverview \/>/)
  assert.match(operationsOverviewSource, /apiGet<OperationsSnapshot>\('\/operations\/metrics'\)/)
  assert.match(operationsOverviewSource, /CDC watermark gap/)
  assert.match(operationsOverviewSource, /Radar 候选 \/ 原始事件/)
  assert.match(operationsOverviewSource, /文件 manifest/)
  for (const component of ['MySQL', 'Worker', 'Socket', 'Agent', 'IM']) {
    assert.match(operationsOverviewSource, new RegExp(`'${component}'`))
  }
  assert.match(operationsOverviewSource, /统一服务组件健康/)
  assert.match(operationsOverviewSource, /workers\.length === 4/)
  assert.match(operationsOverviewSource, /deliveryFailures15m/)
  assert.match(operationsOverviewSource, /全量迁移未就绪/)
  assert.match(operationsOverviewSource, /不返回路径、文件名、业务正文、审批人或凭据/)
  assert.doesNotMatch(operationsOverviewSource, /apiPost|apiPut|apiPatch|apiDelete|setInterval/)
})
check('login-does-not-prefill-or-publish-weak-demo-credentials', () => {
  assert.match(loginPageSource, /useState\(''\)/)
  assert.doesNotMatch(loginPageSource, /123456|演示账号|lin@cybernaut\.com|admin@cybernaut\.com/)
})
check('notification-affordance-stays-hidden-without-server-authority', () => {
  assert.doesNotMatch(appLayoutSource, /markNotificationsRead|showNotifications|aria-label="通知"/)
})
check('dashboard-metrics-are-derived-from-authoritative-state', () => {
  assert.match(dashboardPageSource, /projectsCreatedThisWeek/)
  assert.match(dashboardPageSource, /priorityTodoCount/)
  assert.match(dashboardPageSource, /dueToday/)
  assert.doesNotMatch(dashboardPageSource, /\+ 2|本周新增 2 个|本周已生成 5 份|今日到期 2 项|有 <strong[^>]*>2 项/)
  assert.doesNotMatch(dashboardPageSource, /to: '\/materials'/)
})
check('meeting-page-fails-closed-without-manufacturing-business-content', () => {
  assert.match(meetingsPageSource, /未保存会议或待办，请重试/)
  assert.match(meetingsPageSource, /selected\.rawText/)
  assert.doesNotMatch(meetingsPageSource, /已生成占位纪要|音频模拟转写|项目继续推进，当前不形成最终投资结论/)
  assert.doesNotMatch(meetingsPageSource, /rawText:\s*'会议围绕|showToast\('纪要已导出为 Word 文档'\)/)
})
check('meeting-todos-preserve-explicit-owner-and-due-date', () => {
  assert.match(aiServiceSource, /todos 对象数组/)
  assert.match(aiServiceSource, /normalizeMeetingTodo/)
  assert.match(meetingsPageSource, /inferTodoOwner/)
  assert.match(meetingsPageSource, /normalizeExplicitDate\(item\.dueDate\) \|\| normalizeExplicitDate\(item\.title\)/)
  assert.doesNotMatch(meetingsPageSource, /owner:\s*currentUser\.name,\s*\n\s*dueDate:/)
})
check('formal-ui-uses-authoritative-bp-and-batch-import-jobs', () => {
  assert.match(leadIntakeRoutesSource, /\/leads\/imports\/:id\/commit/)
  assert.match(leadIntakeRoutesSource, /\/leads\/bp-uploads/)
  assert.match(leadIntakeServiceSource, /recordLeadPipelineRawEvent/)
  assert.match(leadIntakeServiceSource, /commitRadarLeadPipelineReady/)
  assert.match(leadIntakeServiceSource, /startLeadBpWorker/)
  assert.doesNotMatch(sourcingPageSource, /\/leads\/imports|\/leads\/bp-uploads|批量导入|上传 BP/)
  assert.doesNotMatch(sourcingPageSource, /批量导入模板已准备|setTimeout\(async|score:\s*76/)
  assert.doesNotMatch(sourcingPageSource, /刷新核验|updateLead\(/)
  assert.doesNotMatch(appStoreSource, /apiPatch<Lead>\(`\/leads\/\$\{leadId\}`/)
  assert.doesNotMatch(meetingRoutesSource, /\/bp-parse|MVP 期间|\/jobs\/:id/)
})
check('project-and-meeting-creation-do-not-write-manufactured-fallbacks', () => {
  assert.doesNotMatch(projectModalSource, /项目已创建，等待上传 BP|\$\{form\.name\}有限公司|待 BP 解析后补充/)
  assert.match(projectModalSource, /summary:\s*form\.summary\.trim\(\)/)
  assert.match(aiServiceSource, /meetingSummary failed/)
  assert.doesNotMatch(aiServiceSource, /summary:\s*`会议纪要生成失败/)
})
check('project-page-awaits-authoritative-writes-and-hides-unimplemented-actions', () => {
  const listEditBlock = projectsPageSource.slice(
    projectsPageSource.indexOf('const saveEdit = async'),
    projectsPageSource.indexOf('const handlePin = async'),
  )
  const detailEditBlock = projectDetailSource.slice(
    projectDetailSource.indexOf('const saveProjectEdit = async'),
    projectDetailSource.indexOf('const tabContent:'),
  )
  assert.match(listEditBlock, /await updateProject\(editing\.id, \{/)
  assert.match(detailEditBlock, /await updateProject\(editingProject\.id, \{/)
  assert.match(listEditBlock, /name: editing\.name/)
  assert.match(detailEditBlock, /name: editingProject\.name/)
  assert.doesNotMatch(listEditBlock, /\bowner\s*:|\bcollaborators\s*:/)
  assert.doesNotMatch(detailEditBlock, /\bowner\s*:|\bcollaborators\s*:/)
  assert.match(projectsPageSource, /await pinProject\(project\.id, !project\.pinned\)/)
  assert.match(projectsPageSource, /Number\(Boolean\(b\.pinned\)\) - Number\(Boolean\(a\.pinned\)\)/)
  assert.match(projectsPageSource, /aria-label="已置顶"/)
  assert.match(projectsPageSource, /await deleteProject\(pendingDelete\.id\)/)
  assert.match(projectsPageSource, /title="确认删除项目"/)
  assert.doesNotMatch(projectsPageSource, /window\.confirm|导出任务已创建|批量导入模板已准备|>导出<|>批量导入|批量分配|批量标签操作已完成|自定义字段/)
})
check('llm-health-uses-the-same-authenticated-gateway-config-as-runtime', () => {
  assert.match(apiRoutesSource, /process\.env\.LLM_BASE_URL \|\| process\.env\.OPENAI_BASE_URL/)
  assert.match(apiRoutesSource, /process\.env\.LLM_API_KEY \|\| process\.env\.OPENAI_API_KEY/)
  assert.match(apiRoutesSource, /Authorization: `Bearer \$\{apiKey\}`/)
  assert.match(apiRoutesSource, /body: '\{\}'/)
  assert.match(apiRoutesSource, /r\.status === 400 \|\| r\.status === 422/)
  assert.doesNotMatch(apiRoutesSource, /fetch\(`\$\{base\}\/models`/)
})
check('lead-conversion-is-one-server-transaction-without-fake-artifacts', () => {
  const conversionBlock = appStoreSource.slice(
    appStoreSource.indexOf('convertLead: async'),
    appStoreSource.indexOf('saveSummary: async'),
  )
  assert.match(conversionBlock, /apiPost<\{ project: Project; lead: Lead \}>\(`\/leads\/\$\{leadId\}\/convert`\)/)
  assert.doesNotMatch(conversionBlock, /addProject|saveSummary|addFile|8\.6 MB|256 KB|待尽调补充|待行业研究补充/)
})
check('ai-and-risk-pages-fail-closed-without-fake-advice-or-timeline', () => {
  assert.doesNotMatch(aiServiceSource, /已回退到受限回复|目标场景明确|形成早期客户验证|项目基础信息|projectSummary fallback/)
  assert.doesNotMatch(meetingRoutesSource, /\/project-summary/)
  assert.doesNotMatch(risksPageSource, /AI 影响分析与处置建议|系统创建风险事件并通知负责人|刚刚|10:20|建议获取原始材料并由项目负责人/)
  assert.doesNotMatch(projectDetailSource, /AI 处置建议|risk\.suggestion/)
})
check('risk-create-uses-the-mysql-hydrated-project-uuid', () => {
  assert.match(risksPageSource, /addRisk\(\{ \.\.\.form, projectId: project\.id, projectName: project\.name/)
  assert.doesNotMatch(risksPageSource, /addRisk\(\{ \.\.\.form, projectName: project\.name/)
})
check('knowledge-upload-persists-real-bytes-without-fake-parse-success', () => {
  assert.match(knowledgePageSource, /'\/projects\/files\/upload'/)
  assert.match(knowledgePageSource, /dataBase64/)
  assert.doesNotMatch(knowledgePageSource, /finishFileParsing|window\.setTimeout|资料解析完成，已可被 AI 检索|向量检索正常|音频 \/ 视频/)
  assert.doesNotMatch(projectRoutesSource, /projectsRouter\.post\('\/files',/)
  assert.doesNotMatch(projectRoutesSource, /\/files\/:id\/parse-finish/)
  assert.doesNotMatch(projectDetailSource, /const defaultSummary|目标场景具备较高匹配度|最近两年审计财务报表/)
})
check('knowledge-grid-allows-the-authoritative-file-table-to-shrink', () => {
  assert.match(knowledgePageSource, /grid-cols-\[270px_minmax\(0,1fr\)\]/)
  assert.doesNotMatch(knowledgePageSource, /grid-cols-\[270px_1fr\]/)
})

check('initial-business-state-is-empty', () => {
  const state = useAppStore.getState()
  for (const key of [
    'projects', 'files', 'aiSummaries', 'todos', 'meetings', 'risks', 'workflowLogs',
    'approvalRequests', 'leads', 'users', 'templates',
    'auditLogs', 'notifications',
  ] as const) assert.deepEqual(state[key], [], `${key} must start empty`)
})

const authUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'authority@example.com',
  name: '权威源验收用户',
  role: '系统管理员',
  department: '迁移验收',
  status: '启用',
}
useAuthStore.getState().setAuth({ user: authUser })
useAppStore.setState({
  meetings: [{ id: 'stale-browser-meeting' }] as never,
  approvalRequests: [{ id: 'stale-browser-approval' }] as never,
  notifications: [{ id: 'stale-browser-notification' }] as never,
  templates: [{ id: 'stale-browser-template' }] as never,
})

const serverProject = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'MySQL 项目',
}
const serverTemplate = {
  id: 'investment_proposal', name: '投资提案', type: 'docx', version: 'v1',
  status: '启用', updatedAt: '2026-08-09T00:00:00.000Z',
}
const serverAudit = {
  id: '33333333-3333-4333-8333-333333333333', user: authUser.name,
  module: '迁移验收', action: '读取权威源', target: 'MySQL', ip: '127.0.0.1',
  createdAt: '2026-08-09T00:00:00.000Z',
}

const originalFetch = globalThis.fetch
globalThis.fetch = async (input) => {
  const url = String(input)
  const ok = (body: JsonValue) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  if (url.endsWith('/api/projects')) return ok({ list: [serverProject] })
  if (url.endsWith('/api/templates')) return ok({ list: [serverTemplate] })
  if (url.endsWith('/api/audit-logs')) return ok({ list: [serverAudit] })
  // A failed authoritative read must clear stale browser data instead of preserving it.
  if (url.endsWith('/api/meetings')) return new Response(JSON.stringify({ code: 'READ_FAILED', message: 'fixture' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  })
  return ok({ list: [] })
}

try {
  await useAppStore.getState().hydrateFromServer()
  check('mysql-hydration-replaces-browser-state-and-fails-empty', () => {
    const state = useAppStore.getState()
    assert.equal(state.projects[0]?.id, serverProject.id)
    assert.deepEqual(state.meetings, [])
    assert.equal(state.templates[0]?.id, serverTemplate.id)
    assert.equal(state.auditLogs[0]?.id, serverAudit.id)
    assert.deepEqual(state.approvalRequests, [])
    assert.deepEqual(state.notifications, [])
    assert.equal(state.currentUser.id, authUser.id)
  })
} finally {
  globalThis.fetch = originalFetch
}

useAppStore.getState().logout()
check('logout-clears-cross-user-business-state', () => {
  const state = useAppStore.getState()
  assert.equal(state.isAuthenticated, false)
  assert.equal(state.currentUser.id, '')
  assert.deepEqual(state.projects, [])
  assert.deepEqual(state.auditLogs, [])
  assert.deepEqual(state.templates, [])
})

console.log(JSON.stringify({ ok: true, checks: checks.length, names: checks }))
