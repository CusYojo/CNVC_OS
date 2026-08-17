/**
 * Retired direct lead mutation entrypoint.
 *
 * Lead subject review now belongs to the MySQL-backed Pipeline
 * Run/Decision/Evidence/Review flow. A standalone model call must never rename
 * or hide formal leads outside that transaction and audit boundary.
 */

export {}

const result = {
  ok: false,
  code: 'LEAD_SUBJECT_REPAIR_REQUIRES_PIPELINE_REVIEW',
  message: '直接主体修复已停用；请通过正式 Pipeline 决策、证据和人工复核流程处理。',
  destructiveWriteAttempted: false,
}

console.error(JSON.stringify(result))
process.exitCode = 78
