import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const manifest = JSON.parse(readFileSync(path.join(root, 'ai-evolution-change-manifest.json'), 'utf8'))
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
execFileSync('git', ['merge-base', '--is-ancestor', manifest.baseCommit, head])
const committed = execFileSync('git', ['diff', '--name-only', '-z', `${manifest.baseCommit}..${head}`], { encoding: 'utf8' })
const actual = [...new Set([...committed.split('\0').filter(Boolean).map(entry => entry.replaceAll('\\', '/')),
  'ai-evolution-change-manifest.json'])].sort()
if (manifest.schemaVersion !== 1 || manifest.latestMigration !== '0112_add_assistant_experience_memory'
  || JSON.stringify(manifest.files) !== JSON.stringify(actual)) throw Error('AI evolution change manifest is stale or incomplete')
console.log(JSON.stringify({ ok: true, baseline: manifest.baseCommit, head, files: actual.length, latestMigration: manifest.latestMigration }))
