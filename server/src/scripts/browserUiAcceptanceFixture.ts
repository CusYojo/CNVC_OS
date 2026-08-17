import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  agentConversations,
  agentMessageParts,
  agentMessages,
  authSessions,
  auditLogs,
  chatConversations,
  identityResolutionIssues,
  knowledgeChunks,
  leadPipelineItems,
  leads,
  meetings,
  projectMembers,
  projects,
  risks,
  todos,
  users,
} from '../db/schema.js'
import { hashNewPassword } from '../security/passwordPolicy.js'
import { identityRepositories } from '../repositories/index.js'
import { transitionLeadPipelineItem } from '../services/leadPipelineEventService.js'
import { deleteProject } from '../services/projectService.js'

const secretDirectory = path.resolve(process.cwd(), '.runtime', 'secrets')
const fixtureFile = path.resolve(secretDirectory, 'browser-ui-acceptance.json')
const uploadFixtureFile = path.resolve(secretDirectory, 'browser-ui-smoke-upload.txt')

type Fixture = {
  schemaVersion: '1.4'
  adminId: string
  ordinaryUserId: string
  projectId: string
  leadId: string
  renderConversationId: string
  renderAgentId: string
  email: string
  password: string
}

async function cleanupFixture(fixture: Fixture) {
  const userIds = [fixture.adminId, fixture.ordinaryUserId]
  await db.delete(agentConversations).where(eq(agentConversations.id, fixture.renderConversationId)).catch(() => undefined)
  await db.delete(chatConversations).where(eq(chatConversations.id, fixture.renderConversationId)).catch(() => undefined)
  const ownedMeetings = await db.select({ id: meetings.id }).from(meetings)
    .where(inArray(meetings.createdBy, userIds))
  const ownedTodos = await db.select({ id: todos.id }).from(todos)
    .where(inArray(todos.createdBy, userIds))
  const ownedRisks = await db.select({ id: risks.id }).from(risks)
    .where(inArray(risks.createdBy, userIds))
  const ownedProjects = await db.select({ id: projects.id }).from(projects)
    .where(inArray(projects.createdBy, userIds))
  const identityEntityIds = [
    ...ownedMeetings.map((item) => item.id),
    ...ownedTodos.map((item) => item.id),
    ...ownedRisks.map((item) => item.id),
    ...ownedProjects.map((item) => item.id),
  ]
  if (identityEntityIds.length) {
    await db.delete(identityResolutionIssues)
      .where(inArray(identityResolutionIssues.entityId, identityEntityIds))
  }
  if (ownedMeetings.length) {
    const meetingIds = ownedMeetings.map((meeting) => meeting.id)
    await db.delete(knowledgeChunks).where(and(
      eq(knowledgeChunks.sourceType, 'meeting'),
      inArray(knowledgeChunks.sourceId, meetingIds),
    ))
    await db.delete(todos).where(inArray(todos.meetingId, meetingIds))
    await db.delete(meetings).where(inArray(meetings.id, meetingIds))
  }
  await db.delete(todos).where(inArray(todos.createdBy, userIds))
  await db.delete(risks).where(inArray(risks.createdBy, userIds))
  for (const project of ownedProjects) await deleteProject(project.id, fixture.adminId)
  const pipelineItems = await db.select({ eventId: leadPipelineItems.eventId, status: leadPipelineItems.status })
    .from(leadPipelineItems)
    .where(eq(leadPipelineItems.leadId, fixture.leadId))
  for (const item of pipelineItems) {
    let status = item.status
    if (status === 'ready' || status === 'rejected') {
      const review = await transitionLeadPipelineItem(item.eventId, {
        status: 'review',
        reason: 'browser acceptance fixture cleanup',
        actorType: 'system',
      })
      status = review.item.status
    }
    if (status !== 'failed') {
      await transitionLeadPipelineItem(item.eventId, {
        status: 'failed',
        reason: 'browser acceptance fixture source removed after isolated UI verification',
        error: 'browser acceptance fixture cleanup',
        actorType: 'system',
      })
    }
  }
  await db.delete(leads).where(eq(leads.id, fixture.leadId))
  await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds))
  await db.delete(authSessions).where(inArray(authSessions.userId, userIds))
  await db.delete(users).where(inArray(users.id, userIds))
  return identityEntityIds
}

