// 启动时自动建表（自创建 SQL，避免依赖 drizzle-kit migrate 流程）
// 后续接正式迁移：drizzle-kit generate -> server/drizzle/*.sql，然后调用 migrate()
import { pool } from './client.js'

const STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(64) NOT NULL,
    role VARCHAR(32) NOT NULL,
    department VARCHAR(64) NOT NULL DEFAULT '投资部',
    password_hash TEXT NOT NULL,
    status VARCHAR(8) NOT NULL DEFAULT '启用',
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL,
    company_name VARCHAR(128),
    industry VARCHAR(64),
    round VARCHAR(64),
    stage VARCHAR(16) NOT NULL DEFAULT '线索',
    stage_source VARCHAR(32),
    owner VARCHAR(64) NOT NULL,
    collaborators JSONB NOT NULL DEFAULT '[]'::jsonb,
    source TEXT,
    financing TEXT,
    valuation TEXT,
    risk_level VARCHAR(8) NOT NULL DEFAULT '低',
    score INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    business_model TEXT,
    market TEXT,
    team TEXT,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    latest_approval_id UUID,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects(stage)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner)`,
  `CREATE TABLE IF NOT EXISTS project_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(16) NOT NULL,
    category VARCHAR(32) NOT NULL,
    size VARCHAR(32),
    uploader VARCHAR(64) NOT NULL,
    parse_status VARCHAR(16) NOT NULL DEFAULT '解析中',
    visibility VARCHAR(16) NOT NULL DEFAULT '项目成员',
    storage_path TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id)`,
  `CREATE TABLE IF NOT EXISTS meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    project_name VARCHAR(128) NOT NULL,
    title VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL DEFAULT '项目会议',
    host VARCHAR(64) NOT NULL,
    attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_transcript TEXT,
    ai_summary TEXT,
    conclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings(project_id)`,
  `CREATE TABLE IF NOT EXISTS todos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    project_name VARCHAR(128),
    title VARCHAR(255) NOT NULL,
    owner VARCHAR(64) NOT NULL,
    due_date VARCHAR(10),
    priority VARCHAR(8) NOT NULL DEFAULT '中',
    status VARCHAR(16) NOT NULL DEFAULT '未开始',
    type VARCHAR(32) NOT NULL DEFAULT '待办',
    meeting_id UUID REFERENCES meetings(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(owner)`,
  `CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id)`,
  `CREATE TABLE IF NOT EXISTS risks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    project_name VARCHAR(128) NOT NULL,
    type VARCHAR(32) NOT NULL,
    level VARCHAR(8) NOT NULL DEFAULT '中',
    title VARCHAR(255) NOT NULL,
    description TEXT,
    source VARCHAR(32) NOT NULL DEFAULT '人工录入',
    status VARCHAR(16) NOT NULL DEFAULT '待处置',
    assignee VARCHAR(64),
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_risks_status ON risks(status)`,
  `CREATE TABLE IF NOT EXISTS ai_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    positioning TEXT,
    highlights JSONB NOT NULL DEFAULT '[]'::jsonb,
    risks JSONB NOT NULL DEFAULT '[]'::jsonb,
    questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    missing JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence INTEGER NOT NULL DEFAULT 0,
    sources JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_summaries_project ON ai_summaries(project_id)`,
  `CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL,
    company_name VARCHAR(128),
    industry VARCHAR(64),
    source TEXT,
    pool_status VARCHAR(32) NOT NULL DEFAULT '成功',
    score INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    highlights JSONB NOT NULL DEFAULT '[]'::jsonb,
    risks JSONB NOT NULL DEFAULT '[]'::jsonb,
    team TEXT,
    funding_rounds JSONB NOT NULL DEFAULT '[]'::jsonb,
    risk_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    sources JSONB NOT NULL DEFAULT '[]'::jsonb,
    claimed_by VARCHAR(64),
    converted_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    user_name VARCHAR(64) NOT NULL,
    module VARCHAR(32) NOT NULL,
    action VARCHAR(64) NOT NULL,
    target TEXT,
    ip VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at)`,
  `CREATE TABLE IF NOT EXISTS chat_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(128) NOT NULL DEFAULT '新会话',
    scope VARCHAR(16) NOT NULL DEFAULT 'project',
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    project_name VARCHAR(128),
    messages JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_conv_user ON chat_conversations(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_conv_updated ON chat_conversations(updated_at)`,
  `ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS agent_id VARCHAR(64)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_conv_agent ON chat_conversations(agent_id)`,
  `ALTER TABLE project_files ADD COLUMN IF NOT EXISTS content_text TEXT`,
  `ALTER TABLE project_files ADD COLUMN IF NOT EXISTS parse_error TEXT`,
  `CREATE TABLE IF NOT EXISTS file_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id UUID NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_file_chunks_file ON file_chunks(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_file_chunks_project ON file_chunks(project_id)`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS scoring JSONB`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS radar_profile JSONB`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS radar_source_keys JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `CREATE INDEX IF NOT EXISTS idx_leads_radar_source_keys ON leads USING GIN (radar_source_keys)`,
  `CREATE TABLE IF NOT EXISTS radar_sync_state (
    id VARCHAR(64) PRIMARY KEY,
    backfill_cursor TEXT,
    backfill_complete BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope VARCHAR(16) NOT NULL,
    ref_id VARCHAR(64) NOT NULL,
    source_type VARCHAR(24) NOT NULL,
    source_id VARCHAR(64),
    source_name VARCHAR(255) NOT NULL DEFAULT '',
    chunk_index INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kc_scope_ref ON knowledge_chunks(scope, ref_id)`,
  `CREATE INDEX IF NOT EXISTS idx_kc_scope ON knowledge_chunks(scope)`,
  `CREATE INDEX IF NOT EXISTS idx_kc_source ON knowledge_chunks(source_id)`,
  // 迁移: 把旧 file_chunks 数据复制进 knowledge_chunks(scope=project)，幂等(仅当目标空)
  `INSERT INTO knowledge_chunks (scope, ref_id, source_type, source_id, source_name, chunk_index, content, created_at)
    SELECT 'project', project_id::text, 'file', file_id::text, file_name, chunk_index, content, created_at
    FROM file_chunks
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_chunks WHERE scope='project' AND source_type='file')`,
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS scoring JSONB`,
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE TABLE IF NOT EXISTS ai_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id VARCHAR(64),
    type VARCHAR(40) NOT NULL,
    parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    template_version VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    stage VARCHAR(64) NOT NULL DEFAULT '等待执行',
    progress INTEGER NOT NULL DEFAULT 0,
    result_summary TEXT,
    error_id VARCHAR(64),
    error_message TEXT,
    cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
    idempotency_key VARCHAR(128) NOT NULL,
    request_hash VARCHAR(64),
    retry_of_task_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ai_tasks_user_idempotency UNIQUE(user_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_tasks_user ON ai_tasks(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_tasks_project ON ai_tasks(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks(status)`,
  `ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64)`,
  `CREATE TABLE IF NOT EXISTS ai_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id VARCHAR(64),
    file_name VARCHAR(255) NOT NULL,
    format VARCHAR(16) NOT NULL,
    mime_type VARCHAR(128) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    storage_path TEXT NOT NULL,
    editable_level VARCHAR(32) NOT NULL DEFAULT 'none',
    source_cutoff_date VARCHAR(10),
    template_version VARCHAR(64) NOT NULL,
    quality_status VARCHAR(16) NOT NULL DEFAULT 'unchecked',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_artifacts_task ON ai_artifacts(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_artifacts_user ON ai_artifacts(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_artifacts_project ON ai_artifacts(project_id)`,
  `CREATE TABLE IF NOT EXISTS ai_task_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
    artifact_id UUID REFERENCES ai_artifacts(id) ON DELETE CASCADE,
    source_type VARCHAR(24) NOT NULL,
    source_id VARCHAR(64),
    source_name VARCHAR(255) NOT NULL,
    locator TEXT,
    verification_status VARCHAR(16) NOT NULL DEFAULT '待核验',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_task_sources_task ON ai_task_sources(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_task_sources_artifact ON ai_task_sources(artifact_id)`,
  `CREATE TABLE IF NOT EXISTS ai_custom_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES chat_conversations(id) ON DELETE SET NULL,
    original_file_name VARCHAR(255) NOT NULL,
    format VARCHAR(16) NOT NULL,
    mime_type VARCHAR(128) NOT NULL,
    file_size INTEGER NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    storage_path TEXT NOT NULL,
    analysis JSONB NOT NULL,
    skill_name VARCHAR(64) NOT NULL,
    skill_path TEXT NOT NULL,
    skill_version VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'succeeded',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_custom_templates_user ON ai_custom_templates(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_custom_templates_project ON ai_custom_templates(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_custom_templates_conversation ON ai_custom_templates(conversation_id)`,
]

export async function ensureSchema(): Promise<void> {
  const client = await pool.connect()
  try {
    for (const stmt of STATEMENTS) {
      try {
        await client.query(stmt)
      } catch (e) {
        const msg = (e as Error).message
        // 同事务内 previous statement 失败时自动回滚，需要每条单独提交
        if (!/current transaction is aborted/i.test(msg)) throw e
      }
    }
  } finally {
    client.release()
  }
}
