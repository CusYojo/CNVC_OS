#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1
LOG="$SCRIPT_DIR/logs/batch_analyze_cron.log"
mkdir -p logs
echo "===== $(date) =====" >> "$LOG"
/usr/bin/node batch_analyze.mjs >> "$LOG" 2>&1
