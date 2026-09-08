import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { evolutionError, evolutionContentHash } from '../../services/aiEvolutionPolicyService.js'

export type EvolutionRepositoryRegistration = {
  id: string
  /** Trusted server configuration only; never accepted from a proposal or model output. */
  root: string
  readablePaths: string[]
  editablePaths: string[]
  protectedPaths: string[]
  /** Optional read-only context for the model; the build snapshot still uses readablePaths. */
  contextPaths?: string[]
}
export type EvolutionSourceFile = { path: string; sha256: string; bytes: number; contentBase64: string }
export type EvolutionSourceSnapshot = { schemaVersion: 1; repositoryId: string; baseCommit: string; contentHash: string; files: EvolutionSourceFile[] }

export function safeEvolutionSourcePath(value: string) {
  return value.length > 0 && value.length <= 240 && !/[\\:\x00-\x1f*?<>|]/.test(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.endsWith('.') && !part.endsWith(' ')
      && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))
}
function within(file: string, roots: string[]) { return roots.some((root) => file === root || file.startsWith(`${root}/`)) }
export function isForbiddenEvolutionSource(value: string) {
  return /(^|\/)(\.env(?:\.[^/]*)?|\.git|\.npmrc|\.runtime|node_modules|uploads?|secrets?|ai-artifacts|project-files)(\/|$)|\.(pem|key|p12|pfx|sqlite|db)$/i.test(value)
}
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')

function git(root: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
    execFile('git', ['--no-replace-objects', '-C', root, ...args], { env, windowsHide: true, encoding: 'buffer', timeout: 30_000, maxBuffer }, (error, stdout) => {
      if (error) reject(evolutionError(503, 'EVOLUTION_SOURCE_READ_FAILED', '无法读取固定 Git 源码快照'))
      else resolve(stdout)
    })
  })
}

export async function captureEvolutionSource(registration: EvolutionRepositoryRegistration, baseCommit: string): Promise<EvolutionSourceSnapshot> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit) || !path.isAbsolute(registration.root)
    || !registration.readablePaths.length || registration.readablePaths.some((value) => !safeEvolutionSourcePath(value))) {
    throw evolutionError(400, 'EVOLUTION_INVALID_SOURCE_BASELINE', '仓库配置或源码基线无效')
  }
  const root = await realpath(registration.root)
  const resolved = (await git(root, ['rev-parse', '--verify', `${baseCommit}^{commit}`])).toString('utf8').trim()
  if (resolved !== baseCommit) throw evolutionError(409, 'EVOLUTION_SOURCE_BASELINE_CHANGED', '源码基线必须是固定提交')
  const entries = (await git(root, ['ls-tree', '-r', '-z', baseCommit])).toString('utf8').split('\0').filter(Boolean)
  const selected: { name: string; objectId: string; size?: number }[] = []
  const names = new Set<string>()
  for (const entry of entries) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry)
    if (!match) throw evolutionError(422, 'EVOLUTION_INVALID_SOURCE_TREE', 'Git 源码树格式无效')
    const [, mode, type, objectId, name] = match
    if (!within(name, registration.readablePaths) || isForbiddenEvolutionSource(name)) continue
    if (!safeEvolutionSourcePath(name) || type !== 'blob' || !['100644', '100755'].includes(mode) || names.has(name.toLowerCase())) {
      throw evolutionError(422, 'EVOLUTION_UNSAFE_SOURCE_ENTRY', '源码包含链接、子模块或不安全路径')
    }
    names.add(name.toLowerCase()); selected.push({ name, objectId })
  }
  if (selected.length > 10_000) throw evolutionError(413, 'EVOLUTION_SOURCE_LIMIT', '源码文件数量超出上限')
  const files: EvolutionSourceFile[] = []
  let total = 0
  for (let offset = 0; offset < selected.length; offset += 8) {
    const batch = await Promise.all(selected.slice(offset, offset + 8).map(async ({ name, objectId }) => {
      const content = await git(root, ['cat-file', 'blob', objectId], 4 * 1024 * 1024)
      return { path: name, sha256: digest(content), bytes: content.length, contentBase64: content.toString('base64') }
    }))
    total += batch.reduce((sum, file) => sum + file.bytes, 0)
    if (total > 128 * 1024 * 1024) throw evolutionError(413, 'EVOLUTION_SOURCE_LIMIT', '源码总大小超出上限')
    files.push(...batch)
  }
  const contentHash = evolutionContentHash(files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })))
  return { schemaVersion: 1, repositoryId: registration.id, baseCommit, contentHash, files }
}

export type EvolutionFileChange = { path: string; expectedSha256: string | null; contentBase64: string | null }

/** Validate the whole patch before any bytes are sent to an execution environment. */
export function applyEvolutionChanges(snapshot: EvolutionSourceSnapshot, registration: EvolutionRepositoryRegistration, allowedPaths: string[], changes: EvolutionFileChange[]) {
  if (snapshot.repositoryId !== registration.id || !allowedPaths.length || allowedPaths.some((value) => !safeEvolutionSourcePath(value))) {
    throw evolutionError(403, 'EVOLUTION_PATCH_SCOPE', '候选修改范围无效')
  }
  if (changes.length > 100) throw evolutionError(413, 'EVOLUTION_PATCH_LIMIT', '单轮修改文件数超出上限')
  const files = new Map(snapshot.files.map((file) => [file.path, file]))
  const touched = new Set<string>()
  for (const change of changes) {
    const name = change.path
    if (!safeEvolutionSourcePath(name) || isForbiddenEvolutionSource(name) || !within(name, allowedPaths)
      || !within(name, registration.editablePaths) || within(name, registration.protectedPaths)
      || touched.has(name.toLowerCase()) || [...files.keys()].some((other) => other.toLowerCase() === name.toLowerCase() && other !== name)) {
      throw evolutionError(403, 'EVOLUTION_PATCH_SCOPE', '候选修改越界或触及受保护文件')
    }
    touched.add(name.toLowerCase())
    const previous = files.get(name)
    if ((previous?.sha256 ?? null) !== change.expectedSha256 || (!previous && change.contentBase64 === null)) {
      throw evolutionError(409, 'EVOLUTION_PATCH_BASELINE', '候选修改使用了过期文件基线')
    }
    if (change.contentBase64 === null) files.delete(name)
    else {
      const content = Buffer.from(change.contentBase64, 'base64')
      if (content.length > 4 * 1024 * 1024 || content.toString('base64') !== change.contentBase64) throw evolutionError(413, 'EVOLUTION_PATCH_CONTENT', '候选文件内容无效或过大')
      files.set(name, { path: name, bytes: content.length, sha256: digest(content), contentBase64: change.contentBase64 })
    }
  }
  const result = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (result.reduce((sum, file) => sum + file.bytes, 0) > 128 * 1024 * 1024) throw evolutionError(413, 'EVOLUTION_PATCH_LIMIT', '候选总大小超出上限')
  return { ...snapshot, files: result, contentHash: evolutionContentHash(result.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))) }
}
