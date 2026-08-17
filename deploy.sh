#!/usr/bin/env bash
#=============================================================================
# cybernaut.newmin.cn 一键部署 / 更新脚本
#=============================================================================
# 用法:
#   bash deploy.sh              # 首次部署（完整流程）
#   bash deploy.sh update       # 快速更新（git pull + build + restart）
#   bash deploy.sh restart      # 重启统一应用服务
#   bash deploy.sh restart-all  # restart 的兼容别名
#   bash deploy.sh radar-configure # 安全写入 GSData 凭据
#   bash deploy.sh status       # 查看服务状态
#   bash deploy.sh logs         # 查看最近日志
#=============================================================================
set -euo pipefail

#---------------------------------------
# 配置区（可按需修改）
#---------------------------------------
DOMAIN="${DOMAIN:-cybernaut.newmin.cn}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://${DOMAIN}}"
TLS_CERT_FILE="${TLS_CERT_FILE:-/etc/letsencrypt/live/${DOMAIN}/fullchain.pem}"
TLS_KEY_FILE="${TLS_KEY_FILE:-/etc/letsencrypt/live/${DOMAIN}/privkey.pem}"
DEPLOY_DIR="/www/sbl"
NODE_BIN="node"
NPM_BIN="npm"
NGINX_CONF="/etc/nginx/conf.d/cybernaut.conf"
APP_SERVICE="cybernaut-app"
APP_RUN_USER="${APP_RUN_USER:-cybernaut}"
APP_RUN_GROUP="${APP_RUN_GROUP:-cybernaut}"
APP_MEMORY_MAX="${APP_MEMORY_MAX:-8G}"
APP_CPU_QUOTA="${APP_CPU_QUOTA:-400%}"
APP_TASKS_MAX="${APP_TASKS_MAX:-512}"
APP_STATE_DIR="/var/lib/cybernaut-app"
DB_MIGRATION_ENV_FILE="${DB_MIGRATION_ENV_FILE:-}"
LEGACY_API_SERVICE="cybernaut-api"
LEGACY_ASSISTANT_SERVICE="cybernaut-assistant"
LEGACY_FLUE_SERVICE="cybernaut-flue"
FLUE_STATE_DIR="/var/lib/cybernaut-assistant"
LEGACY_RADAR_SERVICE="cybernaut-radar"
LEGACY_RADAR_SYNC_SERVICE="cybernaut-radar-sync"
LEGACY_RADAR_SYNC_TIMER="cybernaut-radar-sync.timer"
RADAR_DIR="${DEPLOY_DIR}/project-discovery"
RADAR_STATE_DIR="/var/lib/cybernaut-radar"
SYSTEMD_SERVICE="$APP_SERVICE"
LOG_DIR="${DEPLOY_DIR}/logs"
GENERATED_DIR="${DEPLOY_DIR}/server/generated"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }
step() { echo -e "\n${BLUE}═══ $* ═══${NC}"; }

# 更新部署脚本管理的环境变量，同时保留其他密钥和人工配置。
set_env_value() {
    local file="$1" key="$2" value="$3" tmp
    tmp=$(mktemp)
    awk -v key="$key" -v value="$value" '
        BEGIN { found = 0 }
        $0 ~ ("^" key "=") {
            if (!found) print key "=" value
            found = 1
            next
        }
        { print }
        END {
            if (!found) print key "=" value
        }
    ' "$file" > "$tmp"
    mv "$tmp" "$file"
}

ensure_env_value() {
    local file="$1" key="$2" value="$3"
    if ! grep -q "^${key}=" "$file"; then
        printf '%s=%s\n' "$key" "$value" >> "$file"
    fi
}

#---------------------------------------
# 前置检查
#---------------------------------------
check_prereqs() {
    step "环境检查"

    local ok=true

    if ! command -v "$NODE_BIN" &>/dev/null; then
        err "Node.js 未安装，请先安装 Node.js ≥ 20"
        ok=false
    else
        local nv; nv=$("$NODE_BIN" -v)
        log "Node.js $nv ✓"
    fi

    if ! command -v "$NPM_BIN" &>/dev/null; then
        err "npm 未安装"
        ok=false
    else
        log "npm $("$NPM_BIN" -v) ✓"
    fi

    if ! command -v python3 &>/dev/null; then
        err "Python 3 未安装，情报雷达需要 Python ≥ 3.9"
        ok=false
    else
        local pyv; pyv=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')
        if ! python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 9))'; then
            err "Python ${pyv} 版本过低，情报雷达需要 Python ≥ 3.9"
            ok=false
        else
            log "Python ${pyv} ✓"
        fi
    fi

    if ! command -v nginx &>/dev/null; then
        err "nginx 未安装，请先: apt install nginx"
        ok=false
    else
        log "nginx $(nginx -v 2>&1 | cut -d/ -f2) ✓"
    fi

    if [ ! -d "$DEPLOY_DIR" ]; then
        err "部署目录不存在: $DEPLOY_DIR"
        ok=false
    fi

    $ok || exit 1
}

#---------------------------------------
# 创建非特权运行账号并准备唯一业务服务的可写目录
#---------------------------------------
ensure_runtime_user() {
    if ! getent group "$APP_RUN_GROUP" >/dev/null 2>&1; then
        groupadd --system "$APP_RUN_GROUP"
    fi
    if ! id "$APP_RUN_USER" >/dev/null 2>&1; then
        useradd --system --gid "$APP_RUN_GROUP" --home-dir "$APP_STATE_DIR" --shell /usr/sbin/nologin "$APP_RUN_USER"
    fi
    install -d -m 0750 -o "$APP_RUN_USER" -g "$APP_RUN_GROUP" "$APP_STATE_DIR"
}

prepare_runtime_permissions() {
    local env_file="${DEPLOY_DIR}/.env"
    local runtime_dirs=(
        "$LOG_DIR"
        "$GENERATED_DIR"
        "${DEPLOY_DIR}/server/ai-artifacts"
        "${DEPLOY_DIR}/server/project-files"
        "${DEPLOY_DIR}/server/ai-template-data"
        "${DEPLOY_DIR}/server/ai-template-skills"
        "${DEPLOY_DIR}/server/agent-workspace"
        "$APP_STATE_DIR"
        "${FLUE_STATE_DIR}/workspace"
        "${RADAR_STATE_DIR}/data"
    )
    install -d -m 0750 "${runtime_dirs[@]}"
    chown -R "${APP_RUN_USER}:${APP_RUN_GROUP}" \
        "$LOG_DIR" \
        "$GENERATED_DIR" \
        "${DEPLOY_DIR}/server/ai-artifacts" \
        "${DEPLOY_DIR}/server/project-files" \
        "${DEPLOY_DIR}/server/ai-template-data" \
        "${DEPLOY_DIR}/server/ai-template-skills" \
        "${DEPLOY_DIR}/server/agent-workspace" \
        "$APP_STATE_DIR" \
        "$FLUE_STATE_DIR" \
        "$RADAR_STATE_DIR"
    if [ -f "$env_file" ]; then
        chown "${APP_RUN_USER}:${APP_RUN_GROUP}" "$env_file"
        chmod 0600 "$env_file"
    fi
}

#---------------------------------------
# 数据库初始化
#---------------------------------------
init_database() {
    step "数据库初始化"
    local env_file="${DEPLOY_DIR}/.env" key
    for key in DB_HOST DB_PORT DB_DATABASE DB_USERNAME DB_PASSWORD DB_FREFIX; do
        if ! grep -q "^${key}=..*" "$env_file"; then
            err "${env_file} 缺少有效的 ${key}"
            exit 1
        fi
    done
    cd "$DEPLOY_DIR"
    log "创建当前活动表前缀的一致性迁移前备份..."
    "$NPM_BIN" run db:backup
    if [ -n "$DB_MIGRATION_ENV_FILE" ]; then
        if [ ! -f "$DB_MIGRATION_ENV_FILE" ]; then
            err "MySQL 迁移凭据文件不存在: ${DB_MIGRATION_ENV_FILE}"
            exit 1
        fi
        local migration_owner migration_mode migration_username migration_password
        migration_owner=$(stat -c '%u' "$DB_MIGRATION_ENV_FILE")
        migration_mode=$(stat -c '%a' "$DB_MIGRATION_ENV_FILE")
        if [ "$migration_owner" != "0" ] || [[ "$migration_mode" != "600" && "$migration_mode" != "400" ]]; then
            err "MySQL 迁移凭据文件必须归 root 且权限为 0600/0400"
            exit 1
        fi
        migration_username=$(awk -F= '$1 == "DB_MIGRATION_USERNAME" {sub(/^[^=]*=/, ""); print; exit}' "$DB_MIGRATION_ENV_FILE")
        migration_password=$(awk -F= '$1 == "DB_MIGRATION_PASSWORD" {sub(/^[^=]*=/, ""); print; exit}' "$DB_MIGRATION_ENV_FILE")
        if [ -z "$migration_username" ] || [ -z "$migration_password" ]; then
            err "迁移凭据文件必须包含 DB_MIGRATION_USERNAME 和 DB_MIGRATION_PASSWORD"
            exit 1
        fi
        DB_MIGRATION_USERNAME="$migration_username" DB_MIGRATION_PASSWORD="$migration_password" "$NPM_BIN" run db:migrate
        unset migration_username migration_password
    else
        warn "未配置 DB_MIGRATION_ENV_FILE；本次迁移暂用 DB_USERNAME。生产应拆分 DDL 迁移账号与 DML 运行账号"
        "$NPM_BIN" run db:migrate
    fi
    log "应用版本化系统模板、能力目录和周期任务种子..."
    "$NPM_BIN" run db:seed
    if ! "$NPM_BIN" run audit:mysql-privileges; then
        err "DB_USERNAME 不是最小权限运行账号；请按账号分离方案换号/撤权后再发布"
        exit 1
    fi
    if [ -n "$DB_MIGRATION_ENV_FILE" ]; then
        if ! "$NPM_BIN" run audit:mysql-account-cutover; then
            err "Runtime/Migration 账号分离联合审计失败"
            exit 1
        fi
    fi
    if ! "$NPM_BIN" run audit:password-hashes; then
        err "迁移账号存在明文/无效哈希、缺失映射或已知弱密码；完成强制密码轮换后再发布"
        exit 1
    fi
    "$NPM_BIN" run accept:demo-user-seed-retirement
    "$NPM_BIN" run accept:system-administration
    log "MySQL 连接与版本化 Schema 迁移通过 ✓"
}

