import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { aiBusinessErrorMessage } from '../../src/lib/aiBusinessError.js'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('approval workspace separates project and office flows with compact business views', () => {
  const workflow = source('src/pages/WorkflowPage.tsx')
  const office = source('src/components/FdeOfficePanel.tsx')
  assert.match(workflow, />项目审批<\/button>/)
  assert.match(workflow, />办公申请<\/button>/)
  for (const label of ['待我审批', '我发起的', '阶段看板', '全部记录']) assert.match(workflow, new RegExp(label))
  for (const label of ['待我处理', '我发起的', '已处理', '草稿']) assert.match(office, new RegExp(label))
  assert.doesNotMatch(office, /项目审批与阶段看板/)
})

test('meeting lifecycle and minutes-to-task endpoints are implemented end to end', () => {
  const page = source('src/pages/MeetingsPage.tsx')
  const routes = source('server/src/routes/meetings.ts')
  const service = source('server/src/services/meetingService.ts')
  const migration = source('server/drizzle/0096_allow_legacy_meeting_lifecycle.sql')
  for (const status of ['待开始', '进行中', '已结束', '已取消']) assert.match(page, new RegExp(status))
  assert.match(page, /会前资料/)
  assert.match(page, /确认纪要并同步任务/)
  assert.match(routes, /\/:id\/lifecycle/)
  assert.match(routes, /workflowStatus: 'scheduled'/)
  assert.match(routes, /\/:id\/finalize/)
  assert.match(service, /prepareFdeTodo/)
  assert.match(service, /'in_progress'/)
  assert.match(migration, /`workflow_kind`='legacy' AND `workflow_status` IN \('recorded','scheduled','in_progress','completed','cancelled'\)/)
})

test('knowledge and AI surfaces use business language and keep diagnostics behind admin checks', () => {
  const knowledge = source('src/pages/DataKnowledgePage.tsx')
  const ai = source('src/pages/AIAssistantPage.tsx')
  const actions = source('src/components/AiQuickActions.tsx')
  assert.match(knowledge, /<h1>知识库<\/h1>/)
  assert.match(actions, /常用工具/)
  for (const label of ['投资提案', '投资建议书', '尽调报告', '合规说明', '项目问答', '上传模板']) assert.match(actions, new RegExp(label))
  assert.match(ai, /showAiDiagnostics && <span className="font-mono/)
  assert.equal(aiBusinessErrorMessage(new Error('429 insufficient quota')), 'AI 服务暂不可用，请联系管理员')
  assert.equal(aiBusinessErrorMessage(new Error('request timeout')), '生成时间较长，请稍后重试')
  assert.equal(aiBusinessErrorMessage(new Error('unsupported file format')), '暂不支持该文件格式')
})

test('AI new-session dialog remains dismissible when the user has no projects or sessions', () => {
  const ai = source('src/pages/AIAssistantPage.tsx')
  assert.match(ai, /onClose=\{\(\) => \{ if \(!creatingSession\) setNewSessionOpen\(false\) \}\}/)
  assert.match(ai, /<Button variant="secondary" onClick=\{\(\) => setNewSessionOpen\(false\)\} disabled=\{creatingSession\}>/)
  assert.match(ai, /\{projects\.length === 0 && <p role="status"[^>]*>当前账号暂无可用项目，暂时不能创建项目会话。<\/p>\}/)
  assert.doesNotMatch(ai, /if \(!creatingSession && sessions\.length > 0\) setNewSessionOpen/)
})
