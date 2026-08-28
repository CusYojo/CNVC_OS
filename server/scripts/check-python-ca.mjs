import { access, stat } from 'node:fs/promises'
import { constants, existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const systemBundles = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt']
const contextProbe = `import json, ssl, sys
context = ssl.create_default_context(cafile=sys.argv[1] or None)
stats = context.cert_store_stats()
assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
assert stats.get('x509_ca', 0) > 0
print(json.dumps({'verified': True, 'trustedCaCount': stats['x509_ca']}))
`

function invalid(code, message) {
  return Object.assign(new Error(message), { code })
}

// Read-only preflight. Match the existing Gorden runtime's interpreter and CA
// precedence; never replace an explicit invalid bundle with a system fallback.
export async function checkPythonCa({ root = process.cwd(), env = process.env, platform = process.platform } = {}) {
  if (env.PYTHONHTTPSVERIFY === '0' || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw invalid('PYTHON_CA_VERIFICATION_DISABLED', 'TLS 校验被关闭，请修复配置后重试；不会使用不安全回退。')
  }
  const configured = env.AI_PYTHON_CA_FILE || env.SSL_CERT_FILE || env.REQUESTS_CA_BUNDLE
  let caFile = ''
  for (const candidate of configured ? [configured] : platform === 'win32' ? [] : systemBundles) {
    // The optional path-only output is consumed as one quoted shell value.
    if (/[\r\n\0]/.test(candidate)) throw invalid('PYTHON_CA_PATH_INVALID', 'CA 路径含不允许的控制字符。')
    const resolved = path.resolve(root, candidate)
    const info = await stat(resolved).catch(() => null)
    const readable = info?.isFile() && await access(resolved, constants.R_OK).then(() => true, () => false)
    if (!readable) {
      if (configured) throw invalid('PYTHON_CA_FILE_INVALID', '显式 CA 文件不可读或不是普通文件；不会忽略配置。')
      continue
    }
    caFile = resolved
    break
  }
  const projectPython = path.join(root, 'server', '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3')
  const python = env.AI_PDF_TO_PPT_PYTHON || (existsSync(projectPython) ? projectPython : 'python3')
  const childEnv = { ...env, ...(caFile ? { SSL_CERT_FILE: caFile, REQUESTS_CA_BUNDLE: caFile } : {}) }
  const result = spawnSync(python, ['-I', '-c', contextProbe, caFile], {
    cwd: root, env: childEnv, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw invalid('PYTHON_CA_CONTEXT_INVALID', 'Python 无法建立带可信 CA 的证书及主机名校验上下文；请检查解释器、证书文件或系统 ca-certificates。')
  }
  let probe
  try { probe = JSON.parse(result.stdout) } catch { /* Reject malformed subprocess results without exposing stderr. */ }
  if (probe?.verified !== true || !Number.isInteger(probe.trustedCaCount) || probe.trustedCaCount < 1) {
    throw invalid('PYTHON_CA_PROBE_INVALID', 'Python 证书检查结果无效，已阻止继续部署。')
  }
  return { ok: true, caFile, source: configured ? 'configured' : caFile ? 'system_bundle' : 'python_default', trustedCaCount: probe.trustedCaCount }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || args.some(arg => arg !== '--print-ca-file')) throw invalid('PYTHON_CA_ARGUMENT_INVALID', '未知证书预检参数。')
    const result = await checkPythonCa()
    if (args[0] === '--print-ca-file') process.stdout.write(`${result.caFile}\n`)
    else console.log(JSON.stringify({ ok: result.ok, source: result.source, trustedCaCount: result.trustedCaCount, networkRequests: 0, configurationWrites: 0 }))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'PYTHON_CA_CHECK_FAILED', message: error.code ? error.message : '证书预检失败，未继续部署。' }))
    process.exitCode = 78
  }
}
