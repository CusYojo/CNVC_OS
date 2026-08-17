import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

type Trigger = {
  id: string
  metric: string
  operator: string
  threshold: number
  minimumSample: number
  windowSeconds: number
  action: string
}
type Policy = {
  version: number
  phase: string
  approval: { status: string; requiredRoles: string[] }
  globalRules: Record<string, unknown>
  domains: Array<{ id: string; scope: string; triggers: Trigger[] }>
}

const policyPath = path.resolve('server/migration/cutover-rollback-thresholds.v1.json')
const policy = JSON.parse(await readFile(policyPath, 'utf8')) as Policy
assert.equal(policy.version, 1)
assert.equal(policy.phase, 'pre-ponr-read-only-rollback-window')
assert.equal(policy.approval.status, 'pending-production-window-approval')
assert.deepEqual(new Set(policy.approval.requiredRoles), new Set([
  'business-owner', 'technical-owner', 'data-owner', 'security-owner', 'operations-owner',
]))
assert.equal(policy.globalRules.safeRollbackRequiresAllTargetWriteDeltasEqualZero, true)
assert.equal(policy.globalRules.anyTargetWriteMakesAutomaticRollbackIneligible, true)
assert.equal(policy.globalRules.afterPonrAction, 'forward-repair-only')
assert.equal(policy.globalRules.reverseCdcAvailable, false)

const expectedDomains = ['ai', 'data', 'leads', 'login', 'mysql', 'permissions']
assert.deepEqual(policy.domains.map((domain) => domain.id).sort(), expectedDomains)
const allowedOperators = new Set(['>', '>='])
const allowedActions = new Set([
  'rollback-if-all-write-deltas-zero',
  'halt-and-adjudicate-no-automatic-rollback',
])
for (const domain of policy.domains) {
  assert.ok(domain.scope.trim().length >= 20, `${domain.id}: scope missing`)
  assert.ok(domain.triggers.length >= 2, `${domain.id}: at least two triggers required`)
  assert.ok(domain.triggers.some((trigger) => trigger.action === 'rollback-if-all-write-deltas-zero'))
  assert.ok(domain.triggers.some((trigger) => trigger.action === 'halt-and-adjudicate-no-automatic-rollback'))
  for (const trigger of domain.triggers) {
    assert.match(trigger.id, /^[a-z0-9-]+$/)
    assert.match(trigger.metric, /^[a-z0-9_]+$/)
    assert.ok(allowedOperators.has(trigger.operator), `${trigger.id}: invalid operator`)
    assert.ok(Number.isFinite(trigger.threshold) && trigger.threshold >= 0, `${trigger.id}: invalid threshold`)
    assert.ok(Number.isInteger(trigger.minimumSample) && trigger.minimumSample >= 1, `${trigger.id}: invalid minimum sample`)
    assert.ok(Number.isInteger(trigger.windowSeconds) && trigger.windowSeconds >= 0, `${trigger.id}: invalid window`)
    assert.ok(allowedActions.has(trigger.action), `${trigger.id}: invalid action`)
  }
}
const triggerIds = policy.domains.flatMap((domain) => domain.triggers.map((trigger) => trigger.id))
assert.equal(new Set(triggerIds).size, triggerIds.length, 'trigger IDs must be unique')

const report = {
  ok: true,
  capturedAt: new Date().toISOString(),
  policyVersion: policy.version,
  phase: policy.phase,
  domains: policy.domains.length,
  triggers: triggerIds.length,
  productionApprovalPending: true,
  reverseCdcAvailable: false,
  afterPonrAction: 'forward-repair-only',
}
const evidenceDirectory = path.resolve('.runtime/migration-evidence/cutover-rollback-thresholds')
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
await writeFile(path.join(evidenceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(report))
