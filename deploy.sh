#!/usr/bin/env bash
#=============================================================================
# cybernaut.newmin.cn 一键部署 / 更新脚本
#=============================================================================
# 用法:
#   bash deploy.sh              # 首次部署（完整流程）
#   bash deploy.sh update       # 快速更新（git pull + build + restart）
#   bash deploy.sh restart      # 仅重启后端服务
#   bash deploy.sh restart-all  # 重启全部服务（含 Flue）
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
FLUE_DIR="/www/flue-cybernaut"
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
# 创建 .env 文件
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
FLUE_BASE_URL=http://127.0.0.1:3584

# ---- 内部密钥 ----
INTERNAL_SECRET=cybernaut-internal-2026

# ---- 情报雷达 ----
RADAR_BASE_URL=http://101.126.93.130:8121

# ---- Agent 工作空间 ----
AGENT_WORKSPACE=/data/cybernaut-assistant/workspace
AI_SKILL_ROOT=/data/cybernaut-assistant/workspace/.agents/skills

# ---- 性能 ----
SCORE_QUEUE_CONCURRENCY=3
INGEST_MAX_ATTEMPTS=3
EOF
        log ".env 创建完成 ✓"
        warn "如需启用 AI 功能，请编辑 .env 填写 LLM_API_KEY 和 OPENAI_API_KEY"
    fi
}

#---------------------------------------
# 构建项目
#---------------------------------------
build_project() {
    step "构建项目"

    cd "$DEPLOY_DIR"

    log "安装依赖..."
    "$NPM_BIN" install --production=false

    log "编译 TypeScript + 打包前端..."
    "$NPM_BIN" run build

    # 确保必要目录存在
    mkdir -p "$LOG_DIR" "$GENERATED_DIR"

    log "构建完成 ✓"
}

#---------------------------------------
# Nginx 配置
#---------------------------------------
setup_nginx() {
    step "配置 Nginx"

    # 检查是否已有相同配置
    if [ -f "$NGINX_CONF" ] && grep -q "$DOMAIN" "$NGINX_CONF" 2>/dev/null; then
        log "Nginx 配置已存在，检查语法后重载..."
    else
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
    fi

    # 确保 nginx 主配置 include 了 conf.d
    if ! grep -q "include /etc/nginx/conf.d/\*.conf" /etc/nginx/nginx.conf 2>/dev/null; then
        warn "nginx.conf 未 include conf.d/*.conf，请手动确认"
    fi

    nginx -t && systemctl reload nginx
    log "Nginx 配置生效 ✓"
}

#---------------------------------------
# systemd 服务
#---------------------------------------
setup_systemd() {
    step "配置 systemd 服务"

    # 主 API 服务
    local API_SERVICE_FILE="/etc/systemd/system/${API_SERVICE}.service"
    cat > "$API_SERVICE_FILE" <<SERVICE_EOF
[Unit]
Description=Cybernaut Investment Platform API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${DEPLOY_DIR}
EnvironmentFile=${DEPLOY_DIR}/.env
ExecStart=${NODE_BIN} --env-file=.env ${DEPLOY_DIR}/server-dist/index.js
Restart=on-failure
RestartSec=5

StandardOutput=append:${LOG_DIR}/server.log
StandardError=append:${LOG_DIR}/server.log

[Install]
WantedBy=multi-user.target
SERVICE_EOF

    # Flue Agent 编排服务
    local ANTHROPIC_KEY
    ANTHROPIC_KEY=$(grep -oP 'ANTHROPIC_API_KEY=\K.*' "${DEPLOY_DIR}/.env" 2>/dev/null || echo "")
    local FLUE_SERVICE_FILE="/etc/systemd/system/${FLUE_SERVICE}.service"
    cat > "$FLUE_SERVICE_FILE" <<FLUE_EOF
[Unit]
Description=Cybernaut Flue Agent Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${FLUE_DIR}
Environment=ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
ExecStart=/usr/bin/npx vite dev --port 3584 --host 127.0.0.1
Restart=on-failure
RestartSec=5

StandardOutput=append:${LOG_DIR}/flue.log
StandardError=append:${LOG_DIR}/flue.log

[Install]
WantedBy=multi-user.target
FLUE_EOF

    systemctl daemon-reload
    systemctl enable "$API_SERVICE"
    if [ -d "$FLUE_DIR" ]; then
        systemctl enable "$FLUE_SERVICE" 2>/dev/null || true
    fi
    log "systemd 服务已注册 ✓"
}

