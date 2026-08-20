import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..', '..')
const venvRoot = path.join(projectRoot, 'server', '.venv')
const venvPython = path.join(
  venvRoot,
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3',
)
const skillRoot = path.join(
  projectRoot,
  'server',
  'workspace',
  '.agents',
  'skills',
  'draft-due-diligence-report',
)

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 执行失败（${result.status}）`)
  }
}

if (!existsSync(venvPython)) {
  const bootstrapPython = process.env.AI_DD_SKILL_BOOTSTRAP_PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3')
  console.log(`创建投资文档 Python 运行时：${venvRoot}`)
  run(bootstrapPython, ['-m', 'venv', venvRoot])
}

console.log('安装 draft-due-diligence-report Python 依赖…')
run(venvPython, ['-m', 'pip', 'install', 'python-docx>=1.1.2', 'PyMuPDF>=1.24.0', 'lxml>=5.0.0'])

console.log('检查尽调报告生成、审计与逐页渲染运行时…')
run(venvPython, [path.join(skillRoot, 'scripts', 'check_runtime.py')])
for (const script of [
  'audit_public_research.py',
  'audit_ic_completeness.py',
  'audit_narrative_quality.py',
]) {
  run(venvPython, [path.join(skillRoot, 'scripts', script), '--self-test'])
}

console.log('draft-due-diligence-report 运行时已就绪。')
