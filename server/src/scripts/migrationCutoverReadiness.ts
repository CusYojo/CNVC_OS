import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

type JsonObject = Record<string, unknown>
type Probe = { ok: boolean; exitCode: number | null; value: JsonObject | null }
type Blocker = { code: string; category: string; count: number }

const root = process.cwd()
const evidenceRoot = path.resolve(root, '.runtime/migration-evidence')
const outputDir = path.join(evidenceRoot, 'cutover-readiness')
const strict = process.argv.includes('--strict')
const supportedArgs = new Set(['--strict'])

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[cutover readiness] ${message}`)
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function nonNegative(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function lastJson(output: string): JsonObject | null {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject
    } catch {}
  }
  return null
}

function runProbe(args: string[], expectedExitCodes: number[]): Promise<Probe> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: {
        ...process.env,
        MIGRATION_WRITE_FREEZE: 'true',
        MIGRATION_WRITE_FREEZE_MODE: 'rollback-window',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let exceeded = false
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > 2_000_000) { exceeded = true; child.kill('SIGTERM') }
    })
    child.stderr.on('data', () => undefined)
    child.once('error', () => resolve({ ok: false, exitCode: null, value: null }))
    child.once('exit', (exitCode) => {
      const value = exceeded ? null : lastJson(stdout)
      resolve({ ok: expectedExitCodes.includes(exitCode ?? -1) && Boolean(value), exitCode, value })
    })
  })
}

async function readEvidence(relativePath: string): Promise<JsonObject | null> {
  const target = path.resolve(evidenceRoot, relativePath)
  const relative = path.relative(evidenceRoot, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  try {
    const metadata = await lstat(target)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4_000_000) return null
    return object(JSON.parse(await readFile(target, 'utf8')))
  } catch {
    return null
  }
}

function freshTargetLinuxEvidence(report: JsonObject | null) {
  if (!report || report.ok !== true || report.mode !== 'live-target-linux') return false
  const generated = typeof report.generatedAt === 'string' ? Date.parse(report.generatedAt) : Number.NaN
  return Number.isFinite(generated) && generated <= Date.now() && Date.now() - generated <= 24 * 60 * 60 * 1000
}

async function main() {
  assert(process.argv.slice(2).every((argument) => supportedArgs.has(argument)), 'unsupported argument')
  const nodeWithEnvironment = ['--env-file-if-exists=.env', '--import', 'tsx']
  const [reconciliationProbe, passwordProbe, checklistProbe, runtimeProbe] = await Promise.all([
    runProbe([...nodeWithEnvironment, 'server/src/scripts/mysqlMigrationReconciliationAudit.ts', '--strict-full'], [0, 3]),
    runProbe([...nodeWithEnvironment, 'server/src/scripts/passwordHashAudit.ts'], [0, 2]),
    runProbe(['--import', 'tsx', 'server/src/scripts/migrationChecklistStatusAcceptance.ts'], [0]),
    runProbe([...nodeWithEnvironment, 'server/src/scripts/singleServiceRuntimeAcceptance.ts', '--observe-existing'], [0]),
  ])
  const [reconciliationReport, targetLinuxReport] = await Promise.all([
    readEvidence('mysql-reconciliation/report.json'),
    readEvidence('target-single-service/live-report.json'),
  ])
  const reconciliationReadiness = object(reconciliationReport?.readiness)
  const targetDataIntegrityReady = reconciliationReadiness.targetStructuralIntegrityReady === true
  const fullSourceAndBusinessReconciliationReady = reconciliationReadiness.fullMigrationReady === true
  const weakTargetUsers = nonNegative(passwordProbe.value?.weakTargetUsers)
  const invalidPasswords = nonNegative(passwordProbe.value?.plaintextOrInvalid)
  const passwordMappingsReady = nonNegative(passwordProbe.value?.mappedUsers) === nonNegative(passwordProbe.value?.sourceUsers)
    && nonNegative(passwordProbe.value?.mappedUsers) === nonNegative(passwordProbe.value?.targetUsers)
  const migratedPasswordSecurityReady = passwordProbe.ok && passwordProbe.value?.ok === true
    && weakTargetUsers === 0 && invalidPasswords === 0 && passwordMappingsReady
  const currentSingleServiceReady = runtimeProbe.ok && runtimeProbe.value?.ok === true
    && runtimeProbe.value?.processMutation === false
  const targetLinuxDeploymentReady = freshTargetLinuxEvidence(targetLinuxReport)
  const pendingP0 = nonNegative(checklistProbe.value?.pendingP0)
  const deferredProductionBlockers = nonNegative(checklistProbe.value?.productionBlockingDeferrals)
  const unapprovedAcceptanceExceptions = nonNegative(checklistProbe.value?.unapprovedExceptions)
  const pendingProductionSmoke = nonNegative(checklistProbe.value?.pendingProductionSmoke)
  const pendingFinalConfirmations = nonNegative(checklistProbe.value?.pendingFinalConfirmations)
  const allP0AcceptanceReady = checklistProbe.ok && pendingP0 === 0
  const productionBlockingDeferralsReady = checklistProbe.ok && deferredProductionBlockers === 0
  const acceptanceExceptionsReady = checklistProbe.ok && unapprovedAcceptanceExceptions === 0
  const productionSmokeReady = checklistProbe.ok && pendingProductionSmoke === 0
  const finalAcceptanceConfirmationsReady = checklistProbe.ok && pendingFinalConfirmations === 0
  const dimensions = {
    targetDataIntegrityReady,
    fullSourceAndBusinessReconciliationReady,
    migratedPasswordSecurityReady,
    currentSingleServiceReady,
    targetLinuxDeploymentReady,
    allP0AcceptanceReady,
    productionBlockingDeferralsReady,
    acceptanceExceptionsReady,
    productionSmokeReady,
    finalAcceptanceConfirmationsReady,
  }
  const blockers: Blocker[] = []
  const reconciliationBlockers = Array.isArray(reconciliationReport?.blockers) ? reconciliationReport.blockers : []
  for (const raw of reconciliationBlockers) {
    const item = object(raw)
    const code = typeof item.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(item.code) ? item.code : 'RECONCILIATION_BLOCKER'
    const category = typeof item.category === 'string' && /^[a-z][a-z0-9_-]+$/.test(item.category) ? item.category : 'reconciliation'
    blockers.push({ code, category, count: Math.max(1, nonNegative(item.count)) })
  }
  if (!reconciliationProbe.ok || !reconciliationReport) blockers.push({ code: 'RECONCILIATION_PROBE_FAILED', category: 'execution', count: 1 })
  if (!passwordProbe.ok) blockers.push({ code: 'PASSWORD_AUDIT_PROBE_FAILED', category: 'execution', count: 1 })
  else {
    if (invalidPasswords > 0 || !passwordMappingsReady) blockers.push({ code: 'MIGRATED_PASSWORD_INTEGRITY_NOT_READY', category: 'security', count: Math.max(1, invalidPasswords) })
    if (weakTargetUsers > 0) blockers.push({ code: 'WEAK_PASSWORD_ACCOUNTS_REMAIN', category: 'security', count: weakTargetUsers })
  }
  if (!runtimeProbe.ok || !currentSingleServiceReady) blockers.push({ code: 'CURRENT_SINGLE_SERVICE_NOT_READY', category: 'runtime', count: 1 })
  if (!targetLinuxDeploymentReady) blockers.push({ code: 'TARGET_LINUX_DEPLOYMENT_EVIDENCE_NOT_READY', category: 'deployment', count: 1 })
  if (!checklistProbe.ok) blockers.push({ code: 'ACCEPTANCE_CHECKLIST_PROBE_FAILED', category: 'execution', count: 1 })
  else {
    if (pendingP0 > 0) blockers.push({ code: 'P0_ACCEPTANCE_ITEMS_PENDING', category: 'acceptance', count: pendingP0 })
    if (deferredProductionBlockers > 0) blockers.push({
      code: 'DEFERRED_PRODUCTION_BLOCKERS_REMAIN', category: 'security', count: deferredProductionBlockers,
    })
    if (unapprovedAcceptanceExceptions > 0) blockers.push({
      code: 'UNAPPROVED_ACCEPTANCE_EXCEPTIONS_REMAIN', category: 'acceptance', count: unapprovedAcceptanceExceptions,
    })
    if (pendingProductionSmoke > 0) blockers.push({
      code: 'PRODUCTION_SMOKE_ITEMS_PENDING', category: 'acceptance', count: pendingProductionSmoke,
    })
    if (pendingFinalConfirmations > 0) blockers.push({
      code: 'FINAL_ACCEPTANCE_CONFIRMATIONS_PENDING', category: 'acceptance', count: pendingFinalConfirmations,
    })
  }
  const uniqueBlockers = [...new Map(blockers.map((item) => [item.code, item])).values()].sort((left, right) => left.code.localeCompare(right.code))
  const ready = Object.values(dimensions).every(Boolean) && uniqueBlockers.length === 0
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    mode: 'read-only',
    ready,
    dimensions,
    counts: {
      reconciliationBlockers: reconciliationBlockers.length,
      weakTargetUsers,
      invalidPasswords,
      pendingP0,
      deferredProductionBlockers,
      unapprovedAcceptanceExceptions,
      pendingProductionSmoke,
      pendingFinalConfirmations,
      totalBlockers: uniqueBlockers.length,
    },
    blockers: uniqueBlockers,
    probes: {
      reconciliation: reconciliationProbe.ok,
      passwordAudit: passwordProbe.ok,
      checklist: checklistProbe.ok,
      currentSingleService: runtimeProbe.ok,
      targetLinuxEvidenceAvailable: Boolean(targetLinuxReport),
    },
    pathsExcluded: true,
    fileNamesExcluded: true,
    identitiesExcluded: true,
    businessContentExcluded: true,
    secretsExcluded: true,
    databaseSessionsReadOnly: true,
    databaseWrites: 0,
    processMutation: false,
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const target = path.join(outputDir, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  console.log(JSON.stringify({
    ok: ready,
    ready,
    dimensions,
    blockerCount: uniqueBlockers.length,
    blockerCodes: uniqueBlockers.map((item) => item.code),
    databaseWrites: 0,
    processMutation: false,
    sensitiveDetailsExcluded: true,
    databaseSessionsReadOnly: true,
  }))
  if (strict && !ready) process.exitCode = 2
}

await main()
