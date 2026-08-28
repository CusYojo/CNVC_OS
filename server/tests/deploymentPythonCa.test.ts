import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test, { type TestContext } from 'node:test'
import { checkPythonCa } from '../scripts/check-python-ca.mjs'

const script = path.resolve('server/scripts/check-python-ca.mjs')
const deploy = path.resolve('deploy.sh')
const cleanEnv = () => {
  const env = { ...process.env }
  for (const key of ['AI_PYTHON_CA_FILE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'AI_PDF_TO_PPT_PYTHON', 'PYTHONHTTPSVERIFY', 'NODE_TLS_REJECT_UNAUTHORIZED']) delete env[key]
  return env
}
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'fde-python-ca-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('deployment CA: actual Python validates trusted store without network or configuration writes', async () => {
  const result = await checkPythonCa({ env: cleanEnv() })
  assert.equal(result.ok, true)
  assert.ok(result.trustedCaCount > 0)
})

test('deployment CA: explicit custom bundle wins, and CA path is handled as data', async t => {
  const root = fixture(t)
  const baseline = await checkPythonCa({ env: cleanEnv() })
  assert.ok(baseline.caFile, 'test host must provide a system bundle')
  const bundle = path.join(root, '客户 bundle $(touch forbidden).pem')
  const bytes = readFileSync(baseline.caFile)
  writeFileSync(bundle, bytes)
  const result = await checkPythonCa({ root, env: { ...cleanEnv(), AI_PYTHON_CA_FILE: bundle, SSL_CERT_FILE: '/missing/lower-precedence.pem' } })
  assert.equal(result.caFile, bundle)
  assert.equal(result.source, 'configured')
  assert.deepEqual(readFileSync(bundle), bytes)
})

test('deployment CA: missing, directory, malformed and empty explicit bundles fail without fallback', async t => {
  const root = fixture(t)
  writeFileSync(path.join(root, 'malformed.pem'), 'synthetic-secret-not-for-logs')
  writeFileSync(path.join(root, 'empty.pem'), '')
  for (const target of ['missing.pem', '.', 'malformed.pem', 'empty.pem']) {
    await assert.rejects(checkPythonCa({ root, env: { ...cleanEnv(), AI_PYTHON_CA_FILE: path.join(root, target) } }), /CA|Python/)
  }
})

test('deployment CA: verification bypass and control-character paths are rejected', async () => {
  for (const unsafe of [{ PYTHONHTTPSVERIFY: '0' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { AI_PYTHON_CA_FILE: '/tmp/file\n.pem' }]) {
    await assert.rejects(checkPythonCa({ env: { ...cleanEnv(), ...unsafe } }))
  }
})

test('deployment CA: explicit invalid Python does not silently use another interpreter', async () => {
  await assert.rejects(checkPythonCa({ env: { ...cleanEnv(), AI_PDF_TO_PPT_PYTHON: '/missing/python-secret-path' } }), { code: 'PYTHON_CA_CONTEXT_INVALID' })
})

test('deployment CA: CLI fails closed with no raw secret, path, stdout or stderr from Python', t => {
  const root = fixture(t)
  const bad = path.join(root, 'private-secret.pem')
  writeFileSync(bad, 'synthetic-secret-not-for-logs')
  const r = spawnSync(process.execPath, [script], { cwd: root, env: { ...cleanEnv(), AI_PYTHON_CA_FILE: bad }, encoding: 'utf8' })
  assert.equal(r.status, 78)
  assert.equal(r.stdout, '')
  assert.doesNotMatch(r.stderr, /private-secret|synthetic-secret|Traceback|fde-python-ca-/)
  assert.equal(JSON.parse(r.stderr).code, 'PYTHON_CA_CONTEXT_INVALID')
})

test('deployment CA: real deploy preparation checks before mutation and preserves .env', async t => {
  const root = fixture(t)
  mkdirSync(path.join(root, 'server', 'scripts'), { recursive: true })
  writeFileSync(path.join(root, 'server', 'scripts', 'check-python-ca.mjs'), readFileSync(script))
  const envFile = path.join(root, '.env')
  const run = () => spawnSync('bash', ['-c', `source "$TEST_DEPLOY"\nprepare_document_native_tools() { echo NATIVE_CHECKED; }\nsystemctl() { echo MUTATION_CALLED; }\nvalidate_service_binding() { echo BINDING_CHECKED; }\nprepare_document_runtime() { echo RUNTIME_PREPARED; }\nprepare_mutation`], { cwd: root, env: { ...cleanEnv(), PROJECT_DIR: root, TEST_DEPLOY: deploy }, encoding: 'utf8' })
  const invalid = 'AI_PYTHON_CA_FILE=/missing/synthetic-secret.pem\nUNCHANGED_VALUE=preserve-me\n'
  writeFileSync(envFile, invalid, { mode: 0o600 })
  const rejected = run()
  assert.notEqual(rejected.status, 0, JSON.stringify({ stdout: rejected.stdout, stderr: rejected.stderr }))
  assert.doesNotMatch(rejected.stdout, /NATIVE_CHECKED|MUTATION_CALLED|BINDING_CHECKED|RUNTIME_PREPARED/)
  assert.equal(readFileSync(envFile, 'utf8'), invalid)
  const baseline = await checkPythonCa({ env: cleanEnv() })
  const valid = `AI_PYTHON_CA_FILE=${baseline.caFile}\nUNCHANGED_VALUE=preserve-me\n`
  writeFileSync(envFile, valid, { mode: 0o600 })
  const accepted = run()
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.match(accepted.stdout, /NATIVE_CHECKED\nMUTATION_CALLED\nBINDING_CHECKED\nRUNTIME_PREPARED/)
  assert.equal(readFileSync(envFile, 'utf8'), valid)
})
