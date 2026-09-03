import { randomUUID } from 'node:crypto'
import { mysqlTableCreator, text, longtext, customType, int, bigint, boolean, json, varchar, date, index, uniqueIndex, foreignKey } from 'drizzle-orm/mysql-core'
import { sql } from 'drizzle-orm'
import { mysqlConfig } from './config.js'
import { currentRequestId } from '../runtime/structuredLogger.js'
import type { FdeWorkflowPolicyConfig } from '../contracts/fdeWorkflowPolicyContract.js'
import type { TypePolicyDefinition, TypePolicyReceipt } from '../contracts/fdeTypePolicyContract.js'
import type { TypeRegistrationReceipt } from '../contracts/fdeTypeRegistrationContract.js'
import type { WeeklyReportFacts } from '../contracts/fdeWeeklyReportContract.js'
import type { FridayMinutes } from '../contracts/fdeFridayMeetingContract.js'
import type { CommitteeReceipt } from '../contracts/fdeCommitteeContract.js'
import type { ResponsibilityPolicy, ResponsibilityPolicyReceipt } from '../contracts/fdeResponsibilityPolicyContract.js'
import type { ResponsibilityReceipt } from '../contracts/fdeResponsibilityContract.js'
import type {
  LeadInvestmentProfileAcademicLink,
  LeadInvestmentProfileCustomer,
  LeadInvestmentProfileInstitution,
  LeadInvestmentProfileProduct,
} from '../contracts/leadInvestmentProfileContract.js'
import type { LeadResearchProfileSummary } from '../contracts/leadResearchProfileContract.js'

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
  fdeCategory: varchar('fde_category', { length: 32 }),
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

export const fdeWorkflowPolicies = mysqlTable('fde_workflow_policies', {
  id: uuidPrimaryKey('id'), code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(), activeVersionId: uuidColumn('active_version_id'),
  enabled: boolean('enabled').notNull().default(true), version: int('version').notNull().default(1),
  nextRevision: int('next_revision').notNull().default(2),
}, (t) => ({ uniqueCode: uniqueIndex('uq_fde_policy_code').on(t.code) }))

