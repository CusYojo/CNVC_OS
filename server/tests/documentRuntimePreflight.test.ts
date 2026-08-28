import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test, { type TestContext } from 'node:test'
import { checkDocumentRuntime, fontFamilyMatches, loadDocumentRuntimeContract, type RuntimeContext } from '../src/scripts/verifyDocumentRuntimeDependencies.js'
import { projectQaCommandCandidates } from '../src/services/documentRuntimeDiscovery.js'

const project = process.cwd()
const contract = await loadDocumentRuntimeContract()
const verifier = 'server/src/scripts/verifyDocumentRuntimeDependencies.ts'
const discovery = 'server/src/services/documentRuntimeDiscovery.ts'

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'fde-native-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}')
  const runner = `#!${process.execPath}\nconst path=require('node:path');const fs=require('node:fs');const name=path.basename(process.argv[1]);const args=process.argv.slice(2);if(process.env.PROBE_TRACE)fs.appendFileSync(process.env.PROBE_TRACE,name+' '+args.join(' ')+'\\n');if(process.env.PROBE_FAIL===name){console.error('synthetic-private-path-and-secret');process.exit(3)};const versions={python3:'Python 3.12.1',soffice:'LibreOffice 24.2.0',pdftoppm:'pdftoppm version 24.2.0',pdftotext:'pdftotext version 24.2.0',pdffonts:'pdffonts version 24.2.0','old-pdffonts':'pdffonts version 21.0.0',tesseract:'tesseract 5.4.0','fc-list':'fontconfig version 2.15.0',antiword:'antiword version 0.37.0'};let value=versions[name]||'';if(name==='fc-match')value=process.env.PROBE_FONT||args.at(-1);if(args.includes('--list-langs'))value=process.env.PROBE_LANGS||'chi_sim\\neng';if(args.includes('freeze'))value=process.env.PROBE_BAD_PACKAGES?'other-package==1.0':${JSON.stringify(readFileSync(path.join(project, 'server/requirements-pdf-to-ppt.lock.txt'), 'utf8'))};process.stdout.write(value+'\\n');\n`
  for (const name of ['python3', 'soffice', 'pdftoppm', 'pdftotext', 'pdffonts', 'old-pdffonts', 'tesseract', 'fc-list', 'fc-match', 'antiword']) writeFileSync(path.join(bin, name), runner, { mode: 0o700 })
  const env: NodeJS.ProcessEnv = { PATH: bin, PROBE_TRACE: path.join(root, 'trace'), AI_PDF_TO_PPT_PYTHON: path.join(bin, 'python3'), AI_QA_SOFFICE_BINARY: path.join(bin, 'soffice'), AI_QA_PDFTOPPM_BINARY: path.join(bin, 'pdftoppm'), AI_QA_PDFFONTS_BINARY: path.join(bin, 'pdffonts') }
  const context: RuntimeContext = { root, env, home: path.join(root, 'synthetic-home'), platform: 'linux' }
  return { root, bin, context }
}

test('document preflight: shared QA candidates preserve original order and configured precedence', () => {
  const home = '/synthetic-home'
  const env = { AI_QA_SOFFICE_BINARY: '/qa/office', AI_PDF_TO_PPT_LIBREOFFICE: '/ppt/office', AI_QA_PDFTOPPM_BINARY: '/qa/raster', AI_PDF_TO_PPT_PDFTOPPM: '/ppt/raster', AI_QA_PDFFONTS_BINARY: '/qa/fonts' }
  const actual = projectQaCommandCandidates(env, home)
  const deps = path.join(home, '.cache/codex-runtimes/codex-primary-runtime/dependencies')
  assert.deepEqual(actual.soffice, ['/qa/office', '/ppt/office', 'soffice', path.join(deps, 'bin/override/soffice'), '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice'])
  assert.deepEqual(actual.pdftoppm, ['/qa/raster', '/ppt/raster', 'pdftoppm', path.join(deps, 'bin/override/pdftoppm'), '/opt/homebrew/bin/pdftoppm'])
  assert.deepEqual(actual.pdffonts, ['/qa/fonts', 'pdffonts', path.join(deps, 'native/poppler/poppler/bin/pdffonts'), '/opt/homebrew/bin/pdffonts'])
})

test('document preflight: native-only does not claim Python package validation or invoke pip', async t => {
  const { context } = fixture(t)
  const result = await checkDocumentRuntime(contract, context, true)
  assert.equal(result.ok, true)
  assert.equal(result.checks.exactPythonEnvironment, null)
  assert.equal(result.checks.pythonPackagesChecked, false)
  assert.equal(result.pythonEnvironmentSummary, null)
  assert.equal(result.checks.qaRenderRuntimeCompatible, true)
  assert.doesNotMatch(readFileSync(context.env.PROBE_TRACE!, 'utf8'), /freeze|install/)
  assert.doesNotMatch(JSON.stringify(result), /fde-native-preflight-|synthetic-home/)
})

test('document preflight: full mode still enforces the exact package lock', async t => {
  const { context } = fixture(t)
  assert.equal((await checkDocumentRuntime(contract, context)).ok, true)
  context.env.PROBE_BAD_PACKAGES = '1'
  const result = await checkDocumentRuntime(contract, context)
  assert.equal(result.ok, false)
  assert.equal(result.checks.exactPythonEnvironment, false)
  assert.deepEqual(result.pythonEnvironmentSummary, { expectedEntries: contract.packages.size, observedEntries: 1, missingEntries: contract.packages.size, versionMismatches: 0, unexpectedEntries: 1 })
})

