#!/usr/bin/env bash
#=============================================================================
# Cybernaut 统一应用服务快捷运维脚本
#=============================================================================
# 用法：
#   ./deploy.sh start          # 启动服务（已运行时仅检查健康）
#   ./deploy.sh restart        # 快速重启服务并等待健康检查
#   ./deploy.sh stop           # 停止服务
#   ./deploy.sh status         # 查看路径绑定、systemd 与健康状态
#   ./deploy.sh logs [行数]    # 查看应用日志，默认 100 行
#   ./deploy.sh logs-follow    # 持续查看应用日志
#=============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="${PROJECT_DIR:-$SCRIPT_DIR}"
APP_SERVICE="${APP_SERVICE:-cybernaut-app}"
SERVICE_UNIT="${APP_SERVICE}.service"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4100/api/health/components}"
START_TIMEOUT_SECONDS="${START_TIMEOUT_SECONDS:-120}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-90}"
LOG_LINES="${LOG_LINES:-100}"
APP_ENTRY="${PROJECT_DIR}/server-dist/index.js"
APP_ENV_FILE="${PROJECT_DIR}/.env"
APP_LOG_FILE="${APP_LOG_FILE:-${PROJECT_DIR}/logs/server.log}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { printf '%b[INFO]%b  %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%b[WARN]%b  %s\n' "$YELLOW" "$NC" "$*"; }
err()  { printf '%b[ERROR]%b %s\n' "$RED" "$NC" "$*" >&2; }
step() { printf '\n%b=== %s ===%b\n' "$BLUE" "$*" "$NC"; }

usage() {
    cat <<EOF
用法: ./deploy.sh <命令>

命令:
  start          启动 ${SERVICE_UNIT}；已运行时仅检查健康
  restart        快速重启 ${SERVICE_UNIT} 并等待健康检查
  stop           停止 ${SERVICE_UNIT}
  status         查看项目路径绑定、systemd 和健康状态
  logs [行数]    查看应用日志，默认 ${LOG_LINES} 行
  logs-follow    持续查看应用日志，按 Ctrl+C 退出
  help           显示本帮助

当前项目目录: ${PROJECT_DIR}
健康检查地址: ${HEALTH_URL}

可选环境变量:
  APP_SERVICE               systemd 服务名，默认 ${APP_SERVICE}
  HEALTH_URL                健康检查地址
  START_TIMEOUT_SECONDS     启动等待秒数，默认 ${START_TIMEOUT_SECONDS}
  STOP_TIMEOUT_SECONDS      停止等待秒数，默认 ${STOP_TIMEOUT_SECONDS}
  LOG_LINES                 默认日志行数，默认 ${LOG_LINES}
  APP_LOG_FILE              应用日志文件，默认 ${APP_LOG_FILE}
EOF
}

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        err "缺少命令: $1"
        exit 1
    fi
}

validate_positive_integer() {
    local name="$1" value="$2"
    if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
        err "${name} 必须是正整数，当前值: ${value}"
        exit 1
    fi
}

require_root_for_mutation() {
    if [ "${EUID}" -ne 0 ]; then
        err "${1} 需要 root 权限，请执行: sudo ./deploy.sh ${2}"
        exit 1
    fi
}

check_service_exists() {
    if ! systemctl cat "$SERVICE_UNIT" >/dev/null 2>&1; then
        err "未找到 systemd 服务: ${SERVICE_UNIT}"
        exit 1
    fi
}

validate_project_files() {
    local failed=0
    if [ ! -f "$APP_ENTRY" ]; then
        err "缺少服务构建入口: ${APP_ENTRY}"
        failed=1
    fi
    if [ ! -f "${PROJECT_DIR}/dist/index.html" ]; then
        err "缺少 Web 构建产物: ${PROJECT_DIR}/dist/index.html"
        failed=1
    fi
    if [ ! -f "$APP_ENV_FILE" ]; then
        err "缺少运行环境文件: ${APP_ENV_FILE}"
        failed=1
    fi
    if [ "$failed" -ne 0 ]; then
        err "请先在 ${PROJECT_DIR} 执行 npm run build，并确认 .env 已配置"
        return 1
    fi
}

validate_service_binding() {
    local service_working_directory service_exec_start service_environment_files failed=0
    service_working_directory=$(systemctl show "$SERVICE_UNIT" --property WorkingDirectory --value)
    service_exec_start=$(systemctl show "$SERVICE_UNIT" --property ExecStart --value)
    service_environment_files=$(systemctl show "$SERVICE_UNIT" --property EnvironmentFiles --value)

    if [ "$service_working_directory" != "$PROJECT_DIR" ]; then
        err "systemd 工作目录不匹配: ${service_working_directory:-未配置}"
        err "期望目录: ${PROJECT_DIR}"
        failed=1
    fi
    if [[ "$service_exec_start" != *"$APP_ENTRY"* ]]; then
        err "systemd ExecStart 未绑定当前项目入口: ${APP_ENTRY}"
        failed=1
    fi
    if [[ "$service_environment_files" != *"$APP_ENV_FILE"* ]]; then
        err "systemd EnvironmentFile 未绑定当前项目: ${APP_ENV_FILE}"
        failed=1
    fi
    if [ "$failed" -ne 0 ]; then
        err "为避免误启动其他目录，已取消操作"
        err "请执行 systemctl cat ${SERVICE_UNIT} 检查服务配置"
        return 1
    fi
    log "服务路径已绑定当前项目: ${PROJECT_DIR}"
}

prepare_mutation() {
    systemctl daemon-reload
    validate_project_files
    validate_service_binding
}

