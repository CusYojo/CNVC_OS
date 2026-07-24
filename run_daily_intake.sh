#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
/usr/bin/node --env-file=.env daily_intake.mjs >> daily_intake.log 2>&1
