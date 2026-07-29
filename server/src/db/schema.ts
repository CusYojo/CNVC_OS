import { pgTable, text, timestamp, integer, boolean, jsonb, varchar, index, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 64 }).notNull(),
  role: varchar('role', { length: 32 }).notNull(), // 投资经理/投资总监/风控与法务/投委会秘书/投后管理组/系统管理员
  department: varchar('department', { length: 64 }).notNull().default('投资部'),
  passwordHash: text('password_hash').notNull(),
  status: varchar('status', { length: 8 }).notNull().default('启用'), // 启用/禁用
  lastLogin: timestamp('last_login', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 128 }).notNull(),
  companyName: varchar('company_name', { length: 128 }),
  industry: varchar('industry', { length: 64 }),
  round: varchar('round', { length: 64 }),
  stage: varchar('stage', { length: 16 }).notNull().default('线索'), // 线索/初筛/立项/尽调/上会/投决/投后/退出/放弃
  stageSource: varchar('stage_source', { length: 32 }),
  owner: varchar('owner', { length: 64 }).notNull(),
  collaborators: jsonb('collaborators').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  source: text('source'),
  financing: text('financing'),
  valuation: text('valuation'),
  riskLevel: varchar('risk_level', { length: 8 }).notNull().default('低'),
  score: integer('score').notNull().default(0),
  progress: integer('progress').notNull().default(0),
  summary: text('summary'),
  businessModel: text('business_model'),
  market: text('market'),
  team: text('team'),
  tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  latestApprovalId: uuid('latest_approval_id'),
  createdBy: uuid('created_by').references(() => users.id),
  scoring: jsonb('scoring').$type<unknown>(),
  pinned: boolean('pinned').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byStage: index('idx_projects_stage').on(t.stage),
  byOwner: index('idx_projects_owner').on(t.owner),
}))

export const projectFiles = pgTable('project_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 16 }).notNull(), // PDF/DOCX/XLSX/HTML/PNG/JPG 等
  category: varchar('category', { length: 32 }).notNull(),
  size: varchar('size', { length: 32 }),
  uploader: varchar('uploader', { length: 64 }).notNull(),
  parseStatus: varchar('parse_status', { length: 16 }).notNull().default('解析中'),
  visibility: varchar('visibility', { length: 16 }).notNull().default('项目成员'),
  storagePath: text('storage_path'), // 预留：以后接 OSS 时使用
  contentText: text('content_text'), // 提取的文档正文（RAG 检索用）
  parseError: text('parse_error'),
  version: integer('version').notNull().default(1),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byProject: index('idx_project_files_project').on(t.projectId),
}))

export const meetings = pgTable('meetings', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  projectName: varchar('project_name', { length: 128 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  type: varchar('type', { length: 32 }).notNull().default('项目会议'), // 项目会议/初筛会/上会/投决会
  host: varchar('host', { length: 64 }).notNull(),
  attendees: jsonb('attendees').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rawTranscript: text('raw_transcript'),
  aiSummary: text('ai_summary'),
  conclusions: jsonb('conclusions').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id),
}, (t) => ({
  byProject: index('idx_meetings_project').on(t.projectId),
}))

export const todos = pgTable('todos', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  projectName: varchar('project_name', { length: 128 }),
  title: varchar('title', { length: 255 }).notNull(),
  owner: varchar('owner', { length: 64 }).notNull(),
  dueDate: varchar('due_date', { length: 10 }), // YYYY-MM-DD
  priority: varchar('priority', { length: 8 }).notNull().default('中'), // 高/中/低
  status: varchar('status', { length: 16 }).notNull().default('未开始'), // 未开始/进行中/已完成/已退回
  type: varchar('type', { length: 32 }).notNull().default('待办'), // 待办/流程
  meetingId: uuid('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOwner: index('idx_todos_owner').on(t.owner),
  byProject: index('idx_todos_project').on(t.projectId),
}))

export const risks = pgTable('risks', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  projectName: varchar('project_name', { length: 128 }).notNull(),
  type: varchar('type', { length: 32 }).notNull(), // 工商/法院/舆情/财务/团队/技术/合规/其它
  level: varchar('level', { length: 8 }).notNull().default('中'), // 高/中/低
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  source: varchar('source', { length: 32 }).notNull().default('人工录入'), // 人工录入/系统检测/外部数据
  status: varchar('status', { length: 16 }).notNull().default('待处置'), // 待处置/处置中/已解除/已忽略
  assignee: varchar('assignee', { length: 64 }),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => ({
  byProject: index('idx_risks_project').on(t.projectId),
  byStatus: index('idx_risks_status').on(t.status),
}))