#---------------------------------------
# 创建 / 迁移 .env 文件
#---------------------------------------
create_env() {
    step "配置环境变量"

    local ENV_FILE="${DEPLOY_DIR}/.env"

    if [ -f "$ENV_FILE" ]; then
        log ".env 已存在，保留现有配置"
    else
        log "创建 .env 文件..."
        cat > "$ENV_FILE" <<EOF
# ---- 运行模式 ----
NODE_ENV=production

# ---- 端口 ----
API_PORT=3100

# ---- MySQL（DB_FREFIX 拼写为历史兼容契约，请勿改名） ----
DB_HOST=${DB_HOST:-}
DB_PORT=${DB_PORT:-3306}
DB_DATABASE=${DB_DATABASE:-}
DB_USERNAME=${DB_USERNAME:-}
DB_PASSWORD=${DB_PASSWORD:-}
DB_FREFIX=${DB_FREFIX:-sbl_}
DB_POOL_SIZE=${DB_POOL_SIZE:-10}
DB_POOL_QUEUE_LIMIT=${DB_POOL_QUEUE_LIMIT:-40}
DB_CONNECT_TIMEOUT_MS=${DB_CONNECT_TIMEOUT_MS:-10000}

# ---- 单服务运维指标与告警阈值 ----
OPS_HTTP_MIN_REQUESTS=${OPS_HTTP_MIN_REQUESTS:-20}
OPS_HTTP_SERVER_ERROR_RATE_WARN=${OPS_HTTP_SERVER_ERROR_RATE_WARN:-0.05}
OPS_HTTP_P95_MS_WARN=${OPS_HTTP_P95_MS_WARN:-2000}
OPS_MYSQL_WAITING_REQUESTS_WARN=${OPS_MYSQL_WAITING_REQUESTS_WARN:-1}
OPS_MYSQL_ROW_LOCK_CURRENT_WAITS_WARN=${OPS_MYSQL_ROW_LOCK_CURRENT_WAITS_WARN:-1}
OPS_MYSQL_REPLICATION_LAG_SECONDS_WARN=${OPS_MYSQL_REPLICATION_LAG_SECONDS_WARN:-300}
OPS_QUEUE_DEAD_LETTERS_WARN=${OPS_QUEUE_DEAD_LETTERS_WARN:-1}
OPS_FILE_PARSE_FAILURES_WARN=${OPS_FILE_PARSE_FAILURES_WARN:-1}
OPS_AUTH_DENIED_15M_WARN=${OPS_AUTH_DENIED_15M_WARN:-5}
OPS_AUTH_PREVIOUS_KEY_MATCHES_24H_WARN=${OPS_AUTH_PREVIOUS_KEY_MATCHES_24H_WARN:-1}
OPS_CREDENTIAL_CHANGES_15M_WARN=${OPS_CREDENTIAL_CHANGES_15M_WARN:-1}
OPS_HIGH_RISK_TOOL_DENIED_15M_WARN=${OPS_HIGH_RISK_TOOL_DENIED_15M_WARN:-1}
OPS_CDC_LAG_MS_WARN=${OPS_CDC_LAG_MS_WARN:-300000}
OPS_LEAD_SOURCE_MISSING_WARN=${OPS_LEAD_SOURCE_MISSING_WARN:-1}
OPS_LEAD_REVIEW_PENDING_WARN=${OPS_LEAD_REVIEW_PENDING_WARN:-20}
OPS_LEAD_REVIEW_OLDEST_AGE_MS_WARN=${OPS_LEAD_REVIEW_OLDEST_AGE_MS_WARN:-86400000}
OPS_LEAD_ENTITY_DUPLICATE_GROUPS_WARN=${OPS_LEAD_ENTITY_DUPLICATE_GROUPS_WARN:-1}
OPS_FILE_DISK_FREE_BYTES_WARN=${OPS_FILE_DISK_FREE_BYTES_WARN:-5368709120}
OPS_FILE_DISK_USED_RATIO_WARN=${OPS_FILE_DISK_USED_RATIO_WARN:-0.9}
OPS_FILE_DISK_USED_RATIO_GROWTH_24H_WARN=${OPS_FILE_DISK_USED_RATIO_GROWTH_24H_WARN:-0.05}
OPS_AI_FIRST_TOKEN_MIN_REQUESTS=${OPS_AI_FIRST_TOKEN_MIN_REQUESTS:-5}
OPS_AI_FIRST_TOKEN_P95_MS_WARN=${OPS_AI_FIRST_TOKEN_P95_MS_WARN:-5000}
OPS_AI_FIRST_TOKEN_OBSERVATION_COVERAGE_WARN=${OPS_AI_FIRST_TOKEN_OBSERVATION_COVERAGE_WARN:-0.8}
OPS_FILE_CAPACITY_SNAPSHOT_INTERVAL_SECONDS=${OPS_FILE_CAPACITY_SNAPSHOT_INTERVAL_SECONDS:-3600}
OPS_DOCUMENT_RENDER_FAILURES_WARN=${OPS_DOCUMENT_RENDER_FAILURES_WARN:-1}
OPS_DOCUMENT_QUALITY_FAILURES_WARN=${OPS_DOCUMENT_QUALITY_FAILURES_WARN:-1}
OPS_DOCUMENT_FONT_FAILURES_WARN=${OPS_DOCUMENT_FONT_FAILURES_WARN:-1}
OPS_JOB_FAILURES_24H_WARN=${OPS_JOB_FAILURES_24H_WARN:-1}
OPS_JOB_DEAD_LETTERS_24H_WARN=${OPS_JOB_DEAD_LETTERS_24H_WARN:-1}
OPS_JOB_RETRIED_RECORDS_24H_WARN=${OPS_JOB_RETRIED_RECORDS_24H_WARN:-5}
OPS_JOB_TIMEOUT_FAILURES_24H_WARN=${OPS_JOB_TIMEOUT_FAILURES_24H_WARN:-1}
OPS_JOB_LEASE_RECOVERIES_24H_WARN=${OPS_JOB_LEASE_RECOVERIES_24H_WARN:-1}
OPS_JOB_EXPIRED_LEASES_WARN=${OPS_JOB_EXPIRED_LEASES_WARN:-1}
OPS_JOB_LEASE_CONTENTIONS_24H_WARN=${OPS_JOB_LEASE_CONTENTIONS_24H_WARN:-10}
OPS_JOB_DUPLICATE_SUPPRESSED_24H_WARN=${OPS_JOB_DUPLICATE_SUPPRESSED_24H_WARN:-20}
OPS_JOB_STALE_COMPLETIONS_24H_WARN=${OPS_JOB_STALE_COMPLETIONS_24H_WARN:-1}
OPS_SUPERVISED_PROCESS_FAILURES_24H_WARN=${OPS_SUPERVISED_PROCESS_FAILURES_24H_WARN:-1}
OPS_SUPERVISED_PROCESS_TIMEOUTS_24H_WARN=${OPS_SUPERVISED_PROCESS_TIMEOUTS_24H_WARN:-1}
OPS_SUPERVISED_PROCESS_FORCE_KILLS_24H_WARN=${OPS_SUPERVISED_PROCESS_FORCE_KILLS_24H_WARN:-1}
OPS_ALERT_OWNER_ROLE=${OPS_ALERT_OWNER_ROLE:-operations-on-call}
OPS_ALERT_NOTIFICATION_CHANNEL_ID=${OPS_ALERT_NOTIFICATION_CHANNEL_ID:-}
OPS_ALERT_REMINDER_MINUTES=${OPS_ALERT_REMINDER_MINUTES:-60}
OPS_ALERT_ESCALATION_POLICY_ID=${OPS_ALERT_ESCALATION_POLICY_ID:-}
SEED_DEMO_USERS=0

# ---- 项目文件 ----
PROJECT_FILE_MAX_BYTES=${PROJECT_FILE_MAX_BYTES:-104857600}
PROJECT_FILE_ARCHIVE_MAX_ENTRIES=${PROJECT_FILE_ARCHIVE_MAX_ENTRIES:-5000}
PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES=${PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES:-262144000}
PROJECT_FILE_MAX_COUNT_PER_PROJECT=${PROJECT_FILE_MAX_COUNT_PER_PROJECT:-500}
PROJECT_FILE_MAX_BYTES_PER_PROJECT=${PROJECT_FILE_MAX_BYTES_PER_PROJECT:-5368709120}
PROJECT_FILE_MAX_BYTES_PER_USER=${PROJECT_FILE_MAX_BYTES_PER_USER:-21474836480}

# ---- JWT ----
JWT_SECRET=cybernaut-prod-$(openssl rand -hex 16 2>/dev/null || echo "change-me-$(date +%s)")
JWT_EXPIRES_IN=24h
AUTH_SESSION_SECRET=cybernaut-session-$(openssl rand -hex 32 2>/dev/null || echo "change-me-$(date +%s)")
AUTH_SESSION_PREVIOUS_SECRETS=
AUTH_SESSION_KEY_ROTATION_STARTED_AT=
AUTH_SESSION_MAX_ACTIVE=${AUTH_SESSION_MAX_ACTIVE:-5}
AUTH_SESSION_TTL_MINUTES=${AUTH_SESSION_TTL_MINUTES:-1440}
AUTH_SESSION_REMEMBER_TTL_DAYS=${AUTH_SESSION_REMEMBER_TTL_DAYS:-30}
AUTH_SESSION_RENEW_WINDOW_PERCENT=${AUTH_SESSION_RENEW_WINDOW_PERCENT:-25}
AUTH_PASSWORD_BCRYPT_ROUNDS=${AUTH_PASSWORD_BCRYPT_ROUNDS:-12}

# ---- Web 会话 ----
AUTH_ALLOW_LEGACY_BEARER=false
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAME_SITE=lax
AUTH_COOKIE_DOMAIN=
AUTH_ALLOWED_ORIGINS=${PUBLIC_ORIGIN}

# ---- LLM 网关 ----
LLM_BASE_URL=${LLM_BASE_URL:-https://skill.zeelin.cn/api/v9}
LLM_MODEL=${LLM_MODEL:-gpt-5.6-sol}
LLM_API_KEY=

# ---- OpenAI 兼容网关 ----
OPENAI_BASE_URL=${OPENAI_BASE_URL:-https://skill.zeelin.cn/api/v9}
OPENAI_API_KEY=
OCR_VISION_MODEL=gemini-3.1-pro-preview
AI_PYTHON_CA_FILE=

# ---- MySQL 模型配置凭据保护 ----
MODEL_CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32 2>/dev/null || true)
INTEGRATION_CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32 2>/dev/null || true)
MODEL_PROVIDER_ALLOWED_HOSTS=${MODEL_PROVIDER_ALLOWED_HOSTS:-skill.zeelin.cn}
MODEL_PROVIDER_ALLOW_HTTP=false
AI_CAPABILITIES_ENABLED=true
IM_INTEGRATIONS_ENABLED=true
IM_WEBHOOK_ALLOWED_HOSTS=${IM_WEBHOOK_ALLOWED_HOSTS:-}
IM_OUTBOX_ENABLED=true
IM_OUTBOX_INTERVAL_SECONDS=${IM_OUTBOX_INTERVAL_SECONDS:-15}
IM_OUTBOX_BATCH_SIZE=${IM_OUTBOX_BATCH_SIZE:-10}

# ---- 图片生成网关 ----
GATEWAY_IMAGE_BASE_URL=https://getways-jumu.zeelin.cn
GATEWAY_IMAGE_API_KEY=

# ---- 进程内 JW Agent ----
JW_AGENT_MODEL=${JW_AGENT_MODEL:-gpt-5.6-sol}
JW_GLOBAL_NEW_CONVERSATIONS_ENABLED=${JW_GLOBAL_NEW_CONVERSATIONS_ENABLED:-true}
JW_PROJECT_NEW_CONVERSATIONS_ENABLED=${JW_PROJECT_NEW_CONVERSATIONS_ENABLED:-true}
JW_AGENT_PERMISSION_MODE=dontAsk
JW_AGENT_MAX_TURNS=12
JW_AGENT_MAX_BUDGET_USD=5
JW_AGENT_INTERACTION_TIMEOUT_MS=900000
SOCKET_AUTH_REVALIDATE_MS=60000
SOCKET_RECONNECT_WINDOW_MS=300000
SOCKET_DB_CONCURRENCY=8
LEAD_SUBJECT_AGENT_MAX_TURNS=2
LEAD_SUBJECT_AGENT_MAX_BUDGET_USD=0.25
LEAD_SCORING_AGENT_MAX_TURNS=2
LEAD_SCORING_AGENT_MAX_BUDGET_USD=0.75
LEAD_WORKFLOW_AGENT_MAX_TURNS=2
LEAD_WORKFLOW_AGENT_MAX_BUDGET_USD=0.50
LEAD_WORKFLOW_AGENT_TIMEOUT_MS=180000
LEAD_AGENT_GLOBAL_MAX_CONCURRENCY=16
LEAD_AGENT_GLOBAL_MAX_REQUESTS_PER_MINUTE=60
LEAD_AGENT_GLOBAL_DAILY_BUDGET_USD=100
LEAD_AGENT_GLOBAL_RESERVATION_USD=0.75
LEAD_AGENT_CIRCUIT_FAILURE_THRESHOLD=5
LEAD_AGENT_CIRCUIT_OPEN_MS=300000
LEAD_AGENT_PERMIT_TTL_MS=600000
LEAD_AGENT_PERMIT_RETENTION_DAYS=30
SCORE_MODEL=${SCORE_MODEL:-gpt-5.6-sol}
SCORE_FALLBACK_MODEL=${SCORE_FALLBACK_MODEL:-gpt-5.6-sol}
SCORE_PRIMARY_MODEL_TIMEOUT_MS=90000
SCORE_FALLBACK_MODEL_TIMEOUT_MS=240000

# ---- 情报雷达 ----
RADAR_DATA_DIR=${RADAR_STATE_DIR}/data
RADAR_WECHAT_ACCOUNTS_XLSX=${RADAR_STATE_DIR}/公众号来源.xlsx
RADAR_WECHAT_DAILY_ENABLED=true
RADAR_SYNC_ENABLED=true
RADAR_SYNC_INTERVAL_MS=1800000
RADAR_SYNC_START_DELAY_MS=120000
RADAR_WECHAT_MAX_WORKERS=4
RADAR_WECHAT_REQUEST_ATTEMPTS=3
RADAR_WECHAT_RETRY_BASE_SECONDS=1
RADAR_WECHAT_RETRY_INTERVAL_SECONDS=1800
RADAR_WECHAT_RETRY_BATCH_SIZE=100
RADAR_WECHAT_INSTITUTION_INTERVAL_SECONDS=7200
RADAR_SYNC_PAGE_SIZE=50
RADAR_SYNC_INCREMENTAL_PAGES=4
RADAR_SYNC_BACKFILL_PAGES=1
RADAR_PAPER_CRAWL_ENABLED=true
RADAR_PAPER_DAILY_HOUR=7
RADAR_PAPER_DAILY_MINUTE=30
RADAR_NOTIFICATION_CHANNEL_ID=
RADAR_NOTIFY_SUCCESS=true
RUNTIME_JOB_POLL_MS=5000
RUNTIME_JOB_LEASE_SECONDS=900
RUNTIME_JOB_MAX_RETRIES=3
RUNTIME_JOB_CONCURRENCY=1
SCORE_JOB_POLL_MS=1000
SCORE_JOB_LEASE_SECONDS=900
SCORE_RECOVERY_ENABLED=true
SCORE_RECOVERY_INTERVAL_SECONDS=900
SCORE_RECOVERY_BATCH_SIZE=500
PROJECT_SCORE_QUEUE_CONCURRENCY=1
PROJECT_SCORE_JOB_POLL_MS=1000
PROJECT_SCORE_JOB_LEASE_SECONDS=900
PROJECT_SCORE_MAX_ATTEMPTS=3
PROJECT_SCORE_RETRY_BASE_MS=60000
AI_TASK_LEASE_SECONDS=900
DAILY_INTAKE_ENABLED=true
DAILY_INTAKE=50
DAILY_INTAKE_HOUR=9
DAILY_INTAKE_MINUTE=0
GSDATA_APP_KEY=
GSDATA_APP_SECRET=

# ---- Agent 工作空间 ----
AGENT_WORKSPACE=${FLUE_STATE_DIR}/workspace
AI_SKILL_ROOT=${FLUE_STATE_DIR}/workspace/.agents/skills
AI_PDF_TO_PPT_NODE_PROJECT_ROOT=${DEPLOY_DIR}

# ---- 性能 ----
SCORE_QUEUE_CONCURRENCY=3
SCORE_MAX_ATTEMPTS=3
SCORE_REQUEST_TIMEOUT_MS=360000
SCORE_DEFERRED_RETRY_LIMIT=0
INGEST_MAX_ATTEMPTS=3
EOF
        log ".env 创建完成 ✓"
        warn "如需启用 AI 功能，请编辑 .env 填写 LLM_API_KEY 或 OPENAI_API_KEY"
    fi

    # 以下键属于本部署拓扑，升级旧环境时也必须迁移到进程内 JW Runtime。
    set_env_value "$ENV_FILE" "JW_AGENT_MODEL" "${JW_AGENT_MODEL:-claude-sonnet-4-6}"
    set_env_value "$ENV_FILE" "JW_AGENT_PERMISSION_MODE" "dontAsk"
    ensure_env_value "$ENV_FILE" "JW_AGENT_MAX_TURNS" "12"
    ensure_env_value "$ENV_FILE" "JW_AGENT_MAX_BUDGET_USD" "5"
    ensure_env_value "$ENV_FILE" "JW_AGENT_INTERACTION_TIMEOUT_MS" "900000"
    set_env_value "$ENV_FILE" "AGENT_WORKSPACE" "${FLUE_STATE_DIR}/workspace"
    set_env_value "$ENV_FILE" "AI_SKILL_ROOT" "${FLUE_STATE_DIR}/workspace/.agents/skills"
    set_env_value "$ENV_FILE" "AI_PDF_TO_PPT_NODE_PROJECT_ROOT" "${DEPLOY_DIR}"
    set_env_value "$ENV_FILE" "RADAR_DATA_DIR" "${RADAR_STATE_DIR}/data"
    set_env_value "$ENV_FILE" "RADAR_WECHAT_ACCOUNTS_XLSX" "${RADAR_STATE_DIR}/公众号来源.xlsx"

    # 旧部署升级时补齐 MySQL 键；值为空会在数据库初始化阶段明确阻断。
    ensure_env_value "$ENV_FILE" "DB_HOST" "${DB_HOST:-}"
    ensure_env_value "$ENV_FILE" "DB_PORT" "${DB_PORT:-3306}"
    ensure_env_value "$ENV_FILE" "DB_DATABASE" "${DB_DATABASE:-}"
    ensure_env_value "$ENV_FILE" "DB_USERNAME" "${DB_USERNAME:-}"
    ensure_env_value "$ENV_FILE" "DB_PASSWORD" "${DB_PASSWORD:-}"
    ensure_env_value "$ENV_FILE" "DB_FREFIX" "${DB_FREFIX:-sbl_}"
    ensure_env_value "$ENV_FILE" "DB_POOL_SIZE" "${DB_POOL_SIZE:-10}"
    ensure_env_value "$ENV_FILE" "DB_POOL_QUEUE_LIMIT" "${DB_POOL_QUEUE_LIMIT:-40}"
    ensure_env_value "$ENV_FILE" "DB_CONNECT_TIMEOUT_MS" "${DB_CONNECT_TIMEOUT_MS:-10000}"
    ensure_env_value "$ENV_FILE" "SEED_DEMO_USERS" "0"
    ensure_env_value "$ENV_FILE" "PROJECT_FILE_MAX_BYTES" "${PROJECT_FILE_MAX_BYTES:-104857600}"
    ensure_env_value "$ENV_FILE" "PROJECT_FILE_ARCHIVE_MAX_ENTRIES" "${PROJECT_FILE_ARCHIVE_MAX_ENTRIES:-5000}"
    ensure_env_value "$ENV_FILE" "PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES" "${PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES:-262144000}"
    ensure_env_value "$ENV_FILE" "PROJECT_FILE_MAX_COUNT_PER_PROJECT" "${PROJECT_FILE_MAX_COUNT_PER_PROJECT:-500}"
    ensure_env_value "$ENV_FILE" "PROJECT_FILE_MAX_BYTES_PER_PROJECT" "${PROJECT_FILE_MAX_BYTES_PER_PROJECT:-5368709120}"
    ensure_env_value "$ENV_FILE" "PROJECT_FILE_MAX_BYTES_PER_USER" "${PROJECT_FILE_MAX_BYTES_PER_USER:-21474836480}"
    ensure_env_value "$ENV_FILE" "AUTH_SESSION_SECRET" "cybernaut-session-$(openssl rand -hex 32 2>/dev/null || echo change-me)"
    ensure_env_value "$ENV_FILE" "AUTH_SESSION_PREVIOUS_SECRETS" ""
    ensure_env_value "$ENV_FILE" "AUTH_SESSION_KEY_ROTATION_STARTED_AT" ""
    ensure_env_value "$ENV_FILE" "AUTH_SESSION_MAX_ACTIVE" "${AUTH_SESSION_MAX_ACTIVE:-5}"
    ensure_env_value "$ENV_FILE" "AUTH_SESSION_TTL_MINUTES" "${AUTH_SESSION_TTL_MINUTES:-1440}"
    ensure_env_value "$ENV_FILE" "AUTH_SESSION_REMEMBER_TTL_DAYS" "${AUTH_SESSION_REMEMBER_TTL_DAYS:-30}"
    ensure_env_value "$ENV_FILE" "AUTH_SESSION_RENEW_WINDOW_PERCENT" "${AUTH_SESSION_RENEW_WINDOW_PERCENT:-25}"
    ensure_env_value "$ENV_FILE" "AUTH_PASSWORD_BCRYPT_ROUNDS" "${AUTH_PASSWORD_BCRYPT_ROUNDS:-12}"
    ensure_env_value "$ENV_FILE" "AUTH_ALLOW_LEGACY_BEARER" "false"
    set_env_value "$ENV_FILE" "AUTH_COOKIE_SECURE" "true"
    ensure_env_value "$ENV_FILE" "AUTH_COOKIE_SAME_SITE" "lax"
    ensure_env_value "$ENV_FILE" "AUTH_COOKIE_DOMAIN" ""
    set_env_value "$ENV_FILE" "AUTH_ALLOWED_ORIGINS" "$PUBLIC_ORIGIN"

    # 模型选择允许运维在 .env 中覆盖；缺失时补当前源码默认值。
    ensure_env_value "$ENV_FILE" "LLM_BASE_URL" "${LLM_BASE_URL:-https://skill.zeelin.cn/api/v9}"
    ensure_env_value "$ENV_FILE" "LLM_MODEL" "${LLM_MODEL:-gpt-5.6-sol}"
    ensure_env_value "$ENV_FILE" "OPENAI_BASE_URL" "${OPENAI_BASE_URL:-https://skill.zeelin.cn/api/v9}"
    ensure_env_value "$ENV_FILE" "MODEL_CREDENTIAL_ENCRYPTION_KEY" "$(openssl rand -hex 32 2>/dev/null || true)"
    ensure_env_value "$ENV_FILE" "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY" "$(openssl rand -hex 32 2>/dev/null || true)"
    ensure_env_value "$ENV_FILE" "MODEL_PROVIDER_ALLOWED_HOSTS" "${MODEL_PROVIDER_ALLOWED_HOSTS:-skill.zeelin.cn}"
    set_env_value "$ENV_FILE" "MODEL_PROVIDER_ALLOW_HTTP" "false"
    ensure_env_value "$ENV_FILE" "AI_CAPABILITIES_ENABLED" "true"
    ensure_env_value "$ENV_FILE" "IM_INTEGRATIONS_ENABLED" "true"
    ensure_env_value "$ENV_FILE" "IM_WEBHOOK_ALLOWED_HOSTS" "${IM_WEBHOOK_ALLOWED_HOSTS:-}"
    ensure_env_value "$ENV_FILE" "IM_OUTBOX_ENABLED" "true"
    ensure_env_value "$ENV_FILE" "IM_OUTBOX_INTERVAL_SECONDS" "${IM_OUTBOX_INTERVAL_SECONDS:-15}"
    ensure_env_value "$ENV_FILE" "IM_OUTBOX_BATCH_SIZE" "${IM_OUTBOX_BATCH_SIZE:-10}"
    ensure_env_value "$ENV_FILE" "OPS_CREDENTIAL_CHANGES_15M_WARN" "${OPS_CREDENTIAL_CHANGES_15M_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_AUTH_PREVIOUS_KEY_MATCHES_24H_WARN" "${OPS_AUTH_PREVIOUS_KEY_MATCHES_24H_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_HIGH_RISK_TOOL_DENIED_15M_WARN" "${OPS_HIGH_RISK_TOOL_DENIED_15M_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_LEAD_REVIEW_PENDING_WARN" "${OPS_LEAD_REVIEW_PENDING_WARN:-20}"
    ensure_env_value "$ENV_FILE" "OPS_LEAD_REVIEW_OLDEST_AGE_MS_WARN" "${OPS_LEAD_REVIEW_OLDEST_AGE_MS_WARN:-86400000}"
    ensure_env_value "$ENV_FILE" "OPS_LEAD_ENTITY_DUPLICATE_GROUPS_WARN" "${OPS_LEAD_ENTITY_DUPLICATE_GROUPS_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_MYSQL_ROW_LOCK_CURRENT_WAITS_WARN" "${OPS_MYSQL_ROW_LOCK_CURRENT_WAITS_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_MYSQL_REPLICATION_LAG_SECONDS_WARN" "${OPS_MYSQL_REPLICATION_LAG_SECONDS_WARN:-300}"
    ensure_env_value "$ENV_FILE" "OPS_FILE_DISK_FREE_BYTES_WARN" "${OPS_FILE_DISK_FREE_BYTES_WARN:-5368709120}"
    ensure_env_value "$ENV_FILE" "OPS_FILE_DISK_USED_RATIO_WARN" "${OPS_FILE_DISK_USED_RATIO_WARN:-0.9}"
    ensure_env_value "$ENV_FILE" "OPS_FILE_DISK_USED_RATIO_GROWTH_24H_WARN" "${OPS_FILE_DISK_USED_RATIO_GROWTH_24H_WARN:-0.05}"
    ensure_env_value "$ENV_FILE" "OPS_AI_FIRST_TOKEN_MIN_REQUESTS" "${OPS_AI_FIRST_TOKEN_MIN_REQUESTS:-5}"
    ensure_env_value "$ENV_FILE" "OPS_AI_FIRST_TOKEN_P95_MS_WARN" "${OPS_AI_FIRST_TOKEN_P95_MS_WARN:-5000}"
    ensure_env_value "$ENV_FILE" "OPS_AI_FIRST_TOKEN_OBSERVATION_COVERAGE_WARN" "${OPS_AI_FIRST_TOKEN_OBSERVATION_COVERAGE_WARN:-0.8}"
    ensure_env_value "$ENV_FILE" "OPS_FILE_CAPACITY_SNAPSHOT_INTERVAL_SECONDS" "${OPS_FILE_CAPACITY_SNAPSHOT_INTERVAL_SECONDS:-3600}"
    ensure_env_value "$ENV_FILE" "OPS_DOCUMENT_RENDER_FAILURES_WARN" "${OPS_DOCUMENT_RENDER_FAILURES_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_DOCUMENT_QUALITY_FAILURES_WARN" "${OPS_DOCUMENT_QUALITY_FAILURES_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_DOCUMENT_FONT_FAILURES_WARN" "${OPS_DOCUMENT_FONT_FAILURES_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_JOB_FAILURES_24H_WARN" "${OPS_JOB_FAILURES_24H_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_JOB_DEAD_LETTERS_24H_WARN" "${OPS_JOB_DEAD_LETTERS_24H_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_JOB_RETRIED_RECORDS_24H_WARN" "${OPS_JOB_RETRIED_RECORDS_24H_WARN:-5}"
    ensure_env_value "$ENV_FILE" "OPS_JOB_TIMEOUT_FAILURES_24H_WARN" "${OPS_JOB_TIMEOUT_FAILURES_24H_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_JOB_LEASE_RECOVERIES_24H_WARN" "${OPS_JOB_LEASE_RECOVERIES_24H_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_JOB_EXPIRED_LEASES_WARN" "${OPS_JOB_EXPIRED_LEASES_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_JOB_LEASE_CONTENTIONS_24H_WARN" "${OPS_JOB_LEASE_CONTENTIONS_24H_WARN:-10}"
    ensure_env_value "$ENV_FILE" "OPS_JOB_DUPLICATE_SUPPRESSED_24H_WARN" "${OPS_JOB_DUPLICATE_SUPPRESSED_24H_WARN:-20}"
    ensure_env_value "$ENV_FILE" "OPS_JOB_STALE_COMPLETIONS_24H_WARN" "${OPS_JOB_STALE_COMPLETIONS_24H_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_SUPERVISED_PROCESS_FAILURES_24H_WARN" "${OPS_SUPERVISED_PROCESS_FAILURES_24H_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_SUPERVISED_PROCESS_TIMEOUTS_24H_WARN" "${OPS_SUPERVISED_PROCESS_TIMEOUTS_24H_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_SUPERVISED_PROCESS_FORCE_KILLS_24H_WARN" "${OPS_SUPERVISED_PROCESS_FORCE_KILLS_24H_WARN:-1}"
    ensure_env_value "$ENV_FILE" "OPS_ALERT_REMINDER_MINUTES" "${OPS_ALERT_REMINDER_MINUTES:-60}"
    ensure_env_value "$ENV_FILE" "JW_AGENT_MODEL" "${JW_AGENT_MODEL:-gpt-5.6-sol}"
    ensure_env_value "$ENV_FILE" "JW_GLOBAL_NEW_CONVERSATIONS_ENABLED" "${JW_GLOBAL_NEW_CONVERSATIONS_ENABLED:-true}"
    ensure_env_value "$ENV_FILE" "JW_PROJECT_NEW_CONVERSATIONS_ENABLED" "${JW_PROJECT_NEW_CONVERSATIONS_ENABLED:-true}"
    set_env_value "$ENV_FILE" "JW_AGENT_PERMISSION_MODE" "dontAsk"
    ensure_env_value "$ENV_FILE" "JW_AGENT_MAX_TURNS" "12"
    ensure_env_value "$ENV_FILE" "JW_AGENT_MAX_BUDGET_USD" "5"
    ensure_env_value "$ENV_FILE" "JW_AGENT_INTERACTION_TIMEOUT_MS" "900000"
    ensure_env_value "$ENV_FILE" "SOCKET_AUTH_REVALIDATE_MS" "60000"
    ensure_env_value "$ENV_FILE" "SOCKET_RECONNECT_WINDOW_MS" "300000"
    ensure_env_value "$ENV_FILE" "SOCKET_DB_CONCURRENCY" "8"
    ensure_env_value "$ENV_FILE" "LEAD_SUBJECT_AGENT_MAX_TURNS" "2"
    ensure_env_value "$ENV_FILE" "LEAD_SUBJECT_AGENT_MAX_BUDGET_USD" "0.25"
    ensure_env_value "$ENV_FILE" "LEAD_SCORING_AGENT_MAX_TURNS" "2"
    ensure_env_value "$ENV_FILE" "LEAD_SCORING_AGENT_MAX_BUDGET_USD" "0.75"
    ensure_env_value "$ENV_FILE" "LEAD_WORKFLOW_AGENT_MAX_TURNS" "2"
    ensure_env_value "$ENV_FILE" "LEAD_WORKFLOW_AGENT_MAX_BUDGET_USD" "0.50"
    ensure_env_value "$ENV_FILE" "LEAD_WORKFLOW_AGENT_TIMEOUT_MS" "180000"
    ensure_env_value "$ENV_FILE" "LEAD_AGENT_GLOBAL_MAX_CONCURRENCY" "16"
    ensure_env_value "$ENV_FILE" "LEAD_AGENT_GLOBAL_MAX_REQUESTS_PER_MINUTE" "60"
    ensure_env_value "$ENV_FILE" "LEAD_AGENT_GLOBAL_DAILY_BUDGET_USD" "100"
    ensure_env_value "$ENV_FILE" "LEAD_AGENT_GLOBAL_RESERVATION_USD" "0.75"
    ensure_env_value "$ENV_FILE" "LEAD_AGENT_CIRCUIT_FAILURE_THRESHOLD" "5"
    ensure_env_value "$ENV_FILE" "LEAD_AGENT_CIRCUIT_OPEN_MS" "300000"
    ensure_env_value "$ENV_FILE" "LEAD_AGENT_PERMIT_TTL_MS" "600000"
    ensure_env_value "$ENV_FILE" "LEAD_AGENT_PERMIT_RETENTION_DAYS" "30"
    ensure_env_value "$ENV_FILE" "SCORE_MODEL" "${SCORE_MODEL:-gpt-5.6-sol}"
    ensure_env_value "$ENV_FILE" "SCORE_FALLBACK_MODEL" "${SCORE_FALLBACK_MODEL:-gpt-5.6-sol}"
    ensure_env_value "$ENV_FILE" "SCORE_PRIMARY_MODEL_TIMEOUT_MS" "90000"
    ensure_env_value "$ENV_FILE" "SCORE_FALLBACK_MODEL_TIMEOUT_MS" "240000"
    ensure_env_value "$ENV_FILE" "SCORE_MAX_ATTEMPTS" "3"
    ensure_env_value "$ENV_FILE" "SCORE_REQUEST_TIMEOUT_MS" "360000"
    ensure_env_value "$ENV_FILE" "SCORE_DEFERRED_RETRY_LIMIT" "0"
    ensure_env_value "$ENV_FILE" "SCORE_RECOVERY_ENABLED" "true"
    ensure_env_value "$ENV_FILE" "SCORE_RECOVERY_INTERVAL_SECONDS" "900"
    ensure_env_value "$ENV_FILE" "SCORE_RECOVERY_BATCH_SIZE" "500"
    ensure_env_value "$ENV_FILE" "RADAR_WECHAT_DAILY_ENABLED" "true"
    ensure_env_value "$ENV_FILE" "RADAR_SYNC_ENABLED" "true"
    ensure_env_value "$ENV_FILE" "RADAR_SYNC_INTERVAL_MS" "1800000"
    ensure_env_value "$ENV_FILE" "RADAR_SYNC_START_DELAY_MS" "120000"
    ensure_env_value "$ENV_FILE" "RADAR_PAPER_CRAWL_ENABLED" "true"
    ensure_env_value "$ENV_FILE" "RADAR_PAPER_DAILY_HOUR" "7"
    ensure_env_value "$ENV_FILE" "RADAR_PAPER_DAILY_MINUTE" "30"
    ensure_env_value "$ENV_FILE" "RADAR_NOTIFICATION_CHANNEL_ID" ""
    ensure_env_value "$ENV_FILE" "RADAR_NOTIFY_SUCCESS" "true"
    ensure_env_value "$ENV_FILE" "RADAR_WECHAT_MAX_WORKERS" "4"
    ensure_env_value "$ENV_FILE" "RADAR_WECHAT_REQUEST_ATTEMPTS" "3"
    ensure_env_value "$ENV_FILE" "RADAR_WECHAT_RETRY_BASE_SECONDS" "1"
    ensure_env_value "$ENV_FILE" "RADAR_WECHAT_RETRY_INTERVAL_SECONDS" "1800"
    ensure_env_value "$ENV_FILE" "RADAR_WECHAT_RETRY_BATCH_SIZE" "100"
    ensure_env_value "$ENV_FILE" "RADAR_WECHAT_INSTITUTION_INTERVAL_SECONDS" "7200"
    ensure_env_value "$ENV_FILE" "RADAR_SYNC_PAGE_SIZE" "50"
    ensure_env_value "$ENV_FILE" "RADAR_SYNC_INCREMENTAL_PAGES" "4"
    ensure_env_value "$ENV_FILE" "RADAR_SYNC_BACKFILL_PAGES" "1"
    ensure_env_value "$ENV_FILE" "RUNTIME_JOB_POLL_MS" "5000"
    ensure_env_value "$ENV_FILE" "RUNTIME_JOB_LEASE_SECONDS" "900"
    ensure_env_value "$ENV_FILE" "RUNTIME_JOB_MAX_RETRIES" "3"
    ensure_env_value "$ENV_FILE" "RUNTIME_JOB_CONCURRENCY" "1"
    ensure_env_value "$ENV_FILE" "SCORE_JOB_POLL_MS" "1000"
    ensure_env_value "$ENV_FILE" "SCORE_JOB_LEASE_SECONDS" "900"
    ensure_env_value "$ENV_FILE" "PROJECT_SCORE_QUEUE_CONCURRENCY" "1"
    ensure_env_value "$ENV_FILE" "PROJECT_SCORE_JOB_POLL_MS" "1000"
    ensure_env_value "$ENV_FILE" "PROJECT_SCORE_JOB_LEASE_SECONDS" "900"
    ensure_env_value "$ENV_FILE" "PROJECT_SCORE_MAX_ATTEMPTS" "3"
    ensure_env_value "$ENV_FILE" "PROJECT_SCORE_RETRY_BASE_MS" "60000"
    ensure_env_value "$ENV_FILE" "AI_TASK_LEASE_SECONDS" "900"
    ensure_env_value "$ENV_FILE" "DAILY_INTAKE_ENABLED" "true"
    ensure_env_value "$ENV_FILE" "DAILY_INTAKE" "50"
    ensure_env_value "$ENV_FILE" "DAILY_INTAKE_HOUR" "9"
    ensure_env_value "$ENV_FILE" "DAILY_INTAKE_MINUTE" "0"
    ensure_env_value "$ENV_FILE" "GSDATA_APP_KEY" ""
    ensure_env_value "$ENV_FILE" "GSDATA_APP_SECRET" ""
    chmod 600 "$ENV_FILE"
    log "进程内 JW Runtime 与本地情报雷达环境变量已对齐 ✓"
}

