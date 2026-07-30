import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..', '..')
const venvRoot = path.join(projectRoot, 'server', '.venv')
const venvPython = path.join(
  venvRoot,
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3',
)
const requirements = path.join(
  projectRoot,
  'server',
  'requirements-pdf-to-ppt.txt',
)
const environmentCheck = path.join(
  projectRoot,
  'server',
  'workspace',
  '.agents',
  'skills',
  'pdf-to-editable-ppt',
  'scripts',
  'check_environment.py',
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
  const bootstrapPython = process.env.AI_PDF_TO_PPT_BOOTSTRAP_PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3')
  console.log(`创建 PDF 转 PPT 项目运行时：${venvRoot}`)
  run(bootstrapPython, ['-m', 'venv', venvRoot])
}

console.log('安装 PDF 转 PPT Python 依赖…')
run(venvPython, ['-m', 'pip', 'install', '-r', requirements])

console.log('检查 PyMuPDF、Pillow、OpenCV、Poppler、OCR 与 Artifact Tool…')
try {
  run(venvPython, [environmentCheck, '--json'])
} catch (error) {
  console.error(
    process.platform === 'darwin'
      ? '\n若报告显示缺少 Poppler 或严格 OCR，请运行：brew install poppler tesseract tesseract-lang'
      : '\n请根据环境报告安装 Poppler、Tesseract（含 chi_sim/eng）及 Presentations/Artifact Tool 运行时。',
  )
  throw error
}

console.log('PDF 转 PPT 运行时已就绪。服务端会自动优先使用 server/.venv。')
