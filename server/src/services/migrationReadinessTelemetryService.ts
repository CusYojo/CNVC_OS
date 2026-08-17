import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

type JsonObject = Record<string, unknown>

const evidenceRoot = path.resolve(process.env.MIGRATION_EVIDENCE_ROOT?.trim() || '.runtime/migration-evidence')
const maximumStatusBytes = 2 * 1024 * 1024

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function nonNegative(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function isoTimestamp(value: unknown): string | null {
  const text = typeof value === 'string' ? value : ''
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null
}

async function readReport(relativePath: string): Promise<JsonObject | null> {
  const target = path.resolve(evidenceRoot, relativePath)
  const relative = path.relative(evidenceRoot, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  try {
    const metadata = await lstat(target)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumStatusBytes) return null
    return object(JSON.parse(await readFile(target, 'utf8')))
  } catch {
    return null
  }
}

export type MigrationReadinessHealth = {
  name: 'migration-readiness-evidence'
  kind: 'migration-readiness'
  ok: true
  ready: boolean
  fileManifest: {
    available: boolean
    generatedAt: string | null
    strict: boolean
    technicalReady: boolean
    approvalRecorded: boolean
    roots: number
    rootsPresent: number
    files: number
    blockingIssues: number
    unresolved: number
  }
  productionSources: {
    available: boolean
    generatedAt: string | null
    approved: boolean
  }
  radarAssets: {
    available: boolean
    generatedAt: string | null
    localTechnicalReady: boolean
    productionAssetReady: boolean
    fullSourceAssetReady: boolean
  }
  reconciliation: {
    available: boolean
    generatedAt: string | null
    targetStructuralIntegrityReady: boolean
    sourceReconciliationReady: boolean
    fullMigrationReady: boolean
  }
  pathsExcluded: true
  fileNamesExcluded: true
  identitiesExcluded: true
  businessContentExcluded: true
  secretsExcluded: true
}

export async function migrationReadinessHealth(): Promise<MigrationReadinessHealth> {
  const [fileManifestReport, productionSourceReport, radarReport, reconciliationReport] = await Promise.all([
    readReport('file-assets/status.json').then(async (report) => report ?? readReport('file-assets/manifest.json')),
    readReport('production-source-inventory/report.json'),
    readReport('radar-lead-source-reconciliation/report.json'),
    readReport('mysql-reconciliation/report.json'),
  ])
  const fileSummary = object(fileManifestReport?.summary)
  const fileApproval = object(fileManifestReport?.approval)
  const readiness = object(reconciliationReport?.readiness)
  const fileManifest = {
    available: Boolean(fileManifestReport),
    generatedAt: isoTimestamp(fileManifestReport?.generatedAt),
    strict: fileManifestReport?.strict === true,
    technicalReady: fileManifestReport?.technicalReady === true
      || (fileManifestReport?.strict === true && nonNegative(fileSummary.blockingIssues) === 0),
    approvalRecorded: fileApproval.approved === true,
    roots: nonNegative(fileSummary.roots),
    rootsPresent: nonNegative(fileSummary.rootsPresent),
    files: nonNegative(fileSummary.files),
    blockingIssues: nonNegative(fileSummary.blockingIssues),
    unresolved: nonNegative(fileSummary.unresolved),
  }
  const productionSources = {
    available: Boolean(productionSourceReport),
    generatedAt: isoTimestamp(productionSourceReport?.generatedAt),
    approved: productionSourceReport?.approved === true,
  }
  const radarAssets = {
    available: Boolean(radarReport),
    generatedAt: isoTimestamp(radarReport?.generatedAt),
    localTechnicalReady: radarReport?.localTechnicalReady === true,
    productionAssetReady: radarReport?.productionAssetReady === true,
    fullSourceAssetReady: radarReport?.fullSourceAssetReady === true,
  }
  const reconciliation = {
    available: Boolean(reconciliationReport),
    generatedAt: isoTimestamp(reconciliationReport?.generatedAt),
    targetStructuralIntegrityReady: readiness.targetStructuralIntegrityReady === true,
    sourceReconciliationReady: readiness.sourceReconciliationReady === true,
    fullMigrationReady: readiness.fullMigrationReady === true,
  }
  return {
    name: 'migration-readiness-evidence',
    kind: 'migration-readiness',
    ok: true,
    ready: fileManifest.technicalReady && fileManifest.approvalRecorded
      && productionSources.approved && radarAssets.fullSourceAssetReady
      && reconciliation.fullMigrationReady,
    fileManifest,
    productionSources,
    radarAssets,
    reconciliation,
    pathsExcluded: true,
    fileNamesExcluded: true,
    identitiesExcluded: true,
    businessContentExcluded: true,
    secretsExcluded: true,
  }
}
