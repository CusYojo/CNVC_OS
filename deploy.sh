#!/usr/bin/env bash
#=============================================================================
# Cybernaut 项目服务启停脚本
#=============================================================================
# 用法：
#   bash deploy.sh start          # 停止原进程后启动项目
#   bash deploy.sh stop           # 停止项目
#   bash deploy.sh restart        # 重启项目
#   bash deploy.sh status         # 查看服务和健康状态
#   bash deploy.sh logs [行数]    # 查看最近日志，默认 100 行
#   bash deploy.sh logs-follow    # 持续查看日志
#=============================================================================
set -euo pipefail

APP_SERVICE="${APP_SERVICE:-cybernaut-app}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4100/api/health/components}"
START_TIMEOUT_SECONDS="${START_TIMEOUT_SECONDS:-60}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-30}"
LOG_LINES="${LOG_LINES:-100}"

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
用法: bash deploy.sh <命令>

命令:
  start          停止原进程后启动 ${APP_SERVICE}.service
  stop           停止 ${APP_SERVICE}.service
  restart        重启 ${APP_SERVICE}.service
  status         查看 systemd 状态和应用健康状态
  logs [行数]    查看最近日志，默认 ${LOG_LINES} 行
  logs-follow    持续查看日志，按 Ctrl+C 退出
  help           显示本帮助

可选环境变量:
  APP_SERVICE               systemd 服务名，默认 ${APP_SERVICE}
  HEALTH_URL                健康检查地址，默认 ${HEALTH_URL}
  START_TIMEOUT_SECONDS     启动等待秒数，默认 ${START_TIMEOUT_SECONDS}
  STOP_TIMEOUT_SECONDS      停止等待秒数，默认 ${STOP_TIMEOUT_SECONDS}
  LOG_LINES                 默认日志行数，默认 ${LOG_LINES}
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

check_service_exists() {
    if ! systemctl cat "${APP_SERVICE}.service" >/dev/null 2>&1; then
        err "未找到 systemd 服务: ${APP_SERVICE}.service"
        err "请先安装当前项目的 systemd 服务单元"
        exit 1
    fi
}

wait_for_health() {
    local elapsed=0 code=""
    while (( elapsed < START_TIMEOUT_SECONDS )); do
        if ! systemctl is-active --quiet "${APP_SERVICE}.service"; then
            err "${APP_SERVICE}.service 在启动过程中退出"
            return 1
        fi
        code=$(curl --silent --show-error --output /dev/null \
            --write-out '%{http_code}' --max-time 3 "$HEALTH_URL" 2>/dev/null || true)
        if [ "$code" = "200" ]; then
            log "项目健康检查通过: ${HEALTH_URL}"
            return 0
        fi
        sleep 1
        ((elapsed += 1))
    done

    err "项目在 ${START_TIMEOUT_SECONDS} 秒内未通过健康检查（最后 HTTP: ${code:-不可达}）"
    return 1
}

show_failure_context() {
    systemctl status "${APP_SERVICE}.service" --no-pager --full || true
    journalctl --unit "${APP_SERVICE}.service" --lines 50 --no-pager || true
}

start_project() {
    step "启动项目"

    if systemctl is-active --quiet "${APP_SERVICE}.service"; then
        log "先停止原项目进程..."
        systemctl stop "${APP_SERVICE}.service"

        local elapsed=0
        while (( elapsed < STOP_TIMEOUT_SECONDS )); do
            if ! systemctl is-active --quiet "${APP_SERVICE}.service"; then
                break
            fi
            sleep 1
            ((elapsed += 1))
        done
        if systemctl is-active --quiet "${APP_SERVICE}.service"; then
            err "原项目进程在 ${STOP_TIMEOUT_SECONDS} 秒内未停止，取消启动"
            systemctl status "${APP_SERVICE}.service" --no-pager --full || true
            exit 1
        fi
        log "原项目进程已停止"
    fi

    systemctl start "${APP_SERVICE}.service"
    if ! wait_for_health; then
        show_failure_context
        exit 1
    fi
    log "项目启动完成"
}

stop_project() {
    step "停止项目"
    if ! systemctl is-active --quiet "${APP_SERVICE}.service"; then
        log "${APP_SERVICE}.service 已停止"
        return
    fi

    systemctl stop "${APP_SERVICE}.service"
    local elapsed=0
    while (( elapsed < STOP_TIMEOUT_SECONDS )); do
        if ! systemctl is-active --quiet "${APP_SERVICE}.service"; then
            log "项目已停止"
            return
        fi
        sleep 1
        ((elapsed += 1))
    done

    err "项目在 ${STOP_TIMEOUT_SECONDS} 秒内未停止"
    systemctl status "${APP_SERVICE}.service" --no-pager --full || true
    exit 1
}

restart_project() {
    step "重启项目"
    systemctl restart "${APP_SERVICE}.service"
    if ! wait_for_health; then
        show_failure_context
        exit 1
    fi
    log "项目重启完成"
}

show_status() {
    step "项目状态"
    systemctl status "${APP_SERVICE}.service" --no-pager --full || true

    printf '\n'
    if systemctl is-active --quiet "${APP_SERVICE}.service"; then
        local response_file code
        response_file=$(mktemp)
        code=$(curl --silent --show-error --output "$response_file" \
            --write-out '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || true)
        if [ "$code" = "200" ]; then
            log "健康检查正常（HTTP 200）"
            cat "$response_file"
            printf '\n'
        else
            warn "服务正在运行，但健康检查异常（HTTP ${code:-不可达}）"
        fi
        rm -f "$response_file"
    else
        warn "项目当前未运行"
    fi
}

show_logs() {
    local lines="${1:-$LOG_LINES}"
    validate_positive_integer "日志行数" "$lines"
    journalctl --unit "${APP_SERVICE}.service" --lines "$lines" --no-pager
}

follow_logs() {
    journalctl --unit "${APP_SERVICE}.service" --follow
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

    case "$command" in
        start)
            check_service_exists
            start_project
            ;;
        stop)
            check_service_exists
            stop_project
            ;;
        restart)
            check_service_exists
            restart_project
            ;;
        status)
            check_service_exists
            show_status
            ;;
        logs)
            check_service_exists
            show_logs "${2:-$LOG_LINES}"
            ;;
        logs-follow)
            check_service_exists
            follow_logs
            ;;
    esac
}

main "$@"
