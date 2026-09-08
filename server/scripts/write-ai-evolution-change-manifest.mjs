import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
if (path.resolve(process.cwd()) !== path.resolve(root)) throw Error('Run the manifest generator from the worktree root')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const manifestPath = path.join(root, 'ai-evolution-change-manifest.json')
const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
const baseCommit = typeof existing?.baseCommit === 'string' ? existing.baseCommit : head
execFileSync('git', ['merge-base', '--is-ancestor', baseCommit, head])
const committed = execFileSync('git', ['diff', '--name-only', '-z', `${baseCommit}..${head}`], { encoding: 'utf8' })
const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8' })
const files = committed.split('\0').filter(Boolean).map(entry => entry.replaceAll('\\', '/'))
files.push(...raw.split('\0').filter(Boolean).map(entry => entry.slice(3).replaceAll('\\', '/')))
files.push('ai-evolution-change-manifest.json')
const manifest = { schemaVersion: 1, objective: 'AI assistant self-evolution implementation', baseCommit,
  latestMigration: '0110_add_ai_evolution_requested_rollback', files: [...new Set(files)].sort() }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ ok: true, baseCommit, files: manifest.files.length, latestMigration: manifest.latestMigration }))