async function setup() {
  await mkdir(secretDirectory, { recursive: true, mode: 0o700 })
  await chmod(secretDirectory, 0o700)
  await writeFile(uploadFixtureFile, '浏览器迁移冒烟文件\n用于验证私有原件、正文提取和项目范围知识块。\n', {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  })
  const marker = randomUUID()
  const password = `Browser-A9!-${marker}`
  const [admin] = await db.insert(users).values({
    email: `browser-admin-${marker}@example.invalid`,
    name: `浏览器管理员-${marker.slice(0, 8)}`,
    role: '系统管理员',
    department: '验收部',
    passwordHash: await hashNewPassword(password),
  }).$returningId()
  const [ordinary] = await db.insert(users).values({
    email: `browser-user-${marker}@example.invalid`,
    name: `浏览器用户-${marker.slice(0, 8)}`,
    role: '投资经理',
    department: '验收部',
    passwordHash: await hashNewPassword(`Browser-U8!-${marker}`),
  }).$returningId()
  await identityRepositories.transaction(async ({ users: userRepository }) => {
    await userRepository.synchronizeAdministrationBindings(admin.id, '系统管理员', '验收部')
    await userRepository.synchronizeAdministrationBindings(ordinary.id, '投资经理', '验收部')
  })
  const [project] = await db.insert(projects).values({
    name: `浏览器验收项目-${marker.slice(0, 8)}`,
    companyName: `浏览器验收公司-${marker.slice(0, 8)}`,
    industry: '软件与信息服务',
    owner: `浏览器管理员-${marker.slice(0, 8)}`,
    ownerUserId: admin.id,
    collaborators: [],
    stage: '初筛',
    stageSource: '浏览器验收夹具',
    progress: 25,
    createdBy: admin.id,
  }).$returningId()
  await db.insert(projectMembers).values({
    projectId: project.id,
    userId: admin.id,
    memberRole: 'owner',
    sourceName: `浏览器管理员-${marker.slice(0, 8)}`,
  })
  const leadId = randomUUID()
  await db.insert(leads).values({
    id: leadId,
    name: `浏览器验收线索-${marker.slice(0, 8)}`,
    companyName: `浏览器验收线索公司-${marker.slice(0, 8)}`,
    industry: '先进制造',
    businessRegion: '浙江',
    businessRegionSource: 'browser-acceptance-fixture',
    businessRegionConfidence: 'high',
    source: '浏览器验收夹具',
    poolStatus: '成功',
    score: 73,
    summary: '仅用于线索筛选、详情与转项目浏览器验收。',
    highlights: ['验收夹具亮点'],
    risks: ['验收夹具风险'],
    team: '验收夹具团队',
    fundingRounds: [{ round: 'A轮', amount: '人民币1亿元', valuation: '人民币5亿元' }],
    riskTags: ['客户集中度待核验'],
    radarProfile: { channel: '机构公众号', profile: { project_name: `浏览器验收线索-${marker.slice(0, 8)}` } },
  })
  const renderConversationId = randomUUID()
  const renderAgentId = `browser-render-${marker}`
  const renderMessageId = randomUUID()
  await db.insert(chatConversations).values({
    id: renderConversationId,
    userId: admin.id,
    title: 'AI 消息渲染验收',
    scope: 'global',
    agentId: renderAgentId,
    messages: [],
  })
  await db.insert(agentConversations).values({
    id: renderConversationId,
    userId: admin.id,
    title: 'AI 消息渲染验收',
    scope: 'global',
    status: 'idle',
    runtime: 'jw',
    externalSessionId: renderAgentId,
    metadata: { acceptanceFixture: 'chat-rendering-v1' },
  })
  const markdown = [
    '# 渲染验收标题',
    '',
    '普通文本与 **加粗文本**。',
    '',
    '| 指标 | 结果 |',
    '| --- | --- |',
    '| Markdown 表格 | 通过 |',
    '',
    '```ts',
    'const answer: number = 42',
    '```',
    '',
    '[安全链接](https://example.invalid/render-source)',
    '',
    '[危险链接](javascript:alert(1))',
  ].join('\n')
  await db.insert(agentMessages).values({
    id: renderMessageId,
    conversationId: renderConversationId,
    externalMessageId: `browser-render-message-${marker}`,
    role: 'assistant',
    sequence: 0,
    content: markdown,
    thinking: `仅用于折叠验证的内部思考-${marker}`,
    status: 'complete',
  })
  await db.insert(agentMessageParts).values([
    { messageId: renderMessageId, partIndex: 0, type: 'reasoning', content: `仅用于折叠验证的内部思考-${marker}` },
    { messageId: renderMessageId, partIndex: 1, type: 'text', content: markdown },
  ])
  const toolFixtures = [
    {
      id: randomUUID(), sequence: 1, externalMessageId: `browser-tool-running-${marker}`,
      status: 'running', query: '工具进度验收-运行中', state: 'input-available',
      output: null, errorText: '',
    },
    {
      id: randomUUID(), sequence: 2, externalMessageId: `browser-tool-success-${marker}`,
      status: 'complete', query: '工具进度验收-成功', state: 'output-available',
      output: { hits: 2, summary: '合成成功结果' }, errorText: '',
    },
    {
      id: randomUUID(), sequence: 3, externalMessageId: `browser-tool-error-${marker}`,
      status: 'error', query: '工具进度验收-失败', state: 'output-error',
      output: { message: '合成的工具错误' }, errorText: '合成的工具错误',
    },
  ] as const
  await db.insert(agentMessages).values(toolFixtures.map((tool) => ({
    id: tool.id,
    conversationId: renderConversationId,
    externalMessageId: tool.externalMessageId,
    role: 'tool',
    sequence: tool.sequence,
    toolName: 'search_project_docs',
    toolInput: { query: tool.query },
    toolOutput: tool.output,
    status: tool.status,
  })))
  await db.insert(agentMessageParts).values(toolFixtures.map((tool) => ({
    messageId: tool.id,
    partIndex: 0,
    type: 'dynamic-tool',
    payload: {
      type: 'dynamic-tool',
      toolName: 'search_project_docs',
      state: tool.state,
      input: { query: tool.query },
      output: tool.output,
      errorText: tool.errorText,
    },
  })))
  const fixture: Fixture = {
    schemaVersion: '1.4', adminId: admin.id, ordinaryUserId: ordinary.id,
    projectId: project.id, leadId, renderConversationId, renderAgentId,
    email: `browser-admin-${marker}@example.invalid`, password,
  }
  try {
    await writeFile(fixtureFile, `${JSON.stringify(fixture)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(fixtureFile, 0o600)
  } catch (error) {
    await cleanupFixture(fixture)
    await rm(uploadFixtureFile, { force: true })
    throw error
  }
  console.log(JSON.stringify({ ok: true, action: 'setup', fixtureFileOwnerOnly: true }))
}

async function cleanup() {
  const fixture = JSON.parse(await readFile(fixtureFile, 'utf8')) as Fixture
  if (fixture.schemaVersion !== '1.4') throw new Error('unsupported browser fixture schema')
  const cleanedIdentityEntityIds = await cleanupFixture(fixture)
  await rm(uploadFixtureFile, { force: true })
  await rm(fixtureFile, { force: true })
  const remainingUsers = await db.select({ id: users.id }).from(users)
    .where(inArray(users.id, [fixture.adminId, fixture.ordinaryUserId]))
  const remainingProjects = await db.select({ id: projects.id }).from(projects)
    .where(inArray(projects.createdBy, [fixture.adminId, fixture.ordinaryUserId]))
  const remainingLeads = await db.select({ id: leads.id }).from(leads)
    .where(eq(leads.id, fixture.leadId))
  const remainingMeetings = await db.select({ id: meetings.id }).from(meetings)
    .where(inArray(meetings.createdBy, [fixture.adminId, fixture.ordinaryUserId]))
  const remainingTodos = await db.select({ id: todos.id }).from(todos)
    .where(inArray(todos.createdBy, [fixture.adminId, fixture.ordinaryUserId]))
  const remainingRisks = await db.select({ id: risks.id }).from(risks)
    .where(inArray(risks.createdBy, [fixture.adminId, fixture.ordinaryUserId]))
  const remainingIdentityIssues = cleanedIdentityEntityIds.length
    ? await db.select({ id: identityResolutionIssues.id }).from(identityResolutionIssues)
      .where(inArray(identityResolutionIssues.entityId, cleanedIdentityEntityIds))
    : []
  const remainingConversations = await db.select({ id: chatConversations.id }).from(chatConversations)
    .where(eq(chatConversations.id, fixture.renderConversationId))
  if (remainingUsers.length || remainingProjects.length || remainingLeads.length
    || remainingMeetings.length || remainingTodos.length || remainingRisks.length || remainingIdentityIssues.length
    || remainingConversations.length) {
    throw new Error('browser UI fixture cleanup left database rows')
  }
  console.log(JSON.stringify({
    ok: true, action: 'cleanup', activeFixtureEntityRowsRemaining: 0,
    immutablePipelineHistoryRetained: true,
    secretFileRemoved: true, uploadFixtureRemoved: true,
  }))
}

const action = process.argv[2]
if (action === '--setup') await setup()
else if (action === '--cleanup') await cleanup()
else throw new Error('usage: browserUiAcceptanceFixture.ts --setup|--cleanup')

await pool.end()