wait_for_stopped() {
    local elapsed=0
    while (( elapsed < STOP_TIMEOUT_SECONDS )); do
        if ! systemctl is-active --quiet "$SERVICE_UNIT"; then
            return 0
        fi
        sleep 1
        ((elapsed += 1))
    done
    return 1
}

wait_for_health() {
    local elapsed=0 code="000"
    while (( elapsed < START_TIMEOUT_SECONDS )); do
        if ! systemctl is-active --quiet "$SERVICE_UNIT"; then
            err "${SERVICE_UNIT} 在启动过程中退出"
            return 1
        fi
        code=$(curl --silent --show-error --output /dev/null \
            --write-out '%{http_code}' --max-time 3 "$HEALTH_URL" 2>/dev/null || true)
        if [ "$code" = "200" ]; then
            log "项目健康检查通过（HTTP 200）: ${HEALTH_URL}"
            return 0
        fi
        sleep 1
        ((elapsed += 1))
    done

    err "项目在 ${START_TIMEOUT_SECONDS} 秒内未通过健康检查（最后 HTTP: ${code:-000}）"
    return 1
}

show_failure_context() {
    printf '\n'
    systemctl status "$SERVICE_UNIT" --no-pager --full || true
    printf '\n'
    if [ -f "$APP_LOG_FILE" ]; then
        warn "应用日志最后 ${LOG_LINES} 行: ${APP_LOG_FILE}"
        tail --lines "$LOG_LINES" "$APP_LOG_FILE" || true
    else
        warn "未找到应用日志: ${APP_LOG_FILE}"
        journalctl --unit "$SERVICE_UNIT" --lines "$LOG_LINES" --no-pager || true
    fi
}

start_project() {
    step "启动项目"
    require_root_for_mutation "启动服务" "start"
    prepare_mutation

    if systemctl is-active --quiet "$SERVICE_UNIT"; then
        log "${SERVICE_UNIT} 已在运行，直接检查健康状态"
    else
        systemctl start "$SERVICE_UNIT"
    fi
    if ! wait_for_health; then
        show_failure_context
        exit 1
    fi
    log "项目启动完成"
}

restart_project() {
    step "快速重启项目"
    require_root_for_mutation "重启服务" "restart"
    prepare_mutation

    systemctl restart "$SERVICE_UNIT"
    if ! wait_for_health; then
        show_failure_context
        exit 1
    fi
    log "项目重启完成"
}

stop_project() {
    step "停止项目"
    require_root_for_mutation "停止服务" "stop"
    if ! systemctl is-active --quiet "$SERVICE_UNIT"; then
        log "${SERVICE_UNIT} 已停止"
        return
    fi

    systemctl stop "$SERVICE_UNIT"
    if wait_for_stopped; then
        log "项目已停止"
        return
    fi

    err "项目在 ${STOP_TIMEOUT_SECONDS} 秒内未停止"
    systemctl status "$SERVICE_UNIT" --no-pager --full || true
    exit 1
}

show_status() {
    step "项目状态"
    printf '项目目录: %s\n' "$PROJECT_DIR"
    if validate_project_files && validate_service_binding; then
        log "项目文件与 systemd 路径绑定正常"
    else
        warn "项目文件或 systemd 路径绑定异常"
    fi
    printf '\n'
    systemctl status "$SERVICE_UNIT" --no-pager --full || true

    printf '\n'
    if systemctl is-active --quiet "$SERVICE_UNIT"; then
        local response_file code
        response_file=$(mktemp)
        code=$(curl --silent --show-error --output "$response_file" \
            --write-out '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null || true)
        if [ "$code" = "200" ]; then
            log "健康检查正常（HTTP 200）"
            cat "$response_file"
            printf '\n'
        else
            warn "服务正在运行，但健康检查异常（HTTP ${code:-000}）"
        fi
        rm -f -- "$response_file"
    else
        warn "项目当前未运行"
    fi
}

show_logs() {
    local lines="${1:-$LOG_LINES}"
    validate_positive_integer "日志行数" "$lines"
    if [ -f "$APP_LOG_FILE" ]; then
        tail --lines "$lines" "$APP_LOG_FILE"
    else
        warn "未找到应用日志 ${APP_LOG_FILE}，改为读取 journalctl"
        journalctl --unit "$SERVICE_UNIT" --lines "$lines" --no-pager
    fi
}

follow_logs() {
    if [ -f "$APP_LOG_FILE" ]; then
        tail --follow=name --retry "$APP_LOG_FILE"
    else
        warn "未找到应用日志 ${APP_LOG_FILE}，改为读取 journalctl"
        journalctl --unit "$SERVICE_UNIT" --follow
    fi
}

main() {
    local command="${1:-help}"
    case "$command" in
        help|-h|--help)
            usage
            return
            ;;
        start|stop|restart|status|logs|logs-follow)
            ;;
        *)
            err "未知命令: $command"
            usage
            exit 1
            ;;
    esac

    require_command systemctl
    require_command journalctl
    require_command curl
    validate_positive_integer "START_TIMEOUT_SECONDS" "$START_TIMEOUT_SECONDS"
    validate_positive_integer "STOP_TIMEOUT_SECONDS" "$STOP_TIMEOUT_SECONDS"
    check_service_exists

    case "$command" in
        start) start_project ;;
        stop) stop_project ;;
        restart) restart_project ;;
        status) show_status ;;
        logs) show_logs "${2:-$LOG_LINES}" ;;
        logs-follow) follow_logs ;;
    esac
}

main "$@"