test('document preflight: QA executable is checked even when generic tool passes', async t => {
  const { context, bin } = fixture(t)
  context.env.AI_PDFFONTS_BIN = path.join(bin, 'pdffonts')
  context.env.AI_QA_PDFFONTS_BINARY = path.join(bin, 'old-pdffonts')
  const result = await checkDocumentRuntime(contract, context, true)
  assert.equal(result.native.popplerFonts.compatible, true)
  assert.equal(result.qaRender.pdffonts.version, '21.0.0')
  assert.equal(result.qaRender.pdffonts.compatible, false)
  assert.equal(result.ok, false)
})

test('document preflight: explicit missing/failed commands do not approve fallback or leak errors', async t => {
  const { context, bin } = fixture(t)
  context.env.AI_QA_PDFFONTS_BINARY = path.join(bin, 'missing-sensitive-tool')
  let result = await checkDocumentRuntime(contract, context, true)
  assert.equal(result.ok, false)
  assert.equal(result.qaRender.pdffonts.available, false)
  context.env.AI_QA_PDFFONTS_BINARY = path.join(bin, 'pdffonts')
  context.env.PROBE_FAIL = 'pdffonts'
  result = await checkDocumentRuntime(contract, context, true)
  assert.equal(result.native.popplerFonts.error, 'command_failed')
  assert.equal(result.ok, false)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|secret|missing-sensitive-tool|fde-native-preflight-/)
})

test('document preflight: exact CJK family and language checks reject substitute fonts and missing OCR data', async t => {
  assert.equal(fontFamilyMatches('Noto Sans CJK SC', 'Noto Serif CJK SC'), false)
  assert.equal(fontFamilyMatches('Noto Sans CJK TC', 'Noto Sans CJK SC'), false)
  assert.equal(fontFamilyMatches('Noto Sans CJK SC Extra', 'Noto Sans CJK SC'), false)
  assert.equal(fontFamilyMatches('alias,Noto Serif CJK SC\n', 'Noto Serif CJK SC'), true)
  const { context } = fixture(t)
  context.env.PROBE_FONT = 'Noto Sans CJK SC'
  context.env.PROBE_LANGS = 'eng'
  const result = await checkDocumentRuntime(contract, context, true)
  assert.equal(result.checks.fontContractSatisfied, false)
  assert.equal(result.checks.languageContractSatisfied, false)
  assert.equal(result.ok, false)
})

test('document preflight: relative explicit executable is resolved against project root', async t => {
  const { context } = fixture(t)
  context.env.AI_QA_PDFFONTS_BINARY = 'bin/pdffonts'
  assert.equal((await checkDocumentRuntime(contract, context, true)).ok, true)
})

function prepareCliFixture(t: TestContext) {
  const item = fixture(t)
  for (const file of [verifier, discovery, 'server/document-runtime-dependencies.json', 'server/requirements-pdf-to-ppt.lock.txt']) {
    mkdirSync(path.dirname(path.join(item.root, file)), { recursive: true })
    writeFileSync(path.join(item.root, file), readFileSync(path.join(project, file)))
  }
  writeFileSync(path.join(item.root, 'package.json'), '{"type":"module"}')
  symlinkSync(path.join(project, 'node_modules'), path.join(item.root, 'node_modules'), 'dir')
  symlinkSync(process.execPath, path.join(item.bin, 'node'))
  return item
}

test('document preflight: real CLI through symlink path reports native mode without evidence writes', t => {
  const { root, context } = prepareCliFixture(t)
  const r = spawnSync(process.execPath, ['--import', 'tsx', verifier, '--native-only', '--stdout-only'], { cwd: root, env: context.env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(report.mode, 'native')
  assert.equal(report.checks.pythonPackagesChecked, false)
  assert.equal(existsSync(path.join(root, '.runtime')), false)
  const bad = spawnSync(process.execPath, ['--import', 'tsx', verifier, '--live', '--native-only', '--stdout-only'], { cwd: root, env: context.env, encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.equal(JSON.parse(bad.stderr).code, 'DOCUMENT_RUNTIME_VERIFICATION_FAILED')
})

test('document preflight: actual deployment prepares no mutation after dependency rejection and preserves config', t => {
  const { root, context, bin } = prepareCliFixture(t)
  const envFile = path.join(root, '.env')
  const original = 'UNCHANGED_CUSTOMER_VALUE=preserved\n'
  writeFileSync(envFile, original, { mode: 0o600 })
  const run = () => spawnSync('/bin/bash', ['-c', `source "$TEST_DEPLOY"\nprepare_document_tls() { :; }\nsystemctl() { echo MUTATION_CALLED; }\nvalidate_service_binding() { echo BINDING_CHECKED; }\nprepare_document_runtime() { echo RUNTIME_PREPARED; }\nprepare_mutation`], { cwd: root, env: { ...context.env, PATH: `${bin}:/usr/bin:/bin`, PROJECT_DIR: root, TEST_DEPLOY: path.join(project, 'deploy.sh') }, encoding: 'utf8' })
  context.env.AI_QA_PDFFONTS_BINARY = path.join(bin, 'missing-sensitive-tool')
  const rejected = run()
  assert.notEqual(rejected.status, 0)
  assert.doesNotMatch(rejected.stdout, /MUTATION_CALLED|BINDING_CHECKED|RUNTIME_PREPARED/)
  assert.doesNotMatch(rejected.stderr, /missing-sensitive-tool|fde-native-preflight-/)
  context.env.AI_QA_PDFFONTS_BINARY = path.join(bin, 'pdffonts')
  const accepted = run()
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.match(accepted.stdout, /MUTATION_CALLED\nBINDING_CHECKED\nRUNTIME_PREPARED/)
  assert.equal(readFileSync(envFile, 'utf8'), original)
  assert.equal(existsSync(path.join(root, '.runtime')), false)
})
