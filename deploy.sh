#!/usr/bin/env bash
#=============================================================================
# cybernaut.newmin.cn 一键部署 / 更新脚本
#=============================================================================
# 用法:
#   bash deploy.sh              # 首次部署（完整流程）
#   bash deploy.sh update       # 快速更新（git pull + build + restart）
#   bash deploy.sh restart      # 重启 API、Agent Runtime 与情报雷达
#   bash deploy.sh restart-all  # restart 的兼容别名
#   bash deploy.sh radar-configure # 安全写入 GSData 凭据
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
RADAR_SERVICE="cybernaut-radar"
RADAR_SYNC_SERVICE="cybernaut-radar-sync"
RADAR_SYNC_TIMER="cybernaut-radar-sync.timer"
RADAR_DIR="${DEPLOY_DIR}/project-discovery"
RADAR_STATE_DIR="/var/lib/cybernaut-radar"
RADAR_VENV="${RADAR_DIR}/.venv"
RADAR_PORT="8121"
RADAR_BOOTSTRAP_DEFAULT="http://101.126.93.130:8121"
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
SCORE_FALLBACK_MODEL=zeelin-oai/gpt-5.5
SCORE_PRIMARY_MODEL_TIMEOUT_MS=90000
SCORE_FALLBACK_MODEL_TIMEOUT_MS=240000

# ---- 内部密钥 ----
INTERNAL_SECRET=cybernaut-internal-2026

# ---- 情报雷达 ----
RADAR_BASE_URL=http://127.0.0.1:${RADAR_PORT}
RADAR_DATA_DIR=${RADAR_STATE_DIR}/data
RADAR_WECHAT_ACCOUNTS_XLSX=${RADAR_STATE_DIR}/公众号来源.xlsx
RADAR_BOOTSTRAP_URL=${RADAR_BOOTSTRAP_DEFAULT}
RADAR_AUTO_CRAWL_ENABLED=true
RADAR_WECHAT_DAILY_ENABLED=true
RADAR_SYNC_PAGE_SIZE=50
RADAR_SYNC_INCREMENTAL_PAGES=4
RADAR_SYNC_BACKFILL_PAGES=1
GSDATA_APP_KEY=
GSDATA_APP_SECRET=

# ---- Agent 工作空间 ----
AGENT_WORKSPACE=${FLUE_STATE_DIR}/workspace
AI_SKILL_ROOT=${FLUE_STATE_DIR}/workspace/.agents/skills
AI_PDF_TO_PPT_NODE_PROJECT_ROOT=${DEPLOY_DIR}
FLUE_DB_PATH=${FLUE_STATE_DIR}/flue.db

# ---- 性能 ----
SCORE_QUEUE_CONCURRENCY=3
SCORE_MAX_ATTEMPTS=1
SCORE_REQUEST_TIMEOUT_MS=360000
SCORE_DEFERRED_RETRY_LIMIT=1
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
    set_env_value "$ENV_FILE" "AI_PDF_TO_PPT_NODE_PROJECT_ROOT" "${DEPLOY_DIR}"
    set_env_value "$ENV_FILE" "FLUE_DB_PATH" "${FLUE_STATE_DIR}/flue.db"
    set_env_value "$ENV_FILE" "RADAR_BASE_URL" "http://127.0.0.1:${RADAR_PORT}"
    set_env_value "$ENV_FILE" "RADAR_DATA_DIR" "${RADAR_STATE_DIR}/data"
    set_env_value "$ENV_FILE" "RADAR_WECHAT_ACCOUNTS_XLSX" "${RADAR_STATE_DIR}/公众号来源.xlsx"

    # 模型选择允许运维在 .env 中覆盖；缺失时补当前源码默认值。
    ensure_env_value "$ENV_FILE" "FLUE_MODEL" "zeelin-oai/gpt-5.5"
    ensure_env_value "$ENV_FILE" "SCORE_MODEL" "zeelin/DeepSeek-V4-Flash"
    ensure_env_value "$ENV_FILE" "SCORE_FALLBACK_MODEL" "zeelin-oai/gpt-5.5"
    ensure_env_value "$ENV_FILE" "SCORE_PRIMARY_MODEL_TIMEOUT_MS" "90000"
    ensure_env_value "$ENV_FILE" "SCORE_FALLBACK_MODEL_TIMEOUT_MS" "240000"
    ensure_env_value "$ENV_FILE" "SCORE_MAX_ATTEMPTS" "1"
    ensure_env_value "$ENV_FILE" "SCORE_REQUEST_TIMEOUT_MS" "360000"
    ensure_env_value "$ENV_FILE" "SCORE_DEFERRED_RETRY_LIMIT" "1"
    ensure_env_value "$ENV_FILE" "RADAR_BOOTSTRAP_URL" "$RADAR_BOOTSTRAP_DEFAULT"
    ensure_env_value "$ENV_FILE" "RADAR_AUTO_CRAWL_ENABLED" "true"
    ensure_env_value "$ENV_FILE" "RADAR_WECHAT_DAILY_ENABLED" "true"
    ensure_env_value "$ENV_FILE" "RADAR_SYNC_PAGE_SIZE" "50"
    ensure_env_value "$ENV_FILE" "RADAR_SYNC_INCREMENTAL_PAGES" "4"
    ensure_env_value "$ENV_FILE" "RADAR_SYNC_BACKFILL_PAGES" "1"
    ensure_env_value "$ENV_FILE" "GSDATA_APP_KEY" ""
    ensure_env_value "$ENV_FILE" "GSDATA_APP_SECRET" ""
    chmod 600 "$ENV_FILE"
    log "Agent Runtime 与本地情报雷达环境变量已对齐 ✓"
}

