#!/usr/bin/env bash
#=============================================================================
# cybernaut.newmin.cn 一键部署 / 更新脚本
#=============================================================================
# 用法:
#   bash deploy.sh              # 首次部署（完整流程）
#   bash deploy.sh update       # 快速更新（git pull + build + restart）
#   bash deploy.sh restart      # 重启 API 与 Agent Runtime
#   bash deploy.sh restart-all  # restart 的兼容别名
#   bash deploy.sh status       # 查看服务状态
#   bash deploy.sh logs         # 查看最近日志
#=============================================================================
set -euo pipefail

#---------------------------------------
# 配置区（可按需修改）
#---------------------------------------
DOMAIN="cybernaut.newmin.cn"
DEPLOY_DIR="/www/sbl"
NODE_BIN="node"
NPM_BIN="npm"
NGINX_CONF="/etc/nginx/conf.d/cybernaut.conf"
API_SERVICE="cybernaut-api"
FLUE_SERVICE="cybernaut-flue"
FLUE_DIR="${DEPLOY_DIR}/cybernaut-assistant"
FLUE_STATE_DIR="/var/lib/cybernaut-assistant"
FLUE_PORT="3584"
SYSTEMD_SERVICE="$API_SERVICE"
LOG_DIR="${DEPLOY_DIR}/logs"
GENERATED_DIR="${DEPLOY_DIR}/server/generated"

# 数据库
PG_USER="cybernaut"
PG_PASSWORD="cyb_mvp_2026"
PG_DB="cybernaut_mvp"
PG_HOST="127.0.0.1"
PG_PORT="5432"

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

    if ! command -v nginx &>/dev/null; then
        err "nginx 未安装，请先: apt install nginx"
        ok=false
    else
        log "nginx $(nginx -v 2>&1 | cut -d/ -f2) ✓"
    fi

    if ! command -v docker &>/dev/null; then
        warn "Docker 未安装，将尝试直接连接已有 PostgreSQL"
    else
        log "docker $(docker -v | awk '{print $3}' | tr -d ',') ✓"
    fi

    if [ ! -d "$DEPLOY_DIR" ]; then
        err "部署目录不存在: $DEPLOY_DIR"
        ok=false
    fi

    $ok || exit 1
}

#---------------------------------------
# 数据库初始化
#---------------------------------------
init_database() {
    step "数据库初始化"

    # 先检查是否已有可用的 PostgreSQL（可能已通过 apt 安装）
    if pg_isready -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" &>/dev/null; then
        log "PostgreSQL 已就绪（本地安装） ✓"
    elif command -v docker &>/dev/null && [ -f "${DEPLOY_DIR}/docker-compose.yml" ]; then
        log "通过 Docker Compose 启动 PostgreSQL..."
        cd "$DEPLOY_DIR"
        docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || true

        # 等待 PG ready
        log "等待 PostgreSQL 就绪..."
        local retries=0
        until docker compose exec -T postgres pg_isready -U "$PG_USER" -d "$PG_DB" &>/dev/null; do
            retries=$((retries + 1))
            if [ $retries -gt 30 ]; then
                err "PostgreSQL Docker 启动超时"
                exit 1
            fi
            sleep 1
        done
        log "PostgreSQL (Docker) 已就绪 ✓"
    else
        err "无法连接 PostgreSQL: ${PG_HOST}:${PG_PORT}"
        warn "请先安装并启动 PostgreSQL 16，或安装 Docker 后重新运行"
        exit 1
    fi

    # 导入生产数据（仅首次，空库时导入）
    local DUMP_FILE="${DEPLOY_DIR}/cybernaut_mvp_dump.sql"
    if [ -f "$DUMP_FILE" ]; then
        # 检查数据库是否为空
        local table_count
        table_count=$(PGPASSWORD="$PG_PASSWORD" psql -U "$PG_USER" -h "$PG_HOST" -p "$PG_PORT" -d "$PG_DB" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "0")
        table_count=$(echo "$table_count" | tr -d '[:space:]')

        if [ "${table_count:-0}" -eq 0 ]; then
            log "数据库为空，导入生产数据 (${DUMP_FILE})..."
            PGPASSWORD="$PG_PASSWORD" psql -U "$PG_USER" -h "$PG_HOST" -p "$PG_PORT" -d "$PG_DB" < "$DUMP_FILE"
            log "数据导入完成 ✓"
        else
            log "数据库已有 ${table_count} 张表，跳过数据导入"
        fi
    else
        warn "未找到数据转储文件，应用启动时将自动建表+种子数据"
    fi
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

# ---- 数据库 ----
DATABASE_URL=postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}

