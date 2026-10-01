import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { radarSourceRegistry, runtimeJobs } from '../db/schema.js'
import {
  buildDiscoveryMonitoringPlans, type DiscoveryMonitorKey, type DiscoveryMonitorSource,
} from '../contracts/discoveryMonitoringContract.js'
import { listManagedRadarSources } from './radarSourceManagementService.js'

export async function listDiscoveryMonitoringPlans() {
  const [sources, jobs] = await Promise.all([
    listManagedRadarSources(),
    db.select({ enabled: runtimeJobs.enabled }).from(runtimeJobs)
      .where(eq(runtimeJobs.id, 'radar-collect-sync')).limit(1),
  ])
  return buildDiscoveryMonitoringPlans(sources as DiscoveryMonitorSource[], jobs[0]?.enabled === true)
}

export async function setDiscoveryMonitoringPlanEnabled(key: DiscoveryMonitorKey, enabled: boolean) {
  const plan = (await listDiscoveryMonitoringPlans()).find((item) => item.key === key)
  if (!plan?.ready || plan.sourceIds.length === 0) {
    throw Object.assign(new Error('该监测类型暂无可运行的公开来源，不能启用'), {
      status: 409, code: 'DISCOVERY_MONITOR_NOT_READY',
    })
  }
  await db.update(radarSourceRegistry).set({ enabled, updatedAt: new Date() })
    .where(inArray(radarSourceRegistry.id, plan.sourceIds))
  return (await listDiscoveryMonitoringPlans()).find((item) => item.key === key)
}