#---------------------------------------
# 同步 Agent / 业务任务使用的 Skills 到持久化工作区
#---------------------------------------
sync_agent_skills() {
    step "同步 Agent Skills"

    local skills_root="${FLUE_STATE_DIR}/workspace/.agents/skills"
    local source_root source_dir target_dir required_skill

    # 清空旧的 skills，避免 git 中已删除的 skill 残留
    if [ -d "$skills_root" ]; then
        rm -rf "${skills_root:?}"/*
    fi
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
    log "Agent Skills 已同步到 ${skills_root} ✓"
}

#---------------------------------------
# 安装并验证 PDF → 可编辑 PPTX 的公开生产运行时
#---------------------------------------
setup_pdf_ppt_runtime() {
    step "配置 PDF 转 PPT 公开生产运行时"

    local env_file="${DEPLOY_DIR}/.env"
    local needs_packages=false
    local libreoffice_bin=""

    command -v pdftoppm &>/dev/null || needs_packages=true
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

    libreoffice_bin=$(command -v libreoffice 2>/dev/null || command -v soffice 2>/dev/null || true)
    set_env_value "$env_file" "AI_PDF_TO_PPT_PYTHON" "${DEPLOY_DIR}/server/.venv/bin/python3"
    set_env_value "$env_file" "AI_PDF_TO_PPT_PDFTOPPM" "$(command -v pdftoppm)"
    set_env_value "$env_file" "AI_PDF_TO_PPT_TESSERACT" "$(command -v tesseract)"
    set_env_value "$env_file" "AI_PDF_TO_PPT_LIBREOFFICE" "$libreoffice_bin"
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
# 构建主项目、Agent Runtime 和情报雷达
#---------------------------------------
build_project() {
    step "构建主项目、Agent Runtime 和情报雷达"

    cd "$DEPLOY_DIR"

    if [ ! -f "${FLUE_DIR}/package.json" ] || [ ! -f "${FLUE_DIR}/package-lock.json" ]; then
        err "缺少 Agent Runtime 源码或锁文件: ${FLUE_DIR}"
        err "请确认 cybernaut-assistant 已纳入当前发布版本"
        exit 1
    fi
    if [ ! -f "${RADAR_DIR}/app.py" ] || [ ! -f "${RADAR_DIR}/requirements.txt" ]; then
        err "缺少情报雷达源码或依赖清单: ${RADAR_DIR}"
        exit 1
    fi

    log "按锁文件安装主项目依赖..."
    "$NPM_BIN" ci --include=dev

    log "按锁文件安装 Agent Runtime 依赖..."
    "$NPM_BIN" ci --include=dev --prefix "$FLUE_DIR"

    setup_pdf_ppt_runtime

    log "创建情报雷达 Python 虚拟环境并安装依赖..."
    python3 -m venv "$RADAR_VENV"
    "$RADAR_VENV/bin/python" -m pip install --disable-pip-version-check -r "${RADAR_DIR}/requirements.txt"

    log "执行主项目与 Runtime 类型检查..."
    "$NPM_BIN" run check

    log "编译主项目、前端和 Agent Runtime..."
    "$NPM_BIN" run build

    # 确保必要目录存在
    install -d -m 0750 "$LOG_DIR" "$GENERATED_DIR" "${FLUE_STATE_DIR}/workspace" "${RADAR_STATE_DIR}/data"
    sync_agent_skills

    if [ ! -f "${FLUE_DIR}/dist/server/server.mjs" ]; then
        err "Agent Runtime 构建产物不存在: ${FLUE_DIR}/dist/server/server.mjs"
        exit 1
    fi

    "$RADAR_VENV/bin/python" -m py_compile "${RADAR_DIR}/app.py" "${RADAR_DIR}/scripts/bootstrap_from_remote.py"
    log "主项目、Agent Runtime 和情报雷达构建完成 ✓"
}

#---------------------------------------
# 恢复 / 初始化雷达持久化数据
#---------------------------------------
prepare_radar_state() {
    step "恢复情报雷达数据"

    local env_file="${DEPLOY_DIR}/.env"
    local bootstrap_url="$RADAR_BOOTSTRAP_DEFAULT"
    local candidate source_root state_complete=true candidate_file
    install -d -m 0750 "${RADAR_STATE_DIR}/data"

    if [ -f "$env_file" ]; then
        candidate=$(awk -F= '$1 == "RADAR_BOOTSTRAP_URL" {sub(/^[^=]*=/, ""); print; exit}' "$env_file")
        if [ -n "$candidate" ]; then
            bootstrap_url="$candidate"
        fi
    fi

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

    for candidate_file in \
        arxiv_candidates.jsonl \
        wechat_985_candidates.jsonl \
        wechat_api_candidates.jsonl \
        wechat_chat_candidates.jsonl \
        investment_candidates.jsonl
    do
        if [ ! -f "${RADAR_STATE_DIR}/data/${candidate_file}" ]; then
            state_complete=false
        fi
    done
    if [ ! -s "${RADAR_STATE_DIR}/公众号来源.xlsx" ]; then
        state_complete=false
    fi

    if [ "$state_complete" = false ]; then
        if [ -z "$bootstrap_url" ]; then
            err "雷达状态为空，且 RADAR_BOOTSTRAP_URL 未配置"
            exit 1
        fi
        log "本机缺少完整雷达数据，从旧服务只读恢复..."
        "$RADAR_VENV/bin/python" "${RADAR_DIR}/scripts/bootstrap_from_remote.py" \
            --remote-base "$bootstrap_url" \
            --project-dir "$RADAR_STATE_DIR"
    else
        log "已存在雷达候选数据和公众号清单，保留现有状态"
    fi

    chown -R root:root "$RADAR_STATE_DIR"
    chmod 0750 "$RADAR_STATE_DIR" "${RADAR_STATE_DIR}/data"
    if [ -f "${RADAR_STATE_DIR}/data/gsdata_credentials.json" ]; then
        chmod 0600 "${RADAR_STATE_DIR}/data/gsdata_credentials.json"
    fi
    log "雷达持久化状态就绪: ${RADAR_STATE_DIR} ✓"
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

    read -r -p "GSData app_key: " app_key
    read -r -s -p "GSData app_secret: " app_secret
    echo ""
    if [ -z "$app_key" ] || [ -z "$app_secret" ]; then
        err "app_key 和 app_secret 均不能为空"
        exit 1
    fi

    set_env_value "$env_file" "GSDATA_APP_KEY" "$app_key"
    set_env_value "$env_file" "GSDATA_APP_SECRET" "$app_secret"
    chmod 600 "$env_file"
    unset app_key app_secret
    log "GSData 凭据已安全写入 ${env_file} ✓"

    if systemctl cat "$RADAR_SERVICE" &>/dev/null; then
        systemctl restart "$RADAR_SERVICE"
        wait_for_http "情报雷达" "http://127.0.0.1:${RADAR_PORT}/api/health" 30
    fi
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
    install -d -m 0750 "$LOG_DIR" "$GENERATED_DIR" "${FLUE_STATE_DIR}/workspace" "${RADAR_STATE_DIR}/data"

    # 本地情报雷达。仅监听回环地址，由主 API 通过 RADAR_BASE_URL 消费。
    local RADAR_SERVICE_FILE="/etc/systemd/system/${RADAR_SERVICE}.service"
    cat > "$RADAR_SERVICE_FILE" <<RADAR_EOF
[Unit]
Description=Cybernaut Project Discovery Radar
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${RADAR_DIR}
EnvironmentFile=${DEPLOY_DIR}/.env
ExecStart=${RADAR_VENV}/bin/python -m uvicorn app:app --host 127.0.0.1 --port ${RADAR_PORT}
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

StandardOutput=append:${LOG_DIR}/radar.log
StandardError=append:${LOG_DIR}/radar.log

[Install]
WantedBy=multi-user.target
RADAR_EOF

    # 主 API 服务
    local API_SERVICE_FILE="/etc/systemd/system/${API_SERVICE}.service"
    cat > "$API_SERVICE_FILE" <<SERVICE_EOF
[Unit]
Description=Cybernaut Investment Platform API
Wants=network-online.target
After=network-online.target ${RADAR_SERVICE}.service

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

    # 将 Radar JSONL 中的增量候选自动同步到主数据库。游标状态保存在数据库，
    # 每轮优先处理最新数据，并持续推进历史回填。
    local RADAR_SYNC_SERVICE_FILE="/etc/systemd/system/${RADAR_SYNC_SERVICE}.service"
    cat > "$RADAR_SYNC_SERVICE_FILE" <<RADAR_SYNC_EOF
[Unit]
Description=Cybernaut Radar Incremental Sync
Wants=network-online.target
After=network-online.target ${RADAR_SERVICE}.service ${API_SERVICE}.service

[Service]
Type=oneshot
User=root
WorkingDirectory=${DEPLOY_DIR}
EnvironmentFile=${DEPLOY_DIR}/.env
ExecStart=${node_exec} ${DEPLOY_DIR}/sync_radar.mjs
TimeoutStartSec=15min

[Install]
WantedBy=multi-user.target
RADAR_SYNC_EOF

    local RADAR_SYNC_TIMER_FILE="/etc/systemd/system/${RADAR_SYNC_TIMER}"
    cat > "$RADAR_SYNC_TIMER_FILE" <<RADAR_SYNC_TIMER_EOF
[Unit]
Description=Run Cybernaut Radar Incremental Sync Every 30 Minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
RandomizedDelaySec=30
Persistent=true
Unit=${RADAR_SYNC_SERVICE}.service

[Install]
WantedBy=timers.target
RADAR_SYNC_TIMER_EOF

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
    systemctl enable "$RADAR_SERVICE"
    systemctl enable "$API_SERVICE"
    systemctl enable "$RADAR_SYNC_TIMER"
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
    if [ ! -x "${RADAR_VENV}/bin/python" ]; then
        err "情报雷达虚拟环境不存在，请先执行部署构建"
        exit 1
    fi

    log "重启情报雷达..."
    systemctl restart "$RADAR_SERVICE"
    wait_for_http "情报雷达" "http://127.0.0.1:${RADAR_PORT}/api/health" 30 || {
        journalctl -u "$RADAR_SERVICE" -n 50 --no-pager || true
        exit 1
    }

    log "重启 API 服务..."
    systemctl restart "$API_SERVICE"
    wait_for_http "API 服务" "http://127.0.0.1:3100/api/health" 30 || {
        journalctl -u "$API_SERVICE" -n 50 --no-pager || true
        exit 1
    }

    log "启动雷达增量同步定时器..."
    systemctl restart "$RADAR_SYNC_TIMER"

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
    echo "--- 情报雷达 ---"
    systemctl status "$RADAR_SERVICE" --no-pager -l 2>/dev/null | head -5 || echo "服务未找到"

    echo ""
    echo "--- 雷达增量同步定时器 ---"
    systemctl status "$RADAR_SYNC_TIMER" --no-pager -l 2>/dev/null | head -7 || echo "定时器未找到"

    echo ""
    echo "--- Agent Runtime ---"
    systemctl status "$FLUE_SERVICE" --no-pager -l 2>/dev/null | head -5 || echo "服务未找到"

    echo ""
    echo "--- 端口监听 ---"
    ss -tlnp 2>/dev/null | grep -E "3100|${FLUE_PORT}|${RADAR_PORT}|5432|:80 " || echo "(无)"

    echo ""
    echo "--- API 健康检查 ---"
    curl -s http://127.0.0.1:3100/api/health 2>/dev/null || echo "后端不可达"

    echo ""
    echo "--- 情报雷达健康检查 ---"
    curl -s "http://127.0.0.1:${RADAR_PORT}/api/health" 2>/dev/null || echo "情报雷达不可达"

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
    echo "=== 情报雷达日志 ==="
    if [ -f "${LOG_DIR}/radar.log" ]; then
        tail -30 "${LOG_DIR}/radar.log"
    else
        journalctl -u "$RADAR_SERVICE" -n 30 --no-pager 2>/dev/null || echo "情报雷达日志不存在"
    fi
    echo ""
    echo "=== 雷达增量同步日志 ==="
    journalctl -u "$RADAR_SYNC_SERVICE" -n 30 --no-pager 2>/dev/null || echo "雷达增量同步日志不存在"
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
    prepare_radar_state
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
    prepare_radar_state
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
    radar-restart)
        systemctl restart "$RADAR_SERVICE"
        wait_for_http "情报雷达" "http://127.0.0.1:${RADAR_PORT}/api/health" 30
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
        echo "  restart       - 重启 API、Agent Runtime 与情报雷达"
        echo "  restart-all   - 重启 API、Agent Runtime 与情报雷达"
        echo "  flue-restart  - 仅重启 Agent Runtime"
        echo "  radar-restart - 仅重启情报雷达"
        echo "  radar-configure - 安全配置 GSData 凭据并重启雷达"
        echo "  status        - 查看服务运行状态"
        echo "  logs          - 查看最近日志"
        exit 1
        ;;
esac
