import { createHash } from 'node:crypto'
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

type JsonObject = Record<string, unknown>

const args = process.argv.slice(2)
const enable = args.includes('--enable')
const disable = args.includes('--disable')
const apply = args.includes('--apply')

function value(name: string): string | null {
  const indexes = args.flatMap((argument, index) => argument === name ? [index] : [])
  if (indexes.length !== 1 || !args[indexes[0] + 1] || args[indexes[0] + 1].startsWith('--')) return null
  return args[indexes[0] + 1]
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PONR approval must be a JSON object')
  return value as JsonObject
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`PONR approval ${label} must be an ISO timestamp`)
  }
  if (Date.parse(value) > Date.now() + 5 * 60_000) throw new Error(`PONR approval ${label} cannot be in the future`)
  return value
}

function nonNegativeSequence(value: unknown, label: string): void {
  if ((typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    && (typeof value !== 'string' || !/^\d+$/.test(value))) {
    throw new Error(`PONR approval ${label} must be a non-negative integer or decimal string`)
  }
}

function assertNoCredentialFields(value: unknown, location = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoCredentialFields(child, `${location}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/(?:api.?key|authorization|cookie|credential|password|secret|token)/i.test(key)) {
      throw new Error(`PONR approval must not contain credential field ${location}.${key}`)
    }
    assertNoCredentialFields(child, `${location}.${key}`)
  }
}

async function readOwnerOnlyRegularFile(file: string, label: string): Promise<{ bytes: Buffer; mode: number }> {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only (0600 or stricter)`)
  return { bytes: await readFile(file), mode: stat.mode & 0o777 }
}

async function validatePonrApproval(file: string): Promise<string> {
  const { bytes } = await readOwnerOnlyRegularFile(file, 'PONR approval file')
  const approval = objectValue(JSON.parse(bytes.toString('utf8')))
  assertNoCredentialFields(approval)
  if (approval.schemaVersion !== '1.0') throw new Error('PONR approval schemaVersion must be 1.0')
  if (approval.environment !== 'production') throw new Error('PONR approval environment must be production')
  if (approval.decision !== 'point-of-no-return' || approval.approved !== true) {
    throw new Error('PONR approval must explicitly approve point-of-no-return')
  }
  if (approval.thresholdPolicyVersion !== 1) throw new Error('PONR approval thresholdPolicyVersion must be 1')
  if (typeof approval.commitSha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(approval.commitSha)) {
    throw new Error('PONR approval commitSha must be a 40-64 character hexadecimal revision')
  }
  for (const field of ['reconciliationReportSha256', 'fileManifestSha256'] as const) {
    if (typeof approval[field] !== 'string' || !/^[0-9a-f]{64}$/i.test(approval[field])) {
      throw new Error(`PONR approval ${field} must be SHA-256`)
    }
  }
  nonNegativeSequence(approval.sourceSafeWatermark, 'sourceSafeWatermark')
  nonNegativeSequence(approval.targetSequence, 'targetSequence')
  isoDate(approval.approvedAt, 'approvedAt')
  const approvals = objectValue(approval.approvals)
  const roles = ['business', 'technical', 'data', 'security', 'operations'] as const
  const identities = new Set<string>()
  for (const role of roles) {
    const current = objectValue(approvals[role])
    const approvedBy = typeof current.approvedBy === 'string' ? current.approvedBy.trim() : ''
    if (!/^[A-Za-z0-9._:@-]{3,128}$/.test(approvedBy)) {
      throw new Error(`PONR approval ${role}.approvedBy must be a stable non-empty identity`)
    }
    isoDate(current.approvedAt, `${role}.approvedAt`)
    if (identities.has(approvedBy)) throw new Error('PONR approval requires five distinct approver identities')
    identities.add(approvedBy)
  }
  return sha256(bytes)
}

function updateEnvironment(source: string, desired: Record<string, string>): { output: string; changedKeys: string[] } {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = source.endsWith('\n')
  const lines = source.split(/\r?\n/)
  if (trailingNewline) lines.pop()
  const indexes = new Map<string, number[]>()
  lines.forEach((line, index) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || !(match[1] in desired)) return
    indexes.set(match[1], [...(indexes.get(match[1]) || []), index])
  })
  for (const [key, occurrences] of indexes) {
    if (occurrences.length !== 1) throw new Error(`environment file contains duplicate ${key} entries`)
  }
  const changedKeys: string[] = []
  for (const [key, nextValue] of Object.entries(desired)) {
    const occurrence = indexes.get(key)?.[0]
    const nextLine = `${key}=${nextValue}`
    if (occurrence === undefined) {
      lines.push(nextLine)
      changedKeys.push(key)
    } else if (lines[occurrence] !== nextLine) {
      lines[occurrence] = nextLine
      changedKeys.push(key)
    }
  }
  return { output: `${lines.join(newline)}${trailingNewline ? newline : ''}`, changedKeys: changedKeys.sort() }
}

async function main(): Promise<void> {
  if (enable === disable) throw new Error('specify exactly one of --enable or --disable')
  const envInput = value('--env-file')
  if (!envInput) throw new Error('--env-file is required')
  const envFile = path.resolve(envInput)
  const approvalInput = value('--ponr-approval-file')
  if (disable && !approvalInput) throw new Error('--disable requires --ponr-approval-file')
  if (enable && approvalInput) throw new Error('--ponr-approval-file is only valid with --disable')
  const approvalSha256 = disable ? await validatePonrApproval(path.resolve(approvalInput!)) : null
  const original = await readOwnerOnlyRegularFile(envFile, 'environment file')
  const originalSha256 = sha256(original.bytes)
  const desired = enable
    ? { MIGRATION_WRITE_FREEZE: 'true', MIGRATION_WRITE_FREEZE_MODE: 'rollback-window' }
    : { MIGRATION_WRITE_FREEZE: 'false', MIGRATION_WRITE_FREEZE_MODE: '' }
  const update = updateEnvironment(original.bytes.toString('utf8'), desired)
  if (apply && update.changedKeys.length) {
    const current = await readOwnerOnlyRegularFile(envFile, 'environment file')
    if (sha256(current.bytes) !== originalSha256) throw new Error('environment file changed after preview; retry')
    const temporary = path.join(path.dirname(envFile), `.${path.basename(envFile)}.write-freeze-${process.pid}-${Date.now()}`)
    try {
      await writeFile(temporary, update.output, { mode: 0o600, flag: 'wx' })
      await rename(temporary, envFile)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
  console.log(JSON.stringify({
    ok: true,
    operation: enable ? 'enter-rollback-window' : 'cross-point-of-no-return',
    mode: apply ? 'apply' : 'preview',
    applied: apply,
    idempotent: update.changedKeys.length === 0,
    changedKeys: update.changedKeys,
    environmentPathExcluded: true,
    environmentBeforeSha256: originalSha256,
    environmentAfterSha256: sha256(update.output),
    ponrApprovalSha256: approvalSha256,
    secretsExcluded: true,
  }))
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, message: (error as Error).message }))
  process.exitCode = 1
})