export const fdeWorkflowPolicyVersions = mysqlTable('fde_workflow_policy_versions', {
  id: uuidPrimaryKey('id'), policyId: uuidColumn('policy_id').notNull().references(() => fdeWorkflowPolicies.id, { onDelete: 'restrict' }),
  revision: int('revision').notNull(), status: varchar('status', { length: 16 }).notNull().default('draft'),
  configuration: json('configuration').$type<FdeWorkflowPolicyConfig | TypePolicyDefinition>().notNull(), sha256: varchar('sha256', { length: 64 }).notNull(),
  reason: text('reason').notNull(), version: int('version').notNull().default(1),
  createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'set null' }),
  publishedBy: uuidColumn('published_by').references(() => users.id, { onDelete: 'set null' }),
  publishedAt: timestampColumn('published_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueRevision: uniqueIndex('uq_fde_policy_revision').on(t.policyId, t.revision) }))

// Non-investment definitions share the authoritative version IDs, but use their
// own review/command journal. Investment policies keep their original contract.
export const fdeTypePolicyReviews = mysqlTable('fde_type_policy_reviews', {
  versionId: uuidColumn('version_id').primaryKey().references(() => fdeWorkflowPolicyVersions.id, { onDelete: 'restrict' }),
  approvedBy: uuidColumn('approved_by').references(() => users.id, { onDelete: 'restrict' }),
  approvedAt: timestampColumn('approved_at'), approvedHash: varchar('approved_hash', { length: 64 }),
})
export const fdeTypePolicyCommands = mysqlTable('fde_type_policy_commands', {
  id: uuidPrimaryKey('id'), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  commandId: uuidColumn('command_id').notNull(), commandHash: varchar('command_hash', { length: 64 }),
  receipt: json('receipt').$type<TypePolicyReceipt>(), closedAt: timestampColumn('closed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ command: uniqueIndex('uq_type_policy_command').on(t.actorId, t.commandId) }))
export const fdeTypePolicyEvents = mysqlTable('fde_type_policy_events', {
  id: uuidPrimaryKey('id'), policyId: uuidColumn('policy_id').notNull().references(() => fdeWorkflowPolicies.id, { onDelete: 'restrict' }),
  versionId: uuidColumn('version_id').notNull().references(() => fdeWorkflowPolicyVersions.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  commandId: uuidColumn('command_id').notNull(), action: varchar('action', { length: 16 }).notNull(), reason: text('reason').notNull(),
  snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ command: uniqueIndex('uq_type_policy_event_command').on(t.actorId, t.commandId), history: index('idx_type_policy_history').on(t.policyId, t.createdAt) }))

export const fdeTypeRegistrationCommands = mysqlTable('fde_type_registration_commands', {
  id: uuidPrimaryKey('id'), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  commandId: uuidColumn('command_id').notNull(), commandHash: varchar('command_hash', { length: 64 }),
  receipt: json('receipt').$type<TypeRegistrationReceipt>(), closedAt: timestampColumn('closed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ command: uniqueIndex('uq_type_registration_command').on(t.actorId, t.commandId) }))

export const projects = mysqlTable('projects', {
  id: uuidPrimaryKey('id'),
  name: varchar('name', { length: 128 }).notNull(),
  companyName: varchar('company_name', { length: 128 }),
  industry: varchar('industry', { length: 64 }),
  round: varchar('round', { length: 64 }),
  stage: varchar('stage', { length: 16 }).notNull().default('线索'), // 线索/初筛/立项/尽调/上会/投决/投后/退出/放弃
  stageSource: varchar('stage_source', { length: 32 }),
  classification: varchar('classification', { length: 16 }).notNull().default('normal'), // pool/normal/key
  lifecycle: varchar('lifecycle', { length: 16 }).notNull().default('active'), // active/closed/archived/deleted
  workflowModel: varchar('workflow_model', { length: 16 }).notNull().default('legacy'), // legacy/fde-v1
  governanceVersion: int('governance_version').notNull().default(1),
  workflowPolicyVersionId: uuidColumn('workflow_policy_version_id').references(() => fdeWorkflowPolicyVersions.id, { onDelete: 'restrict' }),
  projectType: varchar('project_type', { length: 32 }).notNull().default('投资项目'),
  healthStatus: varchar('health_status', { length: 16 }).notNull().default('正常'),
  targetDate: varchar('target_date', { length: 10 }), // YYYY-MM-DD
  cycleDays: int('cycle_days').notNull().default(40),
  requirements: text('requirements'),
  investmentFund: varchar('investment_fund', { length: 128 }),
  leaderPriority: varchar('leader_priority', { length: 8 }).notNull().default('中'),
  confidentiality: varchar('confidentiality', { length: 16 }).notNull().default('项目成员'),
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
  byClassificationLifecycle: index('idx_projects_classification_lifecycle').on(t.classification, t.lifecycle, t.updatedAt),
  byTargetDate: index('idx_projects_target_date').on(t.targetDate, t.lifecycle),
}))

export const projectClassificationHistory = mysqlTable('project_classification_history', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fromClassification: varchar('from_classification', { length: 16 }),
  toClassification: varchar('to_classification', { length: 16 }).notNull(),
  reason: text('reason').notNull(),
  changedBy: uuidColumn('changed_by').references(() => users.id, { onDelete: 'set null' }),
  changedByName: varchar('changed_by_name', { length: 64 }).notNull(),
  requestId: varchar('request_id', { length: 64 }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byProjectTime: index('idx_project_classification_history_project_time').on(t.projectId, t.createdAt),
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

export const projectDutyAssignments = mysqlTable('project_duty_assignments', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  duty: varchar('duty', { length: 32 }).notNull(),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  assignedBy: uuidColumn('assigned_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueAssignment: uniqueIndex('uq_project_duty_assignment').on(t.projectId, t.duty, t.userId),
  byUser: index('idx_project_duty_user').on(t.userId, t.projectId),
}))

export const projectGovernanceChanges = mysqlTable('project_governance_changes', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  baseVersion: int('base_version').notNull(),
  proposedOwnerId: uuidColumn('proposed_owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  proposedAssignments: json('proposed_assignments').$type<Array<{ duty: string; userId: string }>>().notNull().default(emptyJsonArray),
  previousSnapshot: json('previous_snapshot').$type<Record<string, unknown>>().notNull(),
  reason: text('reason').notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  activeKey: uuidColumn('active_key'),
  requestedBy: uuidColumn('requested_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  requiredConfirmers: json('required_confirmers').$type<string[]>().notNull().default(emptyJsonArray),
  confirmations: json('confirmations').$type<Array<{ userId: string; decision: string; comment: string; at: string }>>().notNull().default(emptyJsonArray),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  appliedAt: timestampColumn('applied_at'),
}, (t) => ({
  uniquePending: uniqueIndex('uq_project_governance_pending').on(t.activeKey),
  byProject: index('idx_project_governance_history').on(t.projectId, t.createdAt),
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
  accessMode: varchar('access_mode', { length: 16 }).notNull().default('project'),
  accessVersion: int('access_version').notNull().default(1),
  lifecycle: varchar('lifecycle', { length: 16 }).notNull().default('active'),
  deletedBy: uuidColumn('deleted_by').references(() => users.id, { onDelete: 'restrict' }),
  deletedAt: timestampColumn('deleted_at'),
  deleteReason: text('delete_reason'),
  retentionUntil: timestampColumn('retention_until'),
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

export const projectFileGrants = mysqlTable('project_file_grants', {
  id: uuidPrimaryKey('id'),
  fileId: uuidColumn('file_id').notNull().references(() => projectFiles.id, { onDelete: 'restrict' }),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  canView: boolean('can_view').notNull().default(false),
  canDownload: boolean('can_download').notNull().default(false),
  grantedBy: uuidColumn('granted_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ user: uniqueIndex('uq_file_grant_user').on(t.fileId, t.userId) }))

export const projectFileEvents = mysqlTable('project_file_events', {
  id: uuidPrimaryKey('id'), fileId: uuidColumn('file_id').notNull().references(() => projectFiles.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  requestId: uuidColumn('request_id').notNull(), requestHash: varchar('request_hash', { length: 64 }).notNull(),
  action: varchar('action', { length: 24 }).notNull(), version: int('version').notNull(), reason: text('reason').notNull(),
  snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ request: uniqueIndex('uq_file_event_request').on(t.requestId), version: uniqueIndex('uq_file_event_version').on(t.fileId, t.version) }))

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

export const projectMaterialSubmissions = mysqlTable('project_material_submissions', {
  id: uuidPrimaryKey('id'), projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  fileId: uuidColumn('file_id').notNull(), fileVersion: int('file_version').notNull(), fileName: varchar('file_name', { length: 255 }).notNull(),
  fileSha256: varchar('file_sha256', { length: 64 }).notNull(), fileByteSize: bigint('file_byte_size', { mode: 'number' }).notNull(),
  senderId: uuidColumn('sender_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  title: varchar('title', { length: 100 }).notNull(), note: text('note').notNull(), stage: varchar('stage', { length: 32 }).notNull(),
  status: varchar('status', { length: 24 }).notNull().default('pending'), version: int('version').notNull().default(1), revision: int('revision').notNull().default(1), previousId: uuidColumn('previous_id'),
  withdrawnAt: timestampColumn('withdrawn_at'), withdrawalReason: text('withdrawal_reason'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`), updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ previous: uniqueIndex('uq_material_previous').on(t.previousId), list: index('idx_material_project_status').on(t.projectId, t.status, t.createdAt),
  original: foreignKey({ columns: [t.fileId, t.fileVersion], foreignColumns: [projectFileVersions.fileId, projectFileVersions.version] }).onDelete('restrict'),
  previousLink: foreignKey({ columns: [t.previousId], foreignColumns: [t.id] }).onDelete('restrict'),
}))
export const projectMaterialRecipients = mysqlTable('project_material_recipients', {
  id: uuidPrimaryKey('id'), submissionId: uuidColumn('submission_id').notNull().references(() => projectMaterialSubmissions.id, { onDelete: 'restrict' }),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }), version: int('version').notNull().default(1),
  readAt: timestampColumn('read_at'), decision: varchar('decision', { length: 16 }), feedback: text('feedback'), decidedAt: timestampColumn('decided_at'),
}, t => ({ recipient: uniqueIndex('uq_material_recipient').on(t.submissionId, t.userId), user: index('idx_material_recipient_user').on(t.userId, t.decision) }))
export const projectMaterialEvents = mysqlTable('project_material_events', {
  id: uuidPrimaryKey('id'), submissionId: uuidColumn('submission_id').notNull().references(() => projectMaterialSubmissions.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }), requestId: uuidColumn('request_id').notNull(), requestHash: varchar('request_hash', { length: 64 }).notNull(),
  action: varchar('action', { length: 24 }).notNull(), version: int('version').notNull(), reason: text('reason').notNull(), snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ request: uniqueIndex('uq_material_event_request').on(t.requestId), version: uniqueIndex('uq_material_event_version').on(t.submissionId, t.version) }))
// A resolved, uncommitted request is permanently fenced against late delivery.
// No material text or duplicate business state is stored here.
export const projectMaterialRequestClosures = mysqlTable('project_material_request_closures', {
  id: uuidPrimaryKey('id'), requestId: uuidColumn('request_id').notNull(),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ request: uniqueIndex('uq_material_request_closure').on(t.projectId, t.actorId, t.requestId) }))
export const projectMaterialNotices = mysqlTable('project_material_notices', {
  id: uuidPrimaryKey('id'), submissionId: uuidColumn('submission_id').notNull().references(() => projectMaterialSubmissions.id, { onDelete: 'restrict' }),
  recipientId: uuidColumn('recipient_id').notNull().references(() => users.id, { onDelete: 'restrict' }), kind: varchar('kind', { length: 16 }).notNull(), version: int('version').notNull(),
  readAt: timestampColumn('read_at'), closedAt: timestampColumn('closed_at'), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ notice: uniqueIndex('uq_material_notice').on(t.submissionId, t.recipientId, t.kind, t.version), recipient: index('idx_material_notice_recipient').on(t.recipientId, t.closedAt, t.createdAt) }))

export const projectStageMaterials = mysqlTable('project_stage_materials', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  stage: varchar('stage', { length: 32 }).notNull(),
  requirementKey: varchar('requirement_key', { length: 64 }).notNull(),
  fileId: uuidColumn('file_id').references(() => projectFiles.id, { onDelete: 'restrict' }),
  fileVersion: int('file_version'),
  waiverReason: text('waiver_reason'),
  updatedBy: uuidColumn('updated_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueMaterialFile: uniqueIndex('uq_project_stage_material_file').on(t.projectId, t.stage, t.requirementKey, t.fileId),
  byRequirement: index('idx_project_stage_material_requirement').on(t.projectId, t.stage, t.requirementKey),
  byFile: index('idx_project_stage_material_file').on(t.fileId),
}))

export const projectPlans = mysqlTable('project_plans', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  revision: int('revision').notNull().default(1),
  status: varchar('status', { length: 16 }).notNull().default('draft'),
  cycleDays: int('cycle_days').notNull(),
  executionKind: varchar('execution_kind', { length: 16 }).notNull().default('investment'),
  targetDate: varchar('target_date', { length: 10 }).notNull(),
  createdBy: uuidColumn('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  lockedAt: timestampColumn('locked_at'),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueRevision: uniqueIndex('uq_project_plan_revision').on(t.projectId, t.revision),
}))

export const projectAgentConfigs = mysqlTable('project_agent_configs', {
  projectId: uuidColumn('project_id').primaryKey().references(() => projects.id, { onDelete: 'restrict' }),
  configuration: json('configuration').$type<import('../contracts/fdeProjectAgentContract.js').ProjectAgentConfig>().notNull(),
  version: int('version').notNull(), updatedBy: uuidColumn('updated_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})
export const projectAgentRuns = mysqlTable('project_agent_runs', {
  id: uuidPrimaryKey('id'), projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  configuration: json('configuration').$type<import('../contracts/fdeProjectAgentContract.js').ProjectAgentConfig>().notNull(),
  configVersion: int('config_version').notNull(), inputHash: varchar('input_hash', { length: 64 }).notNull(),
  facts: json('facts').$type<import('../contracts/fdeProjectAgentContract.js').ProjectAgentFacts>().notNull(),
  status: varchar('status', { length: 16 }).notNull(), provider: varchar('provider', { length: 16 }).notNull().default('rules'),
  fallbackReason: varchar('fallback_reason', { length: 64 }),
  startedAt: timestampColumn('started_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`), completedAt: timestampColumn('completed_at'),
}, t => ({ byProject: index('idx_project_agent_run').on(t.projectId, t.startedAt, t.id) }))
export const projectAgentRecommendations = mysqlTable('project_agent_recommendations', {
  id: uuidPrimaryKey('id'), runId: uuidColumn('run_id').notNull().references(() => projectAgentRuns.id, { onDelete: 'restrict' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  recommendation: json('recommendation').$type<import('../contracts/fdeProjectAgentContract.js').AgentRecommendation>().notNull(),
  status: varchar('status', { length: 32 }).notNull().default('open'), version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ uniqueRun: uniqueIndex('uq_project_agent_recommendation_run').on(t.runId) }))
export const projectAgentDecisions = mysqlTable('project_agent_decisions', {
  id: uuidPrimaryKey('id'), recommendationId: uuidColumn('recommendation_id').notNull().references(() => projectAgentRecommendations.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  decision: varchar('decision', { length: 32 }).notNull(), note: text('note').notNull(),
  scheduleDraft: json('schedule_draft').$type<import('../contracts/fdeProjectAgentContract.js').AgentScheduleDraft | null>(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ uniqueRecommendation: uniqueIndex('uq_project_agent_decision').on(t.recommendationId) }))
export const projectAgentCommands = mysqlTable('project_agent_commands', {
  id: uuidPrimaryKey('id'), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  requestId: uuidColumn('request_id').notNull(), requestHash: varchar('request_hash', { length: 64 }),
  receipt: json('receipt').$type<{ kind: 'config' | 'run' | 'decision' | 'schedule' | 'timeline' | 'replan'; id: string; version: number } | null>(),
  closedAt: timestampColumn('closed_at'), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ uniqueActorRequest: uniqueIndex('uq_project_agent_command').on(t.actorId, t.requestId) }))

export const projectAgentScheduleRequests = mysqlTable('project_agent_schedule_requests', {
  requestId: uuidColumn('request_id').primaryKey().references(() => oaApprovalRequests.id, { onDelete: 'restrict' }),
  recommendationId: uuidColumn('recommendation_id').notNull().references(() => projectAgentRecommendations.id, { onDelete: 'restrict' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  stage: varchar('stage', { length: 16 }).notNull(), previousDate: varchar('previous_date', { length: 10 }).notNull(),
  requestedDate: varchar('requested_date', { length: 10 }).notNull(), timelineHash: varchar('timeline_hash', { length: 64 }).notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ uniqueRecommendation: uniqueIndex('uq_agent_schedule_recommendation').on(t.recommendationId), byProject: index('idx_agent_schedule_project').on(t.projectId, t.createdAt) }))

export const projectStageDates = mysqlTable('project_stage_dates', {
  id: uuidPrimaryKey('id'), projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  stage: varchar('stage', { length: 16 }).notNull(), plannedDate: varchar('planned_date', { length: 10 }).notNull(),
  approvalId: uuidColumn('approval_id').notNull().references(() => oaApprovalRequests.id, { onDelete: 'restrict' }),
  version: int('version').notNull().default(1), updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ uniqueStage: uniqueIndex('uq_project_stage_date').on(t.projectId, t.stage) }))

// No seed or public activation endpoint: formal calendar/approval policy is a
// separate business decision. Absent/disabled configuration fails closed.
export const projectReplanPolicies = mysqlTable('project_replan_policies', {
  projectId: uuidColumn('project_id').primaryKey().references(() => projects.id, { onDelete: 'restrict' }),
  version: int('version').notNull(), enabled: boolean('enabled').notNull().default(false),
  configuration: json('configuration').$type<import('../contracts/fdeProjectReplanContract.js').ProjectReplanPolicy>().notNull(),
  configurationHash: varchar('configuration_hash', { length: 64 }).notNull(), approvalEvidence: text('approval_evidence').notNull(),
  createdBy: uuidColumn('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  approvedBy: uuidColumn('approved_by').references(() => users.id, { onDelete: 'restrict' }),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})
export const projectReplanRequests = mysqlTable('project_replan_requests', {
  requestId: uuidColumn('request_id').primaryKey().references(() => oaApprovalRequests.id, { onDelete: 'restrict' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  revision: int('revision').notNull(), policyVersion: int('policy_version').notNull(),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  impact: json('impact').$type<import('../contracts/fdeProjectReplanContract.js').ReplanImpact>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ revision: uniqueIndex('uq_project_replan_revision').on(t.projectId, t.revision) }))

export const projectPlanActions = mysqlTable('project_plan_actions', {
  id: uuidPrimaryKey('id'),
  planId: uuidColumn('plan_id').notNull().references(() => projectPlans.id, { onDelete: 'cascade' }),
  actionKey: varchar('action_key', { length: 64 }).notNull(),
  title: varchar('title', { length: 128 }).notNull(),
  ownerUserId: uuidColumn('owner_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  participantUserIds: json('participant_user_ids').$type<string[]>().notNull().default(emptyJsonArray),
  dueDate: varchar('due_date', { length: 10 }).notNull(),
  deliverable: text('deliverable').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('未开始'),
  sortOrder: int('sort_order').notNull(),
  version: int('version').notNull().default(1),
}, (t) => ({
  uniqueAction: uniqueIndex('uq_project_plan_action').on(t.planId, t.actionKey),
  byOwnerDate: index('idx_project_plan_action_owner_date').on(t.ownerUserId, t.dueDate),
}))

export const fdeTypeInstances = mysqlTable('fde_type_instances', {
  projectId: uuidColumn('project_id').primaryKey().references(() => projects.id, { onDelete: 'restrict' }),
  policyVersionId: uuidColumn('policy_version_id').notNull().references(() => fdeWorkflowPolicyVersions.id, { onDelete: 'restrict' }),
  planId: uuidColumn('plan_id').references(() => projectPlans.id, { onDelete: 'restrict' }),
  plan: json('plan').$type<import('../contracts/fdeTypeExecutionContract.js').TypeExecutionPlan>().notNull(),
  planHash: varchar('plan_hash', { length: 64 }).notNull(), stageKey: varchar('stage_key', { length: 48 }).notNull(),
  status: varchar('status', { length: 24 }).$type<import('../contracts/fdeTypeRuntimeContract.js').TypeRuntimeStatus>().notNull(),
  version: int('version').notNull().default(1), createdBy: uuidColumn('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`), updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})
export const fdeTypeExecutionReviews = mysqlTable('fde_type_execution_reviews', {
  id: uuidPrimaryKey('id'), projectId: uuidColumn('project_id').notNull().references(() => fdeTypeInstances.projectId, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 16 }).$type<'plan' | 'stage'>().notNull(), activeKey: uuidColumn('active_key'),
  snapshot: json('snapshot').$type<import('../contracts/fdeTypeRuntimeContract.js').TypeRuntimeReview>().notNull(),
  planSnapshot: json('plan_snapshot').$type<import('../contracts/fdeTypeExecutionContract.js').TypeExecutionPlan>().notNull(),
  status: varchar('status', { length: 16 }).$type<import('../contracts/fdeTypeRuntimeContract.js').TypeRuntimeReview['status']>().notNull(),
  version: int('version').notNull().default(1), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`), updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ active: uniqueIndex('uq_type_execution_active').on(t.activeKey), history: index('idx_type_execution_history').on(t.projectId, t.createdAt, t.id) }))
export const fdeTypeExecutionFiles = mysqlTable('fde_type_execution_files', {
  id: uuidPrimaryKey('id'), reviewId: uuidColumn('review_id').notNull().references(() => fdeTypeExecutionReviews.id, { onDelete: 'restrict' }),
  fileId: uuidColumn('file_id').notNull().references(() => projectFiles.id, { onDelete: 'restrict' }),
  fileVersionId: uuidColumn('file_version_id').notNull().references(() => projectFileVersions.id, { onDelete: 'restrict' }),
}, t => ({ uniqueVersion: uniqueIndex('uq_type_execution_file').on(t.reviewId, t.fileVersionId), byFile: index('idx_type_execution_file').on(t.fileId) }))
export const fdeTypeExecutionCommands = mysqlTable('fde_type_execution_commands', {
  id: uuidPrimaryKey('id'), projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }), commandId: uuidColumn('command_id').notNull(),
  commandHash: varchar('command_hash', { length: 64 }), receipt: json('receipt').$type<import('../contracts/fdeTypeRuntimeContract.js').TypeRuntimeReceipt | null>(), closedAt: timestampColumn('closed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ uniqueCommand: uniqueIndex('uq_type_execution_command').on(t.projectId, t.actorId, t.commandId) }))
export const fdeTypeExecutionNotices = mysqlTable('fde_type_execution_notices', {
  id: uuidPrimaryKey('id'), reviewId: uuidColumn('review_id').notNull().references(() => fdeTypeExecutionReviews.id, { onDelete: 'restrict' }),
  nodeKey: varchar('node_key', { length: 48 }).notNull(), recipientId: uuidColumn('recipient_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`), readAt: timestampColumn('read_at'), closedAt: timestampColumn('closed_at'),
}, t => ({ uniqueNotice: uniqueIndex('uq_type_notice_node_recipient').on(t.reviewId, t.nodeKey, t.recipientId), recipient: index('idx_type_notice_recipient').on(t.recipientId, t.closedAt) }))
export const fdeTypeExecutionEvents = mysqlTable('fde_type_execution_events', {
  id: uuidPrimaryKey('id'), projectId: uuidColumn('project_id').notNull().references(() => fdeTypeInstances.projectId, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }), commandId: uuidColumn('command_id').notNull(),
  action: varchar('action', { length: 24 }).notNull(), version: int('version').notNull(), reason: text('reason').notNull(),
  snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ uniqueVersion: uniqueIndex('uq_type_execution_event').on(t.projectId, t.version) }))

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
  endsAt: timestampColumn('ends_at'),
  workflowKind: varchar('workflow_kind', { length: 24 }).notNull().default('legacy'),
  workflowStatus: varchar('workflow_status', { length: 24 }).notNull().default('recorded'),
  weeklyReview: json('weekly_review').$type<FridayMinutes>(),
  confirmedBy: uuidColumn('confirmed_by').references(() => users.id, { onDelete: 'restrict' }),
  confirmedAt: timestampColumn('confirmed_at'),
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

// Committee schedules use the existing meeting ID/time/participants. Agenda
// contents are separate so no single-project or legacy reader can disclose them.
export const committeeMeetings = mysqlTable('committee_meetings', {
  meetingId: uuidColumn('meeting_id').primaryKey().references(() => meetings.id, { onDelete: 'restrict' }),
  sequenceYear: int('sequence_year'), sequenceNumber: int('sequence_number'),
  ruleNote: text('rule_note').notNull(), materialCheckAt: timestampColumn('material_check_at'),
  checkedAt: timestampColumn('checked_at'), checkedBy: uuidColumn('checked_by').references(() => users.id, { onDelete: 'restrict' }),
  checkHash: varchar('check_hash', { length: 64 }), archivedAt: timestampColumn('archived_at'),
}, t => ({ annualNumber: uniqueIndex('uq_committee_annual_number').on(t.sequenceYear, t.sequenceNumber) }))

export const committeeYears = mysqlTable('committee_years', {
  year: int('year').primaryKey(), nextSequence: int('next_sequence').notNull().default(1),
})

export const committeeAgendas = mysqlTable('committee_agendas', {
  id: uuidPrimaryKey('id'), meetingId: uuidColumn('meeting_id').notNull().references(() => meetings.id, { onDelete: 'restrict' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  position: int('position').notNull(), title: varchar('title', { length: 255 }).notNull(),
  participantIds: json('participant_ids').$type<string[]>().notNull(), active: boolean('active').notNull().default(true),
  minutes: text('minutes'), resolutionNote: text('resolution_note'),
  approvalId: uuidColumn('approval_id').references(() => oaApprovalRequests.id, { onDelete: 'restrict' }),
  recordedBy: uuidColumn('recorded_by').references(() => users.id, { onDelete: 'restrict' }), recordedAt: timestampColumn('recorded_at'),
}, t => ({ byMeeting: index('idx_committee_agenda_meeting').on(t.meetingId, t.active, t.position), byProject: index('idx_committee_agenda_project').on(t.projectId, t.meetingId) }))

export const committeeFiles = mysqlTable('committee_files', {
  id: uuidPrimaryKey('id'), agendaId: uuidColumn('agenda_id').notNull().references(() => committeeAgendas.id, { onDelete: 'restrict' }),
  fileId: uuidColumn('file_id').notNull().references(() => projectFiles.id, { onDelete: 'restrict' }),
  fileVersionId: uuidColumn('file_version_id').notNull().references(() => projectFileVersions.id, { onDelete: 'restrict' }),
  version: int('version').notNull(), sha256: varchar('sha256', { length: 64 }).notNull(),
  kind: varchar('kind', { length: 16 }).$type<'material' | 'minutes' | 'resolution' | 'approval'>().notNull(),
  active: boolean('active').notNull().default(true),
}, t => ({ reference: uniqueIndex('uq_committee_file_reference').on(t.agendaId, t.fileVersionId, t.kind), byFile: index('idx_committee_file').on(t.fileId) }))

export const committeeCommands = mysqlTable('committee_commands', {
  id: uuidPrimaryKey('id'), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  commandId: uuidColumn('command_id').notNull(), commandHash: varchar('command_hash', { length: 64 }),
  receipt: json('receipt').$type<CommitteeReceipt>(), closedAt: timestampColumn('closed_at'),
}, t => ({ actorCommand: uniqueIndex('uq_committee_actor_command').on(t.actorId, t.commandId) }))

export const meetingWorkflowEvents = mysqlTable('meeting_workflow_events', {
  id: uuidPrimaryKey('id'),
  meetingId: uuidColumn('meeting_id').notNull().references(() => meetings.id, { onDelete: 'restrict' }),
  requestId: uuidColumn('request_id').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  action: varchar('action', { length: 24 }).notNull(),
  version: int('version').notNull(),
  reason: text('reason').notNull(),
  snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  result: json('result').$type<{ meetingId: string; planId?: string; weekStart?: string }>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueRequest: uniqueIndex('uq_meeting_workflow_request').on(t.requestId), byMeeting: index('idx_meeting_workflow_event').on(t.meetingId, t.version) }))

export const meetingWorkflowNotices = mysqlTable('meeting_workflow_notices', {
  id: uuidPrimaryKey('id'),
  meetingId: uuidColumn('meeting_id').notNull().references(() => meetings.id, { onDelete: 'restrict' }),
  recipientId: uuidColumn('recipient_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 24 }).notNull(),
  version: int('version').notNull(),
  closedAt: timestampColumn('closed_at'),
  readAt: timestampColumn('read_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueNotice: uniqueIndex('uq_meeting_workflow_notice').on(t.meetingId, t.recipientId, t.version) }))

export const todos = mysqlTable('todos', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').references(() => projects.id, { onDelete: 'set null' }),
  projectName: varchar('project_name', { length: 128 }),
  title: varchar('title', { length: 255 }).notNull(),
  owner: varchar('owner', { length: 64 }).notNull(),
  ownerUserId: uuidColumn('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  dueDate: varchar('due_date', { length: 10 }), // YYYY-MM-DD
  dueTime: varchar('due_time', { length: 5 }), // HH:mm Asia/Shanghai; null means end of day
  priority: varchar('priority', { length: 8 }).notNull().default('中'), // 高/中/低
  status: varchar('status', { length: 16 }).notNull().default('未开始'), // 未开始/进行中/已完成/已退回
  type: varchar('type', { length: 32 }).notNull().default('待办'), // 待办/流程
  meetingId: uuidColumn('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
  approvalRequestId: uuidColumn('approval_request_id'),
  executionModel: varchar('execution_model', { length: 16 }).notNull().default('legacy'),
  creationFingerprint: varchar('creation_fingerprint', { length: 64 }),
  planActionId: uuidColumn('plan_action_id').references(() => projectPlanActions.id, { onDelete: 'restrict' }),
  progress: int('progress').notNull().default(0),
  deliverable: text('deliverable'),
  closureReason: text('closure_reason'),
  completedAt: timestampColumn('completed_at'),
  createdBy: uuidColumn('created_by').references(() => users.id),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byOwner: index('idx_todos_owner').on(t.owner),
  byOwnerUser: index('idx_todos_owner_user').on(t.ownerUserId),
  byProject: index('idx_todos_project').on(t.projectId),
  byApproval: index('idx_todos_approval').on(t.approvalRequestId, t.status),
  uniquePlanAction: uniqueIndex('uq_todo_plan_action').on(t.planActionId),
}))

// Stable provenance for generated stage actions. Execution remains exclusively in todos.
export const projectTimelineTasks = mysqlTable('project_timeline_tasks', {
  taskId: uuidColumn('task_id').primaryKey().references(() => todos.id, { onDelete: 'restrict' }),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  stage: varchar('stage', { length: 16 }).notNull(), actionKey: varchar('action_key', { length: 96 }).notNull(),
  dueDate: varchar('due_date', { length: 10 }).notNull(), dueTime: varchar('due_time', { length: 5 }).notNull(),
  ownerUserId: uuidColumn('owner_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  needLeader: boolean('need_leader').notNull().default(false), critical: boolean('critical').notNull().default(false),
  retired: boolean('retired').notNull().default(false), version: int('version').notNull().default(1),
}, t => ({ uniqueSource: uniqueIndex('uq_project_timeline_task').on(t.projectId, t.stage, t.actionKey) }))
export const projectTimelineSyncs = mysqlTable('project_timeline_syncs', {
  id: uuidPrimaryKey('id'), projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  approvalId: uuidColumn('approval_id').references(() => oaApprovalRequests.id, { onDelete: 'restrict' }),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  source: varchar('source', { length: 24 }).$type<import('../contracts/fdeTimelineTaskContract.js').TimelineSyncSource>().notNull().default('manual'),
  sourceKey: varchar('source_key', { length: 128 }),
  status: varchar('status', { length: 16 }).$type<'completed' | 'pending' | 'resolved' | 'closed'>().notNull().default('completed'),
  resolvedBy: uuidColumn('resolved_by'),
  changes: json('changes').$type<import('../contracts/fdeTimelineTaskContract.js').TimelineChange[]>().notNull(),
  issues: json('issues').$type<string[]>().notNull(), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ byProject: index('idx_project_timeline_sync').on(t.projectId, t.createdAt), byPending: index('idx_timeline_pending').on(t.projectId, t.status), uniqueEvent: uniqueIndex('uq_timeline_event').on(t.projectId, t.sourceKey) }))

// 批示元数据与执行任务一对一；不保存第二份完成状态。
export const projectRecords = mysqlTable('project_records', {
  id: uuidPrimaryKey('id'), projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  authorId: uuidColumn('author_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 24 }).notNull(), title: varchar('title', { length: 255 }).notNull(), content: text('content').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('published'), version: int('version').notNull().default(1),
  sourceKey: varchar('source_key', { length: 128 }), sourceMeetingId: uuidColumn('source_meeting_id').references(() => meetings.id, { onDelete: 'restrict' }),
  sourceApprovalId: uuidColumn('source_approval_id').references(() => oaApprovalRequests.id, { onDelete: 'restrict' }), sourceVersion: int('source_version'),
  closedBy: uuidColumn('closed_by').references(() => users.id, { onDelete: 'restrict' }), closedAt: timestampColumn('closed_at'), closureReason: text('closure_reason'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`), updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ source: uniqueIndex('uq_project_record_source').on(t.sourceKey), list: index('idx_project_record_list').on(t.projectId, t.status, t.updatedAt) }))

export const projectRecordComments = mysqlTable('project_record_comments', {
  id: uuidPrimaryKey('id'), recordId: uuidColumn('record_id').notNull().references(() => projectRecords.id, { onDelete: 'restrict' }),
  authorId: uuidColumn('author_id').notNull().references(() => users.id, { onDelete: 'restrict' }), content: text('content').notNull(),
  withdrawnBy: uuidColumn('withdrawn_by').references(() => users.id, { onDelete: 'restrict' }), withdrawnAt: timestampColumn('withdrawn_at'), withdrawalReason: text('withdrawal_reason'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ record: index('idx_record_comment').on(t.recordId, t.createdAt) }))

export const projectRecordEvents = mysqlTable('project_record_events', {
  id: uuidPrimaryKey('id'), recordId: uuidColumn('record_id').notNull().references(() => projectRecords.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }), requestId: uuidColumn('request_id').notNull(), requestHash: varchar('request_hash', { length: 64 }).notNull(),
  action: varchar('action', { length: 32 }).notNull(), version: int('version').notNull(), reason: text('reason').notNull(), snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ request: uniqueIndex('uq_record_event_request').on(t.requestId), version: uniqueIndex('uq_record_event_version').on(t.recordId, t.version) }))

export const projectDirectives = mysqlTable('project_directives', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  taskId: uuidColumn('task_id').notNull().references(() => todos.id, { onDelete: 'restrict' }),
  issuerId: uuidColumn('issuer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  content: text('content').notNull(),
  conversion: varchar('conversion', { length: 24 }).notNull(),
  requiresReceipt: boolean('requires_receipt').notNull().default(true),
  acknowledgedAt: timestampColumn('acknowledged_at'),
  acknowledgedBy: uuidColumn('acknowledged_by').references(() => users.id, { onDelete: 'restrict' }),
  withdrawnAt: timestampColumn('withdrawn_at'),
  withdrawalReason: text('withdrawal_reason'),
  version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueTask: uniqueIndex('uq_directive_task').on(t.taskId), byProject: index('idx_directive_project').on(t.projectId) }))

// 批示转日程先持久化申请草案；排期/冲突/领导确认由领导时间领域接续，不能标为已确认。
export const leaderTimeRequests = mysqlTable('leader_time_requests', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  sourceDirectiveId: uuidColumn('source_directive_id').references(() => projectDirectives.id, { onDelete: 'restrict' }),
  taskId: uuidColumn('task_id').references(() => todos.id, { onDelete: 'restrict' }),
  sourceTimelineTaskId: uuidColumn('source_timeline_task_id').references(() => projectTimelineTasks.taskId, { onDelete: 'restrict' }),
  sourceWeeklyItemId: uuidColumn('source_weekly_item_id').references(() => projectWeeklyPlanItems.id, { onDelete: 'restrict' }),
  sourceTypeActionId: uuidColumn('source_type_action_id').references(() => projectPlanActions.id, { onDelete: 'restrict' }),
  sourceFingerprint: varchar('source_fingerprint', { length: 64 }),
  sourceVersion: int('source_version'),
  sourceRetired: boolean('source_retired').notNull().default(false),
  leaderId: uuidColumn('leader_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  submittedBy: uuidColumn('submitted_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  reason: text('reason'),
  outcome: text('outcome'),
  impact: text('impact'),
  priority: varchar('priority', { length: 4 }),
  scheduleNote: text('schedule_note'),
  latestFinish: timestampColumn('latest_finish'),
  preferredStart: timestampColumn('preferred_start').notNull(),
  alternativeStart: timestampColumn('alternative_start'),
  durationMinutes: int('duration_minutes').notNull().default(30),
  location: varchar('location', { length: 255 }).notNull().default('待确认'),
  scheduledStart: timestampColumn('scheduled_start'),
  confirmedAt: timestampColumn('confirmed_at'),
  confirmedBy: uuidColumn('confirmed_by').references(() => users.id, { onDelete: 'restrict' }),
  supplementNote: text('supplement_note'),
  status: varchar('status', { length: 24 }).notNull().default('draft'),
  version: int('version').notNull().default(1),
  closureReason: text('closure_reason'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueDirective: uniqueIndex('uq_leader_time_directive').on(t.sourceDirectiveId), uniqueTimeline: uniqueIndex('uq_leader_time_timeline').on(t.sourceTimelineTaskId, t.leaderId), uniqueWeekly: uniqueIndex('uq_leader_time_weekly').on(t.sourceWeeklyItemId, t.leaderId), uniqueTypeAction: uniqueIndex('uq_leader_time_type_action').on(t.sourceTypeActionId, t.leaderId), byLeader: index('idx_leader_time_owner').on(t.leaderId, t.status) }))

export const leaderTimeEvents = mysqlTable('leader_time_events', {
  id: uuidPrimaryKey('id'), timeRequestId: uuidColumn('time_request_id').notNull().references(() => leaderTimeRequests.id, { onDelete: 'restrict' }),
  requestId: uuidColumn('request_id').notNull(), requestHash: varchar('request_hash', { length: 64 }).notNull(),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  action: varchar('action', { length: 32 }).notNull(), reason: text('reason').notNull(),
  version: int('version').notNull(), snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueRequest: uniqueIndex('uq_leader_time_event_request').on(t.requestId), byTime: index('idx_leader_time_event').on(t.timeRequestId, t.version) }))
export const leaderTimeBatches = mysqlTable('leader_time_batches', {
  id: uuidColumn('id').primaryKey(), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  result: json('result').$type<import('../contracts/fdeTimeContract.js').AutoScheduleResult>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})
export const leaderTimeNotices = mysqlTable('leader_time_notices', {
  id: uuidPrimaryKey('id'), timeRequestId: uuidColumn('time_request_id').notNull().references(() => leaderTimeRequests.id, { onDelete: 'restrict' }),
  recipientId: uuidColumn('recipient_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 32 }).notNull(), version: int('version').notNull(),
  readAt: timestampColumn('read_at'), closedAt: timestampColumn('closed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueNotice: uniqueIndex('uq_leader_time_notice').on(t.timeRequestId, t.recipientId, t.version) }))
export const personalCalendarEvents = mysqlTable('personal_calendar_events', {
  id: uuidPrimaryKey('id'), ownerId: uuidColumn('owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  title: varchar('title', { length: 255 }).notNull(), detail: text('detail').notNull(),
  startsAt: timestampColumn('starts_at').notNull(), endsAt: timestampColumn('ends_at').notNull(),
  visibility: varchar('visibility', { length: 16 }).notNull().default('private'),
  status: varchar('status', { length: 16 }).notNull().default('active'), version: int('version').notNull().default(1),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ byOwnerTime: index('idx_calendar_owner_time').on(t.ownerId, t.startsAt) }))
export const personalCalendarHistory = mysqlTable('personal_calendar_history', {
  id: uuidPrimaryKey('id'), eventId: uuidColumn('event_id').notNull().references(() => personalCalendarEvents.id, { onDelete: 'restrict' }),
  requestId: uuidColumn('request_id').notNull(), requestHash: varchar('request_hash', { length: 64 }).notNull(),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  action: varchar('action', { length: 16 }).notNull(), reason: text('reason').notNull(),
  version: int('version').notNull(), snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueRequest: uniqueIndex('uq_calendar_history_request').on(t.requestId) }))

export const todoCalendarSchedules = mysqlTable('todo_calendar_schedules', {
  taskId: uuidColumn('task_id').primaryKey().references(() => todos.id, { onDelete: 'restrict' }),
  ownerUserId: uuidColumn('owner_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  startsAt: timestampColumn('starts_at').notNull(), endsAt: timestampColumn('ends_at').notNull(),
  hidden: boolean('hidden').notNull().default(false), version: int('version').notNull().default(1),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ byOwnerTime: index('idx_todo_calendar_owner_time').on(t.ownerUserId, t.startsAt) }))
export const todoCalendarScheduleHistory = mysqlTable('todo_calendar_schedule_history', {
  id: uuidPrimaryKey('id'), taskId: uuidColumn('task_id').notNull().references(() => todos.id, { onDelete: 'restrict' }),
  requestId: uuidColumn('request_id').notNull(), requestHash: varchar('request_hash', { length: 64 }).notNull(),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  action: varchar('action', { length: 16 }).notNull(), reason: text('reason').notNull(), version: int('version').notNull(),
  snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueRequest: uniqueIndex('uq_todo_calendar_history_request').on(t.requestId), byTask: index('idx_todo_calendar_history_task').on(t.taskId, t.version) }))

export const directiveEvents = mysqlTable('directive_events', {
  id: uuidPrimaryKey('id'), directiveId: uuidColumn('directive_id').notNull().references(() => projectDirectives.id, { onDelete: 'restrict' }),
  requestId: uuidColumn('request_id').notNull(), requestHash: varchar('request_hash', { length: 64 }).notNull(),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  action: varchar('action', { length: 32 }).notNull(), version: int('version').notNull(),
  reason: text('reason').notNull(), snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueRequest: uniqueIndex('uq_directive_request').on(t.requestId), byDirective: index('idx_directive_event').on(t.directiveId, t.version) }))

export const directiveNotices = mysqlTable('directive_notices', {
  id: uuidPrimaryKey('id'), directiveId: uuidColumn('directive_id').notNull().references(() => projectDirectives.id, { onDelete: 'restrict' }),
  recipientId: uuidColumn('recipient_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 32 }).notNull(), version: int('version').notNull(),
  readAt: timestampColumn('read_at'), closedAt: timestampColumn('closed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueNotice: uniqueIndex('uq_directive_notice').on(t.directiveId, t.recipientId, t.version) }))

// 周计划存放计划定义和发布快照，任务执行状态始终读取 todos。
export const projectWeeklyPlans = mysqlTable('project_weekly_plans', {
  id: uuidPrimaryKey('id'),
  projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  weekStart: varchar('week_start', { length: 10 }).notNull(),
  revision: int('revision').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('draft'),
  activeKey: varchar('active_key', { length: 64 }),
  goal: text('goal').notNull(),
  sourceFingerprint: varchar('source_fingerprint', { length: 64 }).notNull(),
  sourceMeetingId: uuidColumn('source_meeting_id').references(() => meetings.id, { onDelete: 'restrict' }),
  sourceMeetingVersion: int('source_meeting_version'),
  version: int('version').notNull().default(1),
  createdBy: uuidColumn('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  publishedBy: uuidColumn('published_by').references(() => users.id, { onDelete: 'restrict' }),
  publishedAt: timestampColumn('published_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueWeekRevision: uniqueIndex('uq_weekly_plan_revision').on(t.projectId, t.weekStart, t.revision),
  uniqueActive: uniqueIndex('uq_weekly_plan_active').on(t.activeKey),
  bySourceMeeting: index('idx_weekly_source_meeting').on(t.sourceMeetingId),
}))

export const projectWeeklyPlanItems = mysqlTable('project_weekly_plan_items', {
  id: uuidPrimaryKey('id'),
  planId: uuidColumn('plan_id').notNull().references(() => projectWeeklyPlans.id, { onDelete: 'restrict' }),
  itemKey: varchar('item_key', { length: 80 }).notNull(),
  sourceKind: varchar('source_kind', { length: 16 }).notNull(), // task/plan/manual
  taskId: uuidColumn('task_id').references(() => todos.id, { onDelete: 'restrict' }),
  planActionId: uuidColumn('plan_action_id').references(() => projectPlanActions.id, { onDelete: 'restrict' }),
  sourceVersion: int('source_version'),
  title: varchar('title', { length: 255 }).notNull(),
  ownerUserId: uuidColumn('owner_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  dueDate: varchar('due_date', { length: 10 }).notNull(),
  dueTime: varchar('due_time', { length: 5 }),
  needLeader: boolean('need_leader').notNull().default(false),
  sourceStage: varchar('source_stage', { length: 64 }),
  deliverable: text('deliverable').notNull(),
  priority: varchar('priority', { length: 8 }).notNull().default('中'),
  sortOrder: int('sort_order').notNull(),
}, (t) => ({ uniqueItem: uniqueIndex('uq_weekly_plan_item').on(t.planId, t.itemKey) }))

export const projectWeeklyPlanEvents = mysqlTable('project_weekly_plan_events', {
  id: uuidPrimaryKey('id'),
  planId: uuidColumn('plan_id').notNull().references(() => projectWeeklyPlans.id, { onDelete: 'restrict' }),
  requestId: uuidColumn('request_id').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  action: varchar('action', { length: 16 }).notNull(),
  planVersion: int('plan_version').notNull(),
  reason: text('reason').notNull(),
  snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueRequest: uniqueIndex('uq_weekly_plan_request').on(t.requestId), byPlan: index('idx_weekly_plan_event').on(t.planId, t.planVersion) }))

// 站内投递事实独立于 IM 外发；没有外部渠道回执时不能显示“已外发”。
export const projectWeeklyPlanNotices = mysqlTable('project_weekly_plan_notices', {
  id: uuidPrimaryKey('id'),
  planId: uuidColumn('plan_id').notNull().references(() => projectWeeklyPlans.id, { onDelete: 'restrict' }),
  recipientId: uuidColumn('recipient_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 16 }).notNull(),
  planVersion: int('plan_version').notNull(),
  closedAt: timestampColumn('closed_at'),
  readAt: timestampColumn('read_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueNotice: uniqueIndex('uq_weekly_plan_notice').on(t.planId, t.recipientId, t.kind, t.planVersion) }))

export const personalWeeklyReports = mysqlTable('personal_weekly_reports', {
  id: uuidPrimaryKey('id'),
  authorId: uuidColumn('author_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  weekStart: varchar('week_start', { length: 10 }).notNull(),
  revision: int('revision').notNull(),
  version: int('version').notNull().default(1),
  status: varchar('status', { length: 16 }).notNull().default('draft'),
  activeKey: varchar('active_key', { length: 64 }),
  body: longtext('body').notNull(),
  facts: json('facts').$type<WeeklyReportFacts>().notNull(),
  sourceHash: varchar('source_hash', { length: 64 }).notNull(),
  publishedAt: timestampColumn('published_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueRevision: uniqueIndex('uq_weekly_report_revision').on(t.authorId, t.weekStart, t.revision),
  uniqueActive: uniqueIndex('uq_weekly_report_active').on(t.activeKey),
}))

export const personalWeeklyReportEvents = mysqlTable('personal_weekly_report_events', {
  id: uuidPrimaryKey('id'),
  reportId: uuidColumn('report_id').notNull().references(() => personalWeeklyReports.id, { onDelete: 'restrict' }),
  requestId: uuidColumn('request_id').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  action: varchar('action', { length: 16 }).notNull(),
  version: int('version').notNull(),
  reason: text('reason').notNull(),
  snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueRequest: uniqueIndex('uq_weekly_report_request').on(t.requestId), byReport: index('idx_weekly_report_event').on(t.reportId, t.version) }))

export const personalWeeklyReportRecipients = mysqlTable('personal_weekly_report_recipients', {
  id: uuidPrimaryKey('id'),
  reportId: uuidColumn('report_id').notNull().references(() => personalWeeklyReports.id, { onDelete: 'restrict' }),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  readAt: timestampColumn('read_at'),
  closedAt: timestampColumn('closed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueRecipient: uniqueIndex('uq_weekly_report_recipient').on(t.reportId, t.userId) }))

export const todoFeedbacks = mysqlTable('todo_feedbacks', {
  id: uuidPrimaryKey('id'),
  todoId: uuidColumn('todo_id').notNull().references(() => todos.id, { onDelete: 'restrict' }),
  taskVersion: int('task_version').notNull(),
  kind: varchar('kind', { length: 16 }).notNull(),
  progress: int('progress').notNull(),
  result: text('result').notNull(),
  blocker: text('blocker').notNull(),
  estimatedDate: varchar('estimated_date', { length: 10 }),
  submittedBy: uuidColumn('submitted_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  submittedAt: timestampColumn('submitted_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueRevision: uniqueIndex('uq_todo_feedback_revision').on(t.todoId, t.taskVersion) }))

export const todoFeedbackEvidence = mysqlTable('todo_feedback_evidence', {
  id: uuidPrimaryKey('id'),
  feedbackId: uuidColumn('feedback_id').notNull().references(() => todoFeedbacks.id, { onDelete: 'restrict' }),
  fileId: uuidColumn('file_id').notNull().references(() => projectFiles.id, { onDelete: 'restrict' }),
  fileVersionId: uuidColumn('file_version_id').notNull().references(() => projectFileVersions.id, { onDelete: 'restrict' }),
  version: int('version').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
}, (t) => ({ uniqueEvidence: uniqueIndex('uq_todo_feedback_file').on(t.feedbackId, t.fileId) }))

export const todoAcceptances = mysqlTable('todo_acceptances', {
  id: uuidPrimaryKey('id'),
  todoId: uuidColumn('todo_id').notNull().references(() => todos.id, { onDelete: 'restrict' }),
  feedbackId: uuidColumn('feedback_id').notNull().references(() => todoFeedbacks.id, { onDelete: 'restrict' }),
  decision: varchar('decision', { length: 16 }).notNull(),
  reason: text('reason').notNull(),
  decidedBy: uuidColumn('decided_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  decidedAt: timestampColumn('decided_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({ uniqueDecision: uniqueIndex('uq_todo_acceptance_feedback').on(t.feedbackId) }))

// OA 项目审批是正式导航中的业务链路，所有状态、节点、审批人和操作记录
// 均以 MySQL 为权威源。active_key 在审批中等于 project_id，终态为 NULL，
// 配合唯一索引保证一个项目最多只有一条活动流程。
export const oaApprovalRequests = mysqlTable('oa_approval_requests', {
  id: uuidPrimaryKey('id'),
  requestNo: varchar('request_no', { length: 40 }).notNull(),
  projectId: uuidColumn('project_id').references(() => projects.id, { onDelete: 'restrict' }),
  projectName: varchar('project_name', { length: 128 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  type: varchar('type', { length: 32 }).notNull(),
  businessType: varchar('business_type', { length: 32 }).notNull().default('project_stage'),
  taskId: uuidColumn('task_id').references(() => todos.id, { onDelete: 'restrict' }),
  businessPayload: json('business_payload').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  officePolicyVersionId: uuidColumn('office_policy_version_id').references(() => oaOfficePolicyVersions.id, { onDelete: 'restrict' }),
  officeRevision: int('office_revision').notNull().default(0),
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
  materialSnapshot: json('material_snapshot').$type<Array<{ requirementKey: string; fileId: string | null; fileVersion: number | null; waiverReason: string | null }>>().notNull().default(emptyJsonArray),
  planId: uuidColumn('plan_id').references(() => projectPlans.id, { onDelete: 'restrict' }),
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
  officeRevision: int('office_revision'),
  officeRule: json('office_rule').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
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

export const oaApprovalRevisions = mysqlTable('oa_approval_revisions', {
  id: uuidPrimaryKey('id'),
  requestId: uuidColumn('request_id').notNull().references(() => oaApprovalRequests.id, { onDelete: 'cascade' }),
  revision: int('revision').notNull(),
  snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  submittedBy: uuidColumn('submitted_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  submittedAt: timestampColumn('submitted_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueRevision: uniqueIndex('uq_oa_approval_revision').on(t.requestId, t.revision),
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

// No seed scores or enabled production rule: a draft needs explicit business
// approval and a separate publication before consumers may use it.
export const responsibilityPolicies = mysqlTable('responsibility_policies', {
  code: varchar('code', { length: 32 }).primaryKey(),
  activeVersionId: uuidColumn('active_version_id'),
  enabled: boolean('enabled').notNull().default(false),
  nextRevision: int('next_revision').notNull().default(1),
  version: int('version').notNull().default(1),
})
export const responsibilityPolicyVersions = mysqlTable('responsibility_policy_versions', {
  id: uuidPrimaryKey('id'),
  policyCode: varchar('policy_code', { length: 32 }).notNull().references(() => responsibilityPolicies.code, { onDelete: 'restrict' }),
  revision: int('revision').notNull(), status: varchar('status', { length: 16 }).notNull().default('draft'),
  configuration: json('configuration').$type<ResponsibilityPolicy>().notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(), reason: text('reason').notNull(),
  createdBy: uuidColumn('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  lastEditedBy: uuidColumn('last_edited_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  approvedBy: uuidColumn('approved_by').references(() => users.id, { onDelete: 'restrict' }), approvedAt: timestampColumn('approved_at'),
  publishedBy: uuidColumn('published_by').references(() => users.id, { onDelete: 'restrict' }), publishedAt: timestampColumn('published_at'),
  version: int('version').notNull().default(1), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ revision: uniqueIndex('uq_resp_policy_revision').on(t.policyCode, t.revision) }))
export const responsibilityPolicyCommands = mysqlTable('responsibility_policy_commands', {
  id: uuidPrimaryKey('id'), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  commandId: uuidColumn('command_id').notNull(), commandHash: varchar('command_hash', { length: 64 }),
  receipt: json('receipt').$type<ResponsibilityPolicyReceipt>(), closedAt: timestampColumn('closed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ command: uniqueIndex('uq_resp_policy_command').on(t.actorId, t.commandId) }))
export const responsibilityPolicyEvents = mysqlTable('responsibility_policy_events', {
  id: uuidPrimaryKey('id'),
  policyCode: varchar('policy_code', { length: 32 }).notNull().references(() => responsibilityPolicies.code, { onDelete: 'restrict' }),
  versionId: uuidColumn('version_id').references(() => responsibilityPolicyVersions.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  commandId: uuidColumn('command_id').notNull(), action: varchar('action', { length: 16 }).notNull(), reason: text('reason').notNull(),
  snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ command: uniqueIndex('uq_resp_policy_event_command').on(t.actorId, t.commandId), time: index('idx_resp_policy_event_time').on(t.policyCode, t.createdAt, t.id) }))

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

export const responsibilityScanCycles = mysqlTable('responsibility_scan_cycles', {
  id: uuidPrimaryKey('id'), asOf: timestampColumn('as_of').notNull(),
  upperTaskId: uuidColumn('upper_task_id'), cursorTaskId: uuidColumn('cursor_task_id'),
  processed: int('processed').notNull().default(0), candidates: int('candidates').notNull().default(0),
  lastErrorCode: varchar('last_error_code', { length: 64 }), completedAt: timestampColumn('completed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})
export const responsibilityScanState = mysqlTable('responsibility_scan_state', {
  name: varchar('name', { length: 64 }).primaryKey(),
  cycleId: uuidColumn('cycle_id').references(() => responsibilityScanCycles.id, { onDelete: 'restrict' }),
})
export const responsibilityRecords = mysqlTable('responsibility_records', {
  id: uuidPrimaryKey('id'), projectId: uuidColumn('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  taskId: uuidColumn('task_id').notNull().references(() => todos.id, { onDelete: 'restrict' }),
  subjectId: uuidColumn('subject_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  policyVersionId: uuidColumn('policy_version_id').notNull().references(() => responsibilityPolicyVersions.id, { onDelete: 'restrict' }),
  activationEventId: uuidColumn('activation_event_id').notNull().references(() => responsibilityPolicyEvents.id, { onDelete: 'restrict' }),
  policySha256: varchar('policy_sha256', { length: 64 }).notNull(), eventCode: varchar('event_code', { length: 32 }).notNull(),
  sourceKey: varchar('source_key', { length: 64 }).notNull(),
  sourceFeedbackId: uuidColumn('source_feedback_id').references(() => todoFeedbacks.id, { onDelete: 'restrict' }),
  relatedFeedbackId: uuidColumn('related_feedback_id').references(() => todoFeedbacks.id, { onDelete: 'restrict' }),
  sourceAcceptanceId: uuidColumn('source_acceptance_id').references(() => todoAcceptances.id, { onDelete: 'restrict' }),
  sourceRiskId: uuidColumn('source_risk_id').references(() => risks.id, { onDelete: 'restrict' }),
  deadlineKey: varchar('deadline_key', { length: 32 }), occurredAt: timestampColumn('occurred_at').notNull(),
  factSnapshot: json('fact_snapshot').$type<Record<string, unknown>>().notNull(),
  originalPoints: int('original_points').notNull(), effectivePoints: int('effective_points').notNull().default(0),
  status: varchar('status', { length: 32 }).notNull(), reason: text('reason').notNull(),
  reviewerId: uuidColumn('reviewer_id').references(() => users.id, { onDelete: 'restrict' }),
  appealedAt: timestampColumn('appealed_at'), createdBy: uuidColumn('created_by').references(() => users.id, { onDelete: 'restrict' }),
  creationOrigin: varchar('creation_origin', { length: 16 }).notNull().default('user'),
  scanCycleId: uuidColumn('scan_cycle_id').references(() => responsibilityScanCycles.id, { onDelete: 'restrict' }),
  version: int('version').notNull().default(1), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ source: uniqueIndex('uq_resp_record_source').on(t.sourceKey), project: index('idx_resp_record_project').on(t.projectId, t.createdAt, t.id), subject: index('idx_resp_record_subject').on(t.subjectId, t.status), reviewer: index('idx_resp_record_reviewer').on(t.reviewerId, t.status) }))
export const responsibilityEvidenceLinks = mysqlTable('responsibility_evidence', {
  id: uuidPrimaryKey('id'), recordId: uuidColumn('record_id').notNull().references(() => responsibilityRecords.id, { onDelete: 'restrict' }),
  fileId: uuidColumn('file_id').notNull().references(() => projectFiles.id, { onDelete: 'restrict' }),
  fileVersionId: uuidColumn('file_version_id').notNull().references(() => projectFileVersions.id, { onDelete: 'restrict' }),
  version: int('version').notNull(), sha256: varchar('sha256', { length: 64 }).notNull(), byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
}, t => ({ file: uniqueIndex('uq_resp_evidence_version').on(t.recordId, t.fileVersionId) }))
export const responsibilityEventsLog = mysqlTable('responsibility_events', {
  id: uuidPrimaryKey('id'), recordId: uuidColumn('record_id').notNull().references(() => responsibilityRecords.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').references(() => users.id, { onDelete: 'restrict' }), action: varchar('action', { length: 32 }).notNull(),
  reason: text('reason').notNull(), version: int('version').notNull(), snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ revision: uniqueIndex('uq_resp_event_version').on(t.recordId, t.version) }))
export const responsibilityCommands = mysqlTable('responsibility_commands', {
  id: uuidPrimaryKey('id'), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }), commandId: uuidColumn('command_id').notNull(),
  projectId: uuidColumn('project_id').notNull(), commandHash: varchar('command_hash', { length: 64 }),
  receipt: json('receipt').$type<ResponsibilityReceipt>(), closedAt: timestampColumn('closed_at'), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ command: uniqueIndex('uq_resp_command_actor').on(t.actorId, t.commandId) }))
export const responsibilityNotices = mysqlTable('responsibility_notices', {
  id: uuidPrimaryKey('id'), recordId: uuidColumn('record_id').notNull().references(() => responsibilityRecords.id, { onDelete: 'restrict' }),
  recipientId: uuidColumn('recipient_id').notNull().references(() => users.id, { onDelete: 'restrict' }), kind: varchar('kind', { length: 32 }).notNull(), version: int('version').notNull(),
  readAt: timestampColumn('read_at'), closedAt: timestampColumn('closed_at'), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ notice: uniqueIndex('uq_resp_notice_version').on(t.recordId, t.recipientId, t.version), recipient: index('idx_resp_notice_recipient').on(t.recipientId, t.closedAt) }))
export const responsibilityTaskMarkers = mysqlTable('responsibility_task_markers', {
  id: uuidPrimaryKey('id'), taskId: uuidColumn('task_id').notNull().references(() => todos.id, { onDelete: 'restrict' }),
  critical: boolean('critical').notNull(), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  reason: text('reason').notNull(), version: int('version').notNull(), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ revision: uniqueIndex('uq_resp_marker_version').on(t.taskId, t.version) }))

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
  enrichmentSnapshotId: uuidColumn('enrichment_snapshot_id'),
  snapshotHash: varchar('snapshot_hash', { length: 64 }),
  ratingSchemaVersion: varchar('rating_schema_version', { length: 64 }),
  requestMode: varchar('request_mode', { length: 24 }).notNull().default('automatic'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byDue: index('idx_lead_score_jobs_due').on(t.status, t.nextAttemptAt),
  byLease: index('idx_lead_score_jobs_lease').on(t.leaseExpiresAt),
}))

// 共享线索联网研究任务。正式入池事件只负责幂等创建任务；专题运行、事实、
// 证据和快照均独立版本化，避免将模型临时输出直接写入评分 JSON。
export const leadEntities = mysqlTable('lead_entities', {
  id: uuidPrimaryKey('id'),
  leadId: uuidColumn('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  entityType: varchar('entity_type', { length: 16 }).notNull(),
  canonicalName: varchar('canonical_name', { length: 255 }).notNull(),
  normalizedName: varchar('normalized_name', { length: 255 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  aliases: json('aliases').$type<string[]>().notNull().default(emptyJsonArray),
  identifiers: json('identifiers').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueIdentity: uniqueIndex('uq_lead_entities_identity').on(t.leadId, t.entityType, t.normalizedName),
  byLead: index('idx_lead_entities_lead').on(t.leadId, t.entityType, t.status),
}))

export const leadEntityRelations = mysqlTable('lead_entity_relations', {
  id: uuidPrimaryKey('id'),
  leadId: uuidColumn('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  fromEntityId: uuidColumn('from_entity_id').notNull().references(() => leadEntities.id, { onDelete: 'cascade' }),
  toEntityId: uuidColumn('to_entity_id').notNull().references(() => leadEntities.id, { onDelete: 'cascade' }),
  relationType: varchar('relation_type', { length: 48 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('claimed'),
  evidenceFactId: uuidColumn('evidence_fact_id'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueRelation: uniqueIndex('uq_lead_entity_relations_identity').on(t.fromEntityId, t.toEntityId, t.relationType),
  byLead: index('idx_lead_entity_relations_lead').on(t.leadId, t.relationType, t.status),
}))

export const leadEnrichmentJobs = mysqlTable('lead_enrichment_jobs', {
  id: uuidPrimaryKey('id'),
  leadId: uuidColumn('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  schemaVersion: varchar('schema_version', { length: 64 }).notNull().default('lead-enrichment-v3'),
  triggerType: varchar('trigger_type', { length: 48 }).notNull(),
  triggerEventId: varchar('trigger_event_id', { length: 64 }).references(() => leadPipelineRawEvents.id, { onDelete: 'set null' }),
  idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
  entityId: uuidColumn('entity_id').references(() => leadEntities.id, { onDelete: 'set null' }),
  entityType: varchar('entity_type', { length: 16 }).notNull().default('unknown'),
  entityStatus: varchar('entity_status', { length: 16 }).notNull().default('missing'),
  status: varchar('status', { length: 24 }).notNull().default('queued'),
  priority: int('priority').notNull().default(100),
  executionAttempts: int('execution_attempts').notNull().default(0),
  nextAttemptAt: timestampColumn('next_attempt_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  leaseOwner: varchar('lease_owner', { length: 128 }),
  leaseExpiresAt: timestampColumn('lease_expires_at'),
  lastError: text('last_error'),
  startedAt: timestampColumn('started_at'),
  completedAt: timestampColumn('completed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueIdempotency: uniqueIndex('uq_lead_enrichment_jobs_idempotency').on(t.idempotencyKey),
  byDue: index('idx_lead_enrichment_jobs_due').on(t.status, t.priority, t.nextAttemptAt),
  byLead: index('idx_lead_enrichment_jobs_lead').on(t.leadId, t.createdAt),
  bySchemaDue: index('idx_lead_enrichment_jobs_schema_due').on(t.schemaVersion, t.status, t.priority, t.nextAttemptAt),
  byLease: index('idx_lead_enrichment_jobs_lease').on(t.leaseExpiresAt),
}))

export const leadEnrichmentTopicRuns = mysqlTable('lead_enrichment_topic_runs', {
  id: uuidPrimaryKey('id'),
  jobId: uuidColumn('job_id').notNull().references(() => leadEnrichmentJobs.id, { onDelete: 'cascade' }),
  leadId: uuidColumn('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  topicKey: varchar('topic_key', { length: 48 }).notNull(),
  status: varchar('status', { length: 24 }).notNull().default('queued'),
  promptVersion: varchar('prompt_version', { length: 64 }),
  model: varchar('model', { length: 128 }),
  toolsetVersion: varchar('toolset_version', { length: 64 }),
  queryPlan: json('query_plan').$type<unknown[]>().notNull().default(emptyJsonArray),
  metrics: json('metrics').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  executionAttempts: int('execution_attempts').notNull().default(0),
  nextAttemptAt: timestampColumn('next_attempt_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  leaseOwner: varchar('lease_owner', { length: 128 }),
  leaseExpiresAt: timestampColumn('lease_expires_at'),
  lastError: text('last_error'),
  startedAt: timestampColumn('started_at'),
  completedAt: timestampColumn('completed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueJobTopic: uniqueIndex('uq_lead_enrichment_topic_job').on(t.jobId, t.topicKey),
  byDue: index('idx_lead_enrichment_topic_due').on(t.status, t.nextAttemptAt),
  byLead: index('idx_lead_enrichment_topic_lead').on(t.leadId, t.topicKey, t.createdAt),
  byLease: index('idx_lead_enrichment_topic_lease').on(t.leaseExpiresAt),
}))

export const leadTopicSearchCache = mysqlTable('lead_topic_search_cache', {
  cacheKey: varchar('cache_key', { length: 64 }).primaryKey(),
  subjectFingerprint: varchar('subject_fingerprint', { length: 64 }).notNull(),
  topicKey: varchar('topic_key', { length: 48 }).notNull(),
  promptVersion: varchar('prompt_version', { length: 64 }).notNull(),
  queryPlanHash: varchar('query_plan_hash', { length: 64 }).notNull(),
  model: varchar('model', { length: 128 }).notNull(),
  result: json('result').$type<Record<string, unknown>>().notNull(),
  expiresAt: timestampColumn('expires_at').notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  bySubjectTopic: index('idx_lead_topic_search_cache_subject').on(t.subjectFingerprint, t.topicKey, t.expiresAt),
  byExpiry: index('idx_lead_topic_search_cache_expiry').on(t.expiresAt),
}))

export const leadFacts = mysqlTable('lead_facts', {
  id: uuidPrimaryKey('id'),
  leadId: uuidColumn('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  topicRunId: uuidColumn('topic_run_id').references(() => leadEnrichmentTopicRuns.id, { onDelete: 'set null' }),
  topicKey: varchar('topic_key', { length: 48 }).notNull(),
  subjectType: varchar('subject_type', { length: 24 }).notNull(),
  subjectId: varchar('subject_id', { length: 128 }).notNull(),
  factKey: varchar('fact_key', { length: 128 }).notNull(),
  instanceKey: varchar('instance_key', { length: 128 }).notNull().default('singleton'),
  value: json('value').$type<unknown>().notNull(),
  valueHash: varchar('value_hash', { length: 64 }).notNull(),
  unit: varchar('unit', { length: 32 }),
  currency: varchar('currency', { length: 16 }),
  periodStart: varchar('period_start', { length: 32 }),
  periodEnd: varchar('period_end', { length: 32 }),
  scope: varchar('scope', { length: 128 }),
  evidenceLevel: varchar('evidence_level', { length: 4 }).notNull(),
  verificationStatus: varchar('verification_status', { length: 24 }).notNull(),
  version: int('version').notNull().default(1),
  supersedesFactId: uuidColumn('supersedes_fact_id'),
  isCurrent: boolean('is_current').notNull().default(true),
  validFrom: timestampColumn('valid_from').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  validUntil: timestampColumn('valid_until'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueVersion: uniqueIndex('uq_lead_facts_instance_version').on(t.leadId, t.subjectId, t.factKey, t.instanceKey, t.version),
  byCurrent: index('idx_lead_facts_current').on(t.leadId, t.isCurrent, t.topicKey),
  byValue: index('idx_lead_facts_value').on(t.leadId, t.factKey, t.valueHash),
  byInstance: index('idx_lead_facts_instance').on(t.leadId, t.factKey, t.instanceKey, t.isCurrent),
}))

// 受控 Web Fetch/PDF 解析得到的不可变来源正文。搜索摘要只负责发现 URL，
// 正式事实引用必须能够落到这里保存的内容哈希和正文定位。
export const leadSourceDocuments = mysqlTable('lead_source_documents', {
  id: uuidPrimaryKey('id'),
  leadId: uuidColumn('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  canonicalUrl: text('canonical_url').notNull(),
  canonicalUrlHash: varchar('canonical_url_hash', { length: 64 }).notNull(),
  finalUrl: text('final_url').notNull(),
  fetchStatus: varchar('fetch_status', { length: 24 }).notNull(),
  httpStatus: int('http_status'),
  contentType: varchar('content_type', { length: 96 }),
  title: text('title'),
  publisher: varchar('publisher', { length: 255 }),
  publishedAt: timestampColumn('published_at'),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  extractedText: longtext('extracted_text').notNull(),
  errorCode: varchar('error_code', { length: 64 }),
  accessedAt: timestampColumn('accessed_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  expiresAt: timestampColumn('expires_at').notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueVersion: uniqueIndex('uq_lead_source_documents_version').on(t.canonicalUrlHash, t.contentHash),
  byCache: index('idx_lead_source_documents_cache').on(t.canonicalUrlHash, t.fetchStatus, t.expiresAt),
  byLead: index('idx_lead_source_documents_lead').on(t.leadId, t.createdAt),
}))

export const leadFactEvidence = mysqlTable('lead_fact_evidence', {
  id: uuidPrimaryKey('id'),
  factId: uuidColumn('fact_id').notNull().references(() => leadFacts.id, { onDelete: 'cascade' }),
  sourceDocumentId: uuidColumn('source_document_id').references(() => leadSourceDocuments.id, { onDelete: 'set null' }),
  sourceUrl: text('source_url').notNull(),
  canonicalUrlHash: varchar('canonical_url_hash', { length: 64 }).notNull(),
  sourceType: varchar('source_type', { length: 32 }).notNull(),
  contentType: varchar('content_type', { length: 32 }).notNull().default('unknown'),
  title: text('title'),
  publisher: varchar('publisher', { length: 255 }),
  quote: longtext('quote').notNull(),
  locator: varchar('locator', { length: 255 }),
  pageHash: varchar('page_hash', { length: 64 }),
  reliability: varchar('reliability', { length: 16 }),
  publishedAt: timestampColumn('published_at'),
  accessedAt: timestampColumn('accessed_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueFactSource: uniqueIndex('uq_lead_fact_evidence_source').on(t.factId, t.canonicalUrlHash),
  byFact: index('idx_lead_fact_evidence_fact').on(t.factId, t.createdAt),
  bySource: index('idx_lead_fact_evidence_source').on(t.canonicalUrlHash),
}))

export const leadFactConflicts = mysqlTable('lead_fact_conflicts', {
  id: uuidPrimaryKey('id'),
  leadId: uuidColumn('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  topicKey: varchar('topic_key', { length: 48 }).notNull(),
  factKey: varchar('fact_key', { length: 128 }).notNull(),
  instanceKey: varchar('instance_key', { length: 128 }).notNull().default('singleton'),
  status: varchar('status', { length: 24 }).notNull().default('open'),
  severity: varchar('severity', { length: 16 }).notNull().default('material'),
  candidateFactIds: json('candidate_fact_ids').$type<string[]>().notNull().default(emptyJsonArray),
  automaticReason: text('automatic_reason'),
  resolution: json('resolution').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  resolvedBy: uuidColumn('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  resolvedAt: timestampColumn('resolved_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byLeadStatus: index('idx_lead_fact_conflicts_status').on(t.leadId, t.status, t.severity),
  byInstance: index('idx_lead_fact_conflicts_instance').on(t.leadId, t.topicKey, t.factKey, t.instanceKey, t.status),
}))

export const leadEnrichmentSnapshots = mysqlTable('lead_enrichment_snapshots', {
  id: uuidPrimaryKey('id'),
  leadId: uuidColumn('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  jobId: uuidColumn('job_id').notNull().references(() => leadEnrichmentJobs.id, { onDelete: 'restrict' }),
  schemaVersion: varchar('schema_version', { length: 64 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  snapshotHash: varchar('snapshot_hash', { length: 64 }).notNull(),
  topicStates: json('topic_states').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  subjectProfile: json('subject_profile').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  facts: json('facts').$type<unknown[]>().notNull().default(emptyJsonArray),
  evidenceIndex: json('evidence_index').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
  gaps: json('gaps').$type<unknown[]>().notNull().default(emptyJsonArray),
  conflicts: json('conflicts').$type<unknown[]>().notNull().default(emptyJsonArray),
  coverage: int('coverage').notNull().default(0),
  frozenAt: timestampColumn('frozen_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueLeadHash: uniqueIndex('uq_lead_enrichment_snapshot_hash').on(t.leadId, t.snapshotHash, t.schemaVersion),
  byLead: index('idx_lead_enrichment_snapshots_lead').on(t.leadId, t.createdAt),
  byJob: index('idx_lead_enrichment_snapshots_job').on(t.jobId),
}))

export const leadInstitutionDictionary = mysqlTable('lead_institution_dictionary', {
  id: uuidPrimaryKey('id'),
  canonicalName: varchar('canonical_name', { length: 255 }).notNull(),
  aliases: json('aliases').$type<string[]>().notNull().default(emptyJsonArray),
  institutionType: varchar('institution_type', { length: 64 }).notNull(),
  tier: varchar('tier', { length: 32 }),
  major: boolean('major').notNull().default(false),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  version: int('version').notNull().default(1),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueName: uniqueIndex('uq_lead_institution_dictionary_name').on(t.canonicalName),
  byStatus: index('idx_lead_institution_dictionary_status').on(t.status, t.major),
}))

export const leadCustomerDictionary = mysqlTable('lead_customer_dictionary', {
  id: uuidPrimaryKey('id'),
  canonicalName: varchar('canonical_name', { length: 255 }).notNull(),
  aliases: json('aliases').$type<string[]>().notNull().default(emptyJsonArray),
  tier: varchar('tier', { length: 8 }).notNull(),
  confidentiality: varchar('confidentiality', { length: 16 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  version: int('version').notNull().default(1),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueName: uniqueIndex('uq_lead_customer_dictionary_name').on(t.canonicalName),
  byStatus: index('idx_lead_customer_dictionary_status').on(t.status, t.confidentiality, t.tier),
}))

export const leadIndustryDictionary = mysqlTable('lead_industry_dictionary', {
  id: uuidPrimaryKey('id'),
  canonicalName: varchar('canonical_name', { length: 255 }).notNull(),
  aliases: json('aliases').$type<string[]>().notNull().default(emptyJsonArray),
  level1: varchar('level1', { length: 128 }).notNull(),
  level2: varchar('level2', { length: 128 }),
  segment: varchar('segment', { length: 255 }),
  chainPosition: varchar('chain_position', { length: 128 }),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  version: int('version').notNull().default(1),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueName: uniqueIndex('uq_lead_industry_dictionary_name').on(t.canonicalName),
  byStatus: index('idx_lead_industry_dictionary_status').on(t.status, t.level1, t.level2),
}))

export const leadAcademicInstitutionDictionary = mysqlTable('lead_academic_institution_dictionary', {
  id: uuidPrimaryKey('id'),
  canonicalName: varchar('canonical_name', { length: 255 }).notNull(),
  aliases: json('aliases').$type<string[]>().notNull().default(emptyJsonArray),
  institutionType: varchar('institution_type', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  version: int('version').notNull().default(1),
  updatedBy: uuidColumn('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueName: uniqueIndex('uq_lead_academic_institution_dictionary_name').on(t.canonicalName),
  byStatus: index('idx_lead_academic_institution_dictionary_status').on(t.status, t.institutionType),
}))

// 共享线索池读取专用投影。权威事实仍在 lead_facts / lead_fact_evidence，
// 本表只保存冻结快照（ready/review）的确定性归并结果，避免列表请求逐条解析证据 JSON。
export const leadInvestmentProfileProjections = mysqlTable('lead_investment_profile_projections', {
  leadId: uuidColumn('lead_id').primaryKey().references(() => leads.id, { onDelete: 'cascade' }),
  schemaVersion: varchar('schema_version', { length: 64 }).notNull(),
  snapshotId: uuidColumn('snapshot_id').notNull().references(() => leadEnrichmentSnapshots.id, { onDelete: 'restrict' }),
  snapshotHash: varchar('snapshot_hash', { length: 64 }).notNull(),
  dictionaryHash: varchar('dictionary_hash', { length: 64 }).notNull(),
  projectionVersion: varchar('projection_version', { length: 64 }).notNull().default('lead-investment-profile-projection-v2'),
  dictionaryBinding: json('dictionary_binding').$type<Record<string, string>>().notNull().default(emptyJsonObject),
  profilePayload: json('profile_payload').$type<Record<string, unknown>>(),
  staleReason: varchar('stale_reason', { length: 64 }),
  snapshotCreatedAt: timestampColumn('snapshot_created_at'),
  projectedAt: timestampColumn('projected_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  industryLevel1: varchar('industry_level1', { length: 128 }),
  industryLevel2: varchar('industry_level2', { length: 128 }),
  industrySegment: varchar('industry_segment', { length: 255 }),
  industryChainPosition: varchar('industry_chain_position', { length: 255 }),
  products: json('products').$type<LeadInvestmentProfileProduct[]>().notNull().default(emptyJsonArray),
  productTotalCount: int('product_total_count').notNull().default(0),
  institutions: json('institutions').$type<LeadInvestmentProfileInstitution[]>().notNull().default(emptyJsonArray),
  institutionTotalCount: int('institution_total_count').notNull().default(0),
  academicLinks: json('academic_links').$type<LeadInvestmentProfileAcademicLink[]>().notNull().default(emptyJsonArray),
  academicLinkTotalCount: int('academic_link_total_count').notNull().default(0),
  customerRepresentatives: json('customer_representatives').$type<LeadInvestmentProfileCustomer[]>().notNull().default(emptyJsonArray),
  customerTotalCount: int('customer_total_count').notNull().default(0),
  mentionedCustomerCount: int('mentioned_customer_count').notNull().default(0),
  engagedCustomerCount: int('engaged_customer_count').notNull().default(0),
  trialCustomerCount: int('trial_customer_count').notNull().default(0),
  contractedCustomerCount: int('contracted_customer_count').notNull().default(0),
  deliveredCustomerCount: int('delivered_customer_count').notNull().default(0),
  payingCustomerCount: int('paying_customer_count').notNull().default(0),
  productSearchText: text('product_search_text'),
  productRouteSearchText: text('product_route_search_text'),
  productionStageSearchText: text('production_stage_search_text'),
  institutionSearchText: text('institution_search_text'),
  academicSearchText: text('academic_search_text'),
  academicInstitutionSearchText: text('academic_institution_search_text'),
  academicRelationSearchText: text('academic_relation_search_text'),
  hasMajorInstitution: boolean('has_major_institution').notNull().default(false),
  hasCommercializationLink: boolean('has_commercialization_link').notNull().default(false),
  financingStatus: varchar('financing_status', { length: 64 }),
  latestRound: varchar('latest_round', { length: 64 }),
  latestRoundDate: date('latest_round_date', { mode: 'string' }),
  latestAmountDisplay: varchar('latest_amount_display', { length: 128 }),
  latestAmountValue: bigint('latest_amount_value', { mode: 'number' }),
  latestAmountCurrency: varchar('latest_amount_currency', { length: 16 }),
  cumulativeAmountDisplay: varchar('cumulative_amount_display', { length: 128 }),
  cumulativeAmountValue: bigint('cumulative_amount_value', { mode: 'number' }),
  completedRoundCount: int('completed_round_count').notNull().default(0),
  valuationDisplay: varchar('valuation_display', { length: 128 }),
  valuationValue: bigint('valuation_value', { mode: 'number' }),
  valuationType: varchar('valuation_type', { length: 24 }),
  valuationCurrency: varchar('valuation_currency', { length: 16 }),
  valuationDate: date('valuation_date', { mode: 'string' }),
  valuationRound: varchar('valuation_round', { length: 64 }),
  highestCustomerStage: varchar('highest_customer_stage', { length: 8 }),
  verifiedCustomerCount: int('verified_customer_count').notNull().default(0),
  tierACustomerCount: int('tier_a_customer_count').notNull().default(0),
  tierBCustomerCount: int('tier_b_customer_count').notNull().default(0),
  tierCCustomerCount: int('tier_c_customer_count').notNull().default(0),
  verifiedDimensions: int('verified_dimensions').notNull().default(0),
  applicableDimensions: int('applicable_dimensions').notNull().default(0),
  conflictCount: int('conflict_count').notNull().default(0),
  profileStatus: varchar('profile_status', { length: 24 }).notNull().default('missing'),
  sourceFactIds: json('source_fact_ids').$type<string[]>().notNull().default(emptyJsonArray),
  factsUpdatedAt: timestampColumn('facts_updated_at'),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byIndustry: index('idx_lead_investment_profiles_industry').on(t.industryLevel1, t.industryLevel2),
  byFinancing: index('idx_lead_investment_profiles_financing').on(t.latestRound, t.latestRoundDate),
  byFundingSort: index('idx_lead_investment_profiles_funding_sort').on(t.latestRoundDate, t.leadId),
  byValuation: index('idx_lead_investment_profiles_valuation').on(t.valuationCurrency, t.valuationValue),
  byValuationSort: index('idx_lead_investment_profiles_valuation_sort').on(t.valuationValue, t.leadId),
  byCustomer: index('idx_lead_investment_profiles_customer').on(t.highestCustomerStage, t.verifiedCustomerCount),
  byCustomerTierA: index('idx_lead_investment_profiles_customer_tier_a').on(t.tierACustomerCount, t.leadId),
  byCustomerTierB: index('idx_lead_investment_profiles_customer_tier_b').on(t.tierBCustomerCount, t.leadId),
  byCustomerTierC: index('idx_lead_investment_profiles_customer_tier_c').on(t.tierCCustomerCount, t.leadId),
  byStatus: index('idx_lead_investment_profiles_status').on(t.profileStatus, t.updatedAt),
  byUpdatedSort: index('idx_lead_investment_profiles_updated_sort').on(t.factsUpdatedAt, t.leadId),
  byInstitution: index('idx_lead_investment_profiles_institution').on(t.hasMajorInstitution),
}))

// 科研线索读取专用投影。论文元数据可直接生成确定性基线，冻结快照中的
// 已核验事实只负责增量补强；不得把企业融资、估值或客户字段映射到此表。
export const leadResearchProfileProjections = mysqlTable('lead_research_profile_projections', {
  leadId: uuidColumn('lead_id').primaryKey().references(() => leads.id, { onDelete: 'cascade' }),
  schemaVersion: varchar('schema_version', { length: 64 }).notNull(),
  projectionVersion: varchar('projection_version', { length: 64 }).notNull(),
  snapshotId: uuidColumn('snapshot_id').references(() => leadEnrichmentSnapshots.id, { onDelete: 'set null' }),
  snapshotHash: varchar('snapshot_hash', { length: 64 }),
  sourceHash: varchar('source_hash', { length: 64 }).notNull(),
  profilePayload: json('profile_payload').$type<LeadResearchProfileSummary>().notNull(),
  profileStatus: varchar('profile_status', { length: 24 }).notNull().default('missing'),
  sourceFactIds: json('source_fact_ids').$type<string[]>().notNull().default(emptyJsonArray),
  factsUpdatedAt: timestampColumn('facts_updated_at'),
  projectedAt: timestampColumn('projected_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byStatus: index('idx_lead_research_profiles_status').on(t.profileStatus, t.updatedAt),
  byUpdated: index('idx_lead_research_profiles_updated').on(t.factsUpdatedAt, t.leadId),
}))

export const leadRatingHistory = mysqlTable('lead_rating_history', {
  id: uuidPrimaryKey('id'),
  leadId: uuidColumn('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  snapshotId: uuidColumn('snapshot_id').notNull().references(() => leadEnrichmentSnapshots.id, { onDelete: 'restrict' }),
  snapshotHash: varchar('snapshot_hash', { length: 64 }).notNull(),
  ratingSchemaVersion: varchar('rating_schema_version', { length: 64 }).notNull(),
  workflow: varchar('workflow', { length: 64 }).notNull(),
  promptVersion: varchar('prompt_version', { length: 128 }).notNull(),
  model: varchar('model', { length: 128 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  result: json('result').$type<Record<string, unknown>>().notNull(),
  completedAt: timestampColumn('completed_at').notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueSnapshotRating: uniqueIndex('uq_lead_rating_history_snapshot').on(t.leadId, t.snapshotHash, t.ratingSchemaVersion),
  byLead: index('idx_lead_rating_history_lead').on(t.leadId, t.completedAt),
  bySnapshot: index('idx_lead_rating_history_snapshot').on(t.snapshotId),
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

// 外部项目库的当前态候选索引。原始响应仍写入不可变 Pipeline 事件；本表只承担
// 范围判断、更新游标和每日准入状态，不与历史 lead_reserve 混用。
export const leadSourceCandidates = mysqlTable('lead_source_candidates', {
  id: uuidPrimaryKey('id'),
  sourceType: varchar('source_type', { length: 32 }).notNull(),
  sourceProjectId: text('source_project_id').notNull(),
  sourceProjectIdHash: varchar('source_project_id_hash', { length: 64 }).notNull(),
  canonicalUrl: text('canonical_url').notNull(),
  projectName: varchar('project_name', { length: 128 }).notNull(),
  companyName: varchar('company_name', { length: 128 }),
  foundedAt: date('founded_at', { mode: 'string' }),
  sourceIndustries: json('source_industries').$type<string[]>().notNull().default(emptyJsonArray),
  sectorLabels: json('sector_labels').$type<string[]>().notNull().default(emptyJsonArray),
  scopeStatus: varchar('scope_status', { length: 32 }).notNull(),
  scopeReasons: json('scope_reasons').$type<string[]>().notNull().default(emptyJsonArray),
  rulesVersion: varchar('rules_version', { length: 32 }).notNull(),
  firstSeenAt: timestampColumn('first_seen_at').notNull(),
  lastSeenAt: timestampColumn('last_seen_at').notNull(),
  fetchedAt: timestampColumn('fetched_at').notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  rawEventId: varchar('raw_event_id', { length: 64 }).notNull()
    .references(() => leadPipelineRawEvents.id, { onDelete: 'restrict' }),
  admissionStatus: varchar('admission_status', { length: 24 }).notNull().default('not_ready'),
  processingStartedAt: timestampColumn('processing_started_at'),
  admittedAt: timestampColumn('admitted_at'),
  admittedLeadId: uuidColumn('admitted_lead_id').references(() => leads.id, { onDelete: 'set null' }),
  attempts: int('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  uniqueSourceProject: uniqueIndex('uq_lead_source_candidates_source').on(t.sourceType, t.sourceProjectIdHash),
  byAdmission: index('idx_lead_source_candidates_admission').on(t.admissionStatus, t.firstSeenAt),
  byScope: index('idx_lead_source_candidates_scope').on(t.scopeStatus, t.lastSeenAt),
  byLead: index('idx_lead_source_candidates_lead').on(t.admittedLeadId),
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
  modelCalls: int('model_calls').notNull().default(0),
  usageCalls: int('usage_calls').notNull().default(0),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  cacheCreationInputTokens: bigint('cache_creation_input_tokens', { mode: 'number' }).notNull().default(0),
  cacheReadInputTokens: bigint('cache_read_input_tokens', { mode: 'number' }).notNull().default(0),
  reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull().default(0),
  totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
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

export const aiTaskEvents = mysqlTable('ai_task_events', {
  id: uuidPrimaryKey('id'),
  taskId: uuidColumn('task_id').notNull().references(() => aiTasks.id, { onDelete: 'cascade' }),
  stage: varchar('stage', { length: 64 }).notNull(),
  progress: int('progress').notNull().default(0),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (t) => ({
  byTask: index('idx_ai_task_events_task').on(t.taskId, t.createdAt),
  uniqueTaskStage: uniqueIndex('uq_ai_task_events_task_stage').on(t.taskId, t.stage),
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

export const companyKnowledge = mysqlTable('company_knowledge', {
  id: uuidPrimaryKey('id'), authorId: uuidColumn('author_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 24 }).notNull(), title: varchar('title', { length: 120 }).notNull(), summary: text('summary').notNull(), link: text('link').notNull(),
  audience: varchar('audience', { length: 16 }).notNull().default('selected'), status: varchar('status', { length: 16 }).notNull().default('draft'),
  fileId: uuidColumn('file_id').references(() => projectFiles.id, { onDelete: 'restrict' }), fileVersionId: uuidColumn('file_version_id').references(() => projectFileVersions.id, { onDelete: 'restrict' }),
  version: int('version').notNull().default(1), publishedAt: timestampColumn('published_at'), archivedAt: timestampColumn('archived_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`), updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ list: index('idx_company_knowledge_list').on(t.status, t.updatedAt), file: index('idx_company_knowledge_file').on(t.fileId) }))
export const companyKnowledgeGrants = mysqlTable('company_knowledge_grants', {
  id: uuidPrimaryKey('id'), entryId: uuidColumn('entry_id').notNull().references(() => companyKnowledge.id, { onDelete: 'restrict' }),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }), canEdit: boolean('can_edit').notNull().default(false),
}, t => ({ member: uniqueIndex('uq_company_knowledge_grant').on(t.entryId, t.userId) }))
export const companyKnowledgeComments = mysqlTable('company_knowledge_comments', {
  id: uuidPrimaryKey('id'), entryId: uuidColumn('entry_id').notNull().references(() => companyKnowledge.id, { onDelete: 'restrict' }),
  authorId: uuidColumn('author_id').notNull().references(() => users.id, { onDelete: 'restrict' }), content: text('content').notNull(),
  withdrawnAt: timestampColumn('withdrawn_at'), withdrawalReason: text('withdrawal_reason'), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ entry: index('idx_company_knowledge_comment').on(t.entryId, t.createdAt) }))
export const companyKnowledgeRatings = mysqlTable('company_knowledge_ratings', {
  id: uuidPrimaryKey('id'), entryId: uuidColumn('entry_id').notNull().references(() => companyKnowledge.id, { onDelete: 'restrict' }),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }), score: int('score'), updatedAt: timestampColumn('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ voter: uniqueIndex('uq_company_knowledge_rating').on(t.entryId, t.userId) }))
export const companyKnowledgeEvents = mysqlTable('company_knowledge_events', {
  id: uuidPrimaryKey('id'), entryId: uuidColumn('entry_id').notNull().references(() => companyKnowledge.id, { onDelete: 'restrict' }),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }), requestId: uuidColumn('request_id').notNull(), requestHash: varchar('request_hash', { length: 64 }).notNull(),
  action: varchar('action', { length: 32 }).notNull(), version: int('version').notNull(), reason: text('reason').notNull(), snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ request: uniqueIndex('uq_company_knowledge_request').on(t.requestId), version: uniqueIndex('uq_company_knowledge_event').on(t.entryId, t.version) }))

// A delayed create/comment can be fenced before its business object exists.
// Deliberately no entry/comment FK; these are recovery keys, not knowledge data.
export const companyKnowledgeCommands = mysqlTable('company_knowledge_commands', {
  id: uuidPrimaryKey('id'), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  commandId: uuidColumn('command_id').notNull(), entryId: uuidColumn('entry_id').notNull(), action: varchar('action', { length: 16 }).notNull(), commentId: uuidColumn('comment_id'),
  commandHash: varchar('command_hash', { length: 64 }), receipt: json('receipt').$type<{ id: string; version: number }>(), closedAt: timestampColumn('closed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`), completedAt: timestampColumn('completed_at'),
}, t => ({ command: uniqueIndex('uq_knowledge_actor_command').on(t.actorId, t.commandId) }))

// Office requests share OA request/node/revision/record identities. These tables
// extend policy, immutable originals and reliable in-app notices, not an alternate engine.
export const oaOfficePolicies = mysqlTable('oa_office_policies', {
  id: uuidPrimaryKey('id'), kind: varchar('kind', { length: 16 }).notNull(), enabled: boolean('enabled').notNull().default(false),
  activeVersionId: uuidColumn('active_version_id'), nextRevision: int('next_revision').notNull().default(1), version: int('version').notNull().default(1),
}, t => ({ kind: uniqueIndex('uq_office_policy_kind').on(t.kind) }))
export const oaOfficePolicyVersions = mysqlTable('oa_office_policy_versions', {
  id: uuidPrimaryKey('id'), policyId: uuidColumn('policy_id').notNull().references(() => oaOfficePolicies.id, { onDelete: 'restrict' }),
  revision: int('revision').notNull(), status: varchar('status', { length: 16 }).notNull().default('draft'), configuration: json('configuration').$type<Record<string, unknown>>().notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(), version: int('version').notNull().default(1), reason: text('reason').notNull(),
  createdBy: uuidColumn('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }), publishedBy: uuidColumn('published_by').references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`), publishedAt: timestampColumn('published_at'),
}, t => ({ revision: uniqueIndex('uq_office_policy_revision').on(t.policyId, t.revision) }))
export const oaOfficeEvents = mysqlTable('oa_office_events', {
  id: uuidPrimaryKey('id'), requestId: uuidColumn('request_id').notNull().references(() => oaApprovalRequests.id, { onDelete: 'restrict' }),
  commandId: uuidColumn('command_id').notNull(), commandHash: varchar('command_hash', { length: 64 }).notNull(), version: int('version').notNull(),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }), action: varchar('action', { length: 32 }).notNull(), reason: text('reason').notNull(),
  snapshot: json('snapshot').$type<Record<string, unknown>>().notNull(), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ command: uniqueIndex('uq_office_command').on(t.commandId), version: uniqueIndex('uq_office_event_version').on(t.requestId, t.version) }))
// Technical serialization keys, not OA business history. A request may not yet
// exist when a delayed create is fenced; deliberately no request/project FK.
export const oaOfficeCommands = mysqlTable('oa_office_commands', {
  id: uuidPrimaryKey('id'), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  commandId: uuidColumn('command_id').notNull(), requestId: uuidColumn('request_id').notNull(), closedAt: timestampColumn('closed_at'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ actorCommand: uniqueIndex('uq_office_actor_command').on(t.actorId, t.commandId) }))
// Rule command results contain identifiers/versions only, never configuration.
// An unsent new draft has no target row; deliberately no target FK.
export const oaOfficePolicyCommands = mysqlTable('oa_office_policy_commands', {
  id: uuidPrimaryKey('id'), actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  commandId: uuidColumn('command_id').notNull(), targetId: uuidColumn('target_id').notNull(), action: varchar('action', { length: 16 }).notNull(),
  commandHash: varchar('command_hash', { length: 64 }), receipt: json('receipt').$type<Record<string, unknown>>(),
  closedAt: timestampColumn('closed_at'), completedAt: timestampColumn('completed_at'), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ actorCommand: uniqueIndex('uq_office_policy_actor_command').on(t.actorId, t.commandId) }))
export const oaOfficeAttachments = mysqlTable('oa_office_attachments', {
  id: uuidPrimaryKey('id'), requestId: uuidColumn('request_id').notNull().references(() => oaApprovalRequests.id, { onDelete: 'restrict' }),
  name: varchar('name', { length: 255 }).notNull(), mime: varchar('mime', { length: 128 }).notNull(), byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(), storagePath: text('storage_path').notNull(), purpose: varchar('purpose', { length: 16 }).notNull().default('application'),
  uploadedBy: uuidColumn('uploaded_by').notNull().references(() => users.id, { onDelete: 'restrict' }), createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, t => ({ request: index('idx_office_attachment_request').on(t.requestId) }))
export const oaOfficeAttachmentGrants = mysqlTable('oa_office_attachment_grants', {
  id: uuidPrimaryKey('id'), attachmentId: uuidColumn('attachment_id').notNull().references(() => oaOfficeAttachments.id, { onDelete: 'restrict' }),
  userId: uuidColumn('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }), canDownload: boolean('can_download').notNull().default(false),
}, t => ({ grant: uniqueIndex('uq_office_attachment_grant').on(t.attachmentId, t.userId) }))
// Immutable manual execution facts. Corrections append a linked record and never
// overwrite approval content or represent calls to payment/seal/signing systems.
export const oaOfficeExecutions = mysqlTable('oa_office_executions', {
  id: uuidPrimaryKey('id'), requestId: uuidColumn('request_id').notNull().references(() => oaApprovalRequests.id, { onDelete: 'restrict' }),
  requestVersion: int('request_version').notNull(), officeRevision: int('office_revision').notNull(),
  policyVersionId: uuidColumn('policy_version_id').notNull().references(() => oaOfficePolicyVersions.id, { onDelete: 'restrict' }),
  action: varchar('action', { length: 16 }).notNull(), outcome: varchar('outcome', { length: 16 }).notNull(), supersedesId: uuidColumn('supersedes_id'),
  actorId: uuidColumn('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }), actorName: varchar('actor_name', { length: 64 }).notNull(),
  occurredAt: timestampColumn('occurred_at').notNull(), recordedAt: timestampColumn('recorded_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  facts: json('facts').$type<Record<string, string>>().notNull(), reason: text('reason').notNull(),
}, t => ({ version: uniqueIndex('uq_office_execution_version').on(t.requestId, t.requestVersion), predecessor: uniqueIndex('uq_office_execution_predecessor').on(t.supersedesId), previous: foreignKey({ columns: [t.supersedesId], foreignColumns: [t.id] }).onDelete('restrict') }))
export const oaOfficeExecutionFiles = mysqlTable('oa_office_execution_files', {
  id: uuidPrimaryKey('id'), executionId: uuidColumn('execution_id').notNull().references(() => oaOfficeExecutions.id, { onDelete: 'restrict' }),
  fileId: uuidColumn('file_id').notNull().references(() => oaOfficeAttachments.id, { onDelete: 'restrict' }),
  version: int('version').notNull().default(1), sha256: varchar('sha256', { length: 64 }).notNull(), name: varchar('name', { length: 255 }).notNull(),
}, t => ({ binding: uniqueIndex('uq_office_execution_file').on(t.executionId, t.fileId) }))
export const oaOfficeNotices = mysqlTable('oa_office_notices', {
  id: uuidPrimaryKey('id'), requestId: uuidColumn('request_id').notNull().references(() => oaApprovalRequests.id, { onDelete: 'restrict' }),
  recipientId: uuidColumn('recipient_id').notNull().references(() => users.id, { onDelete: 'restrict' }), nodeId: uuidColumn('node_id').references(() => oaApprovalNodes.id, { onDelete: 'restrict' }),
  dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(), status: varchar('status', { length: 16 }).notNull().default('pending'),
  createdAt: timestampColumn('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`), readAt: timestampColumn('read_at'), closedAt: timestampColumn('closed_at'),
}, t => ({ unique: uniqueIndex('uq_office_notice_dedupe').on(t.dedupeKey), recipient: index('idx_office_notice_recipient').on(t.recipientId, t.status) }))

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
