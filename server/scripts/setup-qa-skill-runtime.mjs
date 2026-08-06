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
  'generate-project-qa-report',
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
  const bootstrapPython = process.env.AI_QA_SKILL_BOOTSTRAP_PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3')
  console.log(`创建 Q&A Skill 项目运行时：${venvRoot}`)
  run(bootstrapPython, ['-m', 'venv', venvRoot])
}

console.log('安装 generate-project-qa-report Python 依赖…')
run(venvPython, ['-m', 'pip', 'install', '-r', path.join(skillRoot, 'requirements.txt')])

console.log('检查 Markdown 校验、DOCX 生成与逐页渲染运行时…')
run(venvPython, [path.join(skillRoot, 'scripts', 'check_runtime.py'), '--strict'])

console.log('generate-project-qa-report 运行时已就绪。')
