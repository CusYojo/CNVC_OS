import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { evolutionError } from './aiEvolutionPolicyService.js'

const command = promisify(execFile)
export async function readEvolutionReevaluationBase(target: { root: string; baseRef: string }, repositoryRoot: string) {
  if (!path.isAbsolute(target.root) || !path.isAbsolute(repositoryRoot)
    || !/^(?!-)[a-zA-Z0-9_./-]{1,160}$/.test(target.baseRef)) throw Error('Invalid registered Git target')
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
  const options = { env, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }
  const readHead = async () => (await command('git', ['rev-parse', '--verify', '--end-of-options', `${target.baseRef}^{commit}`], { ...options, cwd: target.root })).stdout.trim()
  const baseCommit = await readHead()
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw Error('Target base is not a fixed commit')
  if ((await command('git', ['status', '--porcelain', '--untracked-files=normal'], { ...options, cwd: target.root })).stdout.trim()) {
    throw evolutionError(409, 'EVOLUTION_RELEASE_WORKTREE_DIRTY', '目标工作区有未提交变更，需先整理后重新评估')
  }
  try { await command('git', ['cat-file', '-e', `${baseCommit}^{commit}`], { ...options, cwd: repositoryRoot }) }
  catch { throw evolutionError(409, 'EVOLUTION_REEVALUATION_BASE_UNAVAILABLE', '开发仓库尚未包含目标提交，请先同步仓库') }
  if (await readHead() !== baseCommit) throw evolutionError(409, 'EVOLUTION_REEVALUATION_CHANGED', '检查期间目标分支已变化，请重新查看方案')
  return baseCommit
}
