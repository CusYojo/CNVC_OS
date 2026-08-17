import { db } from '../db/client.js'
import { radarCollectorStates, radarSourceRegistry } from '../db/schema.js'
import {
  radarCollectorHealth,
  runRadarPaperCollection,
  runRadarPublicCollection,
  runRadarWechatDaily,
  runRadarWechatInstitution,
  runRadarWechatRetry,
} from './radarCollectorService.js'
import { fetchRadarWindow } from './radarSyncService.js'

// Compatibility facade for old operational scripts. The implementation is
// deliberately in-process; executable/jobPath are rejected so this module can
// never recreate the retired Python child-process boundary.
export async function runRadarJob<T = Record<string, unknown>>(
  command: string,
  args: string[] = [],
  timeoutMs = 60_000,
  signal?: AbortSignal,
  execution: { executable?: string; jobPath?: string } = {},
): Promise<T> {
  if (execution.executable || execution.jobPath) {
    throw new Error('Radar 外部进程执行入口已退场；采集任务只能在 Node 主进程内运行')
  }
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`Radar job timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    if (command === 'health') return await radarCollectorHealth() as T
    if (command === 'auto') return await runRadarPublicCollection(controller.signal) as T
    if (command === 'paper-daily') return await runRadarPaperCollection(controller.signal) as T
    if (command === 'wechat-daily') return await runRadarWechatDaily(controller.signal) as T
    if (command === 'wechat-retry') return await runRadarWechatRetry(controller.signal) as T
    if (command === 'wechat-institution') return await runRadarWechatInstitution(controller.signal) as T
    if (command === 'candidates') {
      const value = (name: string) => args[args.indexOf(name) + 1]
      const result = await fetchRadarWindow({
        pageSize: Math.min(500, Math.max(1, Number(value('--limit')) || 100)),
        maxPages: 1,
        cursor: value('--cursor'),
        source: value('--source'),
        group: value('--group'),
      })
      return {
        items: result.items, total: result.total, has_more: result.hasMore, next_cursor: result.nextCursor,
      } as T
    }
    if (command === 'snapshot') {
      const [states, registry] = await Promise.all([
        db.select().from(radarCollectorStates),
        db.select().from(radarSourceRegistry),
      ])
      return {
        states: Object.fromEntries(states.map((state) => [state.id, { source_path: '', value: state.state }])),
        source_registry: registry.filter((source) => source.sourceKind === 'university-source').map((source) => source.config),
        accounts: registry.filter((source) => source.sourceKind === 'wechat-account').map((source) => source.config),
        public_sources: registry.filter((source) => source.sourceKind === 'public-source').map((source) => ({ ...source.config, enabled: source.enabled })),
      } as T
    }
    throw new Error(`不支持的 Radar 任务: ${command}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

export async function radarJobHealth() {
  return await radarCollectorHealth()
}
