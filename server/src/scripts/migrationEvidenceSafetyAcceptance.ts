import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

type Finding = {
  file: string
  kind: 'configured-secret' | 'credential-pattern' | 'sensitive-body' | 'invalid-json' | 'unsafe-permission' | 'symlink'
  location?: string
}

const root = process.cwd()
const evidenceRoot = path.resolve(process.env.MIGRATION_EVIDENCE_ROOT || '.runtime/migration-evidence')
const reportExtensions = new Set(['.json', '.md'])
const sensitiveValueEnvName = /(?:API_KEY|SECRET|SECRETS|PASSWORD|TOKEN|COOKIE|CREDENTIAL|CREDENTIALS)$/i
const sensitiveBodyKeys = new Set([
  'body', 'content', 'filecontent', 'fulltext', 'messagebody', 'messages', 'messagetext',
  'prompt', 'rawbody', 'rawcontent', 'rawmessage', 'rawtext', 'systemprompt', 'transcript',
])
const credentialPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bBearer\s+[^\s,;"']{12,}/gi,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  /(?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token|authorization|cookie)["']?\s*[:=]\s*["'][^"'\s,}]{8,}/gi,
]
const sensitiveBodyLine = /(?:原始正文|消息正文|文件正文|完整提示词|raw\s+(?:body|content|text)|message\s+(?:body|content)|transcript)\s*[:：]\s*\S.{15,}/gim
const quarantineControlReports = new Set(['report.json', 'summary.md', 'manifest.json', 'status.json'])

function shouldScanReportContent(file: string): boolean {
  if (!reportExtensions.has(path.extname(file))) return false
  const relative = path.relative(evidenceRoot, file)
  const segments = relative.split(path.sep)
  if (segments[0] !== 'quarantine') return true
  return segments.length === 3 && quarantineControlReports.has(segments[2])
}

function configuredSecrets(): string[] {
  return [...new Set(Object.entries(process.env).flatMap(([name, value]) => {
    if (!sensitiveValueEnvName.test(name) || !value) return []
    return [value, ...value.split(',')].map((item) => item.trim()).filter((item) => item.length >= 8)
  }))].sort((left, right) => right.length - left.length)
}

function hasSubstantiveValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0)
}

function scanJsonBody(value: unknown, file: string, location = '$', findings: Finding[] = []): Finding[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanJsonBody(item, file, `${location}[${index}]`, findings))
    return findings
  }
  if (!value || typeof value !== 'object') return findings
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (sensitiveBodyKeys.has(normalizedKey) && hasSubstantiveValue(child)) {
      findings.push({ file, kind: 'sensitive-body', location: childLocation })
    }
    scanJsonBody(child, file, childLocation, findings)
  }
  return findings
}

function scanReportText(file: string, text: string, secrets: string[]): Finding[] {
  const findings: Finding[] = []
  for (const secret of secrets) {
    if (text.includes(secret)) {
      findings.push({ file, kind: 'configured-secret' })
      break
    }
  }
  if (credentialPatterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })) findings.push({ file, kind: 'credential-pattern' })
  sensitiveBodyLine.lastIndex = 0
  if (sensitiveBodyLine.test(text)) findings.push({ file, kind: 'sensitive-body' })
  if (path.extname(file) === '.json') {
    try {
      findings.push(...scanJsonBody(JSON.parse(text), file))
    } catch {
      findings.push({ file, kind: 'invalid-json' })
    }
  }
  return findings
}

async function collectEvidenceFiles(directory: string): Promise<{ files: string[]; findings: Finding[] }> {
  const files: string[] = []
  const findings: Finding[] = []
  async function walk(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.resolve(current, entry.name)
      const relative = path.relative(evidenceRoot, absolute)
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) {
        findings.push({ file: relative, kind: 'symlink' })
        continue
      }
      if (metadata.isDirectory()) await walk(absolute)
      else if (metadata.isFile()) {
        files.push(absolute)
        if ((metadata.mode & 0o077) !== 0) findings.push({ file: relative, kind: 'unsafe-permission' })
      }
    }
  }
  await walk(directory)
  return { files, findings }
}

function runSelfTest() {
  const fixtureSecret = 'fixture-super-secret-123456'
  const safe = scanReportText('safe.json', JSON.stringify({ counts: { messages: 3 }, sha256: 'a'.repeat(64) }), [fixtureSecret])
  if (safe.length) throw new Error('[migration-evidence-safety] safe fixture was rejected')
  const findings = [
    ...scanReportText('configured.json', JSON.stringify({ value: fixtureSecret }), [fixtureSecret]),
    ...scanReportText('credential.json', JSON.stringify({ api_key: `sk-${'x'.repeat(32)}` }), []),
    ...scanReportText('body.json', JSON.stringify({ content: 'fixture business body' }), []),
  ]
  const kinds = new Set(findings.map((finding) => finding.kind))
  for (const kind of ['configured-secret', 'credential-pattern', 'sensitive-body'] as const) {
    if (!kinds.has(kind)) throw new Error(`[migration-evidence-safety] unsafe fixture was not rejected: ${kind}`)
  }
  if (JSON.stringify(findings).includes(fixtureSecret)) {
    throw new Error('[migration-evidence-safety] finding metadata disclosed a matched secret')
  }
  if (
    !shouldScanReportContent(path.join(evidenceRoot, 'quarantine', 'fixture', 'report.json'))
    || shouldScanReportContent(path.join(evidenceRoot, 'quarantine', 'fixture', 'asset', 'original.md'))
    || !shouldScanReportContent(path.join(evidenceRoot, 'mysql-reconciliation', 'report.json'))
  ) throw new Error('[migration-evidence-safety] quarantine original/report boundary is invalid')
}

async function main() {
  runSelfTest()
  const rootMetadata = await lstat(evidenceRoot).catch(() => null)
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('[migration-evidence-safety] migration evidence root is missing or unsafe')
  }
  const inventory = await collectEvidenceFiles(evidenceRoot)
  const reportFiles = inventory.files.filter(shouldScanReportContent)
  const quarantineOriginalFiles = inventory.files.filter((file) => {
    const segments = path.relative(evidenceRoot, file).split(path.sep)
    return segments[0] === 'quarantine' && !shouldScanReportContent(file)
  })
  const secrets = configuredSecrets()
  const findings = [...inventory.findings]
  for (const absolute of reportFiles) {
    const relative = path.relative(evidenceRoot, absolute)
    findings.push(...scanReportText(relative, await readFile(absolute, 'utf8'), secrets))
  }
  if (findings.length) {
    throw new Error(`[migration-evidence-safety] ${JSON.stringify({ findings })}`)
  }
  console.log(JSON.stringify({
    ok: true,
    files: inventory.files.length,
    reportFiles: reportFiles.length,
    quarantineOriginalFiles: quarantineOriginalFiles.length,
    configuredSecretValuesChecked: secrets.length,
    checks: [
      'unsafe-fixtures-rejected-without-value-disclosure',
      'configured-and-generic-secret-pattern-scan',
      'json-sensitive-body-field-denylist',
      'markdown-sensitive-body-pattern-scan',
      'evidence-file-owner-only-permissions',
      'evidence-symlink-rejection',
      'quarantine-originals-permission-only-and-control-reports-content-scanned',
    ],
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