# ---- JWT ----
JWT_SECRET=cybernaut-prod-$(openssl rand -hex 16 2>/dev/null || echo "change-me-$(date +%s)")
JWT_EXPIRES_IN=24h

# ---- LLM 网关 ----
LLM_BASE_URL=http://127.0.0.1:18081/v1
LLM_MODEL=claude-sonnet-4-6
LLM_API_KEY=

# ---- OpenAI 兼容网关 ----
OPENAI_BASE_URL=http://127.0.0.1:18081/v1
OPENAI_API_KEY=
OCR_VISION_MODEL=gemini-3.1-pro-preview

# ---- 图片生成网关 ----
GATEWAY_IMAGE_BASE_URL=https://getways-jumu.zeelin.cn
GATEWAY_IMAGE_API_KEY=

# ---- Flue Agent ----
FLUE_BASE_URL=http://127.0.0.1:${FLUE_PORT}
FLUE_AGENT_NAME=assistant
EXPRESS_BASE_URL=http://127.0.0.1:3100
FLUE_MODEL=zeelin-oai/gpt-5.5
SCORE_MODEL=zeelin/DeepSeek-V4-Flash
SOURCING_MODEL=zeelin-oai/gpt-5.5

# ---- 内部密钥 ----
INTERNAL_SECRET=cybernaut-internal-2026

# ---- 情报雷达 ----
RADAR_BASE_URL=http://101.126.93.130:8121

# ---- Agent 工作空间 ----
AGENT_WORKSPACE=${FLUE_STATE_DIR}/workspace
AI_SKILL_ROOT=${FLUE_STATE_DIR}/workspace/.agents/skills
FLUE_DB_PATH=${FLUE_STATE_DIR}/flue.db

# ---- 性能 ----
SCORE_QUEUE_CONCURRENCY=3
INGEST_MAX_ATTEMPTS=3
EOF
        log ".env 创建完成 ✓"
        warn "如需启用 AI 功能，请编辑 .env 填写 LLM_API_KEY 或 OPENAI_API_KEY"
    fi

    # 以下键属于本部署拓扑，升级旧环境时也必须迁移到仓库内 Runtime。
    set_env_value "$ENV_FILE" "FLUE_BASE_URL" "http://127.0.0.1:${FLUE_PORT}"
    set_env_value "$ENV_FILE" "FLUE_AGENT_NAME" "assistant"
    set_env_value "$ENV_FILE" "EXPRESS_BASE_URL" "http://127.0.0.1:3100"
    set_env_value "$ENV_FILE" "AGENT_WORKSPACE" "${FLUE_STATE_DIR}/workspace"
    set_env_value "$ENV_FILE" "AI_SKILL_ROOT" "${FLUE_STATE_DIR}/workspace/.agents/skills"
    set_env_value "$ENV_FILE" "FLUE_DB_PATH" "${FLUE_STATE_DIR}/flue.db"

    # 模型选择允许运维在 .env 中覆盖；缺失时补当前源码默认值。
    ensure_env_value "$ENV_FILE" "FLUE_MODEL" "zeelin-oai/gpt-5.5"
    ensure_env_value "$ENV_FILE" "SCORE_MODEL" "zeelin/DeepSeek-V4-Flash"
    ensure_env_value "$ENV_FILE" "SOURCING_MODEL" "zeelin-oai/gpt-5.5"
    chmod 600 "$ENV_FILE"
    log "Agent Runtime 环境变量已对齐 ✓"
}

