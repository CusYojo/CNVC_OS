/**
 * Retired destructive entrypoint.
 *
 * Historical versions of this script selected the oldest row for every exact
 * duplicate lead name, merged a subset of fields, then physically deleted the
 * remaining rows when invoked with --apply. Exact names are not stable legal
 * entity identities, and the migration decision ledger requires all 42
 * existing duplicate groups to receive an explicit business disposition.
 */

export {}

const result = {
  ok: false,
  code: 'LEAD_DEDUP_REQUIRES_APPROVED_LEDGER',
  message: '自动线索去重已停用；必须使用绑定版本化业务裁决、逐组预期行版本和可回放审计的处置工具。',
  destructiveWriteAttempted: false,
}

console.error(JSON.stringify(result))
process.exitCode = 78
