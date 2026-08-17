import { chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectLogicalBackup } from './mysqlBackupRestoreAcceptance.js'

type BackupReport = {
  ok?: boolean
  format?: string
  version?: number
  prefix?: string
  tables?: number
  rows?: number
  sha256?: string
  ownerOnly?: boolean
  connectionIdentityExcluded?: boolean
}

type RestoreReport = {
  ok?: boolean
  tables?: number
  rows?: number
  ddlChecksumsMatch?: boolean
  rowCountsMatch?: boolean
  rowChecksumsMatch?: boolean
  isolatedPrefixRemoved?: boolean
  activePrefixPreserved?: boolean
  backupRemovedAfterAcceptance?: boolean
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be ${minimum}..${maximum}`)
  }
  return value
}

function role(name: string, fallback: string) {
  const value = (process.env[name] || fallback).trim()
  if (!/^[A-Za-z0-9_ .\-/\u4e00-\u9fff]{3,80}$/.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function mode(stat: Awaited<ReturnType<typeof lstat>>) {
  return Number(stat.mode) & 0o777
}

async function ownerOnlyFile(filePath: string) {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || mode(stat) !== 0o600) {
    throw new Error(`backup artifact must be a regular owner-only file: ${path.basename(filePath)}`)
  }
  return stat
}

async function latestRestoreDrill(root: string): Promise<{ createdAtMs: number; report: RestoreReport }> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || mode(rootStat) !== 0o700) {
    throw new Error('restore evidence root must be a regular owner-only directory')
  }
  const candidates: Array<{ createdAtMs: number; report: RestoreReport }> = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const reportPath = path.join(root, entry.name, 'report.json')
    try {
      const stat = await ownerOnlyFile(reportPath)
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as RestoreReport
      if (
        report.ok === true
        && report.ddlChecksumsMatch === true
        && report.rowCountsMatch === true
        && report.rowChecksumsMatch === true
        && report.isolatedPrefixRemoved === true
        && report.activePrefixPreserved === true
        && report.backupRemovedAfterAcceptance === true
      ) candidates.push({ createdAtMs: stat.mtimeMs, report })
    } catch {
      // An incomplete run is not accepted as a successful restore drill.
    }
  }
  candidates.sort((left, right) => right.createdAtMs - left.createdAtMs)
  if (!candidates[0]) throw new Error('no successful owner-only MySQL restore drill report was found')
  return candidates[0]
}

async function main() {
  const now = Date.now()
  const production = process.env.NODE_ENV === 'production'
  const backupRoot = path.resolve(process.env.MYSQL_BACKUP_ROOT || '.runtime/mysql-backups')
  const restoreEvidenceRoot = path.resolve(
    process.env.MYSQL_RESTORE_EVIDENCE_ROOT || '.runtime/migration-evidence/mysql-restore',
  )
  const evidenceRoot = path.resolve(
    process.env.MYSQL_BACKUP_INVENTORY_EVIDENCE_ROOT || '.runtime/migration-evidence/mysql-backup-inventory',
  )
  const retentionDays = boundedInteger('MYSQL_BACKUP_RETENTION_DAYS', 35, 7, 3650)
  const maxBackupAgeHours = boundedInteger('MYSQL_BACKUP_MAX_AGE_HOURS', production ? 26 : 168, 1, 8760)
  const maxRestoreDrillAgeDays = boundedInteger('MYSQL_RESTORE_DRILL_MAX_AGE_DAYS', 30, 1, 365)
  const backupOwnerRole = role('MYSQL_BACKUP_OWNER_ROLE', 'database-operations-on-call')
  const restoreOwnerRole = role('MYSQL_RESTORE_OWNER_ROLE', 'migration-release-commander')
  const approvalOwnerRole = role('MYSQL_BACKUP_APPROVER_ROLE', 'data-owner')
  const offsiteLocationConfigured = Boolean(process.env.MYSQL_BACKUP_OFFSITE_LOCATION_ID?.trim())
  const encryptionAtRestConfirmed = process.env.MYSQL_BACKUP_ENCRYPTION_AT_REST_CONFIRMED === 'true'
  if (production && (!offsiteLocationConfigured || !encryptionAtRestConfirmed)) {
    throw new Error('production backup policy requires configured offsite storage and confirmed encryption at rest')
  }

  const rootStat = await lstat(backupRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || mode(rootStat) !== 0o700) {
    throw new Error('backup root must be a regular owner-only directory')
  }
  const entries = await readdir(backupRoot, { withFileTypes: true })
  const backupNames = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^mysql-pre-migration-[A-Za-z0-9TZ-]+\.jsonl\.gz$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (!backupNames.length) throw new Error('no pre-migration backup was found')

  const inventory: Array<{
    backupIdSha256: string
    createdAt: string
    ageHours: number
    bytes: number
    tables: number
    rows: number
    ownerOnly: true
    reportMatched: true
  }> = []
  for (const name of backupNames) {
    const backupPath = path.join(backupRoot, name)
    const reportPath = `${backupPath}.report.json`
    const backupStat = await ownerOnlyFile(backupPath)
    await ownerOnlyFile(reportPath)
    const [inspected, report] = await Promise.all([
      inspectLogicalBackup(backupPath),
      readFile(reportPath, 'utf8').then((value) => JSON.parse(value) as BackupReport),
    ])
    const createdAtMs = Date.parse(inspected.header.createdAt)
    if (!Number.isFinite(createdAtMs) || createdAtMs > now + 60_000) throw new Error(`backup timestamp is invalid: ${name}`)
    const tables = inspected.footer.tables.length
    if (
      report.ok !== true
      || report.format !== inspected.header.format
      || report.version !== inspected.header.version
      || report.prefix !== inspected.header.tablePrefix
      || report.tables !== tables
      || report.rows !== inspected.totalRows
      || report.sha256 !== inspected.backupSha256
      || report.ownerOnly !== true
      || report.connectionIdentityExcluded !== true
    ) throw new Error(`backup report does not match backup content: ${name}`)
    inventory.push({
      backupIdSha256: inspected.backupSha256,
      createdAt: new Date(createdAtMs).toISOString(),
      ageHours: Number(((now - createdAtMs) / 3_600_000).toFixed(2)),
      bytes: backupStat.size,
      tables,
      rows: inspected.totalRows,
      ownerOnly: true,
      reportMatched: true,
    })
  }
  const newest = [...inventory].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  if (newest.ageHours > maxBackupAgeHours) {
    throw new Error(`newest backup exceeds ${maxBackupAgeHours}h freshness target`)
  }

  const restoreDrill = await latestRestoreDrill(restoreEvidenceRoot)
  const restoreDrillAgeDays = (now - restoreDrill.createdAtMs) / 86_400_000
  if (restoreDrillAgeDays > maxRestoreDrillAgeDays) {
    throw new Error(`latest restore drill exceeds ${maxRestoreDrillAgeDays}d freshness target`)
  }
  if (restoreDrill.report.tables !== newest.tables || restoreDrill.report.rows !== newest.rows) {
    throw new Error('latest restore drill does not cover the newest backup table/row scope')
  }

  const result = {
    ok: true,
    checks: [
      'backup-root-owner-only-and-not-symlink',
      'backup-and-report-owner-only-and-paired',
      'logical-format-manifest-and-footer-readable',
      'report-sha-table-row-and-prefix-match',
      'newest-backup-within-freshness-target',
      'successful-restore-drill-covers-newest-backup-scope',
      'retention-and-operational-owner-roles-recorded',
      'production-offsite-encryption-fails-closed',
      'connection-identity-and-secret-values-excluded',
    ],
    backups: inventory,
    newestBackupAgeHours: newest.ageHours,
    restoreDrillAgeDays: Number(restoreDrillAgeDays.toFixed(2)),
    policy: {
      retentionDays,
      maxBackupAgeHours,
      maxRestoreDrillAgeDays,
      backupOwnerRole,
      restoreOwnerRole,
      approvalOwnerRole,
      mediaCopies: 1 + Number(offsiteLocationConfigured),
      offsiteLocationConfigured,
      encryptionAtRestConfirmed,
      currentEnvironmentPolicySatisfied: !production || (offsiteLocationConfigured && encryptionAtRestConfirmed),
      productionRequirementsSatisfied: offsiteLocationConfigured && encryptionAtRestConfirmed,
    },
    connectionIdentityExcluded: true,
  }
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  await chmod(evidenceRoot, 0o700)
  const reportPath = path.join(evidenceRoot, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  await chmod(reportPath, 0o600)
  console.log(JSON.stringify(result))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
