import { randomUUID } from 'node:crypto'
import { mysqlTableCreator, text, longtext, customType, int, bigint, boolean, json, varchar, index, uniqueIndex, foreignKey } from 'drizzle-orm/mysql-core'
import { sql } from 'drizzle-orm'
import { mysqlConfig } from './config.js'
import { currentRequestId } from '../runtime/structuredLogger.js'

const mysqlTable = mysqlTableCreator((name) => `${mysqlConfig.tablePrefix}${name}`)
const uuidPrimaryKey = (name: string) => varchar(name, { length: 36 }).primaryKey().$defaultFn(randomUUID)
const uuidColumn = (name: string) => varchar(name, { length: 36 })
// The migrated MySQL contract stores DATETIME(3) as a +08:00 wall-clock value. Drizzle's
// built-in datetime(mode=date) assumes the stored string is UTC, so use an explicit map
// to preserve the instant while API JSON continues to serialize Date values as UTC ISO.
const shanghaiDateTime = customType<{ data: Date; driverData: string }>({
  dataType: () => 'datetime(3)',
  toDriver: (value) => new Date(value.getTime() + 8 * 60 * 60 * 1_000)
    .toISOString().replace('T', ' ').replace('Z', ''),
  fromDriver: (value) => new Date(`${value.replace(' ', 'T')}+08:00`),
})
const timestampColumn = (name: string) => shanghaiDateTime(name)
const emptyJsonArray = sql`(JSON_ARRAY())`
const emptyJsonObject = sql`(JSON_OBJECT())`

export const users = mysqlTable('users', {
  id: uuidPrimaryKey('id'),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 64 }).notNull(),
  role: varchar('role', { length: 32 }).notNull(), // 投资经理/投资总监/风控与法务/投委会秘书/投后管理组/系统管理员
  department: varchar('department', { length: 64 }).notNull().default('投资部'),
  passwordHash: text('password_hash').notNull(),
  status: varchar('status', { length: 8 }).notNull().default('启用'), // 启用/禁用
  lastLogin: timestampColumn('last_login'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})

export const iamUserMappings = mysqlTable('iam_user_mappings', {
  id: uuidPrimaryKey('id'),
  sourceSystem: varchar('source_system', { length: 32 }).notNull(),
  sourceUserId: varchar('source_user_id', { length: 64 }).notNull(),
  sourceEmail: varchar('source_email', { length: 255 }).notNull(),
  targetUserId: uuidColumn('target_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueSourceIdentity: uniqueIndex('uq_iam_user_mappings_source').on(t.sourceSystem, t.sourceUserId),
  byTargetUser: index('idx_iam_user_mappings_target').on(t.targetUserId),
}))

export const authSessions = mysqlTable('auth_sessions', {
  id: uuidPrimaryKey('id'),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  csrfHash: varchar('csrf_hash', { length: 64 }).notNull(),
  expiresAt: timestampColumn('expires_at').notNull(),
  revokedAt: timestampColumn('revoked_at'),
  lastSeenAt: timestampColumn('last_seen_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  userAgent: text('user_agent'),
  ipAddress: varchar('ip_address', { length: 64 }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueTokenHash: uniqueIndex('uq_auth_sessions_token_hash').on(t.tokenHash),
  byUser: index('idx_auth_sessions_user').on(t.userId, t.revokedAt),
  byExpiry: index('idx_auth_sessions_expiry').on(t.expiresAt),
}))

// Singleton database kill switch for the temporary legacy JWT migration window.
// Rotating this watermark immediately invalidates every token issued at or before it.
export const authLegacyBearerPolicy = mysqlTable('auth_legacy_bearer_policy', {
  id: varchar('id', { length: 32 }).primaryKey(),
  revokedBefore: timestampColumn('revoked_before').notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(1),
  reason: text('reason').notNull(),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})

// 系统管理权威模型。users.role/department 在迁移窗口继续作为登录快照和旧接口
// 兼容字段；管理写入同时维护下面的稳定关系，待所有消费方切换后再单独退场。
export const departments = mysqlTable('departments', {
  id: uuidPrimaryKey('id'),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 64 }).notNull(),
  parentId: uuidColumn('parent_id'),
  managerUserId: uuidColumn('manager_user_id').references(() => users.id, { onDelete: 'set null' }),
  description: text('description'),
  status: varchar('status', { length: 8 }).notNull().default('启用'),
  sortOrder: int('sort_order').notNull().default(0),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueCode: uniqueIndex('uq_departments_code').on(t.code),
  uniqueName: uniqueIndex('uq_departments_name').on(t.name),
  byParent: index('idx_departments_parent').on(t.parentId, t.sortOrder),
  parentFk: foreignKey({ columns: [t.parentId], foreignColumns: [t.id], name: 'fk_departments_parent' }).onDelete('restrict'),
}))

export const roles = mysqlTable('roles', {
  id: uuidPrimaryKey('id'),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 64 }).notNull(),
  description: text('description'),
  dataScope: varchar('data_scope', { length: 16 }).notNull().default('self'),
  builtIn: boolean('built_in').notNull().default(false),
  status: varchar('status', { length: 8 }).notNull().default('启用'),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueCode: uniqueIndex('uq_roles_code').on(t.code),
  uniqueName: uniqueIndex('uq_roles_name').on(t.name),
}))

export const permissions = mysqlTable('permissions', {
  id: uuidPrimaryKey('id'),
  code: varchar('code', { length: 96 }).notNull(),
  name: varchar('name', { length: 64 }).notNull(),
  module: varchar('module', { length: 32 }).notNull(),
  action: varchar('action', { length: 32 }).notNull(),
  description: text('description'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueCode: uniqueIndex('uq_permissions_code').on(t.code),
  byModule: index('idx_permissions_module').on(t.module, t.action),
}))

export const rolePermissions = mysqlTable('role_permissions', {
  roleId: uuidColumn('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionId: uuidColumn('permission_id').notNull().references(() => permissions.id, { onDelete: 'cascade' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueBinding: uniqueIndex('uq_role_permissions_binding').on(t.roleId, t.permissionId),
  byPermission: index('idx_role_permissions_permission').on(t.permissionId, t.roleId),
}))

export const userRoles = mysqlTable('user_roles', {
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuidColumn('role_id').notNull().references(() => roles.id, { onDelete: 'restrict' }),
  isPrimary: boolean('is_primary').notNull().default(true),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueBinding: uniqueIndex('uq_user_roles_binding').on(t.userId, t.roleId),
  byRole: index('idx_user_roles_role').on(t.roleId, t.userId),
}))

export const userDepartments = mysqlTable('user_departments', {
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  departmentId: uuidColumn('department_id').notNull().references(() => departments.id, { onDelete: 'restrict' }),
  isPrimary: boolean('is_primary').notNull().default(true),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueBinding: uniqueIndex('uq_user_departments_binding').on(t.userId, t.departmentId),
  byDepartment: index('idx_user_departments_department').on(t.departmentId, t.userId),
}))

export const dictionaryGroups = mysqlTable('dictionary_groups', {
  id: uuidPrimaryKey('id'),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 64 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 8 }).notNull().default('启用'),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueCode: uniqueIndex('uq_dictionary_groups_code').on(t.code),
}))

export const dictionaryItems = mysqlTable('dictionary_items', {
  id: uuidPrimaryKey('id'),
  groupId: uuidColumn('group_id').notNull().references(() => dictionaryGroups.id, { onDelete: 'restrict' }),
  value: varchar('value', { length: 128 }).notNull(),
  label: varchar('label', { length: 128 }).notNull(),
  sortOrder: int('sort_order').notNull().default(0),
  status: varchar('status', { length: 8 }).notNull().default('启用'),
  builtIn: boolean('built_in').notNull().default(false),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueValue: uniqueIndex('uq_dictionary_items_group_value').on(t.groupId, t.value),
  byGroup: index('idx_dictionary_items_group_order').on(t.groupId, t.sortOrder),
}))

export const projects = mysqlTable('projects', {
  id: uuidPrimaryKey('id'),
  name: varchar('name', { length: 128 }).notNull(),
  companyName: varchar('company_name', { length: 128 }),
  industry: varchar('industry', { length: 64 }),
  round: varchar('round', { length: 64 }),
  stage: varchar('stage', { length: 16 }).notNull().default('线索'), // 线索/初筛/立项/尽调/上会/投决/投后/退出/放弃
  stageSource: varchar('stage_source', { length: 32 }),
  owner: varchar('owner', { length: 64 }).notNull(),
  ownerUserId: uuidColumn('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  collaborators: json('collaborators').$type<string[]>().notNull().default(emptyJsonArray),
  source: text('source'),
  financing: text('financing'),
  valuation: text('valuation'),
  riskLevel: varchar('risk_level', { length: 8 }).notNull().default('低'),
  score: int('score').notNull().default(0),
  progress: int('progress').notNull().default(0),
  summary: text('summary'),
  businessModel: text('business_model'),
  market: text('market'),
  team: text('team'),
  tags: json('tags').$type<string[]>().notNull().default(emptyJsonArray),
  latestApprovalId: uuidColumn('latest_approval_id'),
  createdBy: uuidColumn('created_by').references(() => users.id),
  scoring: json('scoring').$type<unknown>(),
  pinned: boolean('pinned').notNull().default(false),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byStage: index('idx_projects_stage').on(t.stage),
  byOwner: index('idx_projects_owner').on(t.owner),
  byOwnerUser: index('idx_projects_owner_user').on(t.ownerUserId),
}))

// 项目成员的稳定身份绑定。owner/collaborators 字符串仅保留作展示和迁移审计，
// 授权必须使用 user_id，避免重名、改名或离职账号造成越权。
export const projectMembers = mysqlTable('project_members', {
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  memberRole: varchar('member_role', { length: 16 }).notNull(),
  sourceName: varchar('source_name', { length: 64 }).notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueMember: uniqueIndex('uq_project_members_project_user').on(t.projectId, t.userId),
  byUser: index('idx_project_members_user').on(t.userId, t.projectId),
}))