export const aiSummaries = pgTable('ai_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  positioning: text('positioning'),
  highlights: jsonb('highlights').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  risks: jsonb('risks').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  questions: jsonb('questions').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  missing: jsonb('missing').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  confidence: integer('confidence').notNull().default(0), // 0-100
  sources: jsonb('sources').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byProject: index('idx_ai_summaries_project').on(t.projectId),
}))

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 128 }).notNull(),
  companyName: varchar('company_name', { length: 128 }),
  industry: varchar('industry', { length: 64 }),
  source: text('source'),
  poolStatus: varchar('pool_status', { length: 32 }).notNull().default('成功'), // 成功/解析失败/待处理
  score: integer('score').notNull().default(0),
  summary: text('summary'),
  highlights: jsonb('highlights').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  risks: jsonb('risks').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  team: text('team'),
  fundingRounds: jsonb('funding_rounds').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  riskTags: jsonb('risk_tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  sources: jsonb('sources').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  scoring: jsonb('scoring').$type<unknown>(),  // 多维度评分结果(total/verdict/overall_comment/dimensions/rank/competitors)
  radarProfile: jsonb('radar_profile').$type<unknown>(),  // 雷达情报画像(project_profile/disclosure/next_actions/lab/contact/article_text/signals)
  radarSourceKeys: jsonb('radar_source_keys').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  claimedBy: varchar('claimed_by', { length: 64 }),
  convertedProjectId: uuid('converted_project_id').references(() => projects.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const radarSyncState = pgTable('radar_sync_state', {
  id: varchar('id', { length: 64 }).primaryKey(),
  backfillCursor: text('backfill_cursor'),
  backfillComplete: boolean('backfill_complete').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  userName: varchar('user_name', { length: 64 }).notNull(),
  module: varchar('module', { length: 32 }).notNull(),
  action: varchar('action', { length: 64 }).notNull(),
  target: text('target'),
  ip: varchar('ip', { length: 45 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index('idx_audit_user').on(t.userId),
  byTime: index('idx_audit_time').on(t.createdAt),
}))


export const chatConversations = pgTable('chat_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 128 }).notNull().default('新会话'),
  scope: varchar('scope', { length: 16 }).notNull().default('project'), // project/global
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  projectName: varchar('project_name', { length: 128 }),
  // flue agent 实例 id（会话内容真身存在 flue canonical stream；本表仅做账号级会话索引）
  agentId: varchar('agent_id', { length: 64 }),
  messages: jsonb('messages').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index('idx_chat_conv_user').on(t.userId),
  byUpdated: index('idx_chat_conv_updated').on(t.updatedAt),
  byAgent: index('idx_chat_conv_agent').on(t.agentId),
}))

export const aiTasks = pgTable('ai_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: varchar('conversation_id', { length: 64 }),
  type: varchar('type', { length: 40 }).notNull(),
  parameters: jsonb('parameters').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  templateVersion: varchar('template_version', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  stage: varchar('stage', { length: 64 }).notNull().default('等待执行'),
  progress: integer('progress').notNull().default(0),
  resultSummary: text('result_summary'),
  errorId: varchar('error_id', { length: 64 }),
  errorMessage: text('error_message'),
  cancellationRequested: boolean('cancellation_requested').notNull().default(false),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }),
  retryOfTaskId: uuid('retry_of_task_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index('idx_ai_tasks_user').on(t.userId),
  byProject: index('idx_ai_tasks_project').on(t.projectId),
  byStatus: index('idx_ai_tasks_status').on(t.status),
  uniqueIdempotency: uniqueIndex('uq_ai_tasks_user_idempotency').on(t.userId, t.idempotencyKey),
}))

