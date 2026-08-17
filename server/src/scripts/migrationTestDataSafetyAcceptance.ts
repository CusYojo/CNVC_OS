import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

type Finding = { file: string; kind: string }

const root = process.cwd()
const allowedEmailDomains = new Set(['example.invalid', 'example.com', 'invalid.local', 'mysql.invalid'])
const secretEnvName = /(?:API_KEY|SECRET|PASSWORD|TOKEN|COOKIE|CREDENTIAL|CREDENTIALS)$/i

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[migration test data safety] ${message}`)
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function configuredSecrets() {
  return [...new Set(Object.entries(process.env).flatMap(([name, value]) => {
    if (!secretEnvName.test(name) || !value) return []
    return [value, ...value.split(',')].map((item) => item.trim()).filter((item) => item.length >= 8)
  }))]
}

async function sourceFiles() {
  const scriptsRoot = path.resolve(root, 'server/src/scripts')
  const testsRoot = path.resolve(root, 'server/tests')
  const assetsRoot = path.resolve(root, 'server/assets')
  const scripts = (await readdir(scriptsRoot)).filter((name) => name.endsWith('Acceptance.ts'))
    .filter((name) => !['migrationEvidenceSafetyAcceptance.ts', 'migrationTestDataSafetyAcceptance.ts'].includes(name))
    .map((name) => path.join(scriptsRoot, name))
  const tests = (await readdir(testsRoot)).filter((name) => name.endsWith('.test.ts')).map((name) => path.join(testsRoot, name))
  const assets = (await readdir(assetsRoot)).filter((name) => /(?:gold|fixture).*\.json$/i.test(name)).map((name) => path.join(assetsRoot, name))
  return [...scripts, ...tests, ...assets].sort()
}

function scanSource(file: string, text: string, secrets: string[]) {
  const findings: Finding[] = []
  const relative = path.relative(root, file)
  if (secrets.some((secret) => text.includes(secret))) findings.push({ file: relative, kind: 'configured-secret-value' })
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)) findings.push({ file: relative, kind: 'api-key-literal' })
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push({ file: relative, kind: 'private-key-literal' })
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/.test(text)) findings.push({ file: relative, kind: 'bearer-token-literal' })
  if (/\b1[3-9][0-9]{9}\b/.test(text)) findings.push({ file: relative, kind: 'mainland-phone-literal' })
  if (/\b[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]\b/.test(text)) {
    findings.push({ file: relative, kind: 'mainland-id-literal' })
  }
  if (/password\s*:\s*['"](?:123456|password|admin|qwerty|letmein)['"]/i.test(text)) {
    findings.push({ file: relative, kind: 'known-weak-login-password' })
  }
  for (const email of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
    const domain = email[1]!.toLowerCase()
    const negativeDemoAssertion = relative.endsWith('clientStateAuthorityAcceptance.ts')
      && ['cybernaut.com'].includes(domain)
    if (!allowedEmailDomains.has(domain) && !negativeDemoAssertion) {
      findings.push({ file: relative, kind: 'non-reserved-email-domain' })
      break
    }
  }
  return findings
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/migration-test-data-safety')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  const writeAtomic = async (target: string, content: string) => {
    const temporary = `${target}.${process.pid}-${Date.now()}`
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, target)
    await chmod(target, 0o600)
  }
  await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  await writeAtomic(summaryPath, [
    '# 迁移测试数据安全验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    '- 扫描全部迁移验收脚本、服务测试及版本化金标/夹具 JSON',
    '- 拒绝当前环境真实密钥值、接口密钥、私钥、认证令牌、身份证号、手机号、非保留域邮箱和已知弱登录密码',
    '- AI API 验收使用随机 `.invalid` 账号与强密码，并在项目/会话清理后按精确用户 ID 清零',
    '- 测试证据继续由独立安全门禁检查正文、权限、符号链接和配置密钥泄漏',
    '',
    '报告只保存文件数量、内容清单哈希和检查类型，不保存源代码、业务正文、身份或密钥值。',
    '',
  ].join('\n'))
}

async function main() {
  const files = await sourceFiles()
  const secrets = configuredSecrets()
  const texts = await Promise.all(files.map(async (file) => ({ file, text: await readFile(file, 'utf8') })))
  const findings = texts.flatMap(({ file, text }) => scanSource(file, text, secrets))
  assertContract(!findings.length, `unsafe test-data findings: ${JSON.stringify(findings)}`)
  const aiTaskApi = texts.find((item) => item.file.endsWith('aiTaskApiAcceptance.ts'))?.text || ''
  const fixtureReadiness = texts.find((item) => item.file.endsWith('migrationFixtureReadinessAcceptance.ts'))?.text || ''
  const socketAcceptance = texts.find((item) => item.file.endsWith('socketAcceptance.ts'))?.text || ''
  const jwMultiTurnAcceptance = texts.find((item) => item.file.endsWith('jwMultiTurnLiveAcceptance.ts'))?.text || ''
  assertContract(!/admin@cybernaut\.com|lin@cybernaut\.com|password:\s*['"]123456/.test(aiTaskApi), 'AI API acceptance still uses fixed demo identities or passwords')
  assertContract(/createAcceptanceUsers/.test(aiTaskApi) && /cleanupAcceptanceUsers/.test(aiTaskApi), 'AI API acceptance random identity lifecycle is incomplete')
  assertContract(/@example\.invalid/.test(aiTaskApi) && /randomUUID\(\)/.test(aiTaskApi), 'AI API acceptance does not use reserved random identities')
  assertContract(/syntheticOnly: true/.test(fixtureReadiness) && /fixtureCleanupPending = false/.test(fixtureReadiness), 'migration fixture synthesis or cleanup contract is incomplete')
  assertContract(!/accountRows|ne\(users\.role/.test(socketAcceptance), 'Socket acceptance still selects or modifies existing business users')
  assertContract(/@example\.invalid/.test(socketAcceptance) && /cleanupAcceptanceState/.test(socketAcceptance), 'Socket acceptance synthetic identity lifecycle is incomplete')
  assertContract(/@example\.invalid/.test(jwMultiTurnAcceptance) && /residualUsers\.length === 0/.test(jwMultiTurnAcceptance), 'JW multi-turn acceptance synthetic identity lifecycle is incomplete')
  assertContract(
    /residualProjects\.length === 0/.test(jwMultiTurnAcceptance)
      && /residualMembers\.length === 0/.test(jwMultiTurnAcceptance),
    'JW project conversation acceptance synthetic project lifecycle is incomplete',
  )
  const manifest = texts.map(({ file, text }) => ({ file: path.relative(root, file), sha256: sha256(text) }))
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    scannedFiles: files.length,
    acceptanceScripts: files.filter((file) => file.endsWith('Acceptance.ts')).length,
    serviceTests: files.filter((file) => file.endsWith('.test.ts')).length,
    goldAndFixtureAssets: files.filter((file) => file.endsWith('.json')).length,
    configuredSecretValuesChecked: secrets.length,
    sourceManifestSha256: sha256(JSON.stringify(manifest)),
    findings: 0,
    checks: [
      'configured-secret-values-absent-from-test-sources',
      'credential-and-private-key-literals-absent',
      'phone-and-mainland-id-literals-absent',
      'only-reserved-test-email-domains',
      'known-weak-login-passwords-absent',
      'ai-api-random-identity-exact-cleanup',
      'socket-random-identity-exact-cleanup',
      'jw-multiturn-random-identity-exact-cleanup',
      'jw-project-conversation-random-project-and-membership-exact-cleanup',
      'synthetic-fixture-zero-residue-contract',
      'evidence-excludes-source-content-identities-and-secrets',
    ],
  }
  await persistEvidence(report)
  console.log(JSON.stringify(report))
}

await main()