#---------------------------------------
# 同步 Agent / 业务任务使用的 Skills 到持久化工作区
#---------------------------------------
sync_agent_skills() {
    step "暂存 Agent Skills"

    local skills_parent="${FLUE_STATE_DIR}/workspace/.agents"
    local skills_root="${skills_parent}/skills.next"
    local source_root source_dir target_dir required_skill

    # 只清理暂存目录，不触碰运行中服务正在读取的 skills。
    # 新目录完成复制和校验后，才会在停机窗口内原子切换。
    install -d -m 0750 "$skills_parent"
    if [ -d "$skills_root" ]; then
        rm -rf "${skills_root:?}"
    fi
    install -d -m 0750 "$skills_root"

    for source_root in \
        "${DEPLOY_DIR}/server/workspace/.agents/skills" \
        "${DEPLOY_DIR}/server/workspace/.agents/skills/GordenSuperPPTSkills" \
        "${DEPLOY_DIR}/project-discovery/GordenSuperPPTSkills" \
        "${DEPLOY_DIR}/project-discovery/skills-financial-research-analyst-main"
    do
        if [ ! -d "$source_root" ]; then
            warn "Skill 来源目录不存在，跳过: $source_root"
            continue
        fi
        while IFS= read -r -d '' source_dir; do
            target_dir="${skills_root}/$(basename "$source_dir")"
            install -d -m 0750 "$target_dir"
            # 用 -n 禁止覆盖：先复制的源（server/workspace 的完整版）优先保留，
            # 避免 project-discovery 中同一 Skill 的残缺副本把完整版覆盖掉。
            cp -an "${source_dir}/." "${target_dir}/"
        done < <(
            find "$source_root" -mindepth 1 -maxdepth 1 -type d \
                -exec test -f '{}/SKILL.md' ';' -print0
        )
    done

    for required_skill in \
        generate-project-qa-report \
        draft-investment-proposal \
        write-investment-dd-report
    do
        if [ ! -f "${skills_root}/${required_skill}/SKILL.md" ]; then
            err "核心业务 Skill 同步失败: ${required_skill}"
            exit 1
        fi
    done
    for required_skill in \
        create-reference-driven-editable-ppt \
        GordenSuperPPTSkill \
        pdf-to-editable-ppt
    do
        if [ ! -f "${skills_root}/${required_skill}/SKILL.md" ]; then
            err "投资建议书 PPT Skill 同步失败: ${required_skill}"
            exit 1
        fi
    done
    for required_gorden_runtime in \
        GordenSuperPPTSkill/scripts/ingest_reference_template.py \
        GordenImagePPTGen/scripts/generate_gateway_slide_image.py \
        GordenImagePPTGen/scripts/compose_pptx.py \
        GordenImage2PPTX/scripts/chroma_key.py \
        GordenImage2PPTX/scripts/slice_grid.py \
        GordenImage2PPTX/scripts/layout_guard.py \
        GordenImage2PPTX/scripts/placement_qa.py \
        GordenImage2PPTX/scripts/visual_compare_qa.py \
        GordenImage2PPTX/scripts/compose_pptx.py
    do
        if [ ! -f "${skills_root}/${required_gorden_runtime}" ]; then
            err "Gorden PPT 运行文件同步失败: ${required_gorden_runtime}"
            exit 1
        fi
    done
    touch "${skills_root}/.deploy-ready"
    log "Agent Skills 已暂存并校验: ${skills_root} ✓"
}