// 项目评分的排队、租约、重试和重启恢复状态。projects.scoring 只保存最近一次
// 成功评分结果；执行中的权威状态必须来自本表，不能依赖单进程内存。
export const projectScoreJobs = mysqlTable('project_score_jobs', {
  projectId: uuidColumn('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 16 }).notNull().default('queued'),
  executionAttempts: int('execution_attempts').notNull().default(0),
  nextAttemptAt: timestampColumn('next_attempt_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  leaseOwner: varchar('lease_owner', { length: 128 }),
  leaseExpiresAt: timestampColumn('lease_expires_at'),
  lastStartedAt: timestampColumn('last_started_at'),
  completedAt: timestampColumn('completed_at'),
  deadLetteredAt: timestampColumn('dead_lettered_at'),
  lastError: text('last_error'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byDue: index('idx_project_score_jobs_due').on(t.status, t.nextAttemptAt),
  byLease: index('idx_project_score_jobs_lease').on(t.leaseExpiresAt),
}))

export const projectFiles = mysqlTable('project_files', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 16 }).notNull(), // PDF/DOCX/XLSX/HTML/PNG/JPG 等
  category: varchar('category', { length: 32 }).notNull(),
  size: varchar('size', { length: 32 }),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull().default(0),
  sha256: varchar('sha256', { length: 64 }),
  uploader: varchar('uploader', { length: 64 }).notNull(),
  uploadedBy: uuidColumn('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  parseStatus: varchar('parse_status', { length: 16 }).notNull().default('解析中'),
  visibility: varchar('visibility', { length: 16 }).notNull().default('项目成员'),
  storagePath: text('storage_path'), // 预留：以后接 OSS 时使用
  // 文档正文可能远超 MySQL TEXT 的 64 KiB 上限（大型 Markdown/尽调报告很常见）。
  contentText: longtext('content_text'), // 提取的文档正文（RAG 检索用）
  parseError: text('parse_error'),
  version: int('version').notNull().default(1),
  uploadedAt: timestampColumn('uploaded_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byProject: index('idx_project_files_project').on(t.projectId),
  byUploader: index('idx_project_files_uploader').on(t.uploadedBy, t.projectId),
  byProjectContent: index('idx_project_files_project_sha256').on(t.projectId, t.sha256),
}))

// 每次原始文件写入均保留不可变版本元数据和独立存储路径；project_files 指向当前版本。
export const projectFileVersions = mysqlTable('project_file_versions', {
  id: uuidPrimaryKey('id'),
  fileId: uuidColumn('file_id').notNull().references(() => projectFiles.id, { onDelete: 'cascade' }),
  version: int('version').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull().default(0),
  sha256: varchar('sha256', { length: 64 }),
  storagePath: text('storage_path').notNull(),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueVersion: uniqueIndex('uq_project_file_versions_file_version').on(t.fileId, t.version),
  byHash: index('idx_project_file_versions_sha256').on(t.sha256),
}))

