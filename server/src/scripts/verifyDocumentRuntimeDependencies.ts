import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

type NativeName = 'python' | 'libreOffice' | 'popplerRasterizer' | 'popplerFonts' | 'tesseract' | 'fontconfig'
type VersionRange = { minimum: string; maximumExclusive: string }
type DependencyManifest = {
  schemaVersion: string
  python: { lockFile: string; lockSha256: string; packageCount: number }
  native: Record<NativeName, VersionRange>
  requiredByPlatform: { darwin: NativeName[]; linux: NativeName[] }
  linuxRequiredTesseractLanguages: string[]
  linuxRequiredFontFamilies: string[]
  pathsExcludedFromEvidence: boolean
  versionsRequiredInEvidence: boolean
}

const execFileAsync = promisify(execFile)
const root = process.cwd()
const manifestPath = path.resolve(root, 'server/document-runtime-dependencies.json')
const mode = process.argv.includes('--live') ? 'live' : 'static'

function sha256(data: string | Buffer) {
  return createHash('sha256').update(data).digest('hex')
}

function normalizedPackageName(value: string) {
  return value.trim().toLowerCase().replace(/[_.]+/g, '-')
}

function versionTuple(value: string) {
  const match = value.match(/\d+(?:\.\d+){1,3}/)
  if (!match) return null
  return match[0].split('.').map((part) => Number(part))
}

function compareVersions(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

function versionCompatible(versionText: string, range: VersionRange) {
  const version = versionTuple(versionText)
  const minimum = versionTuple(range.minimum)
  const maximum = versionTuple(range.maximumExclusive)
  return Boolean(version && minimum && maximum
    && compareVersions(version, minimum) >= 0
    && compareVersions(version, maximum) < 0)
}

async function executable(candidates: Array<string | undefined>) {
  const pathDirectories = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const candidate of candidates.filter(Boolean) as string[]) {
    const resolvedCandidates = path.isAbsolute(candidate)
      ? [candidate]
      : pathDirectories.map((directory) => path.join(directory, candidate))
    for (const resolved of resolvedCandidates) {
      if (await access(resolved, constants.X_OK).then(() => true).catch(() => false)) return resolved
    }
  }
  return null
}

