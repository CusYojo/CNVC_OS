import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { leadAgentRuntimeGuardConfig } from '../services/leadAgentRuntimeGuardService.js'

type CountRow = RowDataPacket & { count: number | string }
type QueueRow = RowDataPacket & { status: string; count: number | string }
type RuntimeJobRow = RowDataPacket & {
  id: string
  enabled: number
  last_status: string | null
  consecutive_failures: number
  next_run_at: Date
  last_started_at: Date | null
  last_finished_at: Date | null
  has_error: number
  leased: number
}
type AgentPermitRow = RowDataPacket & {
  agent_profile: string
  state: 'succeeded' | 'failed'
  finished_at: Date
}

const table = (name: string) => quoteMysqlIdentifier(mysqlTableName(name))

async function countRows(name: string): Promise<number> {
  const [rows] = await pool.query<CountRow[]>(`SELECT COUNT(*) count FROM ${table(name)}`)
  return Number(rows[0]?.count || 0)
}

async function queueCounts(name: string): Promise<Record<string, number>> {
  const [rows] = await pool.query<QueueRow[]>(
    `SELECT status,COUNT(*) count FROM ${table(name)} GROUP BY status ORDER BY status`,
  )
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]))
}

async function readPublicHealth() {
  const origin = (process.env.RADAR_OBSERVATION_PUBLIC_ORIGIN || 'https://cybernaut.newmin.cn').replace(/\/$/, '')
  const [healthResponse, componentsResponse] = await Promise.all([
    fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`${origin}/api/health/components`, { signal: AbortSignal.timeout(15_000) }),
  ])
  if (!healthResponse.ok || !componentsResponse.ok) {
    throw new Error(`public health request failed: health=${healthResponse.status} components=${componentsResponse.status}`)
  }
  const health = await healthResponse.json() as { ok?: boolean; status?: string; service?: string }
  const componentHealth = await componentsResponse.json() as {
    ok?: boolean
    components?: Array<{ name?: string; ok?: boolean }>
  }
  const components = componentHealth.components ?? []
  return {
    origin,
    service: health.service ?? null,
    status: health.status ?? null,
    ok: health.ok === true && componentHealth.ok === true && components.every((component) => component.ok === true),
    componentsOk: components.filter((component) => component.ok === true).length,
    componentsTotal: components.length,
    failedComponents: components.filter((component) => component.ok !== true).map((component) => component.name ?? 'unknown'),
  }
}

async function main() {
  const [publicHealth, counts, runtimeJobsResult, queues, integrityResult, agentPermitsResult] = await Promise.all([
    readPublicHealth(),
    Promise.all([
      countRows('radar_candidates'),
      countRows('radar_raw_events'),
      countRows('radar_source_registry'),
      countRows('leads'),
      countRows('lead_reserve'),
      countRows('projects'),
    ]),
    pool.query<RuntimeJobRow[]>(
      `SELECT id,enabled,last_status,consecutive_failures,next_run_at,last_started_at,last_finished_at,
        last_error IS NOT NULL has_error,lease_owner IS NOT NULL leased
       FROM ${table('runtime_jobs')} WHERE id LIKE 'radar-%' ORDER BY id`,
    ),
    Promise.all([
      queueCounts('lead_score_jobs'),
      queueCounts('project_score_jobs'),
      queueCounts('ai_tasks'),
    ]),
    pool.query<Array<RowDataPacket & { candidates_without_raw_event: number | string }>>(
      `SELECT COUNT(*) candidates_without_raw_event
       FROM ${table('radar_candidates')} candidate
       LEFT JOIN ${table('radar_raw_events')} raw
         ON raw.source_key_hash=candidate.source_key_hash AND raw.content_hash=candidate.content_hash
       WHERE raw.id IS NULL`,
    ),
    pool.query<AgentPermitRow[]>(
      `SELECT agent_profile,state,finished_at
       FROM ${table('lead_agent_runtime_permits')}
       WHERE state IN ('succeeded','failed') AND finished_at>=NOW(3)-INTERVAL 24 HOUR
       ORDER BY agent_profile,finished_at DESC`,
    ),
  ])

  const runtimeJobs = runtimeJobsResult[0]
  const integrity = {
    candidatesWithoutRawEvent: Number(integrityResult[0][0]?.candidates_without_raw_event || 0),
  }
  const unhealthyRuntimeJobs = runtimeJobs.filter((job) => (
    !job.enabled
    || job.last_status !== 'succeeded'
    || Number(job.consecutive_failures) !== 0
    || Boolean(job.leased)
    || Boolean(job.has_error)
  ))
  const activeQueueStatuses = new Set(['queued', 'running', 'retrying', 'pending', 'failed', 'dead_letter'])
  const activeQueueItems = queues.reduce((total, queue) => total + Object.entries(queue)
    .filter(([status]) => activeQueueStatuses.has(status))
    .reduce((subtotal, [, value]) => subtotal + value, 0), 0)
  const guardConfig = leadAgentRuntimeGuardConfig()
  const agentProfiles = new Map<string, { consecutiveFailures: number; latestFinishedAt: Date | null; stopped: boolean }>()
  for (const row of agentPermitsResult[0]) {
    const profile = agentProfiles.get(row.agent_profile) ?? { consecutiveFailures: 0, latestFinishedAt: null, stopped: false }
    if (!profile.latestFinishedAt) profile.latestFinishedAt = row.finished_at
    if (!profile.stopped) {
      if (row.state === 'failed') profile.consecutiveFailures += 1
      else profile.stopped = true
    }
    agentProfiles.set(row.agent_profile, profile)
  }
  const sampledAt = new Date()
  const agentCircuits = [...agentProfiles.entries()].map(([agentProfile, profile]) => {
    const consecutiveFailures = profile.consecutiveFailures
    const latestFinishedAt = profile.latestFinishedAt
    const likelyOpen = consecutiveFailures >= guardConfig.circuitFailureThreshold
      && Boolean(latestFinishedAt && latestFinishedAt.getTime() + guardConfig.circuitOpenMs > sampledAt.getTime())
    return { agentProfile, consecutiveFailures, latestFinishedAt, likelyOpen }
  })
  const ok = publicHealth.ok
    && runtimeJobs.length === 5
    && unhealthyRuntimeJobs.length === 0
    && integrity.candidatesWithoutRawEvent === 0
    && activeQueueItems === 0
    && agentCircuits.every((circuit) => !circuit.likelyOpen)

  console.log(JSON.stringify({
    ok,
    sampledAt: sampledAt.toISOString(),
    publicHealth,
    counts: {
      radarCandidates: counts[0],
      radarRawEvents: counts[1],
      radarSourceRegistry: counts[2],
      leads: counts[3],
      leadReserve: counts[4],
      projects: counts[5],
    },
    runtimeJobs: runtimeJobs.map((job) => ({
      id: job.id,
      enabled: Boolean(job.enabled),
      lastStatus: job.last_status,
      consecutiveFailures: Number(job.consecutive_failures),
      nextRunAt: job.next_run_at,
      lastStartedAt: job.last_started_at,
      lastFinishedAt: job.last_finished_at,
      hasError: Boolean(job.has_error),
      leased: Boolean(job.leased),
    })),
    queues: {
      leadScore: queues[0],
      projectScore: queues[1],
      aiTasks: queues[2],
    },
    agentCircuits: {
      failureThreshold: guardConfig.circuitFailureThreshold,
      openMs: guardConfig.circuitOpenMs,
      profiles: agentCircuits,
    },
    integrity,
  }, null, 2))

  if (!ok) process.exitCode = 2
}

await main().finally(async () => pool.end())