export const meetings = mysqlTable('meetings', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').references(() => projects.id, { onDelete: 'set null' }),
  projectName: varchar('project_name', { length: 128 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  type: varchar('type', { length: 32 }).notNull().default('项目会议'), // 项目会议/初筛会/上会/投决会
  host: varchar('host', { length: 64 }).notNull(),
  hostUserId: uuidColumn('host_user_id').references(() => users.id, { onDelete: 'set null' }),
  attendees: json('attendees').$type<string[]>().notNull().default(emptyJsonArray),
  rawTranscript: text('raw_transcript'),
  aiSummary: text('ai_summary'),
  conclusions: json('conclusions').$type<string[]>().notNull().default(emptyJsonArray),
  startedAt: timestampColumn('started_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  createdBy: uuidColumn('created_by').references(() => users.id),
  version: int('version').notNull().default(1),
}, (t) => ({
  byProject: index('idx_meetings_project').on(t.projectId),
  byHostUser: index('idx_meetings_host_user').on(t.hostUserId),
}))

export const meetingParticipants = mysqlTable('meeting_participants', {
  meetingId: uuidColumn('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sourceName: varchar('source_name', { length: 64 }).notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueParticipant: uniqueIndex('uq_meeting_participants_meeting_user').on(t.meetingId, t.userId),
  byUser: index('idx_meeting_participants_user').on(t.userId, t.meetingId),
}))

export const todos = mysqlTable('todos', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').references(() => projects.id, { onDelete: 'set null' }),
  projectName: varchar('project_name', { length: 128 }),
  title: varchar('title', { length: 255 }).notNull(),
  owner: varchar('owner', { length: 64 }).notNull(),
  ownerUserId: uuidColumn('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  dueDate: varchar('due_date', { length: 10 }), // YYYY-MM-DD
  priority: varchar('priority', { length: 8 }).notNull().default('中'), // 高/中/低
  status: varchar('status', { length: 16 }).notNull().default('未开始'), // 未开始/进行中/已完成/已退回
  type: varchar('type', { length: 32 }).notNull().default('待办'), // 待办/流程
  meetingId: uuidColumn('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
  approvalRequestId: uuidColumn('approval_request_id'),
  createdBy: uuidColumn('created_by').references(() => users.id),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byOwner: index('idx_todos_owner').on(t.owner),
  byOwnerUser: index('idx_todos_owner_user').on(t.ownerUserId),
  byProject: index('idx_todos_project').on(t.projectId),
  byApproval: index('idx_todos_approval').on(t.approvalRequestId, t.status),
}))

// OA 项目审批是正式导航中的业务链路，所有状态、节点、审批人和操作记录
// 均以 MySQL 为权威源。active_key 在审批中等于 project_id，终态为 NULL，
// 配合唯一索引保证一个项目最多只有一条活动流程。
export const oaApprovalRequests = mysqlTable('oa_approval_requests', {
  id: uuidPrimaryKey('id'),
  requestNo: varchar('request_no', { length: 40 }).notNull(),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  projectName: varchar('project_name', { length: 128 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  type: varchar('type', { length: 32 }).notNull(),
  fromStage: varchar('from_stage', { length: 16 }).notNull(),
  targetStage: varchar('target_stage', { length: 16 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('审批中'),
  applicantUserId: uuidColumn('applicant_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  applicantName: varchar('applicant_name', { length: 64 }).notNull(),
  department: varchar('department', { length: 64 }).notNull(),
  priority: varchar('priority', { length: 8 }).notNull().default('普通'),
  activeKey: uuidColumn('active_key'),
  currentNodeId: uuidColumn('current_node_id'),
  currentNodeName: varchar('current_node_name', { length: 128 }).notNull(),
  reason: text('reason').notNull(),
  amount: text('amount'),
  valuation: text('valuation'),
  attachments: json('attachments').$type<string[]>().notNull().default(emptyJsonArray),
  checklist: json('checklist').$type<Array<{ label: string; passed: boolean; required: boolean }>>().notNull().default(emptyJsonArray),
  lockVersion: int('lock_version').notNull().default(1),
  submittedAt: timestampColumn('submitted_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  completedAt: timestampColumn('completed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueRequestNo: uniqueIndex('uq_oa_request_no').on(t.requestNo),
  uniqueActiveProject: uniqueIndex('uq_oa_active_project').on(t.activeKey),
  byProjectSubmitted: index('idx_oa_requests_project_submitted').on(t.projectId, t.submittedAt),
  byApplicantSubmitted: index('idx_oa_requests_applicant_submitted').on(t.applicantUserId, t.submittedAt),
  byStatusUpdated: index('idx_oa_requests_status_updated').on(t.status, t.updatedAt),
}))

export const oaApprovalNodes = mysqlTable('oa_approval_nodes', {
  id: uuidPrimaryKey('id'),
  requestId: uuidColumn('request_id').notNull().references(() => oaApprovalRequests.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 128 }).notNull(),
  approverRole: varchar('approver_role', { length: 128 }).notNull(),
  mode: varchar('mode', { length: 8 }).notNull(),
  sequence: int('sequence').notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  approverUserIds: json('approver_user_ids').$type<string[]>().notNull().default(emptyJsonArray),
  approverNames: json('approver_names').$type<string[]>().notNull().default(emptyJsonArray),
  approvedByUserIds: json('approved_by_user_ids').$type<string[]>().notNull().default(emptyJsonArray),
  approvedByNames: json('approved_by_names').$type<string[]>().notNull().default(emptyJsonArray),
  completedAt: timestampColumn('completed_at'),
  comment: text('comment'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueSequence: uniqueIndex('uq_oa_nodes_request_sequence').on(t.requestId, t.sequence),
  byRequestStatus: index('idx_oa_nodes_request_status').on(t.requestId, t.status),
}))

export const oaApprovalRecords = mysqlTable('oa_approval_records', {
  id: uuidPrimaryKey('id'),
  requestId: uuidColumn('request_id').notNull().references(() => oaApprovalRequests.id, { onDelete: 'cascade' }),
  nodeId: uuidColumn('node_id').notNull().references(() => oaApprovalNodes.id, { onDelete: 'restrict' }),
  nodeName: varchar('node_name', { length: 128 }).notNull(),
  operatorUserId: uuidColumn('operator_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  operatorName: varchar('operator_name', { length: 64 }).notNull(),
  action: varchar('action', { length: 16 }).notNull(),
  comment: text('comment').notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byRequestTime: index('idx_oa_records_request_time').on(t.requestId, t.createdAt),
  byOperatorTime: index('idx_oa_records_operator_time').on(t.operatorUserId, t.createdAt),
}))

export const oaWorkflowLogs = mysqlTable('oa_workflow_logs', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  requestId: uuidColumn('request_id').notNull().references(() => oaApprovalRequests.id, { onDelete: 'restrict' }),
  requestNo: varchar('request_no', { length: 40 }).notNull(),
  fromStage: varchar('from_stage', { length: 16 }).notNull(),
  toStage: varchar('to_stage', { length: 16 }).notNull(),
  operatorUserId: uuidColumn('operator_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  operatorName: varchar('operator_name', { length: 64 }).notNull(),
  comment: text('comment').notNull(),
  source: varchar('source', { length: 32 }).notNull().default('OA审批'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byProjectTime: index('idx_oa_workflow_logs_project_time').on(t.projectId, t.createdAt),
  byRequest: index('idx_oa_workflow_logs_request').on(t.requestId),
}))

export const risks = mysqlTable('risks', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').references(() => projects.id, { onDelete: 'set null' }),
  projectName: varchar('project_name', { length: 128 }).notNull(),
  type: varchar('type', { length: 32 }).notNull(), // 工商/法院/舆情/财务/团队/技术/合规/其它
  level: varchar('level', { length: 8 }).notNull().default('中'), // 高/中/低
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  source: varchar('source', { length: 32 }).notNull().default('人工录入'), // 人工录入/系统检测/外部数据
  status: varchar('status', { length: 16 }).notNull().default('待处置'), // 待处置/处置中/已解除/已忽略
  assignee: varchar('assignee', { length: 64 }),
  assigneeUserId: uuidColumn('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdBy: uuidColumn('created_by').references(() => users.id),
  detectedAt: timestampColumn('detected_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  resolvedAt: timestampColumn('resolved_at'),
  version: int('version').notNull().default(1),
}, (t) => ({
  byProject: index('idx_risks_project').on(t.projectId),
  byStatus: index('idx_risks_status').on(t.status),
  byCreator: index('idx_risks_creator').on(t.createdBy),
  byAssigneeUser: index('idx_risks_assignee_user').on(t.assigneeUserId),
}))

// 无法唯一映射到启用用户的历史名称进入持久化冲突台账，默认不参与授权。
export const identityResolutionIssues = mysqlTable('identity_resolution_issues', {
  id: uuidPrimaryKey('id'),
  entityType: varchar('entity_type', { length: 32 }).notNull(),
  entityId: varchar('entity_id', { length: 36 }).notNull(),
  fieldName: varchar('field_name', { length: 32 }).notNull(),
  sourceValue: varchar('source_value', { length: 64 }).notNull(),
  reason: varchar('reason', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('open'),
  resolvedUserId: uuidColumn('resolved_user_id').references(() => users.id, { onDelete: 'set null' }),
  resolvedAt: timestampColumn('resolved_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueIssue: uniqueIndex('uq_identity_resolution_issue').on(t.entityType, t.entityId, t.fieldName, t.sourceValue),
  byStatus: index('idx_identity_resolution_status').on(t.status, t.entityType),
}))

export const aiSummaries = mysqlTable('ai_summaries', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  positioning: text('positioning'),
  highlights: json('highlights').$type<string[]>().notNull().default(emptyJsonArray),
  risks: json('risks').$type<string[]>().notNull().default(emptyJsonArray),
  questions: json('questions').$type<string[]>().notNull().default(emptyJsonArray),
  missing: json('missing').$type<string[]>().notNull().default(emptyJsonArray),
  confidence: int('confidence').notNull().default(0), // 0-100
  sources: json('sources').$type<string[]>().notNull().default(emptyJsonArray),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byProject: index('idx_ai_summaries_project').on(t.projectId),
}))

export const leads = mysqlTable('leads', {
  id: uuidPrimaryKey('id'),
  name: varchar('name', { length: 128 }).notNull(),
  companyName: varchar('company_name', { length: 128 }),
  industry: varchar('industry', { length: 64 }),
  businessRegion: varchar('business_region', { length: 32 }),
  businessRegionSource: varchar('business_region_source', { length: 64 }),
  businessRegionConfidence: varchar('business_region_confidence', { length: 8 }),
  source: text('source'),
  poolStatus: varchar('pool_status', { length: 32 }).notNull().default('成功'), // 成功/解析失败/待处理
  score: int('score').notNull().default(0),
  summary: text('summary'),
  highlights: json('highlights').$type<string[]>().notNull().default(emptyJsonArray),
  risks: json('risks').$type<string[]>().notNull().default(emptyJsonArray),
  team: text('team'),
  fundingRounds: json('funding_rounds').$type<unknown[]>().notNull().default(emptyJsonArray),
  riskTags: json('risk_tags').$type<string[]>().notNull().default(emptyJsonArray),
  sources: json('sources').$type<unknown[]>().notNull().default(emptyJsonArray),
  scoring: json('scoring').$type<unknown>(),  // 多维度评分结果(total/verdict/overall_comment/dimensions/rank/competitors)
  radarProfile: json('radar_profile').$type<unknown>(),  // 雷达情报画像(project_profile/disclosure/next_actions/lab/contact/article_text/signals)
  radarSourceKeys: json('radar_source_keys').$type<string[]>().notNull().default(emptyJsonArray),
  fieldProvenance: json('field_provenance').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  claimedBy: varchar('claimed_by', { length: 64 }),
  convertedProjectId: uuidColumn('converted_project_id').references(() => projects.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byNameAndStatus: index('idx_leads_name_status').on(t.name, t.poolStatus),
}))

// 线索 AI 评分执行状态。leads.scoring.scoreJob 继续作为前端展示快照，
// 真正的排队、租约、重试与实例互斥由本表负责。
export const leadScoreJobs = mysqlTable('lead_score_jobs', {
  leadId: uuidColumn('lead_id').primaryKey().references(() => leads.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 16 }).notNull().default('queued'),
  executionAttempts: int('execution_attempts').notNull().default(0),
  manualRetryCount: int('manual_retry_count').notNull().default(0),
  nextAttemptAt: timestampColumn('next_attempt_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  leaseOwner: varchar('lease_owner', { length: 128 }),
  leaseExpiresAt: timestampColumn('lease_expires_at'),
  lastStartedAt: timestampColumn('last_started_at'),
  completedAt: timestampColumn('completed_at'),
  deadLetteredAt: timestampColumn('dead_lettered_at'),
  lastError: text('last_error'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byDue: index('idx_lead_score_jobs_due').on(t.status, t.nextAttemptAt),
  byLease: index('idx_lead_score_jobs_lease').on(t.leaseExpiresAt),
}))

// 公共线索池人工导入文件与 BP 解析任务。原始文件只保存私有存储路径，数据库
// 保存摘要、租约和处理结果；任务完成后仍可追溯到统一 Pipeline 原始事件。
export const leadIntakeFiles = mysqlTable('lead_intake_files', {
  id: uuidPrimaryKey('id'),
  kind: varchar('kind', { length: 16 }).notNull(), // batch / bp
  idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
  originalName: varchar('original_name', { length: 255 }).notNull(),
  typeLabel: varchar('type_label', { length: 32 }).notNull(),
  contentType: varchar('content_type', { length: 255 }).notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  storagePath: text('storage_path').notNull(),
  status: varchar('status', { length: 24 }).notNull().default('uploaded'),
  stage: varchar('stage', { length: 32 }).notNull().default('uploaded'),
  progress: int('progress').notNull().default(0),
  executionAttempts: int('execution_attempts').notNull().default(0),
  nextAttemptAt: timestampColumn('next_attempt_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  leaseOwner: varchar('lease_owner', { length: 128 }),
  leaseExpiresAt: timestampColumn('lease_expires_at'),
  lastError: text('last_error'),
  eventId: varchar('event_id', { length: 64 }),
  leadId: uuidColumn('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  reviewId: uuidColumn('review_id'),
  uploadedBy: uuidColumn('uploaded_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  uploadedByName: varchar('uploaded_by_name', { length: 64 }).notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  completedAt: timestampColumn('completed_at'),
}, (t) => ({
  uniqueIdempotency: uniqueIndex('uq_lead_intake_files_idempotency').on(t.idempotencyKey),
  byDue: index('idx_lead_intake_files_due').on(t.kind, t.status, t.nextAttemptAt),
  byUploader: index('idx_lead_intake_files_uploader').on(t.uploadedBy, t.createdAt),
  byLease: index('idx_lead_intake_files_lease').on(t.leaseExpiresAt),
}))

export const leadImportBatches = mysqlTable('lead_import_batches', {
  id: uuidPrimaryKey('id'),
  fileId: uuidColumn('file_id').notNull().references(() => leadIntakeFiles.id, { onDelete: 'restrict' }),
  templateVersion: varchar('template_version', { length: 32 }).notNull().default('lead-import-v1'),
  status: varchar('status', { length: 24 }).notNull().default('preview'),
  totalRows: int('total_rows').notNull().default(0),
  validRows: int('valid_rows').notNull().default(0),
  errorRows: int('error_rows').notNull().default(0),
  committedRows: int('committed_rows').notNull().default(0),
  reviewRows: int('review_rows').notNull().default(0),
  failedRows: int('failed_rows').notNull().default(0),
  createdBy: uuidColumn('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  completedAt: timestampColumn('completed_at'),
}, (t) => ({
  uniqueFile: uniqueIndex('uq_lead_import_batches_file').on(t.fileId),
  byCreator: index('idx_lead_import_batches_creator').on(t.createdBy, t.createdAt),
}))

export const leadImportRows = mysqlTable('lead_import_rows', {
  id: uuidPrimaryKey('id'),
  batchId: uuidColumn('batch_id').notNull().references(() => leadImportBatches.id, { onDelete: 'cascade' }),
  rowNumber: int('row_number').notNull(),
  rawData: json('raw_data').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  normalizedData: json('normalized_data').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  validationErrors: json('validation_errors').$type<string[]>().notNull().default(emptyJsonArray),
  status: varchar('status', { length: 24 }).notNull().default('valid'),
  eventId: varchar('event_id', { length: 64 }),
  leadId: uuidColumn('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  reviewId: uuidColumn('review_id'),
  resultMessage: text('result_message'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueRow: uniqueIndex('uq_lead_import_rows_batch_row').on(t.batchId, t.rowNumber),
  byStatus: index('idx_lead_import_rows_status').on(t.batchId, t.status),
}))

// 36氪历史储备池：保留原始顺序、导入状态和原始详情，防止重复摄入或漏迁。
export const leadReserve = mysqlTable('lead_reserve', {
  id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  seq: int('seq'),
  srcId: text('src_id'),
  name: text('name'),
  detailUrl: text('detail_url'),
  detailJson: json('detail_json').$type<Record<string, unknown>>(),
  imported: boolean('imported').notNull().default(false),
  importedAt: timestampColumn('imported_at'),
  importedLeadId: uuidColumn('imported_lead_id'),
  scoreStatus: varchar('score_status', { length: 16 }).notNull().default('not_requested'),
  scoreRequestedAt: timestampColumn('score_requested_at'),
  scoreLastError: text('score_last_error'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byImportedSequence: index('idx_reserve_imported_seq').on(t.imported, t.seq),
  byImportedLead: index('idx_reserve_imported_lead').on(t.importedLeadId),
  byScoreStatus: index('idx_reserve_score_status').on(t.scoreStatus, t.importedAt),
}))

// 进入线索 Pipeline 的统一不可变原始事件。事件 ID/幂等键由来源身份和规范化内容哈希
// 确定，同一来源内容变化会生成新事件，完全相同的重复投递只命中既有事件。
export const leadPipelineRawEvents = mysqlTable('lead_pipeline_raw_events', {
  id: varchar('id', { length: 64 }).primaryKey(),
  sourceType: varchar('source_type', { length: 32 }).notNull(),
  sourceId: text('source_id'),
  sourceIdHash: varchar('source_id_hash', { length: 64 }),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
  payload: json('payload').$type<Record<string, unknown>>().notNull(),
  sourceOccurredAt: timestampColumn('source_occurred_at'),
  ingestedAt: timestampColumn('ingested_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueIdempotency: uniqueIndex('uq_lead_pipeline_raw_idempotency').on(t.idempotencyKey),
  bySource: index('idx_lead_pipeline_raw_source').on(t.sourceType, t.sourceIdHash),
  byContent: index('idx_lead_pipeline_raw_content').on(t.sourceType, t.contentHash),
}))

export const leadPipelineItems = mysqlTable('lead_pipeline_items', {
  eventId: varchar('event_id', { length: 64 }).primaryKey()
    .references(() => leadPipelineRawEvents.id, { onDelete: 'restrict' }),
  status: varchar('status', { length: 16 }).notNull().default('discovered'),
  leadId: uuidColumn('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  processingAttempts: int('processing_attempts').notNull().default(0),
  decisionReason: text('decision_reason'),
  evidence: json('evidence').$type<unknown[]>().notNull().default(emptyJsonArray),
  confidence: int('confidence'),
  lastError: text('last_error'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byStatus: index('idx_lead_pipeline_items_status').on(t.status, t.updatedAt),
  byLead: index('idx_lead_pipeline_items_lead').on(t.leadId),
}))

export const leadPipelineTransitions = mysqlTable('lead_pipeline_transitions', {
  id: uuidPrimaryKey('id'),
  eventId: varchar('event_id', { length: 64 }).notNull()
    .references(() => leadPipelineRawEvents.id, { onDelete: 'restrict' }),
  fromStatus: varchar('from_status', { length: 16 }),
  toStatus: varchar('to_status', { length: 16 }).notNull(),
  reason: text('reason').notNull(),
  evidence: json('evidence').$type<unknown[]>().notNull().default(emptyJsonArray),
  confidence: int('confidence'),
  actorType: varchar('actor_type', { length: 32 }).notNull(),
  actorId: varchar('actor_id', { length: 64 }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byEvent: index('idx_lead_pipeline_transitions_event').on(t.eventId, t.createdAt),
  byStatus: index('idx_lead_pipeline_transitions_status').on(t.toStatus, t.createdAt),
}))

export const leadPipelinePromptVersions = mysqlTable('lead_pipeline_prompt_versions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  agentProfile: varchar('agent_profile', { length: 64 }).notNull(),
  promptVersion: varchar('prompt_version', { length: 64 }).notNull(),
  schemaVersion: varchar('schema_version', { length: 64 }).notNull(),
  skillVersion: varchar('skill_version', { length: 64 }).notNull(),
  toolsetVersion: varchar('toolset_version', { length: 64 }).notNull(),
  promptHash: varchar('prompt_hash', { length: 64 }).notNull(),
  configuration: json('configuration').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueContract: uniqueIndex('uq_lp_prompt_contract').on(
    t.agentProfile, t.promptVersion, t.schemaVersion, t.skillVersion, t.toolsetVersion,
  ),
}))

export const leadPipelineRuns = mysqlTable('lead_pipeline_runs', {
  id: uuidPrimaryKey('id'),
  runKey: varchar('run_key', { length: 64 }).notNull(),
  primaryEventId: varchar('primary_event_id', { length: 64 })
    .references(() => leadPipelineRawEvents.id, { onDelete: 'restrict' }),
  eventIds: json('event_ids').$type<string[]>().notNull().default(emptyJsonArray),
  runtime: varchar('runtime', { length: 32 }).notNull(),
  agentProfile: varchar('agent_profile', { length: 64 }).notNull(),
  promptVersionId: varchar('prompt_version_id', { length: 64 })
    .references(() => leadPipelinePromptVersions.id, { onDelete: 'restrict' }),
  model: varchar('model', { length: 128 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  attempt: int('attempt').notNull().default(1),
  inputTokens: bigint('input_tokens', { mode: 'number' }),
  outputTokens: bigint('output_tokens', { mode: 'number' }),
  totalTokens: bigint('total_tokens', { mode: 'number' }),
  toolCalls: int('tool_calls').notNull().default(0),
  durationMs: int('duration_ms'),
  costMicrousd: bigint('cost_microusd', { mode: 'number' }),
  error: text('error'),
  metadata: json('metadata').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  startedAt: timestampColumn('started_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  finishedAt: timestampColumn('finished_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueRunKey: uniqueIndex('uq_lp_runs_key').on(t.runKey),
  byEvent: index('idx_lp_runs_event').on(t.primaryEventId, t.startedAt),
  byStatus: index('idx_lp_runs_status').on(t.status, t.startedAt),
}))

export const leadAgentRuntimePermits = mysqlTable('lead_agent_runtime_permits', {
  id: uuidPrimaryKey('id'),
  agentProfile: varchar('agent_profile', { length: 64 }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('active'),
  reservedMicrousd: bigint('reserved_microusd', { mode: 'number' }).notNull(),
  actualMicrousd: bigint('actual_microusd', { mode: 'number' }),
  errorClass: varchar('error_class', { length: 64 }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  expiresAt: timestampColumn('expires_at').notNull(),
  finishedAt: timestampColumn('finished_at'),
}, (t) => ({
  byStateExpiry: index('idx_lead_agent_permits_state_expiry').on(t.state, t.expiresAt),
  byCreated: index('idx_lead_agent_permits_created').on(t.createdAt),
  byProfileCreated: index('idx_lead_agent_permits_profile_created').on(t.agentProfile, t.createdAt),
}))

export const leadPipelineDecisions = mysqlTable('lead_pipeline_decisions', {
  id: uuidPrimaryKey('id'),
  decisionKey: varchar('decision_key', { length: 64 }).notNull(),
  eventId: varchar('event_id', { length: 64 }).notNull()
    .references(() => leadPipelineRawEvents.id, { onDelete: 'restrict' }),
  runId: uuidColumn('run_id').references(() => leadPipelineRuns.id, { onDelete: 'restrict' }),
  parentDecisionId: uuidColumn('parent_decision_id'),
  decisionType: varchar('decision_type', { length: 32 }).notNull(),
  outcome: varchar('outcome', { length: 16 }).notNull(),
  subjectType: varchar('subject_type', { length: 16 }),
  subjectName: varchar('subject_name', { length: 128 }),
  legalName: varchar('legal_name', { length: 128 }),
  confidence: int('confidence'),
  reason: text('reason').notNull(),
  output: json('output').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  actorType: varchar('actor_type', { length: 32 }).notNull(),
  actorId: varchar('actor_id', { length: 64 }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueDecisionKey: uniqueIndex('uq_lp_decisions_key').on(t.decisionKey),
  byEvent: index('idx_lp_decisions_event').on(t.eventId, t.createdAt),
  byRun: index('idx_lp_decisions_run').on(t.runId),
  parentDecisionFk: foreignKey({
    columns: [t.parentDecisionId],
    foreignColumns: [t.id],
    name: 'sbl_lp_decisions_parent_fk',
  }).onDelete('restrict'),
}))

export const leadPipelineEvidence = mysqlTable('lead_pipeline_evidence', {
  id: uuidPrimaryKey('id'),
  evidenceKey: varchar('evidence_key', { length: 64 }).notNull(),
  decisionId: uuidColumn('decision_id').notNull()
    .references(() => leadPipelineDecisions.id, { onDelete: 'restrict' }),
  eventId: varchar('event_id', { length: 64 }).notNull()
    .references(() => leadPipelineRawEvents.id, { onDelete: 'restrict' }),
  sourceId: text('source_id'),
  sourceType: varchar('source_type', { length: 32 }).notNull(),
  locator: text('locator'),
  claim: text('claim').notNull(),
  quote: text('quote'),
  sourceUrl: text('source_url'),
  reliability: varchar('reliability', { length: 16 }),
  verificationStatus: varchar('verification_status', { length: 16 }).notNull().default('unverified'),
  metadata: json('metadata').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueEvidenceKey: uniqueIndex('uq_lp_evidence_key').on(t.evidenceKey),
  byEvent: index('idx_lp_evidence_event').on(t.eventId, t.createdAt),
  byDecision: index('idx_lp_evidence_decision').on(t.decisionId),
}))

export const leadPipelineReviews = mysqlTable('lead_pipeline_reviews', {
  id: uuidPrimaryKey('id'),
  reviewKey: varchar('review_key', { length: 64 }).notNull(),
  eventId: varchar('event_id', { length: 64 }).notNull()
    .references(() => leadPipelineRawEvents.id, { onDelete: 'restrict' }),
  triggerDecisionId: uuidColumn('trigger_decision_id').notNull()
    .references(() => leadPipelineDecisions.id, { onDelete: 'restrict' }),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  reason: text('reason').notNull(),
  assignedUserId: uuidColumn('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewerUserId: uuidColumn('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
  resolutionDecisionId: uuidColumn('resolution_decision_id')
    .references(() => leadPipelineDecisions.id, { onDelete: 'restrict' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  resolvedAt: timestampColumn('resolved_at'),
}, (t) => ({
  uniqueReviewKey: uniqueIndex('uq_lp_reviews_key').on(t.reviewKey),
  byStatus: index('idx_lp_reviews_status').on(t.status, t.createdAt),
  byEvent: index('idx_lp_reviews_event').on(t.eventId, t.createdAt),
}))

// Entity resolution is append-only: candidate observations and final resolutions are
// separate rows, so later manual choices never erase the evidence used by an agent.
export const leadPipelineEntityMatches = mysqlTable('lead_pipeline_entity_matches', {
  id: uuidPrimaryKey('id'),
  matchKey: varchar('match_key', { length: 64 }).notNull(),
  eventId: varchar('event_id', { length: 64 }).notNull()
    .references(() => leadPipelineRawEvents.id, { onDelete: 'restrict' }),
  decisionId: uuidColumn('decision_id')
    .references(() => leadPipelineDecisions.id, { onDelete: 'restrict' }),
  reviewId: uuidColumn('review_id')
    .references(() => leadPipelineReviews.id, { onDelete: 'restrict' }),
  subjectType: varchar('subject_type', { length: 16 }),
  subjectName: varchar('subject_name', { length: 128 }).notNull(),
  normalizedSubjectName: varchar('normalized_subject_name', { length: 128 }).notNull(),
  matchType: varchar('match_type', { length: 32 }).notNull(),
  candidateLeadId: uuidColumn('candidate_lead_id')
    .references(() => leads.id, { onDelete: 'set null' }),
  candidateName: varchar('candidate_name', { length: 128 }),
  candidateCompanyName: varchar('candidate_company_name', { length: 128 }),
  score: int('score'),
  status: varchar('status', { length: 16 }).notNull(),
  resolutionType: varchar('resolution_type', { length: 16 }).notNull().default('pending'),
  resolutionDecisionId: uuidColumn('resolution_decision_id')
    .references(() => leadPipelineDecisions.id, { onDelete: 'restrict' }),
  aliases: json('aliases').$type<string[]>().notNull().default(emptyJsonArray),
  metadata: json('metadata').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  resolvedAt: timestampColumn('resolved_at'),
}, (t) => ({
  uniqueMatchKey: uniqueIndex('uq_lp_entity_matches_key').on(t.matchKey),
  byEvent: index('idx_lp_entity_matches_event').on(t.eventId, t.status, t.createdAt),
  byCandidate: index('idx_lp_entity_matches_candidate').on(t.candidateLeadId, t.status, t.createdAt),
  byNormalizedSubject: index('idx_lp_entity_matches_subject').on(t.normalizedSubjectName, t.status, t.createdAt),
}))

export const radarSyncState = mysqlTable('radar_sync_state', {
  id: varchar('id', { length: 64 }).primaryKey(),
  backfillCursor: text('backfill_cursor'),
  backfillComplete: boolean('backfill_complete').notNull().default(false),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})

// Radar 原始采集事件不可变保存；同一来源内容变化会生成新的 content_hash 事件。
export const radarRawEvents = mysqlTable('radar_raw_events', {
  id: varchar('id', { length: 64 }).primaryKey(),
  sourceKey: text('source_key').notNull(),
  sourceKeyHash: varchar('source_key_hash', { length: 64 }).notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  source: varchar('source', { length: 64 }).notNull(),
  sourceGroup: varchar('source_group', { length: 64 }),
  collectedAt: timestampColumn('collected_at'),
  publishedAt: timestampColumn('published_at'),
  cursorTimestamp: bigint('cursor_timestamp', { mode: 'number' }).notNull(),
  cursorDigest: varchar('cursor_digest', { length: 64 }).notNull(),
  payload: json('payload').$type<Record<string, unknown>>().notNull(),
  sourceFile: text('source_file'),
  sourceLine: int('source_line'),
  ingestedAt: timestampColumn('ingested_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueSourceContent: uniqueIndex('uq_radar_raw_source_content').on(t.sourceKeyHash, t.contentHash),
  byCursor: index('idx_radar_raw_cursor').on(t.cursorTimestamp, t.cursorDigest),
  bySource: index('idx_radar_raw_source').on(t.source, t.sourceGroup),
}))

// API/同步任务的当前候选投影。原始证据仍在 radar_raw_events，投影可幂等重建。
export const radarCandidates = mysqlTable('radar_candidates', {
  sourceKeyHash: varchar('source_key_hash', { length: 64 }).primaryKey(),
  sourceKey: text('source_key').notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  source: varchar('source', { length: 64 }).notNull(),
  sourceGroup: varchar('source_group', { length: 64 }),
  attentionScore: int('attention_score').notNull().default(0),
  worthAttention: boolean('worth_attention').notNull().default(false),
  collectedAt: timestampColumn('collected_at'),
  publishedAt: timestampColumn('published_at'),
  cursorTimestamp: bigint('cursor_timestamp', { mode: 'number' }).notNull(),
  cursorDigest: varchar('cursor_digest', { length: 64 }).notNull(),
  payload: json('payload').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byCursor: index('idx_radar_candidates_cursor').on(t.cursorTimestamp, t.cursorDigest),
  bySource: index('idx_radar_candidates_source').on(t.source, t.sourceGroup),
  byAttention: index('idx_radar_candidates_attention').on(t.worthAttention, t.attentionScore),
}))

// 微信群聊 Push API 的原始消息事实表。候选投影仍写入 radar_candidates，
// 消息本体独立保存，保证按日期/群组查询、上下文重建与重复推送幂等。
export const radarWechatChatMessages = mysqlTable('radar_wechat_chat_messages', {
  id: varchar('id', { length: 64 }).primaryKey(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  merchantNo: varchar('merchant_no', { length: 128 }).notNull().default(''),
  msgKey: varchar('msg_key', { length: 191 }).notNull().default(''),
  groupName: varchar('group_name', { length: 255 }).notNull(),
  groupSerialNo: varchar('group_serial_no', { length: 191 }).notNull(),
  senderName: varchar('sender_name', { length: 255 }).notNull(),
  senderSerialNo: varchar('sender_serial_no', { length: 191 }).notNull().default(''),
  citeContent: text('cite_content').notNull(),
  messageContent: longtext('message_content').notNull(),
  messageDate: varchar('message_date', { length: 10 }).notNull(),
  messageTime: timestampColumn('message_time'),
  messageTimeRaw: varchar('message_time_raw', { length: 64 }).notNull().default(''),
  pushedAt: timestampColumn('pushed_at'),
  pushedAtRaw: varchar('pushed_at_raw', { length: 64 }).notNull().default(''),
  msgType: varchar('msg_type', { length: 32 }).notNull().default(''),
  file: json('file').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  rawPayload: json('raw_payload').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  receivedAt: timestampColumn('received_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byGroupTime: index('idx_radar_chat_group_time').on(t.messageDate, t.groupSerialNo, t.messageTime),
  byMerchantTime: index('idx_radar_chat_merchant_time').on(t.merchantNo, t.messageTime),
  byContent: index('idx_radar_chat_content').on(t.contentHash),
}))

// Webhook HMAC receipts provide a durable replay window across application
// restarts and multiple instances. Only a digest is retained; signatures and
// request bodies are never persisted here.
export const radarWebhookReceipts = mysqlTable('radar_webhook_receipts', {
  receiptHash: varchar('receipt_hash', { length: 64 }).primaryKey(),
  signedAt: timestampColumn('signed_at').notNull(),
  expiresAt: timestampColumn('expires_at').notNull(),
  receivedAt: timestampColumn('received_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byExpiry: index('idx_radar_webhook_receipts_expiry').on(t.expiresAt),
}))

export const radarCollectorStates = mysqlTable('radar_collector_states', {
  id: varchar('id', { length: 64 }).primaryKey(),
  stateKind: varchar('state_kind', { length: 32 }).notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  state: json('state').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  sourcePath: text('source_path'),
  capturedAt: timestampColumn('captured_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byKind: index('idx_radar_collector_states_kind').on(t.stateKind),
}))

export const radarSourceRegistry = mysqlTable('radar_source_registry', {
  id: varchar('id', { length: 64 }).primaryKey(),
  sourceKind: varchar('source_kind', { length: 32 }).notNull(),
  sourceGroup: varchar('source_group', { length: 64 }),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  externalKey: varchar('external_key', { length: 255 }),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  config: json('config').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  enabled: boolean('enabled').notNull().default(true),
  importedAt: timestampColumn('imported_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byKindGroup: index('idx_radar_source_registry_kind').on(t.sourceKind, t.sourceGroup),
}))

// 单一业务服务的持久化调度表。next_run_at 与 lease_expires_at 共同保证
// 多实例只会有一个实例取得到期任务；执行历史独立保留在 runtime_job_runs。
export const runtimeJobs = mysqlTable('runtime_jobs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  task: varchar('task', { length: 64 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  scheduleKind: varchar('schedule_kind', { length: 16 }).notNull(), // interval/daily
  intervalSeconds: int('interval_seconds'),
  dailyHour: int('daily_hour'),
  dailyMinute: int('daily_minute'),
  payload: json('payload').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  nextRunAt: timestampColumn('next_run_at').notNull(),
  leaseOwner: varchar('lease_owner', { length: 128 }),
  leaseExpiresAt: timestampColumn('lease_expires_at'),
  currentRunId: uuidColumn('current_run_id'),
  lastStatus: varchar('last_status', { length: 16 }),
  lastStartedAt: timestampColumn('last_started_at'),
  lastFinishedAt: timestampColumn('last_finished_at'),
  lastError: text('last_error'),
  consecutiveFailures: int('consecutive_failures').notNull().default(0),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byDue: index('idx_runtime_jobs_due').on(t.enabled, t.nextRunAt),
  byLease: index('idx_runtime_jobs_lease').on(t.leaseExpiresAt),
}))

export const runtimeJobRuns = mysqlTable('runtime_job_runs', {
  id: uuidPrimaryKey('id'),
  jobId: varchar('job_id', { length: 64 }).notNull().references(() => runtimeJobs.id, { onDelete: 'cascade' }),
  task: varchar('task', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(), // running/succeeded/failed/abandoned/cancelled
  attempt: int('attempt').notNull().default(1),
  leaseOwner: varchar('lease_owner', { length: 128 }).notNull(),
  startedAt: timestampColumn('started_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  finishedAt: timestampColumn('finished_at'),
  result: json('result').$type<Record<string, unknown>>(),
  error: text('error'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byJobStarted: index('idx_runtime_job_runs_job_started').on(t.jobId, t.startedAt),
  byStatus: index('idx_runtime_job_runs_status').on(t.status),
}))

export const radarAiReviews = mysqlTable('radar_ai_reviews', {
  cacheKey: varchar('cache_key', { length: 64 }).primaryKey(),
  sourceKey: text('source_key').notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  promptVersion: varchar('prompt_version', { length: 32 }).notNull(),
  model: varchar('model', { length: 128 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  decision: json('decision').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  attempts: int('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byStatus: index('idx_radar_ai_reviews_status').on(t.status),
}))

// Radar 采集状态使用独立的钉钉自定义机器人。该配置不引用 IM Bot/Binding，
// Webhook access_token 与加签密钥作为同一份 AES-GCM 密文保存。
export const radarDingTalkSettings = mysqlTable('radar_dingtalk_settings', {
  id: varchar('id', { length: 32 }).primaryKey(),
  credentialCiphertext: longtext('credential_ciphertext'),
  credentialHint: varchar('credential_hint', { length: 16 }),
  credentialFingerprint: varchar('credential_fingerprint', { length: 64 }),
  enabled: boolean('enabled').notNull().default(false),
  notifySuccess: boolean('notify_success').notNull().default(true),
  version: int('version').notNull().default(1),
  lastTestStatus: varchar('last_test_status', { length: 16 }),
  lastTestError: text('last_test_error'),
  lastTestLatencyMs: int('last_test_latency_ms'),
  lastTestAt: timestampColumn('last_test_at'),
  lastDeliveryStatus: varchar('last_delivery_status', { length: 16 }),
  lastDeliveryError: text('last_delivery_error'),
  lastDeliveryAt: timestampColumn('last_delivery_at'),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})

export const auditLogs = mysqlTable('audit_logs', {
  id: uuidPrimaryKey('id'),
  userId: uuidColumn('user_id').references(() => users.id),
  userName: varchar('user_name', { length: 64 }).notNull(),
  module: varchar('module', { length: 32 }).notNull(),
  action: varchar('action', { length: 64 }).notNull(),
  target: text('target'),
  ip: varchar('ip', { length: 45 }),
  result: varchar('result', { length: 16 }).notNull().default('success'),
  requestId: varchar('request_id', { length: 64 }).notNull().$defaultFn(() => currentRequestId() ?? randomUUID()),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byUser: index('idx_audit_user').on(t.userId),
  byTime: index('idx_audit_time').on(t.createdAt),
  byRequest: index('idx_audit_request').on(t.requestId),
}))

// 管理配置变更的追加式前态快照。模型与 IM 凭据只会以现有 AES-GCM
// 密文进入快照，管理 API 仅返回版本元数据，不返回 snapshot 正文。
export const adminConfigurationRevisions = mysqlTable('admin_configuration_revisions', {
  id: uuidPrimaryKey('id'),
  domain: varchar('domain', { length: 16 }).notNull(),
  resourceType: varchar('resource_type', { length: 32 }).notNull(),
  resourceId: varchar('resource_id', { length: 191 }).notNull(),
  operation: varchar('operation', { length: 16 }).notNull(),
  sourceVersion: int('source_version').notNull(),
  snapshotCiphertext: longtext('snapshot_ciphertext'),
  snapshotSha256: varchar('snapshot_sha256', { length: 64 }).notNull(),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueResourceVersion: uniqueIndex('uq_admin_config_revision_resource_version')
    .on(t.domain, t.resourceType, t.resourceId, t.sourceVersion),
  byResourceTime: index('idx_admin_config_revision_resource_time')
    .on(t.domain, t.resourceType, t.resourceId, t.createdAt),
  byActorTime: index('idx_admin_config_revision_actor_time').on(t.createdBy, t.createdAt),
}))


export const chatConversations = mysqlTable('chat_conversations', {
  id: uuidPrimaryKey('id'),
  userId: uuidColumn('user_id').references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 128 }).notNull().default('新会话'),
  scope: varchar('scope', { length: 16 }).notNull().default('project'), // project/global
  projectId: uuidColumn('project_id').references(() => projects.id, { onDelete: 'set null' }),
  projectName: varchar('project_name', { length: 128 }),
  // 历史 agent 实例映射；迁移后仅用于兼容旧会话标识，会话正文以 MySQL 为准。
  agentId: varchar('agent_id', { length: 64 }),
  messages: json('messages').$type<unknown[]>().notNull().default(emptyJsonArray),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byUser: index('idx_chat_conv_user').on(t.userId),
  byUpdated: index('idx_chat_conv_updated').on(t.updatedAt),
  byAgent: index('idx_chat_conv_agent').on(t.agentId),
}))

export const agentConversations = mysqlTable('agent_conversations', {
  id: uuidPrimaryKey('id'),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuidColumn('project_id').references(() => projects.id, { onDelete: 'set null' }),
  title: varchar('title', { length: 255 }).notNull().default('新会话'),
  scope: varchar('scope', { length: 16 }).notNull().default('project'),
  status: varchar('status', { length: 16 }).notNull().default('idle'),
  runtime: varchar('runtime', { length: 32 }).notNull().default('jw'),
  externalSessionId: varchar('external_session_id', { length: 128 }),
  legacySource: varchar('legacy_source', { length: 32 }),
  legacyConversationId: varchar('legacy_conversation_id', { length: 64 }),
  modelId: varchar('model_id', { length: 128 }),
  metadata: json('metadata').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byUser: index('idx_agent_conversations_user').on(t.userId),
  byProject: index('idx_agent_conversations_project').on(t.projectId),
  byUpdated: index('idx_agent_conversations_updated').on(t.updatedAt),
  byExternalSession: index('idx_agent_conversations_external').on(t.externalSessionId),
  uniqueLegacyConversation: uniqueIndex('uq_agent_conversations_legacy').on(t.legacySource, t.legacyConversationId),
}))

export const agentMessages = mysqlTable('agent_messages', {
  id: uuidPrimaryKey('id'),
  conversationId: uuidColumn('conversation_id').notNull().references(() => agentConversations.id, { onDelete: 'cascade' }),
  externalMessageId: varchar('external_message_id', { length: 128 }),
  role: varchar('role', { length: 16 }).notNull(),
  sequence: int('sequence').notNull(),
  content: longtext('content'),
  toolName: varchar('tool_name', { length: 128 }),
  toolInput: json('tool_input').$type<unknown>(),
  toolOutput: json('tool_output').$type<unknown>(),
  thinking: longtext('thinking'),
  status: varchar('status', { length: 16 }).notNull().default('complete'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byConversationSequence: index('idx_agent_messages_conversation_sequence').on(t.conversationId, t.sequence),
  uniqueExternalMessage: uniqueIndex('uq_agent_messages_external').on(t.conversationId, t.externalMessageId),
}))

export const agentMessageParts = mysqlTable('agent_message_parts', {
  id: uuidPrimaryKey('id'),
  messageId: uuidColumn('message_id').notNull().references(() => agentMessages.id, { onDelete: 'cascade' }),
  partIndex: int('part_index').notNull(),
  type: varchar('type', { length: 32 }).notNull(),
  content: longtext('content'),
  payload: json('payload').$type<unknown>(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueMessagePart: uniqueIndex('uq_agent_message_parts_order').on(t.messageId, t.partIndex),
}))

export const agentConversationSourceMappings = mysqlTable('agent_conversation_source_mappings', {
  id: uuidPrimaryKey('id'),
  conversationId: uuidColumn('conversation_id').notNull(),
  sourceSystem: varchar('source_system', { length: 32 }).notNull(),
  sourceConversationId: varchar('source_conversation_id', { length: 191 }).notNull(),
  sourceInstanceId: varchar('source_instance_id', { length: 191 }),
  sourceChecksum: varchar('source_checksum', { length: 64 }).notNull(),
  metadata: json('metadata').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueSourceConversation: uniqueIndex('uq_agent_conversation_source').on(t.sourceSystem, t.sourceConversationId),
  byConversation: index('idx_agent_conversation_source_target').on(t.conversationId),
  conversationFk: foreignKey({
    name: 'fk_agent_conv_source_conversation',
    columns: [t.conversationId],
    foreignColumns: [agentConversations.id],
  }).onDelete('cascade'),
}))

export const agentMessageSourceMappings = mysqlTable('agent_message_source_mappings', {
  id: uuidPrimaryKey('id'),
  messageId: uuidColumn('message_id').notNull(),
  sourceSystem: varchar('source_system', { length: 32 }).notNull(),
  sourceConversationId: varchar('source_conversation_id', { length: 191 }).notNull(),
  sourceMessageId: varchar('source_message_id', { length: 191 }).notNull(),
  sourceChecksum: varchar('source_checksum', { length: 64 }).notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueSourceMessage: uniqueIndex('uq_agent_message_source').on(t.sourceSystem, t.sourceConversationId, t.sourceMessageId),
  byMessage: index('idx_agent_message_source_target').on(t.messageId),
  messageFk: foreignKey({
    name: 'fk_agent_message_source_message',
    columns: [t.messageId],
    foreignColumns: [agentMessages.id],
  }).onDelete('cascade'),
}))

export const migrationRuns = mysqlTable('migration_runs', {
  id: uuidPrimaryKey('id'),
  migrationType: varchar('migration_type', { length: 64 }).notNull(),
  sourceLocator: text('source_locator').notNull(),
  sourceSha256: varchar('source_sha256', { length: 64 }).notNull(),
  mode: varchar('mode', { length: 16 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('running'),
  sourceCounts: json('source_counts').$type<Record<string, number>>().notNull().default(emptyJsonObject),
  targetCounts: json('target_counts').$type<Record<string, number>>().notNull().default(emptyJsonObject),
  sourceChecksum: varchar('source_checksum', { length: 64 }),
  targetChecksum: varchar('target_checksum', { length: 64 }),
  report: json('report').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  startedAt: timestampColumn('started_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  completedAt: timestampColumn('completed_at'),
}, (t) => ({
  byTypeStarted: index('idx_migration_runs_type_started').on(t.migrationType, t.startedAt),
  bySourceChecksum: index('idx_migration_runs_source_sha').on(t.sourceSha256),
}))

export const migrationIssues = mysqlTable('migration_issues', {
  id: uuidPrimaryKey('id'),
  runId: uuidColumn('run_id').notNull(),
  severity: varchar('severity', { length: 16 }).notNull(),
  sourceSystem: varchar('source_system', { length: 32 }).notNull(),
  sourceTable: varchar('source_table', { length: 64 }),
  sourceKey: varchar('source_key', { length: 255 }),
  code: varchar('code', { length: 64 }).notNull(),
  message: text('message').notNull(),
  payload: json('payload').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byRun: index('idx_migration_issues_run').on(t.runId),
  byCode: index('idx_migration_issues_code').on(t.code),
  runFk: foreignKey({
    name: 'fk_migration_issue_run',
    columns: [t.runId],
    foreignColumns: [migrationRuns.id],
  }).onDelete('cascade'),
}))

export const migrationEntityMappings = mysqlTable('migration_entity_mappings', {
  id: uuidPrimaryKey('id'),
  runId: uuidColumn('run_id'),
  sourceSystem: varchar('source_system', { length: 32 }).notNull(),
  sourceTable: varchar('source_table', { length: 64 }).notNull(),
  sourceId: varchar('source_id', { length: 191 }).notNull(),
  targetTable: varchar('target_table', { length: 64 }).notNull(),
  targetId: varchar('target_id', { length: 191 }).notNull(),
  mappingKind: varchar('mapping_kind', { length: 16 }).notNull(),
  sourceChecksum: varchar('source_checksum', { length: 64 }).notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueSourceEntity: uniqueIndex('uq_migration_entity_source').on(t.sourceSystem, t.sourceTable, t.sourceId),
  byTargetEntity: index('idx_migration_entity_target').on(t.targetTable, t.targetId),
  byRun: index('idx_migration_entity_run').on(t.runId),
  runFk: foreignKey({
    name: 'fk_migration_entity_run',
    columns: [t.runId],
    foreignColumns: [migrationRuns.id],
  }).onDelete('set null'),
}))

export const migrationCdcCheckpoints = mysqlTable('migration_cdc_checkpoints', {
  id: uuidPrimaryKey('id'),
  sourceSystem: varchar('source_system', { length: 32 }).notNull(),
  sourceInstance: varchar('source_instance', { length: 128 }).notNull(),
  sourceFingerprint: varchar('source_fingerprint', { length: 64 }).notNull(),
  captureVersion: varchar('capture_version', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('idle'),
  lastSequence: bigint('last_sequence', { mode: 'bigint', unsigned: true }).notNull().default(0n),
  lastTxid: bigint('last_txid', { mode: 'bigint', unsigned: true }).notNull().default(0n),
  sourceSafeWatermark: bigint('source_safe_watermark', { mode: 'bigint', unsigned: true }).notNull().default(0n),
  sourceObservedWatermark: bigint('source_observed_watermark', { mode: 'bigint', unsigned: true }).notNull().default(0n),
  appliedEvents: bigint('applied_events', { mode: 'bigint', unsigned: true }).notNull().default(0n),
  replayedEvents: bigint('replayed_events', { mode: 'bigint', unsigned: true }).notNull().default(0n),
  insertedEvents: bigint('inserted_events', { mode: 'bigint', unsigned: true }).notNull().default(0n),
  updatedEvents: bigint('updated_events', { mode: 'bigint', unsigned: true }).notNull().default(0n),
  deletedEvents: bigint('deleted_events', { mode: 'bigint', unsigned: true }).notNull().default(0n),
  cascadeDeletedEvents: bigint('cascade_deleted_events', { mode: 'bigint', unsigned: true }).notNull().default(0n),
  replicationLagMs: bigint('replication_lag_ms', { mode: 'number', unsigned: true }).notNull().default(0),
  lastEventAt: timestampColumn('last_event_at'),
  report: json('report').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueSource: uniqueIndex('uq_migration_cdc_source').on(t.sourceSystem, t.sourceInstance),
}))

export const migrationCdcEvents = mysqlTable('migration_cdc_events', {
  id: uuidPrimaryKey('id'),
  checkpointId: uuidColumn('checkpoint_id').notNull(),
  sourceSequence: bigint('source_sequence', { mode: 'bigint', unsigned: true }).notNull(),
  sourceTxid: bigint('source_txid', { mode: 'bigint', unsigned: true }).notNull(),
  sourceTable: varchar('source_table', { length: 64 }).notNull(),
  sourceEntityId: varchar('source_entity_id', { length: 191 }).notNull(),
  operation: varchar('operation', { length: 8 }).notNull(),
  eventChecksum: varchar('event_checksum', { length: 64 }).notNull(),
  outcome: varchar('outcome', { length: 16 }).notNull(),
  tombstone: boolean('tombstone').notNull().default(false),
  cascadeDelete: boolean('cascade_delete').notNull().default(false),
  sourceOccurredAt: timestampColumn('source_occurred_at').notNull(),
  appliedAt: timestampColumn('applied_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueSequence: uniqueIndex('uq_migration_cdc_event_sequence').on(t.checkpointId, t.sourceSequence),
  byEntity: index('idx_migration_cdc_event_entity').on(t.sourceTable, t.sourceEntityId, t.sourceSequence),
  byTransaction: index('idx_migration_cdc_event_txid').on(t.checkpointId, t.sourceTxid, t.sourceSequence),
  checkpointFk: foreignKey({
    name: 'fk_migration_cdc_event_checkpoint',
    columns: [t.checkpointId],
    foreignColumns: [migrationCdcCheckpoints.id],
  }).onDelete('cascade'),
}))

// 内置专业任务模板的 MySQL 注册表。代码包继续承载不可变模板资产，数据库记录
// 当前批准版本、Skill 和输出格式，任务创建前必须逐项匹配，避免引用不存在的模板。
export const aiTaskTemplates = mysqlTable('ai_task_templates', {
  type: varchar('type', { length: 40 }).primaryKey(),
  label: varchar('label', { length: 128 }).notNull(),
  templateVersion: varchar('template_version', { length: 64 }).notNull(),
  skillName: varchar('skill_name', { length: 128 }).notNull(),
  outputFormat: varchar('output_format', { length: 16 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('enabled'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byStatus: index('idx_ai_task_templates_status').on(t.status, t.type),
}))

export const aiModelProviders = mysqlTable('ai_model_providers', {
  id: uuidPrimaryKey('id'),
  name: varchar('name', { length: 128 }).notNull(),
  protocol: varchar('protocol', { length: 32 }).notNull().default('openai-compatible'),
  baseUrl: varchar('base_url', { length: 2048 }).notNull(),
  credentialCiphertext: longtext('credential_ciphertext'),
  credentialHint: varchar('credential_hint', { length: 16 }),
  credentialFingerprint: varchar('credential_fingerprint', { length: 64 }),
  timeoutMs: int('timeout_ms').notNull().default(120_000),
  enabled: boolean('enabled').notNull().default(true),
  version: int('version').notNull().default(1),
  lastTestStatus: varchar('last_test_status', { length: 16 }),
  lastTestError: text('last_test_error'),
  lastTestLatencyMs: int('last_test_latency_ms'),
  lastTestTraceId: uuidColumn('last_test_trace_id'),
  lastTestAt: timestampColumn('last_test_at'),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueName: uniqueIndex('uq_ai_model_providers_name').on(t.name),
  byEnabled: index('idx_ai_model_providers_enabled').on(t.enabled, t.name),
}))

export const aiModels = mysqlTable('ai_models', {
  id: uuidPrimaryKey('id'),
  providerId: uuidColumn('provider_id').notNull().references(() => aiModelProviders.id, { onDelete: 'restrict' }),
  modelKey: varchar('model_key', { length: 128 }).notNull(),
  displayName: varchar('display_name', { length: 128 }).notNull(),
  contextWindow: int('context_window'),
  capabilityTags: json('capability_tags').$type<string[]>().notNull().default(emptyJsonArray),
  allowedRoles: json('allowed_roles').$type<string[]>().notNull().default(emptyJsonArray),
  enabled: boolean('enabled').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  version: int('version').notNull().default(1),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueProviderKey: uniqueIndex('uq_ai_models_provider_key').on(t.providerId, t.modelKey),
  byEnabledDefault: index('idx_ai_models_enabled_default').on(t.enabled, t.isDefault),
}))

export const aiModelRoutes = mysqlTable('ai_model_routes', {
  profileKey: varchar('profile_key', { length: 64 }).primaryKey(),
  modelId: uuidColumn('model_id').notNull().references(() => aiModels.id, { onDelete: 'restrict' }),
  fallbackModelId: uuidColumn('fallback_model_id').references(() => aiModels.id, { onDelete: 'restrict' }),
  enabled: boolean('enabled').notNull().default(true),
  version: int('version').notNull().default(1),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byModels: index('idx_ai_model_routes_models').on(t.modelId, t.fallbackModelId),
}))

export const aiCapabilities = mysqlTable('ai_capabilities', {
  id: uuidPrimaryKey('id'),
  kind: varchar('kind', { length: 16 }).notNull(),
  capabilityKey: varchar('capability_key', { length: 128 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  description: text('description'),
  source: varchar('source', { length: 32 }).notNull().default('builtin'),
  packageVersion: varchar('package_version', { length: 64 }).notNull().default('builtin'),
  config: json('config').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  toolNames: json('tool_names').$type<string[]>().notNull().default(emptyJsonArray),
  dependencyNames: json('dependency_names').$type<string[]>().notNull().default(emptyJsonArray),
  allowedRoles: json('allowed_roles').$type<string[]>().notNull().default(emptyJsonArray),
  enabled: boolean('enabled').notNull().default(true),
  version: int('version').notNull().default(1),
  lastTestStatus: varchar('last_test_status', { length: 16 }),
  lastTestError: text('last_test_error'),
  lastTestLatencyMs: int('last_test_latency_ms'),
  lastTestTraceId: uuidColumn('last_test_trace_id'),
  lastTestAt: timestampColumn('last_test_at'),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueKindKey: uniqueIndex('uq_ai_capabilities_kind_key').on(t.kind, t.capabilityKey),
  byEnabled: index('idx_ai_capabilities_enabled').on(t.enabled, t.kind, t.name),
}))

export const aiCapabilityBindings = mysqlTable('ai_capability_bindings', {
  id: uuidPrimaryKey('id'),
  capabilityId: uuidColumn('capability_id').notNull().references(() => aiCapabilities.id, { onDelete: 'cascade' }),
  scopeType: varchar('scope_type', { length: 16 }).notNull(),
  scopeKey: varchar('scope_key', { length: 128 }).notNull(),
  department: varchar('department', { length: 64 }),
  projectId: uuidColumn('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  version: int('version').notNull().default(1),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueScope: uniqueIndex('uq_ai_capability_bindings_scope').on(t.capabilityId, t.scopeType, t.scopeKey),
  byProject: index('idx_ai_capability_bindings_project').on(t.projectId, t.enabled),
  byDepartment: index('idx_ai_capability_bindings_department').on(t.department, t.enabled),
}))

export const aiConversationCapabilities = mysqlTable('ai_conversation_capabilities', {
  conversationId: uuidColumn('conversation_id').notNull().references(() => agentConversations.id, { onDelete: 'cascade' }),
  capabilityId: uuidColumn('capability_id').notNull().references(() => aiCapabilities.id, { onDelete: 'cascade' }),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueConversationCapability: uniqueIndex('uq_ai_conversation_capabilities').on(t.conversationId, t.capabilityId),
  byUser: index('idx_ai_conversation_capabilities_user').on(t.userId, t.conversationId),
}))

// IM 机器人由统一业务进程管理。凭据只保存 AES-GCM 密文；绑定使用稳定
// MySQL 用户/项目/会话 ID，外部会话标识不能直接决定内部授权范围。
export const imBots = mysqlTable('im_bots', {
  id: uuidPrimaryKey('id'),
  platform: varchar('platform', { length: 16 }).notNull(), // dingtalk/feishu/wechat
  name: varchar('name', { length: 128 }).notNull(),
  credentialCiphertext: longtext('credential_ciphertext').notNull(),
  credentialHint: varchar('credential_hint', { length: 16 }).notNull(),
  credentialFingerprint: varchar('credential_fingerprint', { length: 64 }).notNull(),
  config: json('config').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  enabled: boolean('enabled').notNull().default(false),
  connectionStatus: varchar('connection_status', { length: 16 }).notNull().default('disconnected'),
  lastConnectedAt: timestampColumn('last_connected_at'),
  lastError: text('last_error'),
  version: int('version').notNull().default(1),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniquePlatformName: uniqueIndex('uq_im_bots_platform_name').on(t.platform, t.name),
  byEnabled: index('idx_im_bots_enabled').on(t.enabled, t.platform),
}))

export const imBotBindings = mysqlTable('im_bot_bindings', {
  id: uuidPrimaryKey('id'),
  botId: uuidColumn('bot_id').notNull().references(() => imBots.id, { onDelete: 'cascade' }),
  externalConversationId: varchar('external_conversation_id', { length: 191 }).notNull(),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuidColumn('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: uuidColumn('conversation_id').references(() => agentConversations.id, { onDelete: 'cascade' }),
  department: varchar('department', { length: 64 }),
  enabled: boolean('enabled').notNull().default(true),
  version: int('version').notNull().default(1),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueExternalConversation: uniqueIndex('uq_im_bot_bindings_external').on(t.botId, t.externalConversationId),
  byUser: index('idx_im_bot_bindings_user').on(t.userId, t.enabled),
  byProject: index('idx_im_bot_bindings_project').on(t.projectId, t.enabled),
  byConversation: index('idx_im_bot_bindings_conversation').on(t.conversationId, t.enabled),
}))

export const imOutbox = mysqlTable('im_outbox', {
  id: uuidPrimaryKey('id'),
  botId: uuidColumn('bot_id').notNull().references(() => imBots.id, { onDelete: 'restrict' }),
  bindingId: uuidColumn('binding_id').notNull().references(() => imBotBindings.id, { onDelete: 'restrict' }),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
  payload: json('payload').$type<Record<string, unknown>>().notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  attempts: int('attempts').notNull().default(0),
  nextAttemptAt: timestampColumn('next_attempt_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  leaseOwner: varchar('lease_owner', { length: 128 }),
  leaseExpiresAt: timestampColumn('lease_expires_at'),
  lastError: text('last_error'),
  sentAt: timestampColumn('sent_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueIdempotency: uniqueIndex('uq_im_outbox_idempotency').on(t.botId, t.idempotencyKey),
  byDue: index('idx_im_outbox_due').on(t.status, t.nextAttemptAt, t.leaseExpiresAt),
  byBinding: index('idx_im_outbox_binding').on(t.bindingId, t.createdAt),
}))

export const imDeliveryLogs = mysqlTable('im_delivery_logs', {
  id: uuidPrimaryKey('id'),
  outboxId: uuidColumn('outbox_id').notNull().references(() => imOutbox.id, { onDelete: 'cascade' }),
  attempt: int('attempt').notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  externalMessageId: varchar('external_message_id', { length: 191 }),
  httpStatus: int('http_status'),
  durationMs: int('duration_ms').notNull(),
  error: text('error'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueAttempt: uniqueIndex('uq_im_delivery_logs_attempt').on(t.outboxId, t.attempt),
  byStatus: index('idx_im_delivery_logs_status').on(t.status, t.createdAt),
}))

export const imInboundMessages = mysqlTable('im_inbound_messages', {
  id: uuidPrimaryKey('id'),
  botId: uuidColumn('bot_id').notNull().references(() => imBots.id, { onDelete: 'restrict' }),
  bindingId: uuidColumn('binding_id').references(() => imBotBindings.id, { onDelete: 'set null' }),
  externalMessageId: varchar('external_message_id', { length: 191 }).notNull(),
  externalConversationId: varchar('external_conversation_id', { length: 191 }).notNull(),
  externalUserId: varchar('external_user_id', { length: 191 }),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  payload: json('payload').$type<Record<string, unknown>>().notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  rejectionReason: varchar('rejection_reason', { length: 64 }),
  receivedAt: timestampColumn('received_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueExternalMessage: uniqueIndex('uq_im_inbound_external').on(t.botId, t.externalMessageId),
  byRoute: index('idx_im_inbound_route').on(t.bindingId, t.status, t.receivedAt),
}))

// 线索池只保存对已授权 IM 绑定的引用和业务规则，不复制凭据。
export const imLeadPushRules = mysqlTable('im_lead_push_rules', {
  id: uuidPrimaryKey('id'),
  name: varchar('name', { length: 128 }).notNull(),
  botId: uuidColumn('bot_id').notNull().references(() => imBots.id, { onDelete: 'restrict' }),
  bindingId: uuidColumn('binding_id').notNull().references(() => imBotBindings.id, { onDelete: 'restrict' }),
  leadStatus: varchar('lead_status', { length: 32 }),
  projectId: uuidColumn('project_id').references(() => projects.id, { onDelete: 'set null' }),
  minScore: int('min_score'),
  messageTemplate: text('message_template').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  version: int('version').notNull().default(1),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueName: uniqueIndex('uq_im_lead_push_rules_name').on(t.name),
  byEnabledStatus: index('idx_im_lead_push_rules_enabled').on(t.enabled, t.leadStatus, t.minScore),
  byTarget: index('idx_im_lead_push_rules_target').on(t.botId, t.bindingId),
  byProject: index('idx_im_lead_push_rules_project').on(t.projectId, t.enabled),
}))

export const aiTasks = mysqlTable('ai_tasks', {
  id: uuidPrimaryKey('id'),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: varchar('conversation_id', { length: 64 }),
  type: varchar('type', { length: 40 }).notNull(),
  parameters: json('parameters').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  templateVersion: varchar('template_version', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  stage: varchar('stage', { length: 64 }).notNull().default('等待执行'),
  progress: int('progress').notNull().default(0),
  resultSummary: text('result_summary'),
  errorId: varchar('error_id', { length: 64 }),
  errorCode: varchar('error_code', { length: 64 }),
  errorMessage: text('error_message'),
  retryable: boolean('retryable'),
  cancellationRequested: boolean('cancellation_requested').notNull().default(false),
  executionAttempts: int('execution_attempts').notNull().default(0),
  leaseOwner: varchar('lease_owner', { length: 128 }),
  leaseExpiresAt: timestampColumn('lease_expires_at'),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }),
  retryOfTaskId: uuidColumn('retry_of_task_id'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  startedAt: timestampColumn('started_at'),
  completedAt: timestampColumn('completed_at'),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byUser: index('idx_ai_tasks_user').on(t.userId),
  byProject: index('idx_ai_tasks_project').on(t.projectId),
  byStatus: index('idx_ai_tasks_status').on(t.status),
  byLease: index('idx_ai_tasks_lease').on(t.status, t.leaseExpiresAt),
  byRetrySource: index('idx_ai_tasks_retry_of').on(t.retryOfTaskId),
  uniqueIdempotency: uniqueIndex('uq_ai_tasks_user_idempotency').on(t.userId, t.idempotencyKey),
}))

export const aiArtifacts = mysqlTable('ai_artifacts', {
  id: uuidPrimaryKey('id'),
  taskId: uuidColumn('task_id').notNull().references(() => aiTasks.id, { onDelete: 'cascade' }),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: varchar('conversation_id', { length: 64 }),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  format: varchar('format', { length: 16 }).notNull(),
  mimeType: varchar('mime_type', { length: 128 }).notNull(),
  version: int('version').notNull().default(1),
  storagePath: text('storage_path').notNull(),
  editableLevel: varchar('editable_level', { length: 32 }).notNull().default('none'),
  sourceCutoffDate: varchar('source_cutoff_date', { length: 10 }),
  templateVersion: varchar('template_version', { length: 64 }).notNull(),
  qualityStatus: varchar('quality_status', { length: 16 }).notNull().default('unchecked'),
  metadata: json('metadata').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  archived: boolean('archived').notNull().default(false),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byTask: index('idx_ai_artifacts_task').on(t.taskId),
  byUser: index('idx_ai_artifacts_user').on(t.userId),
  byProject: index('idx_ai_artifacts_project').on(t.projectId),
}))

export const aiTaskSources = mysqlTable('ai_task_sources', {
  id: uuidPrimaryKey('id'),
  taskId: uuidColumn('task_id').notNull().references(() => aiTasks.id, { onDelete: 'cascade' }),
  artifactId: uuidColumn('artifact_id').references(() => aiArtifacts.id, { onDelete: 'cascade' }),
  sourceType: varchar('source_type', { length: 24 }).notNull(),
  sourceId: varchar('source_id', { length: 64 }),
  sourceName: varchar('source_name', { length: 255 }).notNull(),
  locator: text('locator'),
  verificationStatus: varchar('verification_status', { length: 16 }).notNull().default('待核验'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
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

export const aiCustomTemplates = mysqlTable('ai_custom_templates', {
  id: uuidPrimaryKey('id'),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: uuidColumn('conversation_id'),
  originalFileName: varchar('original_file_name', { length: 255 }).notNull(),
  format: varchar('format', { length: 16 }).notNull(),
  mimeType: varchar('mime_type', { length: 128 }).notNull(),
  fileSize: int('file_size').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  storagePath: text('storage_path').notNull(),
  analysis: json('analysis').$type<AiCustomTemplateAnalysis>().notNull(),
  skillName: varchar('skill_name', { length: 64 }).notNull(),
  skillPath: text('skill_path').notNull(),
  skillVersion: varchar('skill_version', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('succeeded'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byUser: index('idx_ai_custom_templates_user').on(t.userId),
  byProject: index('idx_ai_custom_templates_project').on(t.projectId),
  byConversation: index('idx_ai_custom_templates_conversation').on(t.conversationId),
  conversationFk: foreignKey({
    name: 'fk_ai_custom_templates_conversation',
    columns: [t.conversationId],
    foreignColumns: [chatConversations.id],
  }).onDelete('set null'),
}))

// 耗时模板分析的在线进度。该状态必须跨刷新、重启可解释且按用户/项目隔离，
// 不允许再退回 `.runtime` JSON 文件作为事实源。
export const aiTemplateAnalysisProgress = mysqlTable('ai_template_analysis_progress', {
  id: uuidPrimaryKey('id'),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  taskId: uuidColumn('task_id').references(() => aiTasks.id, { onDelete: 'set null' }),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  purpose: varchar('purpose', { length: 48 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('running'),
  stage: varchar('stage', { length: 255 }).notNull(),
  progress: int('progress').notNull().default(0),
  errorMessage: text('error_message'),
  result: json('result').$type<unknown>(),
  startedAt: timestampColumn('started_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  expiresAt: timestampColumn('expires_at').notNull(),
}, (t) => ({
  byUserUpdated: index('idx_ai_template_progress_user_updated').on(t.userId, t.updatedAt),
  byStatusExpiry: index('idx_ai_template_progress_status_expiry').on(t.status, t.expiresAt),
}))

export const fileChunks = mysqlTable('file_chunks', {
  id: uuidPrimaryKey('id'),
  fileId: uuidColumn('file_id').notNull().references(() => projectFiles.id, { onDelete: 'cascade' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  chunkIndex: int('chunk_index').notNull().default(0),
  content: text('content').notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byFile: index('idx_file_chunks_file').on(t.fileId),
  byProject: index('idx_file_chunks_project').on(t.projectId),
}))

// 统一知识库 RAG：scope 区分来源库(project当前项目/lead共有线索池/org机构公共)，ref_id 为通用外键(不强绑FK)
export const knowledgeChunks = mysqlTable('knowledge_chunks', {
  id: uuidPrimaryKey('id'),
  scope: varchar('scope', { length: 16 }).notNull(), // 'project' | 'lead' | 'org'
  refId: varchar('ref_id', { length: 64 }).notNull(), // 项目id/线索id/'org'
  sourceType: varchar('source_type', { length: 24 }).notNull(), // file|meeting|material|audio|video|ppt|pdf|lead_profile
  sourceId: varchar('source_id', { length: 64 }), // 来源实体id(file_id/meeting_id/lead_id)
  sourceName: varchar('source_name', { length: 255 }).notNull().default(''),
  chunkIndex: int('chunk_index').notNull().default(0),
  content: text('content').notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byScopeRef: index('idx_kc_scope_ref').on(t.scope, t.refId),
  byScope: index('idx_kc_scope').on(t.scope),
  bySource: index('idx_kc_source').on(t.sourceId),
  uniqueSourceChunk: uniqueIndex('uq_kc_source_chunk').on(t.scope, t.refId, t.sourceId, t.chunkIndex),
}))
