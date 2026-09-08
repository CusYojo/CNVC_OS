import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
if (path.resolve(process.cwd()) !== path.resolve(root)) throw Error('Run the manifest generator from the worktree root')
const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8' })
const files = raw.split('\0').filter(Boolean).map(entry => entry.slice(3).replaceAll('\\', '/'))
files.push('ai-evolution-change-manifest.json')
const manifest = { schemaVersion: 1, objective: 'AI assistant self-evolution implementation', baseCommit,
  latestMigration: '0107_add_ai_evolution_release_jobs', files: [...new Set(files)].sort() }
writeFileSync(path.join(root, 'ai-evolution-change-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ ok: true, baseCommit, files: manifest.files.length, latestMigration: manifest.latestMigration }))