#---------------------------------------
# 在 API/Agent Runtime 停止后原子启用已校验的 Skills
#---------------------------------------
activate_agent_skills() {
    local skills_parent="${FLUE_STATE_DIR}/workspace/.agents"
    local live_root="${skills_parent}/skills"
    local staged_root="${skills_parent}/skills.next"
    local previous_root="${skills_parent}/skills.previous"

    if [ ! -f "${staged_root}/.deploy-ready" ]; then
        err "Agent Skills 暂存目录不存在或未通过校验: ${staged_root}"
        exit 1
    fi

    if [ -d "$previous_root" ]; then
        rm -rf "${previous_root:?}"
    fi
    if [ -d "$live_root" ]; then
        mv "$live_root" "$previous_root"
    fi
    mv "$staged_root" "$live_root"
    rm -f "${live_root}/.deploy-ready"
    log "Agent Skills 已原子切换到 ${live_root} ✓"
}

finalize_agent_skills() {
    local previous_root="${FLUE_STATE_DIR}/workspace/.agents/skills.previous"
    if [ -d "$previous_root" ]; then
        rm -rf "${previous_root:?}"
    fi
}

rollback_agent_skills() {
    local skills_parent="${FLUE_STATE_DIR}/workspace/.agents"
    local live_root="${skills_parent}/skills"
    local previous_root="${skills_parent}/skills.previous"
    local failed_root="${skills_parent}/skills.failed.$(date -u +%Y%m%dT%H%M%SZ)"
    if [ ! -d "$previous_root" ]; then
        warn "没有上一版 Agent Skills 可回退"
        return 0
    fi
    if [ -d "$live_root" ]; then
        mv "$live_root" "$failed_root"
    fi
    mv "$previous_root" "$live_root"
    warn "已恢复上一版 Agent Skills；失败版本保留在 ${failed_root}"
}

