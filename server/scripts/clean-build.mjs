import { spawn } from 'node:child_process'
import path from 'node:path'

const script = path.resolve(process.cwd(), 'server/scripts/build-platform.mjs')
const child = spawn(process.execPath, [script, '--discard-candidate'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
})
const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', resolve)
})
if (code !== 0) throw new Error(`candidate cleanup failed with exit code ${String(code)}`)
