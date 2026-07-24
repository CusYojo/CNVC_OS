#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
python3 -m uvicorn app:app --host 0.0.0.0 --port "${PORT:-9888}"

