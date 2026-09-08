import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const id = process.argv[2]
if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw Error('Invalid render identity')
const input = JSON.parse(fs.readFileSync(`/workspace/input/${id}.json`, 'utf8'))
const output = `/workspace/output/${id}`
fs.mkdirSync('/workspace/output', { recursive: true })
fs.mkdirSync(output)
const scripts = '/workspace/platform/skill/scripts'
const logs = []
function command(label, executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 128_000,
    env: { PATH: process.env.PATH, HOME: '/workspace', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' } })
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  fs.writeFileSync(path.join(output, `${label}.txt`), text, { flag: 'wx' })
  const passed = !result.error && result.status === 0 && !/(?:^|\n)(?:ERROR|WARNING):/.test(text)
  logs.push({ id: label, passed, exitCode: result.status, executionError: result.error ? 'execution failed or exceeded limits' : null })
  return passed
}
for (const [name, value] of Object.entries({ report: input.report, 'diligence-data': input.diligenceData, evidence: input.evidence })) {
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(value), { flag: 'wx' })
}
// Model-provided image paths cannot read unrelated container files. Images need a separate approved asset binding.
const assetsBound = !(input.report?.blocks ?? []).some(block => block?.type === 'image')
if (!assetsBound) {
  fs.writeFileSync(path.join(output, 'assets.txt'), 'Report image requires an approved asset binding', { flag: 'wx' })
  logs.push({ id: 'assets', passed: false, exitCode: 1, executionError: null })
}
const report = path.join(output, 'report.json'), data = path.join(output, 'diligence-data.json'), evidence = path.join(output, 'evidence.json')
const runtime = command('runtime', 'python3', [path.join(scripts, 'check_runtime.py'), '--json'])
const fields = command('fields', 'python3', [path.join(scripts, 'audit_ic_completeness.py'), data, '--report', report, '--evidence', evidence])
const content = command('content', 'python3', [path.join(scripts, 'audit_report_content.py'), report, '--evidence', evidence])
command('narrative', 'python3', [path.join(scripts, 'audit_narrative_quality.py'), report, '--strict'])
if (assetsBound && runtime && fields && content && command('build', 'python3', [path.join(scripts, 'build_report_docx.py'), '--input', report,
  '--diligence-data', data, '--evidence', evidence, '--output', path.join(output, 'draft.docx')])) {
  command('format', 'python3', [path.join(scripts, 'deta_dd_processor.py'), 'format', '--input', path.join(output, 'draft.docx'), '--output', path.join(output, 'report.docx')])
  if (fs.existsSync(path.join(output, 'report.docx'))) {
    command('pdf', 'soffice', ['-env:UserInstallation=file:///workspace/lo-' + id, '--headless', '--convert-to', 'pdf', '--outdir', output, path.join(output, 'report.docx')])
    if (fs.existsSync(path.join(output, 'report.pdf'))) command('pages', 'python3', ['-c',
      'import fitz,sys,json; from pathlib import Path; root=Path(sys.argv[1]); doc=fitz.open(root/"report.pdf"); assert 0<len(doc)<=80; pages=[]\nfor i,page in enumerate(doc):\n pix=page.get_pixmap(matrix=fitz.Matrix(1.25,1.25)); pix.save(root/("page-%03d.png"%(i+1))); pages.append({"page":i+1,"width":page.rect.width,"height":page.rect.height,"text":page.get_text()})\n(root/"pages.json").write_text(json.dumps(pages,ensure_ascii=False),encoding="utf8")', output])
  }
}
fs.writeFileSync(path.join(output, 'render-checks.json'), JSON.stringify({ schemaVersion: 1, checks: logs,
  renderCompleted: logs.some(row => row.id === 'pages' && row.passed), requiresIndependentReview: true }), { flag: 'wx' })
const files = fs.readdirSync(output).sort().map(name => {
  const filename = path.join(output, name), info = fs.lstatSync(filename)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw Error('Invalid render output')
  return { path: `${id}/${name}`, bytes: info.size, sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }
})
if (files.length > 100 || files.reduce((sum, file) => sum + file.bytes, 0) > 64 * 1024 * 1024) throw Error('Render output exceeds limits')
process.stdout.write(JSON.stringify({ files, checks: logs }))
