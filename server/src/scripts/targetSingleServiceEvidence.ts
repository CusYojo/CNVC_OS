import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readFile, readlink, readdir, rename, lstat, writeFile, mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'

const root = process.cwd()
const evidenceDir = path.resolve(root, '.runtime/migration-evidence/target-single-service')
const legacyUnits = [
  'cybernaut-api.service',
  'cybernaut-assistant.service',
  'cybernaut-flue.service',
  'cybernaut-radar.service',
  'cybernaut-radar-sync.service',
  'cybernaut-radar-sync.timer',
] as const
const retiredCronPattern = /(?:daily_intake|batch_analyze|sync_radar|cybernaut-radar|project-discovery\/job\.py)/i
const projectUnitPattern = /(?:cybernaut|(?:^|[_.@-])flue(?:[_.@-]|$)|(?:^|[_.@-])radar(?:[_.@-]|$)|(?:^|[_.@-])sbl(?:[_.@-]|$)|(?:^|[_.@-])jedi(?:[_.@-]|$))/i
const projectProcessPattern = /(?:\/www\/sbl(?:\/|\s)|server-dist\/index\.js|project-discovery\/(?:job\.py|app\/)|cybernaut|(?:^|[\s/_-])flue(?:[\s/_:-]|$)|(?:^|[\s/_-])radar(?:[\s/_:-]|$))/i

