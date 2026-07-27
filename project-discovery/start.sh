#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-.venv/bin/python}"
if [ ! -x "$PYTHON_BIN" ]; then
    PYTHON_BIN=python3
fi

ENV_FILE="${ENV_FILE:-../.env}"
ENV_ARGS=()
if [ -f "$ENV_FILE" ]; then
    ENV_ARGS=(--env-file "$ENV_FILE")
fi

exec "$PYTHON_BIN" -m uvicorn app:app "${ENV_ARGS[@]}" \
    --host "${HOST:-127.0.0.1}" \
    --port "${PORT:-8121}"