#---------------------------------------
# 安装并验证 PDF → 可编辑 PPTX 的公开生产运行时
#---------------------------------------
setup_pdf_ppt_runtime() {
    step "配置 PDF 转 PPT 公开生产运行时"

    local env_file="${DEPLOY_DIR}/.env"
    local needs_packages=false
    local libreoffice_bin=""
    local python_ca_file=""

    command -v pdftoppm &>/dev/null || needs_packages=true
    command -v pdffonts &>/dev/null || needs_packages=true
    command -v tesseract &>/dev/null || needs_packages=true
    if command -v tesseract &>/dev/null; then
        tesseract --list-langs 2>/dev/null | grep -qx "chi_sim" || needs_packages=true
        tesseract --list-langs 2>/dev/null | grep -qx "eng" || needs_packages=true
    fi
    libreoffice_bin=$(command -v libreoffice 2>/dev/null || command -v soffice 2>/dev/null || true)
    [ -n "$libreoffice_bin" ] || needs_packages=true
    if ! command -v fc-match &>/dev/null || ! fc-match "Noto Sans CJK SC" 2>/dev/null | grep -qi "Noto.*CJK"; then
        needs_packages=true
    fi
    if ! python3 -m venv --help &>/dev/null; then
        needs_packages=true
    fi
    for candidate in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt; do
        if [ -f "$candidate" ] && [ -r "$candidate" ]; then
            python_ca_file="$candidate"
            break
        fi
    done
    [ -n "$python_ca_file" ] || needs_packages=true

    if [ "$needs_packages" = true ]; then
        if ! command -v apt-get &>/dev/null; then
            err "当前系统缺少 PDF/PPT 运行依赖，且未找到 apt-get"
            err "请安装 python3-venv、poppler-utils、tesseract-ocr、tesseract-ocr-chi-sim、libreoffice、fontconfig、fonts-noto-cjk"
            exit 1
        fi
        log "安装 Poppler、Tesseract 中文 OCR、LibreOffice 和 CJK 字体..."
        apt-get update
        env DEBIAN_FRONTEND=noninteractive apt-get install -y \
            python3-venv \
            ca-certificates \
            poppler-utils \
            tesseract-ocr \
            tesseract-ocr-chi-sim \
            libreoffice \
            fontconfig \
            fonts-noto-cjk
        fc-cache -f
    fi

    log "创建项目 Python 运行时并执行生成/渲染冒烟测试..."
    "$NODE_BIN" "${DEPLOY_DIR}/server/scripts/setup-pdf-to-ppt-runtime.mjs"
    "$NPM_BIN" run verify:document-runtime-dependencies

    libreoffice_bin=$(command -v libreoffice 2>/dev/null || command -v soffice 2>/dev/null || true)
    python_ca_file=""
    for candidate in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt; do
        if [ -f "$candidate" ] && [ -r "$candidate" ]; then
            python_ca_file="$candidate"
            break
        fi
    done
    if [ -z "$python_ca_file" ]; then
        err "未找到可读的系统 CA 文件；不能为 Python 图片/PDF 子进程关闭 TLS 验证"
        exit 1
    fi
    set_env_value "$env_file" "AI_PDF_TO_PPT_PYTHON" "${DEPLOY_DIR}/server/.venv/bin/python3"
    set_env_value "$env_file" "AI_PDF_TO_PPT_PDFTOPPM" "$(command -v pdftoppm)"
    set_env_value "$env_file" "AI_PDF_TO_PPT_TESSERACT" "$(command -v tesseract)"
    set_env_value "$env_file" "AI_PDF_TO_PPT_LIBREOFFICE" "$libreoffice_bin"
    set_env_value "$env_file" "AI_QA_SOFFICE_BINARY" "$libreoffice_bin"
    set_env_value "$env_file" "AI_QA_PDFTOPPM_BINARY" "$(command -v pdftoppm)"
    set_env_value "$env_file" "AI_QA_PDFFONTS_BINARY" "$(command -v pdffonts)"
    set_env_value "$env_file" "AI_PYTHON_CA_FILE" "$python_ca_file"
    chmod 600 "$env_file"
    log "PDF 转 PPT 公开生产运行时已通过端到端检查 ✓"
}

#---------------------------------------
# 从历史独立部署目录迁移会话数据库和工作区（仅在新状态不存在时复制）
#---------------------------------------
migrate_legacy_agent_state() {
    step "迁移历史 Agent 状态"

    local marker="${FLUE_STATE_DIR}/.legacy-migrated"
    local candidate copied_workspace=false
    install -d -m 0750 "$FLUE_STATE_DIR" "${FLUE_STATE_DIR}/workspace"
    if [ -f "$marker" ]; then
        log "历史 Agent 状态已完成迁移，跳过"
        return
    fi

    if [ ! -f "${FLUE_STATE_DIR}/flue.db" ]; then
        for candidate in \
            "/data/cybernaut-assistant/data/flue.db" \
            "/www/flue-cybernaut/data/flue.db"
        do
            if [ -f "$candidate" ]; then
                # 停止旧进程后复制，避免 SQLite WAL 尚未 checkpoint。
                systemctl stop "$APP_SERVICE" "$LEGACY_ASSISTANT_SERVICE" "$LEGACY_FLUE_SERVICE" 2>/dev/null || true
                cp -a "$candidate" "${FLUE_STATE_DIR}/flue.db"
                log "已迁移历史会话数据库: $candidate"
                break
            fi
        done
    fi

    for candidate in \
        "/data/cybernaut-assistant/workspace" \
        "/www/flue-cybernaut/workspace"
    do
        if [ -d "$candidate" ]; then
            # 不覆盖新版本已同步的 Skill，只补入历史上传文件和产物。
            cp -an "${candidate}/." "${FLUE_STATE_DIR}/workspace/"
            copied_workspace=true
            log "已合并历史 Agent 工作区: $candidate"
        fi
    done

    if [ ! -f "${FLUE_STATE_DIR}/flue.db" ] && [ "$copied_workspace" = false ]; then
        log "未发现需要迁移的历史 Agent 状态"
    fi
    touch "$marker"
}

#---------------------------------------
# 构建主项目（内含 JW Runtime 与 TypeScript Radar）
#---------------------------------------
build_project() {
    step "构建统一主项目"

    cd "$DEPLOY_DIR"

    log "按锁文件安装主项目依赖..."
    "$NPM_BIN" ci --include=dev

    setup_pdf_ppt_runtime

    log "安装并验证 Q&A 文档生成运行时..."
    "$NPM_BIN" run setup:qa-skill-runtime

    log "安装并验证尽调报告原生运行时..."
    "$NPM_BIN" run setup:dd-skill-runtime

    log "执行主项目与进程内 Runtime 类型检查..."
    "$NPM_BIN" run check

    log "编译主项目、前端和进程内 Runtime..."
    "$NPM_BIN" run build

    # 确保必要目录存在；Skill 在 start_services 的停机窗口内切换。
    install -d -m 0750 "$LOG_DIR" "$GENERATED_DIR" "${FLUE_STATE_DIR}/workspace" "${RADAR_STATE_DIR}/data"

    log "主项目、进程内 JW Runtime 和 TypeScript Radar 构建完成 ✓"
}

