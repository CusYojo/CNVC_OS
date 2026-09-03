import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PLATFORM_AUDIT_ONLY_COMMANDS,
  PRODUCTION_RELEASE_REQUIRED_COMMANDS,
} from '../contracts/productionReleaseGatePolicy.js'

const root = process.cwd()

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function executableDeployCommand(deploySource: string, command: string): boolean {
  const source = deploySource
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  return new RegExp(`\\bnpm\\s+run\\s+${escaped(command)}(?=\\s|;|$)`, 'm').test(source)
}

function classifiedReleaseAssertions(checkerSource: string): string[] {
  const commands = new Set<string>()
  for (const match of checkerSource.matchAll(/releaseGatePolicyCovers\('([^']+)'\)/g)) commands.add(match[1]!)
  return [...commands].sort()
}

const [packageSource, deploySource, checkerSource] = await Promise.all([
  readFile(path.resolve(root, 'package.json'), 'utf8'),
  readFile(path.resolve(root, 'deploy.sh'), 'utf8'),
  readFile(path.resolve(root, 'server/src/scripts/checkSingleServiceBoundary.ts'), 'utf8'),
])
const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> }
const scripts = packageJson.scripts ?? {}
const perRelease = new Set<string>(PRODUCTION_RELEASE_REQUIRED_COMMANDS)
const auditOnly = new Set<string>(PLATFORM_AUDIT_ONLY_COMMANDS)

assert.equal(perRelease.size, PRODUCTION_RELEASE_REQUIRED_COMMANDS.length, 'per-release command list contains duplicates')
assert.equal(auditOnly.size, PLATFORM_AUDIT_ONLY_COMMANDS.length, 'audit-only command list contains duplicates')
for (const command of perRelease) {
  assert(!auditOnly.has(command), `${command} is classified in both release modes`)
  assert.equal(typeof scripts[command], 'string', `missing package script for per-release command: ${command}`)
  assert(executableDeployCommand(deploySource, command), `deploy.sh does not execute per-release command: ${command}`)
}
for (const command of auditOnly) {
  assert.equal(typeof scripts[command], 'string', `missing package script for audit-only command: ${command}`)
  assert(!executableDeployCommand(deploySource, command), `audit-only command must not run on every deployment: ${command}`)
}

const classifiedLegacy = new Set([...perRelease, ...auditOnly])
const releaseAssertions = classifiedReleaseAssertions(checkerSource)
const unclassified = releaseAssertions.filter((command) => !classifiedLegacy.has(command))
assert.deepEqual(unclassified, [], `legacy release assertions contain unclassified commands: ${unclassified.join(', ')}`)
const unreferencedAuditCommands = [...auditOnly].filter((command) => !releaseAssertions.includes(command))
assert.deepEqual(unreferencedAuditCommands, [], `audit-only commands have no platform assertion: ${unreferencedAuditCommands.join(', ')}`)

console.log(JSON.stringify({
  ok: true,
  perReleaseCommands: perRelease.size,
  platformAuditOnlyCommands: auditOnly.size,
  legacyAssertionsClassified: true,
  deploySourceCommentsExcluded: true,
  databaseWrites: 0,
  processMutation: false,
}))