export const aiArtifacts = pgTable('ai_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => aiTasks.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: varchar('conversation_id', { length: 64 }),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  format: varchar('format', { length: 16 }).notNull(),
  mimeType: varchar('mime_type', { length: 128 }).notNull(),
  version: integer('version').notNull().default(1),
  storagePath: text('storage_path').notNull(),
  editableLevel: varchar('editable_level', { length: 32 }).notNull().default('none'),
  sourceCutoffDate: varchar('source_cutoff_date', { length: 10 }),
  templateVersion: varchar('template_version', { length: 64 }).notNull(),
  qualityStatus: varchar('quality_status', { length: 16 }).notNull().default('unchecked'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  archived: boolean('archived').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byTask: index('idx_ai_artifacts_task').on(t.taskId),
  byUser: index('idx_ai_artifacts_user').on(t.userId),
  byProject: index('idx_ai_artifacts_project').on(t.projectId),
}))

export const aiTaskSources = pgTable('ai_task_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => aiTasks.id, { onDelete: 'cascade' }),
  artifactId: uuid('artifact_id').references(() => aiArtifacts.id, { onDelete: 'cascade' }),
  sourceType: varchar('source_type', { length: 24 }).notNull(),
  sourceId: varchar('source_id', { length: 64 }),
  sourceName: varchar('source_name', { length: 255 }).notNull(),
  locator: text('locator'),
  verificationStatus: varchar('verification_status', { length: 16 }).notNull().default('待核验'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byTask: index('idx_ai_task_sources_task').on(t.taskId),
  byArtifact: index('idx_ai_task_sources_artifact').on(t.artifactId),
}))

export type AiCustomTemplateAnalysis = {
  schemaVersion?: '1.0'
  analysisVersion?: string
  format: 'docx' | 'pptx'
  fileName: string
  formatProfile: {
    fonts: string[]
    primaryFont: string
    headingFont: string
    titleSizePt: number | null
    headingSizePt: number | null
    bodySizePt: number | null
    lineSpacing: string
    paragraphSpacing: string
    alignment: string[]
    pageSize: string
    margins: string
    orientation: string
    colors: string[]
    header: string
    footer: string
    hasPageNumbers: boolean
    tableCount: number
    imageCount: number
  }
  structures: Array<{
    order: number
    title: string
    level: number
    contentPurpose: string
    contentSummary: string
    contentRequirements: string[]
  }>
  summary: string
}

export const aiCustomTemplates = pgTable('ai_custom_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').references(() => chatConversations.id, { onDelete: 'set null' }),
  originalFileName: varchar('original_file_name', { length: 255 }).notNull(),
  format: varchar('format', { length: 16 }).notNull(),
  mimeType: varchar('mime_type', { length: 128 }).notNull(),
  fileSize: integer('file_size').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  storagePath: text('storage_path').notNull(),
  analysis: jsonb('analysis').$type<AiCustomTemplateAnalysis>().notNull(),
  skillName: varchar('skill_name', { length: 64 }).notNull(),
  skillPath: text('skill_path').notNull(),
  skillVersion: varchar('skill_version', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('succeeded'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index('idx_ai_custom_templates_user').on(t.userId),
  byProject: index('idx_ai_custom_templates_project').on(t.projectId),
  byConversation: index('idx_ai_custom_templates_conversation').on(t.conversationId),
}))

export const fileChunks = pgTable('file_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileId: uuid('file_id').notNull().references(() => projectFiles.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  chunkIndex: integer('chunk_index').notNull().default(0),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byFile: index('idx_file_chunks_file').on(t.fileId),
  byProject: index('idx_file_chunks_project').on(t.projectId),
}))

// 统一知识库 RAG：scope 区分来源库(project当前项目/lead共有线索池/org机构公共)，ref_id 为通用外键(不强绑FK)
export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: varchar('scope', { length: 16 }).notNull(), // 'project' | 'lead' | 'org'
  refId: varchar('ref_id', { length: 64 }).notNull(), // 项目id/线索id/'org'
  sourceType: varchar('source_type', { length: 24 }).notNull(), // file|meeting|material|audio|video|ppt|pdf|lead_profile
  sourceId: varchar('source_id', { length: 64 }), // 来源实体id(file_id/meeting_id/lead_id)
  sourceName: varchar('source_name', { length: 255 }).notNull().default(''),
  chunkIndex: integer('chunk_index').notNull().default(0),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byScopeRef: index('idx_kc_scope_ref').on(t.scope, t.refId),
  byScope: index('idx_kc_scope').on(t.scope),
  bySource: index('idx_kc_source').on(t.sourceId),
}))