run_release_gates() {
    step "执行线索 Agent 生产发布门禁"

    log "执行迁移验收清单与未完成项快照一致性门禁..."
    "$NPM_BIN" run check:migration-checklist-status

    log "执行暂存构建、停机激活和失败回退文件事务门禁..."
    "$NPM_BIN" run accept:build-release

    log "执行生产源盘点参数、未知 dump、符号链接和批准输出边界门禁..."
    "$NPM_BIN" run accept:production-source-inventory

    log "执行 SQL 注入、路径穿越、越权和任意文件读取安全门禁..."
    "$NPM_BIN" run accept:security-boundary

    log "执行 MySQL 周期任务多实例单租约与过期接管门禁..."
    "$NPM_BIN" run accept:runtime-job-leader

    log "执行 MySQL 网络中断、重连与事务持久性门禁..."
    "$NPM_BIN" run accept:mysql-resilience

    log "执行 MySQL 字符集、时区、连接容量和慢查询配置门禁..."
    "$NPM_BIN" run accept:mysql-operational-config

    log "执行中文知识检索金标、隔离和稳定排序门禁..."
    "$NPM_BIN" run accept:chinese-retrieval

    log "执行知识分块原子替换、失败回滚和幂等唯一约束门禁..."
    "$NPM_BIN" run accept:knowledge-ingestion-atomicity

    log "执行项目文件临时残留 TTL、安全边界和幂等清理门禁..."
    "$NPM_BIN" run accept:project-file-temp-cleanup

    log "执行项目文件删除归属、共享资产和回滚源隔离门禁..."
    "$NPM_BIN" run accept:project-file-deletion-isolation

    log "执行 Agent 会话删除与 workspace 精确清理门禁..."
    "$NPM_BIN" run accept:agent-workspace-lifecycle

    log "执行 PDF、DOCX、PPTX、XLSX 和图片迁移样本真实打开门禁..."
    "$NPM_BIN" run accept:migration-file-samples

    log "执行迁移角色、隔离项目、文件、线索与故障模拟夹具就绪门禁..."
    "$NPM_BIN" run accept:migration-fixture-readiness

    log "执行迁移测试脚本、金标、身份和凭据安全门禁..."
    "$NPM_BIN" run accept:migration-test-data-safety

    log "执行 API/Agent 错误形状、脱敏和追踪编号门禁..."
    "$NPM_BIN" run accept:error-contract

    log "执行项目评分 MySQL 租约、重启恢复和并发门禁..."
    "$NPM_BIN" run accept:project-score-lifecycle

    log "执行模板分析进度 MySQL 持久化、隔离和重启门禁..."
    "$NPM_BIN" run accept:ai-template-progress

    log "执行前端业务状态 MySQL 权威源与跨用户清理门禁..."
    "$NPM_BIN" run accept:client-state-authority

    log "执行旧 API 保留路由、响应形状与不安全端点退场门禁..."
    "$NPM_BIN" run accept:legacy-api-compatibility

    log "执行退休 Assistant 旧共享密钥、旧数据库入口与启动失败关闭门禁..."
    "$NPM_BIN" run accept:retired-assistant-boundary

    log "执行 OA 审批 MySQL 状态机、权限、并发与刷新恢复门禁..."
    "$NPM_BIN" run accept:oa-workflow

    log "执行会议纪要、关联待办与审计原子持久化门禁..."
    "$NPM_BIN" run accept:meeting-persistence

    log "执行公共线索转专属项目原子持久化门禁..."
    "$NPM_BIN" run accept:lead-conversion

    log "执行风险字段契约、状态映射和审计事务门禁..."
    "$NPM_BIN" run accept:risk-persistence

    log "执行会话并发上限、续期和密钥轮换门禁..."
    "$NPM_BIN" run accept:auth-session-policy

    log "执行会话历史密钥命中、轮换窗口与脱敏运维告警门禁..."
    "$NPM_BIN" run accept:auth-session-key-telemetry
    log "验证 AI 首 Token、总耗时、错误、取消和不可观测覆盖率"
    "$NPM_BIN" run accept:ai-runtime-telemetry
    "$NPM_BIN" run accept:legacy-bearer-policy

    log "执行用户、角色、状态、会话失效与项目成员审计门禁..."
    "$NPM_BIN" run accept:identity-administration

    log "执行用户与权限 Repository 并发、事务回滚和原子写入门禁..."
    "$NPM_BIN" run accept:identity-repository

    log "执行唯一 MySQL 用户身份源、会话、Socket、项目授权和浏览器恢复门禁..."
    "$NPM_BIN" run accept:identity-authority

    log "执行 Agent 会话、消息、Part 并发序号、重放和原子中断门禁..."
    "$NPM_BIN" run accept:agent-conversation-repository

    log "执行 AI Task 租约、幂等、产物来源完成事务和恢复门禁..."
    "$NPM_BIN" run accept:ai-task-repository

    log "执行 AI Provider、模型路由、能力授权与会话选择 Repository 门禁..."
    "$NPM_BIN" run accept:ai-configuration-repository

    log "执行 IM Bot、绑定、Outbox 租约、投递与入站幂等 Repository 门禁..."
    "$NPM_BIN" run accept:im-integration-repository

    log "执行模型、能力与 IM 配置加密版本链、影响确认和精确回滚门禁..."
    "$NPM_BIN" run accept:admin-configuration-rollback

    log "执行 MySQL 领域命名、运行配置、调度审计与部分唯一约束架构门禁..."
    "$NPM_BIN" run accept:mysql-architecture-contract

    log "执行回滚观察窗全局写冻结与六域回滚阈值契约门禁..."
    "$NPM_BIN" run accept:migration-write-freeze
    "$NPM_BIN" run accept:migration-write-freeze-env
    "$NPM_BIN" run accept:cutover-rollback-thresholds

    log "执行 MySQL 迁移前备份、隔离前缀回退与版本化种子生命周期门禁..."
    "$NPM_BIN" run accept:mysql-schema-lifecycle

    log "执行线索名称/公司实体重复组运维指标门禁..."
    "$NPM_BIN" run accept:lead-duplicate-telemetry
    "$NPM_BIN" run accept:lead-dedup-safety
    "$NPM_BIN" run accept:lead-duplicate-dispositions
    "$NPM_BIN" run accept:lead-duplicate-apply
    "$NPM_BIN" run accept:source-gap-dispositions

    log "执行线索人工复核积压、吞吐与处理时长运维指标门禁..."
    "$NPM_BIN" run accept:lead-review-telemetry

    log "执行文件容量跨日历史、增长率告警与幂等快照门禁..."
    "$NPM_BIN" run accept:file-storage-capacity-history

    log "执行单服务 HTTP、Socket、MySQL、队列、IM、文件、安全与 CDC 运维指标门禁..."
    "$NPM_BIN" run accept:operations-telemetry

    log "执行 Runtime 最小权限 MySQL 慢查询、行锁、死锁与复制观测能力门禁..."
    "$NPM_BIN" run accept:mysql-server-telemetry

    log "执行受监督子进程退出原因、退出码、强杀和历史聚合门禁..."
    "$NPM_BIN" run accept:process-supervisor-telemetry

    log "执行 Radar/lead_reserve 来源键、游标、原始事件、正式映射和恢复边界门禁..."
    "$NPM_BIN" run accept:radar-lead-source-reconciliation

    log "执行任务租约争抢、重复抑制、过期恢复和旧结果拒绝持久事件门禁..."
    "$NPM_BIN" run accept:job-coordination-telemetry

    log "执行进程内运维告警 Outbox、去重、投递日志与恢复通知门禁..."
    "$NPM_BIN" run accept:operational-alert-delivery

    log "执行 MySQL Schema、外键孤儿和目标结构完整性门禁..."
    "$NPM_BIN" run check:migration-integrity

    log "执行迁移来源白名单与拒绝源、表、记录排除门禁..."
    "$NPM_BIN" run accept:migration-source-allowlist

    log "执行 JW SQLite 白名单迁移、拒绝源零写入与幂等门禁..."
    "$NPM_BIN" run accept:jw-sqlite-migration

    log "执行旧会话迁移顺序、文本、内容块、附件、工具和停止状态门禁..."
    "$NPM_BIN" run check:flue-migration
    "$NPM_BIN" run audit:conversation-migration-content

    log "执行 JW 全局/项目新会话独立准入与无 Flue 回退门禁..."
    "$NPM_BIN" run accept:jw-conversation-rollout

    log "执行 JW 模型、Token、成本与上下文压缩持久化恢复门禁..."
    "$NPM_BIN" run accept:jw-usage-compaction

    log "执行 JW 交互问题回答、取消、越权和重启恢复门禁..."
    "$NPM_BIN" run accept:jw-interaction

    log "执行 JW 外部模型主动提问、回答恢复和后续生成门禁..."
    "$NPM_BIN" run accept:jw-interaction-live

    log "执行 JW Markdown、链接与思考内容隔离渲染门禁..."
    "$NPM_BIN" run accept:jw-message-rendering

    log "执行 JW 工具调用进度、成功、失败与刷新恢复门禁..."
    "$NPM_BIN" run accept:jw-tool-lifecycle

    log "执行 JW 会话模型切换、历史保留和权限门禁..."
    "$NPM_BIN" run accept:jw-model-switch

    log "执行迁移 checksum、外键、状态机与跨表业务不变量门禁..."
    "$NPM_BIN" run accept:migration-business-invariants

    log "执行迁移报告、文件 manifest 与隔离报告敏感信息门禁..."
    "$NPM_BIN" run accept:migration-evidence-safety

    log "执行 MySQL JSON 合法性与源端坏 JSON 隔离门禁..."
    "$NPM_BIN" run accept:migration-json-safety

    log "执行旧实体 ID 到目标 ID 的完整映射门禁..."
    "$NPM_BIN" run accept:migration-entity-mappings

    log "执行历史评分来源标记与新评分 Agent 证据链门禁..."
    "$NPM_BIN" run accept:legacy-scoring

    log "执行 MySQL 北京时间存取、UTC API 输出与前端上海时间门禁..."
    "$NPM_BIN" run accept:timezone

    log "执行迁移枚举、布尔、UUID 与唯一约束转换门禁..."
    "$NPM_BIN" run accept:migration-scalar-constraints

    log "执行项目、线索和人工复核稳定排序分页门禁..."
    "$NPM_BIN" run accept:stable-pagination

    log "执行 JW Runtime 工具、网络、子进程、文件和数据库越界审计门禁..."
    "$NPM_BIN" run accept:jw-runtime-boundary

    log "执行模型配置加密、权限、路由与服务端连接测试门禁..."
    "$NPM_BIN" run accept:ai-model-settings
    "$NPM_BIN" run accept:ai-capabilities
    "$NPM_BIN" run accept:im-integrations
    "$NPM_BIN" run accept:extension-feature-flags

    log "执行 MySQL 全局并发、速率、预算和熔断门禁..."
    "$NPM_BIN" run accept:lead-agent-runtime-guard

    log "执行线索 Agent 顶层/按模型 Token 用量兼容门禁..."
    "$NPM_BIN" run accept:lead-agent-usage

    log "执行线索主体真实模型金标发布门禁..."
    "$NPM_BIN" run accept:lead-subject-gold

    log "执行线索项目/论文评分真实模型金标发布门禁..."
    "$NPM_BIN" run accept:lead-scoring-gold

    log "执行线索研究/初筛/补全真实模型金标发布门禁..."
    "$NPM_BIN" run accept:lead-workflow-gold
}