type CommandResult = { code: number; stdout: string; stderr: string }
type ProcessRow = { pid: number; parentPid: number; command: string }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[target-single-service] ${message}`)
}

function run(command: string, args: string[], timeout = 15_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: root,
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException & { code?: number } | null)?.code === 'number'
        ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
        : error ? 1 : 0
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`[target-single-service] required command is unavailable: ${command}`))
        return
      }
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

function parseProperties(value: string): Record<string, string> {
  return Object.fromEntries(value.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf('=')
    return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
  }))
}

function activeCronLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
}

function processRows(value: string): ProcessRow[] {
  return value.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) return []
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }]
  })
}

function ancestorProcessIds(rows: ProcessRow[]): Set<number> {
  const parents = new Map(rows.map((row) => [row.pid, row.parentPid]))
  const values = new Set<number>()
  let current = process.pid
  while (current > 0 && !values.has(current)) {
    values.add(current)
    current = parents.get(current) || 0
  }
  return values
}

async function projectProcessRows(rows: ProcessRow[], excluded: Set<number>): Promise<ProcessRow[]> {
  const values: ProcessRow[] = []
  for (const row of rows) {
    if (excluded.has(row.pid)) continue
    let hasProjectWorkingDirectory = false
    try {
      const cwd = await readlink(`/proc/${row.pid}/cwd`)
      hasProjectWorkingDirectory = cwd === root || cwd.startsWith(`${root}${path.sep}`)
    } catch {
      // Short-lived or inaccessible non-project processes remain discoverable by command signature.
    }
    if (hasProjectWorkingDirectory || projectProcessPattern.test(row.command)) values.push(row)
  }
  return values
}

function unitName(line: string): string {
  return line.trim().split(/\s+/)[0] || ''
}

async function inspectCronSources(serviceUser: string): Promise<{
  sources: string[]
  userCrontabsInspected: number
  systemCronFilesInspected: number
}> {
  requireCheck(/^[a-z_][a-z0-9_-]*[$]?$/i.test(serviceUser), 'systemd service User is invalid')
  const sources: string[] = []
  let userCrontabsInspected = 0
  for (const user of [...new Set(['root', serviceUser])]) {
    const result = await run('crontab', ['-u', user, '-l'])
    if (result.code === 0) {
      sources.push(result.stdout)
      userCrontabsInspected += 1
      continue
    }
    const diagnostic = `${result.stdout}\n${result.stderr}`
    requireCheck(/no crontab for|no crontab/i.test(diagnostic), `cannot inspect crontab for ${user}`)
    userCrontabsInspected += 1
  }

  let systemCronFilesInspected = 0
  try {
    sources.push(await readFile('/etc/crontab', 'utf8'))
    systemCronFilesInspected += 1
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  let entries: Dirent[]
  try {
    entries = await readdir('/etc/cron.d', { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = []
    else throw error
  }
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    sources.push(await readFile(path.join('/etc/cron.d', entry.name), 'utf8'))
    systemCronFilesInspected += 1
  }
  return { sources, userCrontabsInspected, systemCronFilesInspected }
}

function listenerRows(value: string, port: number): string[] {
  return value.split(/\r?\n/).filter((line) => new RegExp(`(?:^|[\\]:.])${port}(?:\\s|$)`).test(line))
}

function listenerPids(rows: string[]): number[] {
  const values = new Set<number>()
  for (const row of rows) {
    for (const match of row.matchAll(/pid=(\d+)/g)) values.add(Number(match[1]))
  }
  return [...values]
}

function loopbackListener(row: string, port: number): boolean {
  const fields = row.trim().split(/\s+/)
  const endpoint = fields[3] || ''
  return endpoint === `127.0.0.1:${port}` || endpoint === `[::1]:${port}` || endpoint === `::1:${port}`
}

async function pidBelongsToControlGroup(pid: number, controlGroup: string): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || !controlGroup.startsWith('/')) return false
  try {
    const membership = await readFile(`/proc/${pid}/cgroup`, 'utf8')
    return membership.split(/\r?\n/).some((line) => line.endsWith(`:${controlGroup}`))
  } catch {
    return false
  }
}

async function inspectContainerRuntime(command: 'docker' | 'podman') {
  try {
    const result = await run(command, ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Ports}}'])
    const projectContainers = result.stdout.split(/\r?\n/).filter((line) => (
      /cybernaut|(?:^|[\s/_-])flue(?:[\s/_:-]|$)|(?:^|[\s/_-])radar(?:[\s/_:-]|$)|(?:^|[\s/_-])sbl(?:[\s/_:-]|$)|(?::|->)(?:3100|3584|8121)(?:\/|\b)/i.test(line)
    )).length
    return { runtime: command, available: true, inspected: result.code === 0, projectContainers }
  } catch {
    return { runtime: command, available: false, inspected: true, projectContainers: 0 }
  }
}

async function staticAcceptance() {
  const [packageSource, deploySource, manualSource, source] = await Promise.all([
    readFile(path.resolve(root, 'package.json'), 'utf8'),
    readFile(path.resolve(root, 'deploy.sh'), 'utf8'),
    readFile(path.resolve(root, 'docs/迁移计划/目标Linux单服务现场取证手册-20260811.md'), 'utf8'),
    readFile(path.resolve(root, 'server/src/scripts/targetSingleServiceEvidence.ts'), 'utf8'),
  ])
  const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> }
  const checks = {
    packageScripts: packageJson.scripts?.['accept:target-single-service-evidence']
      === 'node --import tsx server/src/scripts/targetSingleServiceEvidence.ts --static'
      && packageJson.scripts?.['capture:target-single-service-evidence']
      === 'node --import tsx server/src/scripts/targetSingleServiceEvidence.ts --live',
    deploymentGate: /\"\$NPM_BIN\" run capture:target-single-service-evidence/.test(deploySource),
    oneServiceAndRetiredUnits: /cybernaut-app\.service/.test(source)
      && legacyUnits.every((unit) => source.includes(unit)),
    cgroupAndResourceContract: /ControlGroup/.test(source) && /KillMode/.test(source)
      && /MemoryMax/.test(source) && /CPUQuotaPerSecUSec/.test(source) && /TasksMax/.test(source)
      && /ExecStartPre=.*singleServicePrestart\.js/.test(deploySource)
      && /RestartPreventExitStatus=2 78/.test(deploySource)
      && /StartLimitIntervalSec=300/.test(deploySource) && /StartLimitBurst=5/.test(deploySource),
    portContract: /3100/.test(source) && /3584/.test(source) && /8121/.test(source)
      && /loopbackListener/.test(source),
    timerCronContainerAndNginxContract: /list-timers/.test(source) && /crontab/.test(source)
      && /inspectContainerRuntime/.test(source)
      && /nginx/.test(source) && /ssl_protocols/.test(source),
    completeCronInventoryContract: /readdir\('\/etc\/cron\.d'/.test(source)
      && /new Set\(\['root', serviceUser\]\)/.test(source)
      && /\/etc\/cron\.d\/\*/.test(deploySource),
    completeSystemdInventoryContract: /list-unit-files/.test(source)
      && /--type=service/.test(source) && /--type=timer/.test(source)
      && /projectUnitPattern/.test(source)
      && /migration-backups\/systemd/.test(deploySource)
      && /retire_legacy_systemd_unit_files/.test(deploySource),
    projectProcessCgroupContract: /ps', \['-eo', 'pid=,ppid=,args='\]/.test(source)
      && /ancestorProcessIds/.test(source) && /projectProcessPattern/.test(source)
      && /readlink\(`\/proc\/\$\{row\.pid\}\/cwd`\)/.test(source)
      && /rogueProjectProcessCount/.test(source),
    redactedEvidenceContract: /hostnameSha256/.test(source) && /machineIdSha256/.test(source)
      && /identifiersExcluded: true/.test(source) && /mode: 0o600/.test(source),
    handoffContract: /capture:target-single-service-evidence/.test(manualSource)
      && /不生成 PPT/.test(manualSource) && /不读取或保存.*密钥/.test(manualSource),
  }
  const ok = Object.values(checks).every(Boolean)
  const report = { schemaVersion: '1.0', generatedAt: new Date().toISOString(), mode: 'static', ok, checks }
  await writePrivate(path.join(evidenceDir, 'static-report.json'), report)
  console.log(JSON.stringify({ ok, mode: 'static', checks: Object.keys(checks).length }))
  if (!ok) process.exitCode = 2
}

async function liveEvidence() {
  requireCheck(process.platform === 'linux', 'live evidence must run on the target Linux host')
  const service = await run('systemctl', [
    'show', 'cybernaut-app.service', '--no-pager',
    '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState', '-p', 'MainPID',
    '-p', 'ControlGroup', '-p', 'User', '-p', 'KillMode', '-p', 'MemoryMax',
    '-p', 'CPUQuotaPerSecUSec', '-p', 'TasksMax',
  ])
  requireCheck(service.code === 0, 'cannot inspect cybernaut-app.service')
  const properties = parseProperties(service.stdout)
  const mainPid = Number(properties.MainPID || 0)
  const controlGroup = properties.ControlGroup || ''

  const socketState = await run('ss', ['-ltnpH'])
  requireCheck(socketState.code === 0, 'cannot inspect TCP listeners')
  const appListeners = listenerRows(socketState.stdout, 3100)
  const appListenerPids = listenerPids(appListeners)
  const legacyListenerRows = [...listenerRows(socketState.stdout, 3584), ...listenerRows(socketState.stdout, 8121)]

  const legacyStates = [] as Array<{ unit: typeof legacyUnits[number]; active: string; enabled: string }>
  for (const unit of legacyUnits) {
    const [active, enabled] = await Promise.all([
      run('systemctl', ['is-active', unit]),
      run('systemctl', ['is-enabled', unit]),
    ])
    legacyStates.push({ unit, active: active.stdout.trim() || 'not-found', enabled: enabled.stdout.trim() || 'not-found' })
  }

  const [timers, serviceUnits, serviceUnitFiles, timerUnitFiles, processState] = await Promise.all([
    run('systemctl', ['list-timers', '--all', '--no-legend', '--no-pager']),
    run('systemctl', ['list-units', '--type=service', '--all', '--plain', '--no-legend', '--no-pager']),
    run('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager']),
    run('systemctl', ['list-unit-files', '--type=timer', '--no-legend', '--no-pager']),
    run('ps', ['-eo', 'pid=,ppid=,args=']),
  ])
  requireCheck(timers.code === 0 && timerUnitFiles.code === 0, 'cannot inspect systemd timers')
  requireCheck(serviceUnits.code === 0 && serviceUnitFiles.code === 0, 'cannot inspect systemd service inventory')
  requireCheck(processState.code === 0, 'cannot inspect process inventory')
  const projectTimerLines = timers.stdout.split(/\r?\n/).filter((line) => (
    projectUnitPattern.test(unitName(line)) || /daily_intake|batch_analyze|sync_radar/i.test(line)
  ))
  const projectTimerUnitFiles = timerUnitFiles.stdout.split(/\r?\n/)
    .filter((line) => projectUnitPattern.test(unitName(line)))
  const projectServiceUnits = serviceUnits.stdout.split(/\r?\n/)
    .filter((line) => projectUnitPattern.test(unitName(line)))
  const projectServiceUnitFiles = serviceUnitFiles.stdout.split(/\r?\n/)
    .filter((line) => projectUnitPattern.test(unitName(line)))
  const unexpectedProjectServiceUnits = [...projectServiceUnits, ...projectServiceUnitFiles]
    .filter((line) => unitName(line) !== 'cybernaut-app.service')

  const allProcessRows = processRows(processState.stdout)
  const evidenceProcessTree = ancestorProcessIds(allProcessRows)
  const projectProcesses = await projectProcessRows(allProcessRows, evidenceProcessTree)
  const projectProcessOwnership = await Promise.all(projectProcesses.map(async (row) => ({
    pid: row.pid,
    belongsToUnifiedCgroup: await pidBelongsToControlGroup(row.pid, controlGroup),
  })))
  const rogueProjectProcessCount = projectProcessOwnership.filter((row) => !row.belongsToUnifiedCgroup).length

  const cronInventory = await inspectCronSources(properties.User || '')
  const retiredCronEntries = cronInventory.sources.flatMap(activeCronLines)
    .filter((line) => retiredCronPattern.test(line))

  const [serviceFile, nginxFile, environmentMetadata, machineId, hostname, docker, podman] = await Promise.all([
    readFile('/etc/systemd/system/cybernaut-app.service', 'utf8'),
    readFile('/etc/nginx/conf.d/cybernaut.conf', 'utf8'),
    lstat(path.resolve(root, '.env')),
    readFile('/etc/machine-id', 'utf8'),
    run('hostname', []),
    inspectContainerRuntime('docker'),
    inspectContainerRuntime('podman'),
  ])
  const nginxCheck = await run('nginx', ['-t'])
  const health = await fetch('http://127.0.0.1:3100/api/health/components', { signal: AbortSignal.timeout(10_000) })
  const healthBody = health.ok ? await health.json() as { service?: unknown; status?: unknown } : {}

  let cgroupProcessCount = 0
  try {
    const members = await readFile(path.resolve('/sys/fs/cgroup', controlGroup.replace(/^\/+/, ''), 'cgroup.procs'), 'utf8')
    cgroupProcessCount = members.split(/\r?\n/).filter(Boolean).length
  } catch {
    cgroupProcessCount = 0
  }

  const listenerOwnership = appListenerPids.length > 0
    && (await Promise.all(appListenerPids.map((pid) => pidBelongsToControlGroup(pid, controlGroup)))).every(Boolean)
  const legacyUnitsInactive = legacyStates.every((item) => item.active !== 'active')
  const legacyUnitsDisabled = legacyStates.every((item) => ['disabled', 'masked', 'not-found', 'static'].includes(item.enabled))
  const checks = {
    linuxTarget: true,
    unifiedServiceActive: properties.ActiveState === 'active' && properties.SubState === 'running',
    unifiedServiceEnabled: ['enabled', 'enabled-runtime'].includes(properties.UnitFileState || ''),
    dedicatedNonRootRuntimeUser: Boolean(properties.User) && properties.User !== 'root',
    validMainPidAndControlGroup: mainPid > 0 && controlGroup.startsWith('/')
      && await pidBelongsToControlGroup(mainPid, controlGroup),
    controlledCgroupResources: properties.KillMode === 'control-group'
      && !['', 'infinity', '[not set]'].includes(properties.MemoryMax || '')
      && !['', 'infinity', '[not set]'].includes(properties.CPUQuotaPerSecUSec || '')
      && !['', 'infinity', '[not set]'].includes(properties.TasksMax || ''),
    oneLoopbackApplicationListener: appListeners.length > 0
      && appListeners.every((row) => loopbackListener(row, 3100)) && listenerOwnership,
    retiredPortsClosed: legacyListenerRows.length === 0,
    legacyUnitsInactive,
    legacyUnitsDisabled,
    noUnexpectedProjectSystemdServices: unexpectedProjectServiceUnits.length === 0,
    noLegacyProjectTimers: projectTimerLines.length === 0 && projectTimerUnitFiles.length === 0,
    noLegacyProjectCron: retiredCronEntries.length === 0,
    allProjectProcessesInUnifiedCgroup: projectProcesses.some((row) => row.pid === mainPid)
      && rogueProjectProcessCount === 0,
    noParallelProjectContainers: docker.inspected && podman.inspected
      && docker.projectContainers === 0 && podman.projectContainers === 0,
    hardenedServiceUnit: /ExecStart=.*server-dist\/index\.js/.test(serviceFile)
      && /ExecStartPre=.*server-dist\/scripts\/singleServicePrestart\.js/.test(serviceFile)
      && /SINGLE_SERVICE_PRESTART_EVIDENCE_DIR=/.test(serviceFile)
      && /RestartPreventExitStatus=2 78/.test(serviceFile)
      && /StartLimitIntervalSec=300/.test(serviceFile) && /StartLimitBurst=5/.test(serviceFile)
      && /KillMode=control-group/.test(serviceFile) && /NoNewPrivileges=true/.test(serviceFile)
      && /ProtectSystem=strict/.test(serviceFile) && !/ExecStart=.*(?:3584|8121|cybernaut-assistant)/.test(serviceFile),
    privateRuntimeEnvironment: environmentMetadata.isFile() && !environmentMetadata.isSymbolicLink()
      && (environmentMetadata.mode & 0o077) === 0,
    tlsNginxConfiguration: nginxCheck.code === 0
      && /ssl_protocols\s+TLSv1\.2\s+TLSv1\.3/.test(nginxFile)
      && /proxy_pass\s+http:\/\/127\.0\.0\.1:3100/.test(nginxFile)
      && !/\/ai\/api|3584|8121/.test(nginxFile),
    applicationHealth: health.ok && healthBody.service === 'cybernaut-app',
    cgroupProcessInventoryReadable: cgroupProcessCount > 0,
  }
  const ok = Object.values(checks).every(Boolean)
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    mode: 'live-target-linux',
    ok,
    environment: {
      hostnameSha256: sha256(hostname.stdout.trim()),
      machineIdSha256: sha256(machineId.trim()),
      platform: process.platform,
      architecture: process.arch,
      identifiersExcluded: true,
    },
    topology: {
      businessServiceCount: 1,
      businessService: 'cybernaut-app.service',
      applicationPort: 3100,
      retiredPorts: [3584, 8121],
      cgroupProcessCount,
      listenerProcessCount: appListenerPids.length,
      userCrontabsInspected: cronInventory.userCrontabsInspected,
      systemCronFilesInspected: cronInventory.systemCronFilesInspected,
      projectServiceUnitsObserved: projectServiceUnits.length,
      projectServiceUnitFilesObserved: projectServiceUnitFiles.length,
      projectTimerUnitFilesObserved: projectTimerUnitFiles.length,
      projectProcessesObserved: projectProcesses.length,
      rogueProjectProcessCount,
      processIdsExcluded: true,
      controlGroupPathExcluded: true,
    },
    legacyUnits: legacyStates,
    containerRuntimes: [docker, podman],
    checks,
  }
  await writePrivate(path.join(evidenceDir, 'live-report.json'), report)
  console.log(JSON.stringify({ ok, mode: report.mode, checks: Object.keys(checks).length, businessServiceCount: 1 }))
  if (!ok) process.exitCode = 2
}

async function main() {
  const staticMode = process.argv.includes('--static')
  const liveMode = process.argv.includes('--live')
  requireCheck(staticMode !== liveMode, 'choose exactly one of --static or --live')
  if (staticMode) await staticAcceptance()
  else await liveEvidence()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
