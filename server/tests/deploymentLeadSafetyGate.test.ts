import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// Execute only the extracted function with shell stubs. Never source the whole
// deploy script, touch systemd, run npm/build, or connect to a database.
const source = readFileSync(new URL('../../deploy.sh', import.meta.url), 'utf8')
const start = source.indexOf('rebuild_and_activate() {')
const end = source.indexOf('\nrollback_failed_release() {', start)
assert.ok(start >= 0 && end > start)
const rebuild = source.slice(start, end)
// deploy.sh is intentionally a POSIX/systemd release script. Windows workstations
// still run the application checks, but cannot execute this shell-level contract.
const bashTest = process.platform === 'win32' ? test.skip : test

function exercise(safetyPasses: boolean, isolationPasses = true) {
  return spawnSync('bash', ['-c', `
set -eu
require_command() { :; }
step() { :; }
err() { printf '%s\\n' "$*" >&2; }
systemctl() { printf 'systemctl:%s\\n' "$*"; return 1; }
npm() {
  printf 'npm:%s\\n' "$*"
  if [ "$*" = 'run check:production-release-gates' ]; then return 0; fi
  if [ "$*" = 'run accept:lead-dedup-safety' ]; then return ${safetyPasses ? 0 : 78}; fi
  if [ "$*" = 'run accept:lead-duplicate-release' ]; then return ${isolationPasses ? 0 : 79}; fi
  if [ "$*" = 'run build' ]; then return 33; fi
  return 99
}
SERVICE_UNIT=isolated-test.service
${rebuild}
rebuild_and_activate
`], { encoding: 'utf8' })
}

bashTest('release safety failure stops before systemd checks, build, migration or activation', () => {
  const result = exercise(false)
  assert.equal(result.status, 1, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), ['npm:run check:production-release-gates', 'npm:run accept:lead-dedup-safety'])
  assert.match(result.stderr, /尚未构建、迁移、停服或激活/)
})

bashTest('successful safety check precedes build and a build failure still stops before migration', () => {
  const result = exercise(true)
  assert.equal(result.status, 1, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'npm:run check:production-release-gates',
    'npm:run accept:lead-dedup-safety',
    'npm:run accept:lead-duplicate-release',
    'systemctl:is-active --quiet isolated-test.service',
    'npm:run build',
  ])
  assert.match(result.stderr, /项目构建失败/)
})

bashTest('isolated acceptance or cleanup failure prevents build, migration and service operations', () => {
  const result = exercise(true, false)
  assert.equal(result.status, 1, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), ['npm:run check:production-release-gates', 'npm:run accept:lead-dedup-safety', 'npm:run accept:lead-duplicate-release'])
  assert.match(result.stderr, /隔离验收或清理失败/)
})
