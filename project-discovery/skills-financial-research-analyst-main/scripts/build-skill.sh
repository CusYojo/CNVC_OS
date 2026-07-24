#!/bin/bash
set -e

# Navigate to repo root (parent of scripts/)
cd "$(dirname "$0")/.."

VERSION="${1:?Version is required as first argument}"
SKILL_NAME="bigdata-financial-research-analyst"
OUTPUT_DIR="scripts/output"
OUTPUT_FILE="${OUTPUT_DIR}/${SKILL_NAME}_${VERSION}.skill"

# Ensure output directory exists
mkdir -p "${OUTPUT_DIR}"

echo "Building skill package: ${OUTPUT_FILE}"

if command -v zip >/dev/null 2>&1; then
  zip -r "${OUTPUT_FILE}" bigdata-financial-research-analyst/
else
  python3 -m zipfile -c "${OUTPUT_FILE}" bigdata-financial-research-analyst
fi

echo "Created: ${OUTPUT_FILE}"