#---------------------------------------
# 启动 / 重启服务
#---------------------------------------
start_services() {
    step "启动服务"

    # 启动主 API
    if systemctl is-active --quiet "$API_SERVICE" 2>/dev/null; then
        log "重启 API 服务..."
        systemctl restart "$API_SERVICE"
    else
        log "首次启动 API 服务..."
        systemctl start "$API_SERVICE"
    fi

    # 启动 Flue（如果存在）
    if [ -d "$FLUE_DIR" ]; then
        if systemctl is-active --quiet "$FLUE_SERVICE" 2>/dev/null; then
            log "重启 Flue 服务..."
            systemctl restart "$FLUE_SERVICE"
        else
            log "首次启动 Flue 服务..."
            systemctl start "$FLUE_SERVICE" 2>/dev/null || log "Flue 服务启动失败（可能未安装依赖）"
        fi
    fi

    sleep 3

    # 验证 API
    if systemctl is-active --quiet "$API_SERVICE"; then
        log "API 服务启动成功 ✓"
        sleep 1
        local health
        health=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/health 2>/dev/null || echo "000")
        if [ "$health" = "200" ]; then
            log "API 健康检查通过 ✓"
        else
            warn "API 健康检查返回 HTTP $health"
        fi
    else
        err "API 服务启动失败！请查看日志: journalctl -u ${API_SERVICE} -n 50"
    fi

    # 验证 Flue
    if systemctl is-active --quiet "$FLUE_SERVICE" 2>/dev/null; then
        local flue_health
        flue_health=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3584/health 2>/dev/null || echo "000")
        if [ "$flue_health" = "200" ]; then
            log "Flue 服务健康检查通过 ✓"
        else
            warn "Flue 健康检查返回 HTTP $flue_health"
        fi
    fi
}

#---------------------------------------
# 状态
#---------------------------------------
show_status() {
    step "服务状态"

    echo "--- API 服务 ---"
    systemctl status "$API_SERVICE" --no-pager -l 2>/dev/null | head -5 || echo "服务未找到"

    echo ""
    echo "--- Flue 服务 ---"
    systemctl status "$FLUE_SERVICE" --no-pager -l 2>/dev/null | head -5 || echo "服务未找到"

    echo ""
    echo "--- 端口监听 ---"
    ss -tlnp 2>/dev/null | grep -E '3100|3584|5432|:80 ' || echo "(无)"

    echo ""
    echo "--- API 健康检查 ---"
    curl -s http://127.0.0.1:3100/api/health 2>/dev/null || echo "后端不可达"

    echo ""
    echo "--- Flue 健康检查 ---"
    curl -s http://127.0.0.1:3584/health 2>/dev/null || echo "Flue 不可达"

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
    echo "=== Flue 服务日志 ==="
    if [ -f "${LOG_DIR}/flue.log" ]; then
        tail -20 "${LOG_DIR}/flue.log"
    else
        journalctl -u "$FLUE_SERVICE" -n 20 --no-pager 2>/dev/null || echo "Flue 日志不存在"
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

    build_project
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
        systemctl restart "$API_SERVICE" "$FLUE_SERVICE" 2>/dev/null || true
        sleep 2
        echo "已重启全部服务"
        ;;
    flue-restart)
        systemctl restart "$FLUE_SERVICE" 2>/dev/null || true
        sleep 1
        echo "Flue 服务已重启"
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
        echo "  restart       - 仅重启后端 API 服务"
        echo "  restart-all   - 重启全部服务（含 Flue）"
        echo "  flue-restart  - 仅重启 Flue Agent 服务"
        echo "  status        - 查看服务运行状态"
        echo "  logs          - 查看最近日志"
        exit 1
        ;;
esac
