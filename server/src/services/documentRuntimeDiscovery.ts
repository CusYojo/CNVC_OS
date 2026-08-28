import { homedir } from 'node:os'
import path from 'node:path'

// Shared with deployment checks: preserve the QA renderer's candidate order.
// This module has no database, model, filesystem mutation or process side effects.
export function projectQaCommandCandidates(env: NodeJS.ProcessEnv = process.env, homeDirectory = homedir()) {
  const dependencies = path.join(homeDirectory, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies')
  const override = path.join(dependencies, 'bin', 'override')
  const poppler = path.join(dependencies, 'native', 'poppler', 'poppler', 'bin')
  return {
    soffice: [env.AI_QA_SOFFICE_BINARY, env.AI_PDF_TO_PPT_LIBREOFFICE, 'soffice', path.join(override, 'soffice'), '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice'],
    pdftoppm: [env.AI_QA_PDFTOPPM_BINARY, env.AI_PDF_TO_PPT_PDFTOPPM, 'pdftoppm', path.join(override, 'pdftoppm'), '/opt/homebrew/bin/pdftoppm'],
    pdffonts: [env.AI_QA_PDFFONTS_BINARY, 'pdffonts', path.join(poppler, 'pdffonts'), '/opt/homebrew/bin/pdffonts'],
  }
}