#---------------------------------------
# 接管可选的历史 Radar 文件（仅首次迁移兼容）
#---------------------------------------
prepare_radar_state() {
    step "接管历史情报雷达数据"

    local source_root
    install -d -m 0750 "${RADAR_STATE_DIR}/data"

    # 优先接管同机旧部署或人工随源码上传的数据，不覆盖已恢复的持久化状态。
    for source_root in \
        "${RADAR_DIR}" \
        "/project/zhitou/project-discovery" \
        "/www/project-discovery"
    do
        if [ "$source_root" = "$RADAR_STATE_DIR" ] || [ ! -d "$source_root" ]; then
            continue
        fi
        if [ -d "${source_root}/data" ]; then
            cp -an "${source_root}/data/." "${RADAR_STATE_DIR}/data/"
        fi
        if [ -f "${source_root}/公众号来源.xlsx" ] && [ ! -f "${RADAR_STATE_DIR}/公众号来源.xlsx" ]; then
            cp -a "${source_root}/公众号来源.xlsx" "${RADAR_STATE_DIR}/公众号来源.xlsx"
        fi
    done

    chown -R "${APP_RUN_USER}:${APP_RUN_GROUP}" "$RADAR_STATE_DIR"
    chmod 0750 "$RADAR_STATE_DIR" "${RADAR_STATE_DIR}/data"
    if [ -f "${RADAR_STATE_DIR}/data/gsdata_credentials.json" ]; then
        chmod 0600 "${RADAR_STATE_DIR}/data/gsdata_credentials.json"
    fi
    log "历史 Radar 文件接管目录就绪（运行态以 MySQL 为准）: ${RADAR_STATE_DIR} ✓"
}

#---------------------------------------
# 交互式写入 GSData 凭据，避免密钥出现在命令行和 Git
#---------------------------------------
configure_radar_credentials() {
    local env_file="${DEPLOY_DIR}/.env"
    local app_key app_secret
    if [ ! -f "$env_file" ]; then
        create_env
    fi
    ensure_runtime_user

    read -r -p "GSData app_key: " app_key
    read -r -s -p "GSData app_secret: " app_secret
    echo ""
    if [ -z "$app_key" ] || [ -z "$app_secret" ]; then
        err "app_key 和 app_secret 均不能为空"
        exit 1
    fi

    set_env_value "$env_file" "GSDATA_APP_KEY" "$app_key"
    set_env_value "$env_file" "GSDATA_APP_SECRET" "$app_secret"
    chown "${APP_RUN_USER}:${APP_RUN_GROUP}" "$env_file"
    chmod 600 "$env_file"
    unset app_key app_secret
    log "GSData 凭据已安全写入 ${env_file} ✓"

    if systemctl cat "$APP_SERVICE" &>/dev/null; then
        systemctl restart "$APP_SERVICE"
        wait_for_http "统一应用" "http://127.0.0.1:3100/api/health/components" 30
    fi
}

