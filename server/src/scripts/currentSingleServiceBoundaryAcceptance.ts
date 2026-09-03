import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { PRODUCTION_RELEASE_REQUIRED_COMMANDS } from '../contracts/productionReleaseGatePolicy.js'

const execFileAsync = promisify(execFile)
const root = process.cwd()

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length
}

const [packageSource, deploy, start, serverEntry, prestart] = await Promise.all([
  readFile(path.resolve(root, 'package.json'), 'utf8'),
  readFile(path.resolve(root, 'deploy.sh'), 'utf8'),
  readFile(path.resolve(root, 'start.sh'), 'utf8'),
  readFile(path.resolve(root, 'server/src/index.ts'), 'utf8'),
  readFile(path.resolve(root, 'server/src/scripts/singleServicePrestart.ts'), 'utf8'),
])
const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> }
const scripts = packageJson.scripts ?? {}

await execFileAsync('/bin/bash', ['-n', path.resolve(root, 'deploy.sh')])
await execFileAsync('/bin/bash', ['-n', path.resolve(root, 'start.sh')])

assert.equal(scripts.start, 'node --env-file-if-exists=.env server-dist/index.js')
assert.equal(scripts['start:app'], scripts.start)
assert.equal(scripts['start:all'], 'npm run start:app')
assert.equal(scripts['check:single-service-prestart'], 'node --env-file-if-exists=.env --import tsx server/src/scripts/singleServicePrestart.ts')
assert.match(start, /exec npm run start:app/)

assert.match(deploy, /APP_SERVICE="\$\{APP_SERVICE:-cybernaut-app\}"/)
assert.match(deploy, /PROJECT_DIR="\$\{PROJECT_DIR:-\$SCRIPT_DIR\}"/)
assert.match(deploy, /HEALTH_URL="\$\{HEALTH_URL:-http:\/\/127\.0\.0\.1:4100\/api\/health\/components\}"/)
assert.match(deploy, /validate_service_binding\(\)/)
assert.match(deploy, /systemctl show "\$SERVICE_UNIT" --property WorkingDirectory --value/)
assert.match(deploy, /systemctl show "\$SERVICE_UNIT" --property ExecStart --value/)
assert.match(deploy, /systemctl show "\$SERVICE_UNIT" --property EnvironmentFiles --value/)
assert.match(deploy, /require_root_for_mutation "启动服务" "start"/)
assert.match(deploy, /require_root_for_mutation "重启服务" "restart"/)
assert.doesNotMatch(deploy, /DEPLOY_DIR="\/www\/sbl"/)
assert.doesNotMatch(deploy, /systemctl\s+(?:start|stop|restart)\s+cybernaut-(?:assistant|radar|api)/)

for (const command of PRODUCTION_RELEASE_REQUIRED_COMMANDS) {
  assert.match(deploy, new RegExp(`\\bnpm\\s+run\\s+${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|;|$)`))
}

const buildAt = deploy.indexOf('npm run build')
const migrationAt = deploy.indexOf('npm run db:migrate:separated')
const stopAt = deploy.indexOf('systemctl stop "$SERVICE_UNIT"', migrationAt)
const activateAt = deploy.indexOf('npm run activate:build:if-present')
const pairAcceptanceAt = deploy.indexOf('npm run accept:build-release')
const prestartAt = deploy.indexOf('npm run check:single-service-prestart')
const templateSyncAt = deploy.indexOf('npm run db:sync-ai-task-templates')
assert(buildAt > 0 && buildAt < migrationAt, 'build must finish before migration')
assert(migrationAt < stopAt, 'compatible migration must finish before the service stops')
assert(stopAt < activateAt && activateAt < pairAcceptanceAt && pairAcceptanceAt < prestartAt,
  'activation, paired-build acceptance and offline prestart must remain ordered')
assert(prestartAt < templateSyncAt, 'template registration must follow offline prestart')
assert.match(deploy, /rollback_failed_release/)
assert.match(deploy, /npm run rollback:build/)
assert.match(deploy, /systemctl start "\$SERVICE_UNIT"/)
assert.match(deploy, /if ! wait_for_health; then[\s\S]*rollback_failed_release/)

assert.equal(count(serverEntry, /app\.listen\(/g), 1, 'the server must expose one HTTP listener')
assert.match(serverEntry, /app\.listen\(port, '127\.0\.0\.1'\)/)
for (const startup of [
  'startLeadEnrichmentWorker()',
  'startProjectScoreJobWorker(executeProjectScoring)',
  'startLeadBpWorker()',
  'startRuntimeJobScheduler()',
  'startWeixinMessageBridge()',
  'initializeAgentSocket(httpServer!)',
]) assert(serverEntry.includes(startup), `unified server is missing in-process startup: ${startup}`)
assert(!serverEntry.includes('startLeadScoreJobWorker'), 'retired lead scoring worker must not restart')
assert(!serverEntry.includes("listen(3584") && !serverEntry.includes("listen(8121"), 'retired service ports must not listen')

assert.match(prestart, /const requiredPorts = \[4100, 3584, 8121\] as const/)
assert.match(prestart, /assertPortsFree\(requiredPorts\)/)
assert.match(prestart, /await validatePrestartFiles\(root\)/)
assert.match(prestart, /await validateReadOnlyDatabase\(\)/)
assert.match(prestart, /transaction_read_only/)
assert.match(prestart, /processMutation: false/)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'shell-syntax',
    'single-server-entry',
    'service-path-binding',
    'explicit-repeatable-release-gates',
    'build-migrate-stop-activate-order',
    'paired-build-prestart-and-rollback',
    'retired-lead-score-worker-absent',
    'retired-ports-guarded',
    'read-only-prestart-database-check',
  ],
  productionReleaseCommands: PRODUCTION_RELEASE_REQUIRED_COMMANDS.length,
  databaseWrites: 0,
  processMutation: false,
}))
