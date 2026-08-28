import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, existsSync, realpathSync } from 'node:fs'
import { access, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { projectQaCommandCandidates } from '../services/documentRuntimeDiscovery.js'

type NativeName = 'python' | 'libreOffice' | 'popplerRasterizer' | 'popplerText'
  | 'popplerFonts' | 'tesseract' | 'fontconfig' | 'legacyWordExtractor'
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
const mode = process.argv.includes('--native-only') ? 'native' : process.argv.includes('--live') ? 'live' : 'static'
export type RuntimeContext = { root: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string }
const runtimeContext = (): RuntimeContext => ({ root, env: process.env, platform: process.platform, home: homedir() })

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

async function executable(candidates: Array<string | undefined>, context: RuntimeContext) {
  const pathDirectories = (context.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const candidate of candidates.filter(Boolean) as string[]) {
    const resolvedCandidates = path.isAbsolute(candidate) || candidate.includes(path.sep)
      ? [path.resolve(context.root, candidate)]
      : pathDirectories.map((directory) => path.resolve(context.root, directory, candidate))
    for (const resolved of resolvedCandidates) {
      if (await stat(resolved).then(info => info.isFile()).catch(() => false)
        && await access(resolved, constants.X_OK).then(() => true).catch(() => false)) return resolved
    }
  }
  return null
}

async function commandOutput(command: string, args: string[], context: RuntimeContext) {
  const result = await execFileAsync(command, args, {
    cwd: context.root,
    env: context.env,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim()
}

function nativeCandidates(context: RuntimeContext) {
  const { root, env } = context
  const bundled = path.join(context.home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies')
  const override = path.join(bundled, 'bin', 'override')
  const poppler = path.join(bundled, 'native', 'poppler', 'poppler', 'bin')
  const candidates = {
    python: [
      env.AI_PDF_TO_PPT_PYTHON,
      path.resolve(root, 'server/.venv/bin/python3'),
      path.resolve(root, 'server/.venv/bin/python'),
      'python3',
    ],
    libreOffice: [
      env.AI_PDF_TO_PPT_LIBREOFFICE,
      env.AI_SOFFICE_PATH,
      env.AI_QA_SOFFICE_BINARY,
      path.join(override, 'soffice'),
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      'soffice',
      'libreoffice',
    ],
    popplerRasterizer: [
      env.AI_PDF_TO_PPT_PDFTOPPM,
      env.AI_QA_PDFTOPPM_BINARY,
      path.join(override, 'pdftoppm'),
      path.join(poppler, 'pdftoppm'),
      'pdftoppm',
    ],
    popplerText: [
      path.join(poppler, 'pdftotext'),
      'pdftotext',
    ],
    popplerFonts: [
      env.AI_PDFFONTS_BIN,
      env.AI_QA_PDFFONTS_BINARY,
      path.join(poppler, 'pdffonts'),
      'pdffonts',
    ],
    tesseract: [env.AI_PDF_TO_PPT_TESSERACT, 'tesseract'],
    fontconfig: [path.join(poppler, 'fc-list'), 'fc-list'],
    legacyWordExtractor: ['antiword'],
    fontMatch: [path.join(poppler, 'fc-match'), 'fc-match'],
  }
  // A preflight must not approve a broken explicit setting merely because a
  // different executable is installed. Runtime fallback behavior stays intact.
  const keys = {
    python: ['AI_PDF_TO_PPT_PYTHON'], libreOffice: ['AI_PDF_TO_PPT_LIBREOFFICE', 'AI_SOFFICE_PATH', 'AI_QA_SOFFICE_BINARY'],
    popplerRasterizer: ['AI_PDF_TO_PPT_PDFTOPPM', 'AI_QA_PDFTOPPM_BINARY'], popplerFonts: ['AI_PDFFONTS_BIN', 'AI_QA_PDFFONTS_BINARY'], tesseract: ['AI_PDF_TO_PPT_TESSERACT'],
  } as const
  for (const name of Object.keys(keys) as Array<keyof typeof keys>) {
    const explicit = keys[name].map(key => env[key]).find(Boolean)
    if (explicit) candidates[name] = [explicit]
  }
  return candidates
}

const commandArguments: Record<NativeName, string[]> = {
  python: ['--version'],
  libreOffice: ['--version'],
  popplerRasterizer: ['-v'],
  popplerText: ['-v'],
  popplerFonts: ['-v'],
  tesseract: ['--version'],
  fontconfig: ['--version'],
  legacyWordExtractor: ['-h'],
}

export async function loadDocumentRuntimeContract(projectRoot = root) {
  const manifestPath = path.resolve(projectRoot, 'server/document-runtime-dependencies.json')
  const manifestRaw = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestRaw) as DependencyManifest
  const lockPath = path.resolve(projectRoot, manifest.python.lockFile)
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

async function staticChecks(contract: Awaited<ReturnType<typeof loadDocumentRuntimeContract>>) {
  const [setupSource, deploySource] = await Promise.all([
    readFile(path.resolve(root, 'server/scripts/setup-pdf-to-ppt-runtime.mjs'), 'utf8'),
    readFile(path.resolve(root, 'deploy.sh'), 'utf8'),
  ])
  const requiredDirectPackages = [
    'pymupdf', 'pillow', 'opencv-python-headless', 'numpy', 'pypdf', 'reportlab',
    'python-docx', 'python-pptx', 'openpyxl', 'pandas', 'xlrd', 'scipy',
  ]
  const directPackagesLocked = requiredDirectPackages.every((name) => contract.packages.has(name))
  const setupUsesExactLock = /requirements-pdf-to-ppt\.lock\.txt/.test(setupSource)
  const setupRunsLiveVerification = /verifyDocumentRuntimeDependencies\.ts.*--live/s.test(setupSource)
  const deployRunsLiveVerification = /verify:document-runtime-dependencies/.test(deploySource)
  const linuxNativeContractComplete = [
    'python', 'libreOffice', 'popplerRasterizer', 'popplerText', 'popplerFonts',
    'tesseract', 'fontconfig', 'legacyWordExtractor',
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

export async function checkDocumentRuntime(contract: Awaited<ReturnType<typeof loadDocumentRuntimeContract>>, context = runtimeContext(), nativeOnly = false) {
  if (!['darwin', 'linux'].includes(context.platform)) {
    throw new Error('unsupported live verification platform')
  }
  const candidates = nativeCandidates(context)
  const required = new Set(contract.manifest.requiredByPlatform[context.platform as 'darwin' | 'linux'])
  const native = {} as Record<NativeName, {
    required: boolean
    available: boolean
    version: string | null
    versionOutputSha256: string | null
    compatible: boolean
    error: 'unavailable' | 'command_failed' | null
  }>
  const resolved = {} as Record<NativeName, string | null>
  for (const name of Object.keys(contract.manifest.native) as NativeName[]) {
    const command = await executable(candidates[name], context)
    resolved[name] = command
    let version: string | null = null
    let versionOutputSha256: string | null = null
    let error: 'unavailable' | 'command_failed' | null = command ? null : 'unavailable'
    if (command) try {
      const output = await commandOutput(command, commandArguments[name], context)
      version = versionTuple(output)?.join('.') || null
      versionOutputSha256 = sha256(output)
    } catch { error = 'command_failed' }
    native[name] = {
      required: required.has(name),
      available: Boolean(command),
      version,
      versionOutputSha256,
      compatible: Boolean(version && versionCompatible(version, contract.manifest.native[name])),
      error,
    }
  }
  const python = resolved.python
  const freeze = !nativeOnly && python ? await commandOutput(python, ['-m', 'pip', 'freeze'], context).catch(() => '') : ''
  const installed = new Map(freeze.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((pin) => {
    const [name, version] = pin.split('==')
    return [normalizedPackageName(name || ''), version || '']
  }))
  const exactPythonEnvironment = !nativeOnly && installed.size === contract.packages.size
    && [...contract.packages.entries()].every(([name, version]) => installed.get(name) === version)
  const pythonEnvironmentSummary = nativeOnly ? null : {
    expectedEntries: contract.packages.size,
    observedEntries: installed.size,
    missingEntries: [...contract.packages.keys()].filter(name => !installed.has(name)).length,
    versionMismatches: [...contract.packages.entries()].filter(([name, version]) => installed.has(name) && installed.get(name) !== version).length,
    unexpectedEntries: [...installed.keys()].filter(name => !contract.packages.has(name)).length,
  }
  const tesseractLanguages = Object.fromEntries(contract.manifest.linuxRequiredTesseractLanguages.map((name) => [name, false]))
  if (context.platform === 'linux' && resolved.tesseract) {
    const languageOutput = await commandOutput(resolved.tesseract, ['--list-langs'], context).catch(() => '')
    for (const language of Object.keys(tesseractLanguages)) tesseractLanguages[language] = languageOutput.split(/\s+/).includes(language)
  }
  const fontFamilies = Object.fromEntries(contract.manifest.linuxRequiredFontFamilies.map((name) => [name, false]))
  if (context.platform === 'linux') {
    const fontMatch = await executable(candidates.fontMatch, context)
    if (fontMatch) {
      for (const family of Object.keys(fontFamilies)) {
        const match = await commandOutput(fontMatch, ['-f', '%{family}', family], context).catch(() => '')
        fontFamilies[family] = fontFamilyMatches(match, family)
      }
    }
  }
  const requiredNativeCompatible = Object.values(native).every((item) => !item.required || (item.available && item.compatible))
  const languageContractSatisfied = context.platform !== 'linux' || Object.values(tesseractLanguages).every(Boolean)
  const fontContractSatisfied = context.platform !== 'linux' || Object.values(fontFamilies).every(Boolean)
  const qaCandidates = projectQaCommandCandidates(context.env, context.home)
  const qaKinds = { soffice: 'libreOffice', pdftoppm: 'popplerRasterizer', pdffonts: 'popplerFonts' } as const
  const qaKeys = { soffice: ['AI_QA_SOFFICE_BINARY', 'AI_PDF_TO_PPT_LIBREOFFICE'], pdftoppm: ['AI_QA_PDFTOPPM_BINARY', 'AI_PDF_TO_PPT_PDFTOPPM'], pdffonts: ['AI_QA_PDFFONTS_BINARY'] }
  const qaRender = {} as Record<keyof typeof qaKinds, { available: boolean; compatible: boolean; version: string | null; versionOutputSha256: string | null }>
  for (const name of Object.keys(qaKinds) as Array<keyof typeof qaKinds>) {
    const explicit = qaKeys[name].map(key => context.env[key]).find(Boolean)
    let output: string | null = null
    for (const candidate of explicit ? [explicit] : qaCandidates[name]) {
      const selected = await executable([candidate], context)
      if (selected) try { output = await commandOutput(selected, commandArguments[qaKinds[name]], context); break } catch { /* Same fallback order as QA when no explicit override. */ }
    }
    qaRender[name] = { available: output !== null, compatible: output !== null && versionCompatible(output, contract.manifest.native[qaKinds[name]]), version: output === null ? null : versionTuple(output)?.join('.') || null, versionOutputSha256: output === null ? null : sha256(output) }
  }
  const qaRenderRuntimeCompatible = Object.values(qaRender).every(item => item.available && item.compatible)
  return {
    ok: (nativeOnly || exactPythonEnvironment) && requiredNativeCompatible && languageContractSatisfied && fontContractSatisfied && qaRenderRuntimeCompatible,
    checks: {
      exactPythonEnvironment: nativeOnly ? null : exactPythonEnvironment,
      pythonPackagesChecked: !nativeOnly,
      requiredNativeCompatible,
      languageContractSatisfied,
      fontContractSatisfied,
      qaRenderRuntimeCompatible,
    },
    native,
    qaRender,
    pythonEnvironmentSummary,
    tesseractLanguages: context.platform === 'linux' ? tesseractLanguages : { required: false },
    fontFamilies: context.platform === 'linux' ? fontFamilies : { required: false },
  }
}

export function fontFamilyMatches(output: string, expected: string) {
  return output.split(/[,\r\n]/).some(family => family.trim().toLocaleLowerCase('en') === expected.toLocaleLowerCase('en'))
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => !['--live', '--static', '--native-only', '--stdout-only'].includes(arg)) || args.filter(arg => ['--live', '--static', '--native-only'].includes(arg)).length > 1) throw new Error('invalid document runtime verification arguments')
  const contract = await loadDocumentRuntimeContract()
  const verification = mode === 'static' ? await staticChecks(contract) : await checkDocumentRuntime(contract, runtimeContext(), mode === 'native')
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
  if (!args.includes('--stdout-only')) {
    const evidenceRoot = path.resolve(root, '.runtime/migration-evidence/document-runtime-dependencies')
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
    await chmod(evidenceRoot, 0o700)
    const reportPath = path.join(evidenceRoot, `${mode}-report.json`)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    await chmod(reportPath, 0o600)
  }
  console.log(JSON.stringify(report))
  if (!ok) process.exitCode = 1
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(() => {
  console.error(JSON.stringify({ ok: false, mode, code: 'DOCUMENT_RUNTIME_VERIFICATION_FAILED', error: '文档运行时检查失败；请核对参数、依赖锁和安装环境。', pathsExcluded: true }))
  process.exitCode = 1
})