#---------------------------------------
# Nginx 配置
#---------------------------------------
setup_nginx() {
    step "配置 Nginx"

    if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
        err "DOMAIN 只能包含域名字符: ${DOMAIN}"
        exit 1
    fi
    if [[ ! "$PUBLIC_ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
        err "PUBLIC_ORIGIN 必须是无路径的 HTTPS Origin: ${PUBLIC_ORIGIN}"
        exit 1
    fi
    for tls_file in "$TLS_CERT_FILE" "$TLS_KEY_FILE"; do
        if [[ ! "$tls_file" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$tls_file" == *"/../"* ]] || [ ! -f "$tls_file" ]; then
            err "TLS 证书文件不存在或路径不安全: ${tls_file}"
            exit 1
        fi
    done

    local had_existing=false
    # 此文件由部署脚本完整管理；保留一份最近备份后覆盖，确保 update 能下发新反代。
    if [ -f "$NGINX_CONF" ]; then
        had_existing=true
        cp -a "$NGINX_CONF" "${NGINX_CONF}.bak"
    fi
    log "写入 Nginx 配置: $NGINX_CONF"
    cat > "$NGINX_CONF" <<'NGINX_EOF'
server {
    listen 80;
    server_name __DOMAIN__;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name __DOMAIN__;

    ssl_certificate __TLS_CERT_FILE__;
    ssl_certificate_key __TLS_KEY_FILE__;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:cybernaut_tls:10m;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # 访问日志
    access_log /var/log/nginx/cybernaut.access.log;
    error_log  /var/log/nginx/cybernaut.error.log;

    # 前端静态资源（Vite build 产物，带 hash 可长缓存）
    location /assets/ {
        root /www/sbl/dist;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # 前端入口（禁止缓存）
    location / {
        root /www/sbl/dist;
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }

    # 后端 API 反代
    location /api/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
        client_max_body_size 150m;
    }

    # JW Agent 实时事件，与 API 共用 3100 和同一 systemd 服务。
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

}
NGINX_EOF
    sed -i \
        -e "s|__DOMAIN__|${DOMAIN}|g" \
        -e "s|__TLS_CERT_FILE__|${TLS_CERT_FILE}|g" \
        -e "s|__TLS_KEY_FILE__|${TLS_KEY_FILE}|g" \
        "$NGINX_CONF"

    # 确保 nginx 主配置 include 了 conf.d
    if ! grep -q "include /etc/nginx/conf.d/\*.conf" /etc/nginx/nginx.conf 2>/dev/null; then
        warn "nginx.conf 未 include conf.d/*.conf，请手动确认"
    fi

    if ! nginx -t; then
        mv "$NGINX_CONF" "${NGINX_CONF}.failed"
        if [ "$had_existing" = true ]; then
            cp -a "${NGINX_CONF}.bak" "$NGINX_CONF"
            nginx -t || true
            warn "已恢复上一版 Nginx 配置"
        fi
        err "新 Nginx 配置校验失败，未重载"
        exit 1
    fi
    systemctl reload nginx
    log "Nginx 配置生效 ✓"
}

#---------------------------------------
# systemd 服务
#---------------------------------------
remove_legacy_project_cron() {
    local pattern='daily_intake|run_daily_intake|batch_analyze|run_batch_analyze|sync_radar|cybernaut-radar|project-discovery/job\.py'
    local current_file filtered_file cron_file cron_user seen_cron_users=""

    if command -v crontab >/dev/null 2>&1; then
        for cron_user in root "$APP_RUN_USER"; do
            case " ${seen_cron_users} " in *" ${cron_user} "*) continue ;; esac
            seen_cron_users="${seen_cron_users} ${cron_user}"
            current_file=$(mktemp)
            filtered_file=$(mktemp)
            crontab -u "$cron_user" -l > "$current_file" 2>/dev/null || true
            grep -Eiv "$pattern" "$current_file" > "$filtered_file" || true
            if ! cmp -s "$current_file" "$filtered_file"; then
                crontab -u "$cron_user" "$filtered_file"
                log "已删除 ${cron_user} crontab 中的旧项目摄入/同步任务 ✓"
            fi
            rm -f "$current_file" "$filtered_file"
        done
    fi

    for cron_file in /etc/crontab /etc/cron.d/*; do
        [ -f "$cron_file" ] || continue
        case "$cron_file" in *.pre-mysql-job.bak) continue ;; esac
        filtered_file=$(mktemp)
        grep -Eiv "$pattern" "$cron_file" > "$filtered_file" || true
        if ! cmp -s "$cron_file" "$filtered_file"; then
            cp -a "$cron_file" "${cron_file}.pre-mysql-job.bak"
            install -m 0644 "$filtered_file" "$cron_file"
            log "已删除 ${cron_file} 中的旧项目摄入/同步任务 ✓"
        fi
        rm -f "$filtered_file"
    done
}

retire_legacy_systemd_unit_files() {
    local backup_dir="" unit unit_file
    for unit in \
        "${LEGACY_API_SERVICE}.service" \
        "${LEGACY_ASSISTANT_SERVICE}.service" \
        "${LEGACY_FLUE_SERVICE}.service" \
        "${LEGACY_RADAR_SERVICE}.service" \
        "${LEGACY_RADAR_SYNC_SERVICE}.service" \
        "$LEGACY_RADAR_SYNC_TIMER"
    do
        unit_file="/etc/systemd/system/${unit}"
        if [ -e "$unit_file" ] || [ -L "$unit_file" ]; then
            if [ -z "$backup_dir" ]; then
                backup_dir="${APP_STATE_DIR}/migration-backups/systemd/$(date -u +%Y%m%dT%H%M%SZ)"
                install -d -m 0700 "$backup_dir"
            fi
            cp -a -- "$unit_file" "${backup_dir}/${unit}"
            rm -f -- "$unit_file"
            log "已备份并移除旧 systemd 单元文件: ${unit} ✓"
        fi
    done
}

setup_systemd() {
    step "配置 systemd 服务"

    local node_exec
    node_exec=$(command -v "$NODE_BIN")
    install -d -m 0750 "$LOG_DIR" "$GENERATED_DIR" "${FLUE_STATE_DIR}/workspace" "${RADAR_STATE_DIR}/data"

    # API 进程内包含 JW Runtime、MySQL 持久化调度器与 TypeScript Radar。
    local APP_SERVICE_FILE="/etc/systemd/system/${APP_SERVICE}.service"
    cat > "$APP_SERVICE_FILE" <<SERVICE_EOF
[Unit]
Description=Cybernaut Unified Application
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=${APP_RUN_USER}
Group=${APP_RUN_GROUP}
WorkingDirectory=${DEPLOY_DIR}
EnvironmentFile=${DEPLOY_DIR}/.env
Environment=NODE_ENV=production
Environment=HOME=${APP_STATE_DIR}
Environment=TMPDIR=/tmp
Environment=SINGLE_SERVICE_PRESTART_EVIDENCE_DIR=${APP_STATE_DIR}/prestart
ExecStartPre=${node_exec} ${DEPLOY_DIR}/server-dist/scripts/singleServicePrestart.js
ExecStart=${node_exec} ${DEPLOY_DIR}/server-dist/index.js
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=2 78
KillMode=control-group
TimeoutStopSec=90
MemoryMax=${APP_MEMORY_MAX}
CPUQuota=${APP_CPU_QUOTA}
TasksMax=${APP_TASKS_MAX}
LimitNOFILE=65536
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=${LOG_DIR} ${GENERATED_DIR} ${DEPLOY_DIR}/server/ai-artifacts ${DEPLOY_DIR}/server/project-files ${DEPLOY_DIR}/server/ai-template-data ${DEPLOY_DIR}/server/ai-template-skills ${DEPLOY_DIR}/server/agent-workspace ${APP_STATE_DIR} ${FLUE_STATE_DIR} ${RADAR_STATE_DIR}

StandardOutput=append:${LOG_DIR}/app.log
StandardError=append:${LOG_DIR}/app.log

[Install]
WantedBy=multi-user.target
SERVICE_EOF

    # 旧的 API/Assistant/Flue/Radar 单元必须停用，防止重复监听端口或重复执行 Radar 同步。
    systemctl disable --now "$LEGACY_API_SERVICE" "$LEGACY_ASSISTANT_SERVICE" "$LEGACY_FLUE_SERVICE" "$LEGACY_RADAR_SERVICE" 2>/dev/null || true
    systemctl disable --now "$LEGACY_RADAR_SYNC_TIMER" 2>/dev/null || true
    systemctl stop "$LEGACY_RADAR_SYNC_SERVICE" 2>/dev/null || true
    remove_legacy_project_cron
    retire_legacy_systemd_unit_files
    systemctl daemon-reload
    systemctl enable "$APP_SERVICE"
    log "统一 systemd 服务已注册: ${APP_SERVICE} ✓"
}

#---------------------------------------
# 启动 / 重启服务
#---------------------------------------
wait_for_http() {
    local name="$1" url="$2" attempts="${3:-30}" code="" i
    for ((i = 1; i <= attempts; i++)); do
        code=$(curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)
        if [ "$code" = "200" ]; then
            log "${name} 健康检查通过 ✓"
            return 0
        fi
        sleep 1
    done
    err "${name} 健康检查失败: ${url} (最后 HTTP ${code:-不可达})"
    return 1
}

wait_for_document_skill_bindings() {
    local url="http://127.0.0.1:3100/api/health"
    local expected="generate-project-qa-report,draft-investment-proposal,write-investment-dd-report"
    local response_file document_skills i
    response_file=$(mktemp)
    for ((i = 1; i <= 30; i++)); do
        if curl -fsS "$url" -o "$response_file" 2>/dev/null; then
            document_skills=$("$NODE_BIN" -e '
              const fs = require("node:fs");
              try {
                const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
                process.stdout.write(Array.isArray(body.documentSkillNames) ? body.documentSkillNames.join(",") : "");
              } catch {}
            ' "$response_file")
            if [ "$document_skills" = "$expected" ]; then
                rm -f "$response_file"
                log "投资文档 Skill 绑定检查通过: ${expected} ✓"
                return 0
            fi
        fi
        sleep 1
    done
    rm -f "$response_file"
    err "API 未加载完整投资文档 Skill: 期望 ${expected}，实际 ${document_skills:-未返回}"
    return 1
}

stop_app_service_and_orphans() {
    local listener_pids="" pid="" cmdline="" remaining=""

    systemctl stop "$APP_SERVICE" "$LEGACY_API_SERVICE" "$LEGACY_ASSISTANT_SERVICE" "$LEGACY_FLUE_SERVICE" "$LEGACY_RADAR_SERVICE" 2>/dev/null || true
    systemctl stop "$LEGACY_RADAR_SYNC_TIMER" "$LEGACY_RADAR_SYNC_SERVICE" 2>/dev/null || true
    listener_pids=$(ss -ltnp 2>/dev/null \
        | awk '/127\.0\.0\.1:(3100|3584|8121)/ { while (match($0, /pid=[0-9]+/)) { print substr($0, RSTART + 4, RLENGTH - 4); $0 = substr($0, RSTART + RLENGTH) } }' \
        | sort -u)
    for pid in $listener_pids; do
        [ -r "/proc/${pid}/cmdline" ] || continue
        cmdline=$(tr '\0' ' ' < "/proc/${pid}/cmdline")
        if [[ "$cmdline" != *"${DEPLOY_DIR}/server-dist/supervisor.js"* \
            && "$cmdline" != *"${DEPLOY_DIR}/server-dist/index.js"* \
            && "$cmdline" != *"/cybernaut-assistant/dist/server/server.mjs"* \
            && "$cmdline" != *"-m uvicorn app:app --host 127.0.0.1 --port 8121"* ]]; then
            err "应用内部端口被非发布进程占用，拒绝自动终止: pid=${pid} cmd=${cmdline}"
            exit 1
        fi
        log "终止脱离统一 systemd 单元的旧进程: pid=${pid}"
        kill -TERM "$pid" 2>/dev/null || true
    done

    for _ in {1..20}; do
        remaining=$(ss -ltnp 2>/dev/null | grep -E '127\.0\.0\.1:(3100|3584|8121)' || true)
        [ -z "$remaining" ] && return 0
        sleep 0.5
    done
    err "旧进程未在超时内释放应用内部端口"
    echo "$remaining"
    exit 1
}

start_services() {
    step "启动服务"

    local build_activated=false
    ensure_runtime_user
    prepare_runtime_permissions

    # restart 也必须从当前发布目录重新暂存 Skill；旧进程停止后再切换，
    # 避免出现“旧 API + 已删除旧 Skill”的混合版本窗口。
    sync_agent_skills
    log "停止统一应用及历史服务，准备切换发布版本..."
    stop_app_service_and_orphans
    activate_agent_skills
    if [ -f "${DEPLOY_DIR}/.runtime/build-candidate.json" ]; then
        log "激活已校验的前后端候选构建..."
        if ! "$NPM_BIN" run activate:build; then
            rollback_agent_skills
            err "候选构建激活失败，已恢复上一版 Agent Skills；服务保持停止以便检查"
            exit 1
        fi
        build_activated=true
    fi
    # Skill 切换由 root 完成，启动前重新收敛为非特权运行账号所有。
    prepare_runtime_permissions

    log "执行不启动进程、不写库的单服务离线启动前门禁..."
    if ! NODE_ENV=production "$NPM_BIN" run check:single-service-prestart; then
        if [ "$build_activated" = true ]; then
            "$NPM_BIN" run rollback:build || true
        fi
        rollback_agent_skills
        prepare_runtime_permissions
        err "单服务离线启动前门禁失败；已尝试恢复上一版产物与 Skills，服务保持停止"
        exit 1
    fi

    log "启动统一应用服务..."
    systemctl restart "$APP_SERVICE"
    wait_for_http "统一应用" "http://127.0.0.1:3100/api/health/components" 60 || {
        journalctl -u "$APP_SERVICE" -n 100 --no-pager || true
        systemctl stop "$APP_SERVICE" 2>/dev/null || true
        if [ "$build_activated" = true ]; then
            if ! "$NPM_BIN" run rollback:build; then
                rollback_agent_skills
                err "构建产物自动回退失败；服务保持停止，必须人工恢复"
                exit 1
            fi
        fi
        rollback_agent_skills
        prepare_runtime_permissions
        systemctl restart "$APP_SERVICE" 2>/dev/null || true
        wait_for_http "上一版统一应用" "http://127.0.0.1:3100/api/health/components" 60 || true
        exit 1
    }
    wait_for_document_skill_bindings || {
        journalctl -u "$APP_SERVICE" -n 100 --no-pager || true
        systemctl stop "$APP_SERVICE" 2>/dev/null || true
        if [ "$build_activated" = true ]; then
            if ! "$NPM_BIN" run rollback:build; then
                rollback_agent_skills
                err "构建产物自动回退失败；服务保持停止，必须人工恢复"
                exit 1
            fi
        fi
        rollback_agent_skills
        prepare_runtime_permissions
        systemctl restart "$APP_SERVICE" 2>/dev/null || true
        wait_for_http "上一版统一应用" "http://127.0.0.1:3100/api/health/components" 60 || true
        exit 1
    }
    local app_main_pid app_cgroup listener_pid port legacy_unit
    app_main_pid=$(systemctl show "$APP_SERVICE" -p MainPID --value)
    app_cgroup=$(systemctl show "$APP_SERVICE" -p ControlGroup --value)
    if [ -z "$app_main_pid" ] || [ "$app_main_pid" = "0" ] || [ -z "$app_cgroup" ]; then
        err "统一应用 systemd 归属信息无效: main=${app_main_pid:-无} cgroup=${app_cgroup:-无}"
        exit 1
    fi
    for port in 3100; do
        listener_pid=$(ss -ltnp 2>/dev/null \
            | awk -v port=":${port}" 'index($0, port) && match($0, /pid=[0-9]+/) { print substr($0, RSTART + 4, RLENGTH - 4); exit }')
        if [ -z "$listener_pid" ] || ! grep -Fq "$app_cgroup" "/proc/${listener_pid}/cgroup"; then
            err "端口 ${port} 的监听进程不属于统一服务 cgroup: pid=${listener_pid:-无} cgroup=${app_cgroup}"
            exit 1
        fi
    done
    for port in 3584 8121; do
        listener_pid=$(ss -ltnp 2>/dev/null \
            | awk -v port=":${port}" 'index($0, port) && match($0, /pid=[0-9]+/) { print substr($0, RSTART + 4, RLENGTH - 4); exit }')
        if [ -n "$listener_pid" ]; then
            err "旧业务端口 ${port} 仍在监听: pid=${listener_pid}"
            exit 1
        fi
    done
    for legacy_unit in "$LEGACY_API_SERVICE" "$LEGACY_ASSISTANT_SERVICE" "$LEGACY_FLUE_SERVICE" "$LEGACY_RADAR_SERVICE" "$LEGACY_RADAR_SYNC_SERVICE" "$LEGACY_RADAR_SYNC_TIMER"; do
        if systemctl is-active --quiet "$legacy_unit" 2>/dev/null; then
            err "旧项目单元仍处于 active: ${legacy_unit}"
            exit 1
        fi
    done
    log "单服务归属检查通过: main=${app_main_pid} cgroup=${app_cgroup} ✓"
    finalize_agent_skills
    log "固化目标 Linux 单服务、cgroup、端口、timer/cron 与 TLS 脱敏证据..."
    "$NPM_BIN" run capture:target-single-service-evidence
}

run_post_start_release_gates() {
    step "执行启动后发布门禁"
    log "执行 Socket 多连接、多会话、广播与重连压力门禁..."
    "$NPM_BIN" run accept:socket
    log "执行 JW Runtime 无 SQLite/Flue 真实多轮对话门禁..."
    "$NPM_BIN" run accept:jw-multiturn-live
}

#---------------------------------------
# 状态
#---------------------------------------
show_status() {
    step "服务状态"

    echo "--- 统一应用服务 ---"
    systemctl status "$APP_SERVICE" --no-pager -l 2>/dev/null | head -8 || echo "服务未找到"

    echo ""
    echo "--- 端口监听 ---"
    ss -tlnp 2>/dev/null | grep -E "3100|3306|:80 " || echo "(无)"

    echo ""
    echo "--- 统一健康检查 ---"
    curl -s http://127.0.0.1:3100/api/health/components 2>/dev/null || echo "统一应用不可达"

    echo ""
    echo "--- 前端检查 ---"
    curl -s -o /dev/null -w "HTTP %{http_code}" "${PUBLIC_ORIGIN}/" 2>/dev/null || echo "域名不可达"

    echo ""
}

#---------------------------------------
# 日志
#---------------------------------------
show_logs() {
    echo "=== 统一应用日志 ==="
    if [ -f "${LOG_DIR}/app.log" ]; then
        tail -100 "${LOG_DIR}/app.log"
    else
        journalctl -u "$APP_SERVICE" -n 100 --no-pager
    fi
}

#---------------------------------------
# 首次部署（完整流程）
#---------------------------------------
do_init() {
    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║  Cybernaut 投资平台 - 首次部署          ║"
    echo "║  ${DOMAIN}                  ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""

    check_prereqs
    ensure_runtime_user
    create_env
    build_project
    init_database
    run_release_gates
    prepare_radar_state
    setup_nginx
    setup_systemd
    migrate_legacy_agent_state
    prepare_runtime_permissions
    start_services
    run_post_start_release_gates

    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║  ✅ 部署完成！                          ║"
    echo "║                                          ║"
    echo "║  访问地址: ${PUBLIC_ORIGIN}         ║"
    echo "║  管理命令:                               ║"
    echo "║    bash deploy.sh update   # 更新重启    ║"
    echo "║    bash deploy.sh restart  # 仅重启      ║"
    echo "║    bash deploy.sh status   # 查看状态    ║"
    echo "║    bash deploy.sh logs     # 查看日志    ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""
}

#---------------------------------------
# 快速更新（拉代码 → 构建 → 重启）
#---------------------------------------
do_update() {
    step "代码更新"

    check_prereqs
    ensure_runtime_user

    cd "$DEPLOY_DIR"

    # 保存当前 git hash
    local before; before=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

    log "拉取最新代码..."
    git pull origin main 2>/dev/null || git pull 2>/dev/null || {
        warn "git pull 失败，使用本地代码继续"
    }

    local after; after=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    if [ "$before" != "$after" ]; then
        log "代码已更新: ${before:0:8} → ${after:0:8}"
    else
        log "代码已是最新"
    fi

    create_env
    build_project
    init_database
    run_release_gates
    prepare_radar_state
    setup_systemd
    migrate_legacy_agent_state
    prepare_runtime_permissions
    setup_nginx   # 确保 nginx 配置最新
    start_services
    run_post_start_release_gates

    echo ""
    log "更新完成！访问 ${PUBLIC_ORIGIN}"
}

#---------------------------------------
# 仅重启
#---------------------------------------
do_restart() {
    check_prereqs
    start_services
}

#---------------------------------------
# 入口
#---------------------------------------
case "${1:-init}" in
    init)
        do_init
        ;;
    update)
        do_update
        ;;
    restart)
        do_restart
        ;;
    restart-all)
        do_restart
        ;;
    flue-restart)
        warn "Flue 已纳入统一应用；将重启 ${APP_SERVICE}"
        do_restart
        ;;
    radar-restart)
        warn "Radar 已纳入统一应用；将重启 ${APP_SERVICE}"
        do_restart
        ;;
    radar-configure)
        configure_radar_credentials
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    *)
        echo "用法: bash deploy.sh [init|update|restart|restart-all|flue-restart|radar-restart|radar-configure|status|logs]"
        echo ""
        echo "  init          - 首次完整部署"
        echo "  update        - 拉取代码 + 重新构建 + 重启服务"
        echo "  restart       - 重启统一应用服务"
        echo "  restart-all   - restart 的兼容别名"
        echo "  flue-restart  - 兼容命令：重启统一应用服务"
        echo "  radar-restart - 兼容命令：重启统一应用服务"
        echo "  radar-configure - 安全配置 GSData 凭据并重启雷达"
        echo "  status        - 查看服务运行状态"
        echo "  logs          - 查看最近日志"
        exit 1
        ;;
esac
