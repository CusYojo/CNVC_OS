import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

type DependencyName = 'python' | 'libreOffice' | 'popplerRasterizer' | 'popplerFonts' | 'tesseract' | 'fontconfig'
type DependencyState = { available: boolean; configuredOverride: boolean; required: boolean }

const cacheTtlMs = 5 * 60_000
let cached: { expiresAt: number; value: DocumentNativeRuntimeHealth } | null = null

export type DocumentNativeRuntimeHealth = {
  ok: boolean
  kind: 'document-native-runtime'
  requiredDependencies: number
  availableDependencies: number
  missingRequired: number
  dependencies: Record<DependencyName, DependencyState>
  pathsExcluded: true
  versionsExcluded: true
}

function executableCandidates(environmentNames: string[], commands: string[], absoluteCandidates: string[] = []) {
  const configured = environmentNames.map((name) => process.env[name]?.trim()).filter(Boolean) as string[]
  const pathDirectories = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const pathCandidates = commands.flatMap((command) => pathDirectories.map((directory) => path.join(directory, command)))
  return { configured, candidates: [...configured, ...absoluteCandidates, ...pathCandidates] }
}

async function dependencyState(
  environmentNames: string[],
  commands: string[],
  absoluteCandidates: string[] = [],
  required = true,
): Promise<DependencyState> {
  const { configured, candidates } = executableCandidates(environmentNames, commands, absoluteCandidates)
  for (const candidate of [...new Set(candidates)]) {
    if (!path.isAbsolute(candidate)) continue
    if (await access(candidate, constants.X_OK).then(() => true).catch(() => false)) {
      return { available: true, configuredOverride: configured.includes(candidate), required }
    }
  }
  return { available: false, configuredOverride: configured.length > 0, required }
}

async function collect(): Promise<DocumentNativeRuntimeHealth> {
  const bundledDependencies = path.join(
    homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies',
  )
  const bundledOverride = path.join(bundledDependencies, 'bin', 'override')
  const bundledPoppler = path.join(bundledDependencies, 'native', 'poppler', 'poppler', 'bin')
  const dependencies = {
    python: await dependencyState(
      ['AI_PDF_TO_PPT_PYTHON', 'AI_DD_SKILL_PYTHON', 'AI_INVESTMENT_PROPOSAL_PYTHON', 'AI_QA_SKILL_PYTHON'],
      ['python3', 'python'],
      [path.resolve('server/.venv/bin/python')],
    ),
    libreOffice: await dependencyState(
      ['AI_SOFFICE_PATH', 'AI_PDF_TO_PPT_LIBREOFFICE', 'AI_QA_SOFFICE_BINARY'],
      ['soffice', 'libreoffice'],
      [path.join(bundledOverride, 'soffice'), '/Applications/LibreOffice.app/Contents/MacOS/soffice'],
    ),
    popplerRasterizer: await dependencyState(
      ['AI_PDF_TO_PPT_PDFTOPPM', 'AI_QA_PDFTOPPM_BINARY'],
      ['pdftoppm'],
      [path.join(bundledOverride, 'pdftoppm'), path.join(bundledPoppler, 'pdftoppm')],
    ),
    popplerFonts: await dependencyState(
      ['AI_PDFFONTS_BIN', 'AI_QA_PDFFONTS_BINARY'],
      ['pdffonts'],
      [path.join(bundledPoppler, 'pdffonts')],
    ),
    tesseract: await dependencyState(
      ['AI_PDF_TO_PPT_TESSERACT'],
      ['tesseract'],
      [],
      process.platform !== 'darwin',
    ),
    fontconfig: await dependencyState(
      [],
      ['fc-list'],
      [],
      process.platform !== 'darwin',
    ),
  } satisfies Record<DependencyName, DependencyState>
  const requiredDependencies = Object.values(dependencies).filter((item) => item.required).length
  const availableDependencies = Object.values(dependencies).filter((item) => item.available).length
  const availableRequiredDependencies = Object.values(dependencies)
    .filter((item) => item.required && item.available).length
  return {
    ok: availableRequiredDependencies === requiredDependencies,
    kind: 'document-native-runtime',
    requiredDependencies,
    availableDependencies,
    missingRequired: requiredDependencies - availableRequiredDependencies,
    dependencies,
    pathsExcluded: true,
    versionsExcluded: true,
  }
}

export async function documentNativeRuntimeHealth(now = Date.now()) {
  if (cached && cached.expiresAt > now) return cached.value
  const value = await collect()
  cached = { expiresAt: now + cacheTtlMs, value }
  return value
}

export function resetDocumentNativeRuntimeHealthCacheForAcceptance() {
  cached = null
}