async function commandOutput(command: string, args: string[]) {
  const result = await execFileAsync(command, args, {
    cwd: root,
    env: process.env,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim()
}

function nativeCandidates() {
  const bundled = path.join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies')
  const override = path.join(bundled, 'bin', 'override')
  const poppler = path.join(bundled, 'native', 'poppler', 'poppler', 'bin')
  return {
    python: [
      process.env.AI_PDF_TO_PPT_PYTHON,
      path.resolve(root, 'server/.venv/bin/python3'),
      path.resolve(root, 'server/.venv/bin/python'),
      'python3',
    ],
    libreOffice: [
      process.env.AI_PDF_TO_PPT_LIBREOFFICE,
      process.env.AI_SOFFICE_PATH,
      process.env.AI_QA_SOFFICE_BINARY,
      path.join(override, 'soffice'),
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      'soffice',
      'libreoffice',
    ],
    popplerRasterizer: [
      process.env.AI_PDF_TO_PPT_PDFTOPPM,
      process.env.AI_QA_PDFTOPPM_BINARY,
      path.join(override, 'pdftoppm'),
      path.join(poppler, 'pdftoppm'),
      'pdftoppm',
    ],
    popplerFonts: [
      process.env.AI_PDFFONTS_BIN,
      process.env.AI_QA_PDFFONTS_BINARY,
      path.join(poppler, 'pdffonts'),
      'pdffonts',
    ],
    tesseract: [process.env.AI_PDF_TO_PPT_TESSERACT, 'tesseract'],
    fontconfig: [path.join(poppler, 'fc-list'), 'fc-list'],
    fontMatch: [path.join(poppler, 'fc-match'), 'fc-match'],
  }
}

const commandArguments: Record<NativeName, string[]> = {
  python: ['--version'],
  libreOffice: ['--version'],
  popplerRasterizer: ['-v'],
  popplerFonts: ['-v'],
  tesseract: ['--version'],
  fontconfig: ['--version'],
}

async function loadContract() {
  const manifestRaw = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestRaw) as DependencyManifest
  const lockPath = path.resolve(root, manifest.python.lockFile)
  const lockRaw = await readFile(lockPath, 'utf8')
  const pins = lockRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const exactPinPattern = /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+$/
  const packages = new Map<string, string>()
  for (const pin of pins) {
    if (!exactPinPattern.test(pin)) throw new Error(`Python lock contains a non-exact requirement: ${pin}`)
    const [name, version] = pin.split('==')
    const normalized = normalizedPackageName(name || '')
    if (!normalized || !version || packages.has(normalized)) throw new Error(`Python lock contains an invalid duplicate: ${pin}`)
    packages.set(normalized, version)
  }
  const lockHash = sha256(lockRaw)
  if (manifest.schemaVersion !== '1.0') throw new Error('unsupported document runtime dependency schema')
  if (manifest.python.lockSha256 !== lockHash) throw new Error('Python dependency lock SHA-256 differs from manifest')
  if (manifest.python.packageCount !== packages.size) throw new Error('Python dependency lock package count differs from manifest')
  if (!manifest.pathsExcludedFromEvidence || !manifest.versionsRequiredInEvidence) {
    throw new Error('dependency evidence privacy/version contract is incomplete')
  }
  for (const [name, range] of Object.entries(manifest.native)) {
    if (!versionTuple(range.minimum) || !versionTuple(range.maximumExclusive)
      || compareVersions(versionTuple(range.minimum)!, versionTuple(range.maximumExclusive)!) >= 0) {
      throw new Error(`invalid native dependency range: ${name}`)
    }
  }
  for (const platform of ['darwin', 'linux'] as const) {
    if (!manifest.requiredByPlatform[platform].length) throw new Error(`empty required dependency list: ${platform}`)
  }
  return { manifest, lockHash, packages }
}

async function staticChecks(contract: Awaited<ReturnType<typeof loadContract>>) {
  const [setupSource, deploySource] = await Promise.all([
    readFile(path.resolve(root, 'server/scripts/setup-pdf-to-ppt-runtime.mjs'), 'utf8'),
    readFile(path.resolve(root, 'deploy.sh'), 'utf8'),
  ])
  const requiredDirectPackages = [
    'pymupdf', 'pillow', 'opencv-python-headless', 'numpy', 'pypdf', 'reportlab', 'python-pptx',
  ]
  const directPackagesLocked = requiredDirectPackages.every((name) => contract.packages.has(name))
  const setupUsesExactLock = /requirements-pdf-to-ppt\.lock\.txt/.test(setupSource)
  const setupRunsLiveVerification = /verifyDocumentRuntimeDependencies\.ts.*--live/s.test(setupSource)
  const deployRunsLiveVerification = /verify:document-runtime-dependencies/.test(deploySource)
  const linuxNativeContractComplete = [
    'python', 'libreOffice', 'popplerRasterizer', 'popplerFonts', 'tesseract', 'fontconfig',
  ].every((name) => contract.manifest.requiredByPlatform.linux.includes(name as NativeName))
  const linuxLanguageAndFontContractComplete = ['chi_sim', 'eng'].every((language) => (
    contract.manifest.linuxRequiredTesseractLanguages.includes(language)
  )) && ['Noto Sans CJK SC', 'Noto Serif CJK SC'].every((family) => (
    contract.manifest.linuxRequiredFontFamilies.includes(family)
  ))
  return {
    ok: directPackagesLocked && setupUsesExactLock && setupRunsLiveVerification
      && deployRunsLiveVerification && linuxNativeContractComplete && linuxLanguageAndFontContractComplete,
    checks: {
      exactPythonTransitiveLock: contract.packages.size === contract.manifest.python.packageCount,
      lockSha256MatchesManifest: true,
      requiredDirectPackagesLocked: directPackagesLocked,
      setupUsesExactLock,
      setupRunsLiveVerification,
      deployRunsLiveVerification,
      linuxNativeContractComplete,
      linuxLanguageAndFontContractComplete,
    },
  }
}

async function liveChecks(contract: Awaited<ReturnType<typeof loadContract>>) {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error(`unsupported live verification platform: ${process.platform}`)
  }
  const candidates = nativeCandidates()
  const required = new Set(contract.manifest.requiredByPlatform[process.platform as 'darwin' | 'linux'])
  const native = {} as Record<NativeName, {
    required: boolean
    available: boolean
    version: string | null
    versionOutputSha256: string | null
    compatible: boolean
  }>
  const resolved = {} as Record<NativeName, string | null>
  for (const name of Object.keys(contract.manifest.native) as NativeName[]) {
    const command = await executable(candidates[name])
    resolved[name] = command
    let version: string | null = null
    let versionOutputSha256: string | null = null
    if (command) {
      const output = await commandOutput(command, commandArguments[name])
      version = versionTuple(output)?.join('.') || null
      versionOutputSha256 = sha256(output)
    }
    native[name] = {
      required: required.has(name),
      available: Boolean(command),
      version,
      versionOutputSha256,
      compatible: Boolean(version && versionCompatible(version, contract.manifest.native[name])),
    }
  }
  const python = resolved.python
  if (!python) throw new Error('document runtime Python is unavailable')
  const freeze = await commandOutput(python, ['-m', 'pip', 'freeze'])
  const installed = new Map(freeze.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((pin) => {
    const [name, version] = pin.split('==')
    return [normalizedPackageName(name || ''), version || '']
  }))
  const exactPythonEnvironment = installed.size === contract.packages.size
    && [...contract.packages.entries()].every(([name, version]) => installed.get(name) === version)
  const tesseractLanguages = Object.fromEntries(contract.manifest.linuxRequiredTesseractLanguages.map((name) => [name, false]))
  if (process.platform === 'linux' && resolved.tesseract) {
    const languageOutput = await commandOutput(resolved.tesseract, ['--list-langs'])
    for (const language of Object.keys(tesseractLanguages)) tesseractLanguages[language] = languageOutput.split(/\s+/).includes(language)
  }
  const fontFamilies = Object.fromEntries(contract.manifest.linuxRequiredFontFamilies.map((name) => [name, false]))
  if (process.platform === 'linux') {
    const fontMatch = await executable(candidates.fontMatch)
    if (fontMatch) {
      for (const family of Object.keys(fontFamilies)) {
        const match = await commandOutput(fontMatch, ['-f', '%{family}', family])
        fontFamilies[family] = /Noto/i.test(match) && /CJK/i.test(match)
      }
    }
  }
  const requiredNativeCompatible = Object.values(native).every((item) => !item.required || (item.available && item.compatible))
  const languageContractSatisfied = process.platform !== 'linux' || Object.values(tesseractLanguages).every(Boolean)
  const fontContractSatisfied = process.platform !== 'linux' || Object.values(fontFamilies).every(Boolean)
  return {
    ok: exactPythonEnvironment && requiredNativeCompatible && languageContractSatisfied && fontContractSatisfied,
    checks: {
      exactPythonEnvironment,
      requiredNativeCompatible,
      languageContractSatisfied,
      fontContractSatisfied,
    },
    native,
    tesseractLanguages: process.platform === 'linux' ? tesseractLanguages : { required: false },
    fontFamilies: process.platform === 'linux' ? fontFamilies : { required: false },
  }
}

async function main() {
  const contract = await loadContract()
  const verification = mode === 'live' ? await liveChecks(contract) : await staticChecks(contract)
  const { ok, ...verificationDetails } = verification
  const report = {
    ok,
    mode,
    platform: process.platform,
    schemaVersion: contract.manifest.schemaVersion,
    pythonLock: { sha256: contract.lockHash, packageCount: contract.packages.size, exactPins: true },
    ...verificationDetails,
    pathsExcluded: true,
    environmentValuesExcluded: true,
    businessContentExcluded: true,
    generatedAt: new Date().toISOString(),
  }
  const evidenceRoot = path.resolve(root, '.runtime/migration-evidence/document-runtime-dependencies')
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  await chmod(evidenceRoot, 0o700)
  const reportPath = path.join(evidenceRoot, `${mode}-report.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await chmod(reportPath, 0o600)
  console.log(JSON.stringify(report))
  if (!ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, mode, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
