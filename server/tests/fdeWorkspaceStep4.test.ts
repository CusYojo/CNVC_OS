import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { publicApiErrorMessage } from '../src/contracts/apiErrorContract.js'
import { isAiPlatformAdminRole, isSystemAdminRole } from '../src/contracts/adminRoleContract.js'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('global visual rules keep business pages readable and responsive', () => {
  const styles = source('src/styles.css')
  const shell = source('src/layout/fde-shell.css')
  const collaboration = source('src/pages/CollaborationPage.css')
  assert.match(styles, /min-width:\s*320px/)
  assert.doesNotMatch(styles, /min-width:\s*1180px/)
  assert.match(shell, /@media \(max-width: 900px\)/)
  assert.match(shell, /\.fde-ui-modal, \.fde-app \.fde-ui-drawer[^}]+box-shadow:\s*var\(--shadow-lg\)/s)
  assert.match(shell, /\.fde-app \.fde-ui-card[^}]+box-shadow:\s*none/s)
  assert.match(shell, /\.fde-app \.fde-ui-button\[data-variant="primary"\][^}]+box-shadow:\s*none/s)
  assert.match(collaboration, /@media \(max-width: 900px\)[^{]*\{[\s\S]*?\.fde-task-table \{ display: block; min-width: 0;/)
})

test('public API errors hide implementation details and resolve concurrent edits', () => {
  const requestId = '76b61240-b524-4a1b-be74-b03468558cb5'
  const sha = 'a'.repeat(64)
  assert.equal(publicApiErrorMessage(500, 'INTERNAL', `服务器内部错误（请求编号：${requestId}）`), '服务暂时不可用，请稍后重试')
  assert.equal(publicApiErrorMessage(409, 'VERSION_CONFLICT', 'HTTP 409'), '内容已被其他人更新，请刷新后重试')
  assert.equal(publicApiErrorMessage(400, 'BAD_FILE', `文件 ${sha} 不可用`), '文件不可用')
})

test('task, project and calendar surfaces use the same task source', () => {
  const project = source('src/pages/ProjectDetailPage.tsx')
  const dashboard = source('src/pages/DashboardPage.tsx')
  const taskSystem = source('src/components/task/TaskSystem.tsx')
  const workbench = source('server/src/services/fdeWorkbenchService.ts')
  assert.match(project, /incompleteTaskCount=\{project\.workflowModel === 'fde-v1' \? canonicalTaskCount/)
  assert.doesNotMatch(project, /canonicalTaskCount \?\? legacyOpenTaskCount/)
  assert.match(dashboard, /<TaskDrawer taskId=\{selectedTaskId\}/)
  assert.match(taskSystem, /export function TaskDrawer/)
  assert.match(workbench, /project\.classification === 'key'/)
  assert.match(dashboard, /data\.actions\.filter\(action => action\.dueDate === data\.today\)/)
})

test('ordinary roles cannot enter system settings and AI diagnostics remain privileged', () => {
  for (const role of ['董事长', '合伙人', '投资经理', '法务', '风控', '董秘']) {
    assert.equal(isSystemAdminRole(role), false)
    assert.equal(isAiPlatformAdminRole(role), false)
  }
  assert.equal(isSystemAdminRole('系统管理员'), true)
  const app = source('src/App.tsx')
  const layout = source('src/layout/AppLayout.tsx')
  const auth = source('server/src/middleware/requireAuth.ts')
  assert.match(app, /<SystemAdminOnly><SystemPage/)
  assert.match(app, /<AiPlatformAdminOnly><ModelSettingsPage/)
  assert.match(layout, /isSystemAdminRole\(currentUser\.role\)/)
  assert.match(auth, /isSystemAdminRole\(req\.user\.role\)/)
  assert.match(auth, /isAiPlatformAdminRole\(req\.user\.role\)/)
})

test('meeting participants are the source for reminders, access and generated tasks', () => {
  const service = source('server/src/services/meetingService.ts')
  const routes = source('server/src/routes/meetings.ts')
  assert.match(service, /meetingParticipants\.userId/)
  assert.match(service, /MEETING_TASK_OWNER_NOT_PARTICIPANT/)
  assert.match(service, /prepareFdeTodo/)
  assert.match(service, /meetingWorkflowNotices/)
  assert.match(routes, /\/:id\/finalize/)
  assert.match(routes, /\/:id\/notices\/:noticeId\/read/)
})

test('business surfaces no longer expose tiny text or technical identifiers', () => {
  const files = [
    'src/pages/DashboardPage.tsx',
    'src/pages/ProjectDetailPage.tsx',
    'src/pages/WorkflowPage.tsx',
    'src/pages/MeetingsPage.tsx',
    'src/pages/DataKnowledgePage.tsx',
    'src/components/FdeOfficePanel.tsx',
    'src/components/FdeWeeklyReportPanel.tsx',
    'src/components/FdeFilePanel.tsx',
  ]
  const combined = files.map(source).join('\n')
  assert.doesNotMatch(combined, /text-\[(?:8|9|10|11)px\]/)
  assert.doesNotMatch(combined, /SHA-?256/)
  assert.doesNotMatch(combined, />collaborator</i)
  assert.doesNotMatch(combined, /同一会话内 AI 记住上下文/)
  assert.doesNotMatch(combined, /项目审批与阶段看板/)
  assert.doesNotMatch(combined, />\s*Close\s*</)
})
