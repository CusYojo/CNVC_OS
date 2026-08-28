import assert from 'node:assert/strict'
import path from 'node:path'

// This guard is for synthetic acceptance only, not authorization to merge
// business leads. The release runner owns the fresh prefix and temporary cwd.
export function assertLeadDuplicateAcceptanceIsolation(env: NodeJS.ProcessEnv, cwd: string) {
  assert.match(env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/, 'LEAD_ACCEPTANCE_REQUIRES_ISOLATED_PREFIX')
  assert.equal(env.DB_FREFIX, env.LEAD_ACCEPTANCE_PREFIX, 'LEAD_ACCEPTANCE_PREFIX_MISMATCH')
  assert.match(env.LEAD_ACCEPTANCE_SOURCE_PREFIX ?? '', /^[A-Za-z0-9_]+$/, 'LEAD_ACCEPTANCE_SOURCE_REQUIRED')
  assert.notEqual(env.DB_FREFIX, env.LEAD_ACCEPTANCE_SOURCE_PREFIX, 'LEAD_ACCEPTANCE_BUSINESS_PREFIX_FORBIDDEN')
  assert.ok(env.LEAD_ACCEPTANCE_ROOT && path.isAbsolute(env.LEAD_ACCEPTANCE_ROOT), 'LEAD_ACCEPTANCE_ROOT_REQUIRED')
  assert.equal(path.resolve(cwd), env.LEAD_ACCEPTANCE_ROOT, 'LEAD_ACCEPTANCE_TEMP_CWD_REQUIRED')
  assert.match(path.basename(cwd), /^lead-duplicate-release-[A-Za-z0-9]+$/, 'LEAD_ACCEPTANCE_TEMP_ROOT_REQUIRED')
}
