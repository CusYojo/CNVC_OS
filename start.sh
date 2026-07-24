#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
pkill -f server-dist/index.js 2>/dev/null || true
sleep 1
mkdir -p logs server/generated
exec node --env-file=.env server-dist/index.js