#---------------------------------------
# 同步 Agent / 业务任务使用的 Skills 到持久化工作区
#---------------------------------------
sync_agent_skills() {
    step "同步 Agent Skills"

    local skills_root="${FLUE_STATE_DIR}/workspace/.agents/skills"
    local source_root source_dir target_dir
    install -d -m 0750 "$skills_root"

    for source_root in \
        "${DEPLOY_DIR}/server/workspace/.agents/skills" \
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
            cp -a "${source_dir}/." "${target_dir}/"
        done < <(
            find "$source_root" -mindepth 1 -maxdepth 1 -type d \
                -exec test -f '{}/SKILL.md' ';' -print0
        )
    done

    if [ ! -f "${skills_root}/answer-project-qa/SKILL.md" ]; then
        err "核心业务 Skill 同步失败: answer-project-qa"
        exit 1
    fi
    log "Agent Skills 已同步到 ${skills_root} ✓"
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
                systemctl stop "$FLUE_SERVICE" 2>/dev/null || true
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
# 构建主项目和 Agent Runtime
#---------------------------------------
build_project() {
    step "构建主项目和 Agent Runtime"

    cd "$DEPLOY_DIR"

    if [ ! -f "${FLUE_DIR}/package.json" ] || [ ! -f "${FLUE_DIR}/package-lock.json" ]; then
        err "缺少 Agent Runtime 源码或锁文件: ${FLUE_DIR}"
        err "请确认 cybernaut-assistant 已纳入当前发布版本"
        exit 1
    fi

    log "按锁文件安装主项目依赖..."
    "$NPM_BIN" ci --include=dev

    log "按锁文件安装 Agent Runtime 依赖..."
    "$NPM_BIN" ci --include=dev --prefix "$FLUE_DIR"

    log "执行主项目与 Runtime 类型检查..."
    "$NPM_BIN" run check

    log "编译主项目、前端和 Agent Runtime..."
    "$NPM_BIN" run build

    # 确保必要目录存在
    install -d -m 0750 "$LOG_DIR" "$GENERATED_DIR" "${FLUE_STATE_DIR}/workspace"
    sync_agent_skills

    if [ ! -f "${FLUE_DIR}/dist/server/server.mjs" ]; then
        err "Agent Runtime 构建产物不存在: ${FLUE_DIR}/dist/server/server.mjs"
        exit 1
    fi

    log "主项目和 Agent Runtime 构建完成 ✓"
}

#---------------------------------------
# Nginx 配置
#---------------------------------------
setup_nginx() {
    step "配置 Nginx"

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
    server_name cybernaut.newmin.cn;

    # 访问日志
    access_log /var/log/nginx/cybernaut.access.log;
    error_log  /var/log/nginx/cybernaut.error.log;

    # 前端静态资源（Vite build 产物，带 hash 可长缓存）
    location /assets/ {
        root /www/sbl/dist;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # Agent Runtime：保留 /ai/api 前缀，供 Flue SDK 流式/长轮询接口使用。
    location ^~ /ai/api/ {
        proxy_pass http://127.0.0.1:3584;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        client_max_body_size 150m;
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

    # 生成文件（PPT 产物等）
    location /generated/ {
        alias /www/sbl/server/generated/;
        expires 1d;
    }
}
NGINX_EOF

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
setup_systemd() {
    step "配置 systemd 服务"

    local node_exec
    node_exec=$(command -v "$NODE_BIN")
    install -d -m 0750 "$LOG_DIR" "$GENERATED_DIR" "${FLUE_STATE_DIR}/workspace"

    # 主 API 服务
    local API_SERVICE_FILE="/etc/systemd/system/${API_SERVICE}.service"
    cat > "$API_SERVICE_FILE" <<SERVICE_EOF
[Unit]
Description=Cybernaut Investment Platform API
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${DEPLOY_DIR}
EnvironmentFile=${DEPLOY_DIR}/.env
ExecStart=${node_exec} ${DEPLOY_DIR}/server-dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

StandardOutput=append:${LOG_DIR}/server.log
StandardError=append:${LOG_DIR}/server.log

[Install]
WantedBy=multi-user.target
SERVICE_EOF

    # 当前仓库内的 Flue Agent Runtime（使用生产构建产物，禁止在线上运行 dev server）。
    local FLUE_SERVICE_FILE="/etc/systemd/system/${FLUE_SERVICE}.service"
    cat > "$FLUE_SERVICE_FILE" <<FLUE_EOF
[Unit]
Description=Cybernaut Assistant Flue Runtime
Wants=network-online.target
After=network-online.target ${API_SERVICE}.service

[Service]
Type=simple
User=root
WorkingDirectory=${FLUE_DIR}
EnvironmentFile=${DEPLOY_DIR}/.env
Environment=NODE_ENV=production
Environment=PORT=${FLUE_PORT}
ExecStart=${node_exec} ${FLUE_DIR}/dist/server/server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

StandardOutput=append:${LOG_DIR}/flue.log
StandardError=append:${LOG_DIR}/flue.log

[Install]
WantedBy=multi-user.target
FLUE_EOF

    systemctl daemon-reload
    systemctl enable "$API_SERVICE"
    systemctl enable "$FLUE_SERVICE"
    log "systemd 服务已注册 ✓"
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

start_services() {
    step "启动服务"

    if [ ! -f "${FLUE_DIR}/dist/server/server.mjs" ]; then
        err "Agent Runtime 构建产物不存在，请先执行部署构建"
        exit 1
    fi

    log "重启 API 服务..."
    systemctl restart "$API_SERVICE"
    wait_for_http "API 服务" "http://127.0.0.1:3100/api/health" 30 || {
        journalctl -u "$API_SERVICE" -n 50 --no-pager || true
        exit 1
    }

    log "重启 Agent Runtime..."
    systemctl restart "$FLUE_SERVICE"
    wait_for_http "Agent Runtime" "http://127.0.0.1:${FLUE_PORT}/health" 30 || {
        journalctl -u "$FLUE_SERVICE" -n 50 --no-pager || true
        exit 1
    }
}

#---------------------------------------
# 状态
#---------------------------------------
show_status() {
    step "服务状态"

    echo "--- API 服务 ---"
    systemctl status "$API_SERVICE" --no-pager -l 2>/dev/null | head -5 || echo "服务未找到"

    echo ""
    echo "--- Agent Runtime ---"
    systemctl status "$FLUE_SERVICE" --no-pager -l 2>/dev/null | head -5 || echo "服务未找到"

    echo ""
    echo "--- 端口监听 ---"
    ss -tlnp 2>/dev/null | grep -E "3100|${FLUE_PORT}|5432|:80 " || echo "(无)"

    echo ""
    echo "--- API 健康检查 ---"
    curl -s http://127.0.0.1:3100/api/health 2>/dev/null || echo "后端不可达"

    echo ""
    echo "--- Agent Runtime 健康检查 ---"
    curl -s "http://127.0.0.1:${FLUE_PORT}/health" 2>/dev/null || echo "Agent Runtime 不可达"

    echo ""
    echo "--- 前端检查 ---"
    curl -s -o /dev/null -w "HTTP %{http_code}" "http://${DOMAIN}/" 2>/dev/null || echo "域名不可达"

    echo ""
}

#---------------------------------------
# 日志
#---------------------------------------
show_logs() {
    echo "=== API 服务日志 ==="
    if [ -f "${LOG_DIR}/server.log" ]; then
        tail -50 "${LOG_DIR}/server.log"
    else
        journalctl -u "$API_SERVICE" -n 50 --no-pager
    fi
    echo ""
    echo "=== Agent Runtime 日志 ==="
    if [ -f "${LOG_DIR}/flue.log" ]; then
        tail -20 "${LOG_DIR}/flue.log"
    else
        journalctl -u "$FLUE_SERVICE" -n 20 --no-pager 2>/dev/null || echo "Agent Runtime 日志不存在"
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
    init_database
    create_env
    build_project
    setup_nginx
    setup_systemd
    migrate_legacy_agent_state
    start_services

    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║  ✅ 部署完成！                          ║"
    echo "║                                          ║"
    echo "║  访问地址: http://${DOMAIN}         ║"
    echo "║  登录账号: admin@cybernaut.com           ║"
    echo "║  登录密码: 123456                        ║"
    echo "║                                          ║"
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
    setup_systemd
    migrate_legacy_agent_state
    setup_nginx   # 确保 nginx 配置最新
    start_services

    echo ""
    log "更新完成！访问 http://${DOMAIN}"
}

#---------------------------------------
# 仅重启
#---------------------------------------
do_restart() {
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
        check_prereqs
        do_update
        ;;
    restart)
        do_restart
        ;;
    restart-all)
        start_services
        ;;
    flue-restart)
        systemctl restart "$FLUE_SERVICE"
        wait_for_http "Agent Runtime" "http://127.0.0.1:${FLUE_PORT}/health" 30
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    *)
        echo "用法: bash deploy.sh [init|update|restart|restart-all|flue-restart|status|logs]"
        echo ""
        echo "  init          - 首次完整部署"
        echo "  update        - 拉取代码 + 重新构建 + 重启服务"
        echo "  restart       - 重启 API 与 Agent Runtime"
        echo "  restart-all   - 重启 API 与 Agent Runtime"
        echo "  flue-restart  - 仅重启 Agent Runtime"
        echo "  status        - 查看服务运行状态"
        echo "  logs          - 查看最近日志"
        exit 1
        ;;
esac
