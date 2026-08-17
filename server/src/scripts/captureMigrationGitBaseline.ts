import { execFile } from 'node:child_process'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = process.cwd()
const evidenceDir = path.resolve(projectRoot, '.runtime/migration-evidence/git-baseline')
const args = process.argv.slice(2)

function argument(name: string, fallback: string): string {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? path.resolve(projectRoot, args[index + 1]) : fallback
}

const projectBaseBranch = (() => {
  const index = args.indexOf('--project-base-branch')
  return index >= 0 && args[index + 1] ? args[index + 1] : 'main'
})()
const jwRoot = argument('--jw-root', path.resolve(projectRoot, '../jw'))

type Change = {
  indexStatus: string
  worktreeStatus: string
  path: string
  originalPath?: string
}

type RepositoryBaseline = {
  root: string
  branch: string
  head: string
  baseBranch?: string
  baseHead?: string
  headMatchesBase?: boolean
  upstream: string | null
  ahead: number | null
  behind: number | null
  remotes: Array<{ name: string; operation: string; url: string }>
  changes: Change[]
  counts: {
    staged: number
    unstaged: number
    untracked: number
    deleted: number
    total: number
  }
}

async function git(root: string, commandArgs: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...commandArgs], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

async function gitOptional(root: string, commandArgs: string[]): Promise<string | null> {
  try {
    return (await git(root, commandArgs)).trim() || null
  } catch {
    return null
  }
}

function sanitizedRemote(raw: string): string {
  const value = raw.trim()
  if (!value) return value
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return value.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1')
  }
}

function parseStatus(raw: string): Change[] {
  const records = raw.split('\0')
  const changes: Change[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const indexStatus = record[0] || ' '
    const worktreeStatus = record[1] || ' '
    const change: Change = {
      indexStatus,
      worktreeStatus,
      path: record.slice(3),
    }
    if ('RC'.includes(indexStatus) || 'RC'.includes(worktreeStatus)) {
      change.originalPath = records[index + 1] || undefined
      index += 1
    }
    changes.push(change)
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path))
}

function changeCounts(changes: Change[]): RepositoryBaseline['counts'] {
  return {
    staged: changes.filter((change) => ![' ', '?'].includes(change.indexStatus)).length,
    unstaged: changes.filter((change) => ![' ', '?'].includes(change.worktreeStatus)).length,
    untracked: changes.filter((change) => change.indexStatus === '?' && change.worktreeStatus === '?').length,
    deleted: changes.filter((change) => change.indexStatus === 'D' || change.worktreeStatus === 'D').length,
    total: changes.length,
  }
}

async function inspectRepository(root: string, baseBranch?: string): Promise<RepositoryBaseline> {
  const resolvedRoot = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  const branch = (await git(root, ['branch', '--show-current'])).trim()
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const upstream = await gitOptional(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])
  const divergence = upstream
    ? (await git(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])).trim().split(/\s+/).map(Number)
    : null
  const remoteLines = (await git(root, ['remote', '-v'])).trim().split('\n').filter(Boolean)
  const remotes = remoteLines.map((line) => {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    return match
      ? { name: match[1], url: sanitizedRemote(match[2]), operation: match[3] }
      : { name: 'unparsed', url: sanitizedRemote(line), operation: 'unknown' }
  })
  const changes = parseStatus(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
  const baseHead = baseBranch ? await gitOptional(root, ['rev-parse', baseBranch]) : null
  return {
    root: resolvedRoot,
    branch,
    head,
    ...(baseBranch ? { baseBranch, baseHead: baseHead || undefined, headMatchesBase: baseHead === head } : {}),
    upstream,
    ahead: divergence?.[0] ?? null,
    behind: divergence?.[1] ?? null,
    remotes,
    changes,
    counts: changeCounts(changes),
  }
}

async function writePrivate(file: string, data: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, data, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

function markdownRepository(title: string, repository: RepositoryBaseline): string[] {
  const lines = [
    `## ${title}`,
    '',
    `- 根目录：\`${repository.root}\``,
    `- 分支：\`${repository.branch}\``,
    `- HEAD：\`${repository.head}\``,
    `- 上游：${repository.upstream ? `\`${repository.upstream}\`` : '无'}`,
    `- Ahead/Behind：${repository.ahead ?? 'N/A'}/${repository.behind ?? 'N/A'}`,
  ]
  if (repository.baseBranch) {
    lines.push(`- 基线分支：\`${repository.baseBranch}\``)
    lines.push(`- 基线提交：\`${repository.baseHead || '不存在'}\``)
    lines.push(`- 当前 HEAD 与基线一致：${repository.headMatchesBase ? '是' : '否'}`)
  }
  lines.push(`- 未提交文件：${repository.counts.total}（暂存 ${repository.counts.staged}、未暂存 ${repository.counts.unstaged}、未跟踪 ${repository.counts.untracked}、删除 ${repository.counts.deleted}）`)
  lines.push('', '### 未提交文件清单', '')
  if (!repository.changes.length) lines.push('- 无')
  for (const change of repository.changes) {
    const rename = change.originalPath ? `（原路径：\`${change.originalPath}\`）` : ''
    lines.push(`- \`${change.indexStatus}${change.worktreeStatus}\` \`${change.path}\`${rename}`)
  }
  lines.push('')
  return lines
}

async function main() {
  const [project, jw] = await Promise.all([
    inspectRepository(projectRoot, projectBaseBranch),
    inspectRepository(jwRoot),
  ])
  const checks = {
    projectUsesDedicatedMigrationBranch: project.branch.startsWith('codex/') && !['main', 'master'].includes(project.branch),
    projectHeadMatchesRecordedBase: project.headMatchesBase === true,
    projectDirtyStateCaptured: project.counts.total === project.changes.length,
    jwSourceBranchAndCommitCaptured: Boolean(jw.branch && jw.head),
    remoteUrlsContainNoEmbeddedCredentials: [...project.remotes, ...jw.remotes].every((remote) => !/^https?:\/\/[^/@\s]+@/i.test(remote.url)),
  }
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: Object.values(checks).every(Boolean),
    checks,
    project,
    jw,
    note: 'This baseline preserves the complete dirty-file inventory. It does not infer ownership or classify pre-existing user changes as migration changes.',
  }
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  await writePrivate(path.join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const summary = [
    '# Git 迁移基线',
    '',
    `生成时间：${report.generatedAt}`,
    '',
    '本证据固定项目仓库和 JW 底座的分支、提交、远端差异及完整未提交文件清单。它不会推断文件归属，也不会把已有用户改动自动归类为迁移改动。',
    '',
    ...markdownRepository('项目仓库', project),
    ...markdownRepository('JW 底座仓库', jw),
  ].join('\n')
  await writePrivate(path.join(evidenceDir, 'summary.md'), `${summary}\n`)
  console.log(JSON.stringify({
    ok: report.ok,
    evidenceDir,
    project: {
      branch: project.branch,
      head: project.head,
      baseBranch: project.baseBranch,
      baseHead: project.baseHead,
      headMatchesBase: project.headMatchesBase,
      counts: project.counts,
    },
    jw: {
      branch: jw.branch,
      head: jw.head,
      counts: jw.counts,
    },
    checks,
  }))
  if (!report.ok) process.exitCode = 2
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
