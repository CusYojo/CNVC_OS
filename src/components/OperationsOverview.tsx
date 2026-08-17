import { Activity, Bot, Database, FileCheck2, Gauge, MessageSquare, Play, Plug, Power, RefreshCw, SearchCheck, Workflow } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { formatShanghaiDateTime } from '../lib/dateTime'
import { useToast } from './Toast'
import { Badge, Button, Card } from './ui'

type MigrationReadiness = {
  kind: 'migration-readiness'
  ready: boolean
  fileManifest: {
    available: boolean
    generatedAt: string | null
    strict: boolean
    technicalReady: boolean
    approvalRecorded: boolean
    roots: number
    rootsPresent: number
    files: number
    blockingIssues: number
    unresolved: number
  }
  productionSources: { available: boolean; generatedAt: string | null; approved: boolean }
  radarAssets: {
    available: boolean
    generatedAt: string | null
    localTechnicalReady: boolean
    productionAssetReady: boolean
    fullSourceAssetReady: boolean
  }
  reconciliation: {
    available: boolean
    generatedAt: string | null
    targetStructuralIntegrityReady: boolean
    sourceReconciliationReady: boolean
    fullMigrationReady: boolean
  }
}

type OperationsSnapshot = {
  status: 'ok' | 'warning' | 'critical'
  timestamp: string
  alerts: Array<{ code: string; severity: 'warning' | 'critical'; metric: string; value: number }>
  database: {
    mysqlPool: {
      configuredLimit: number
      totalConnections: number
      freeConnections: number
      waitingRequests: number
    }
    mysqlServer: {
      statusObservationAvailable: boolean
      threadsConnected: number
      threadsRunning: number
      slowQueriesTotal: number
      currentRowLockWaits: number
    }
    im: {
      queued: number
      sending: number
      failed: number
      deadLetter: number
      deliveries15m: number
      deliveryFailures15m: number
      averageDeliveryMs15m: number
    }
    jobHistory: {
      failed24h: number
      deadLetter24h: number
      timeoutFailures24h: number
      expiredLeases: number
    }
    cdc: {
      sources: number
      unhealthySources: number
      maxReplicationLagMs: number
      watermarkGap: number
      deleteEvents: number
      cascadeDeleteEvents: number
    }
    leadReserve: {
      total: number
      imported: number
      importedTimestampMissing: number
      sourceMissing: number
      awaitingProcessing: number
      maxSequence: number
      rawEventMissing: number
    }
    radar: {
      rawEvents: number
      candidates: number
      collectorStates: number
      sourceRegistry: number
      syncStates: number
      incompleteBackfills: number
      latestCursorTimestamp: number
      runtimeJobs: number
      failedRuntimeJobs: number
    }
  }
  components: Array<{
    name?: string
    kind?: string
    ok?: boolean
    active?: number
    enabled?: number
    leased?: number
    queued?: number
    pending?: number
    running?: number
    retrying?: number
    failed?: number
    deadLetter?: number
    activeSessions?: number
    pendingInteractions?: number
    connections?: number
    dbOperations?: { active: number; waiting: number; limit: number }
    lifecycle?: { pendingReconnects: number; disconnectRecoveryRate: number }
  } & Record<string, unknown>>
}

type RadarManagement = {
  sources: Array<{
    id: string
    kind: string
    group: string
    name: string
    externalKey: string
    enabled: boolean
    config: { type: string; url: string; frequency: string; note: string }
    lastFetched: number | null
    lastError: string
    updatedAt: string
  }>
  jobs: Array<{
    id: string
    enabled: boolean
    scheduleKind: 'interval' | 'daily'
    intervalSeconds: number | null
    dailyHour: number | null
    dailyMinute: number | null
    nextRunAt: string
    lastStatus: string | null
    lastFinishedAt: string | null
    lastError: string | null
    running: boolean
  }>
}

function readinessBadge(ready: boolean, readyText = '已就绪', blockedText = '待补证') {
  return <Badge tone={ready ? 'green' : 'amber'}>{ready ? readyText : blockedText}</Badge>
}

function timestamp(value: string | null | undefined) {
  if (!value) return '无证据'
  try { return formatShanghaiDateTime(value) } catch { return '时间不可用' }
}

function metricCard(icon: typeof Activity, label: string, value: string | number, note: string) {
  const Icon = icon
  return <Card className="p-4"><Icon className="h-4 w-4 text-brand-600" /><p className="mt-3 text-xs text-slate-400">{label}</p><p className="mt-1 text-xl font-semibold text-slate-800">{value}</p><p className="mt-1 text-[11px] text-slate-400">{note}</p></Card>
}

function healthCard(
  icon: typeof Activity,
  label: string,
  ready: boolean,
  value: string | number,
  note: string,
) {
  const Icon = icon
  return <Card className="min-w-0 p-4">
    <div className="flex items-center justify-between gap-2"><Icon className="h-4 w-4 shrink-0 text-brand-600" />{readinessBadge(ready, '正常', '需关注')}</div>
    <p className="mt-3 text-xs text-slate-400">{label}</p>
    <p className="mt-1 truncate text-xl font-semibold text-slate-800">{value}</p>
    <p className="mt-1 text-[11px] text-slate-400">{note}</p>
  </Card>
}

export function OperationsOverview() {
  const { showToast } = useToast()
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null)
  const [radarManagement, setRadarManagement] = useState<RadarManagement | null>(null)
  const [loading, setLoading] = useState(false)
  const [radarBusy, setRadarBusy] = useState('')
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextSnapshot, nextRadarManagement] = await Promise.all([
        apiGet<OperationsSnapshot>('/operations/metrics'),
        apiGet<RadarManagement>('/operations/radar'),
      ])
      setSnapshot(nextSnapshot)
      setRadarManagement(nextRadarManagement)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '运维快照加载失败')
    } finally {
      setLoading(false)
    }
  }, [])
  const mutateRadar = useCallback(async (key: string, action: () => Promise<unknown>, success: string) => {
    setRadarBusy(key)
    try {
      await action()
      setRadarManagement(await apiGet<RadarManagement>('/operations/radar'))
      showToast(success)
    } catch (reason) {
      showToast(`Radar 配置操作失败：${reason instanceof Error ? reason.message : '未知错误'}`, 'error')
    } finally {
      setRadarBusy('')
    }
  }, [showToast])
  useEffect(() => { void load() }, [load])
  const migration = useMemo(() => snapshot?.components.find((component) => (
    component.kind === 'migration-readiness'
  )) as MigrationReadiness | undefined, [snapshot])

  if (!snapshot && loading) return <Card className="p-10 text-center text-sm text-slate-400">正在读取统一运维快照…</Card>
  if (!snapshot) return <Card className="p-8 text-center"><p className="text-sm text-rose-600">{error || '运维快照不可用'}</p><Button className="mt-4" variant="secondary" onClick={() => void load()}>重新加载</Button></Card>

  const { cdc, radar, leadReserve, mysqlPool, mysqlServer, im, jobHistory } = snapshot.database
  const agent = snapshot.components.find((component) => component.name === 'jw-agent-runtime')
  const socket = snapshot.components.find((component) => component.name === 'agent-socket')
  const workers = snapshot.components.filter((component) => [
    'mysql-runtime-jobs', 'mysql-lead-score-jobs', 'mysql-project-score-jobs', 'mysql-ai-tasks',
  ].includes(component.name ?? ''))
  const workerQueued = workers.reduce((sum, worker) => sum + (worker.queued ?? worker.pending ?? 0), 0)
  const workerRunning = workers.reduce((sum, worker) => sum + (worker.running ?? worker.active ?? 0), 0)
  const workerDeadLetter = workers.reduce((sum, worker) => sum + (worker.deadLetter ?? 0), 0)
  const workersReady = workers.length === 4 && workers.every((worker) => worker.ok !== false)
  const mysqlReady = mysqlPool.waitingRequests === 0 && mysqlServer.currentRowLockWaits === 0
  const imReady = im.deadLetter === 0 && im.deliveryFailures15m === 0
  const fullReady = migration?.reconciliation.fullMigrationReady === true
  const publicSources = radarManagement?.sources.filter((source) => source.kind === 'public-source') ?? []
  const inheritedSources = radarManagement?.sources.filter((source) => source.kind !== 'public-source') ?? []
  return <div className="space-y-5">
    <div className="flex items-center gap-3">
      {readinessBadge(fullReady, '全量迁移已就绪', '全量迁移未就绪')}
      <span className="text-xs text-slate-400">快照时间：{timestamp(snapshot.timestamp)}</span>
      <Button className="ml-auto" size="sm" variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
    </div>

    {error && <Card className="border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">刷新失败，当前显示上一次成功快照：{error}</Card>}

    <div>
      <div className="mb-3"><h3 className="font-medium text-slate-800">统一服务组件健康</h3><p className="mt-1 text-xs text-slate-400">MySQL、四类 Worker、Socket、Agent 与 IM 均由当前 cybernaut-app 进程统一观测。</p></div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {healthCard(Database, 'MySQL', mysqlReady, `${mysqlPool.totalConnections}/${mysqlPool.configuredLimit} 连接`, `空闲 ${mysqlPool.freeConnections} · 等待 ${mysqlPool.waitingRequests} · 运行线程 ${mysqlServer.statusObservationAvailable ? mysqlServer.threadsRunning : '观测受限'}`)}
        {healthCard(Workflow, 'Worker', workersReady && workerDeadLetter === 0, `${workers.filter((worker) => worker.ok !== false).length}/${workers.length} 健康`, `排队 ${workerQueued} · 运行 ${workerRunning} · 死信 ${workerDeadLetter}`)}
        {healthCard(Plug, 'Socket', socket?.ok === true && (socket.dbOperations?.waiting ?? 0) === 0, socket?.connections ?? 0, `DB 活跃/等待 ${socket?.dbOperations?.active ?? 0}/${socket?.dbOperations?.waiting ?? 0} · 待重连 ${socket?.lifecycle?.pendingReconnects ?? 0}`)}
        {healthCard(Bot, 'Agent', agent?.ok === true, agent?.activeSessions ?? 0, `活跃会话 · 待交互 ${agent?.pendingInteractions ?? 0}`)}
        {healthCard(MessageSquare, 'IM', imReady, im.queued + im.sending, `待发/发送中 · 15 分钟成功 ${im.deliveries15m} · 失败 ${im.deliveryFailures15m} · 死信 ${im.deadLetter}`)}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">任务历史 24 小时：失败 {jobHistory.failed24h} · 超时 {jobHistory.timeoutFailures24h} · 死信 {jobHistory.deadLetter24h} · 过期租约 {jobHistory.expiredLeases}；MySQL 慢查询累计 {mysqlServer.slowQueriesTotal}。</p>
    </div>

    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {metricCard(Activity, 'CDC watermark gap', cdc.watermarkGap, `${cdc.sources} 个源 · ${cdc.unhealthySources} 个异常`)}
      {metricCard(Gauge, 'Radar 候选 / 原始事件', `${radar.candidates} / ${radar.rawEvents}`, `${radar.sourceRegistry} 个来源 · ${radar.collectorStates} 份状态`)}
      {metricCard(Database, '储备池待处理', leadReserve.awaitingProcessing, `总计 ${leadReserve.total} · 已导入 ${leadReserve.imported}`)}
      {metricCard(FileCheck2, '文件 manifest', migration?.fileManifest.files ?? 0, `${migration?.fileManifest.rootsPresent ?? 0}/${migration?.fileManifest.roots ?? 0} 个根可见`)}
    </div>

    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <div><h3 className="font-medium text-slate-800">Radar 外部源统一管理</h3><p className="mt-1 text-xs text-slate-400">来源配置、TypeScript 采集和线索同步均由当前 3100 主服务及 MySQL 调度管理，不启动独立采集服务。</p></div>
        <Badge tone="blue">{publicSources.filter((source) => source.enabled).length}/{publicSources.length} 个公开源启用</Badge>
      </div>
      <div className="grid gap-0 xl:grid-cols-[1.3fr_1fr]">
        <div className="border-b border-slate-100 xl:border-b-0 xl:border-r">
          <div className="grid grid-cols-[1fr_110px_90px_80px] gap-3 bg-slate-50 px-5 py-2 text-[11px] font-medium text-slate-400"><span>来源</span><span>分组/频率</span><span>类型</span><span>状态</span></div>
          <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
            {publicSources.map((source) => <div key={source.id} className="grid grid-cols-[1fr_110px_90px_80px] items-center gap-3 px-5 py-3 text-sm">
              <div className="min-w-0"><p className="truncate font-medium text-slate-700">{source.name}</p><p className={`mt-0.5 truncate text-[11px] ${source.lastError ? 'text-rose-500' : 'text-slate-400'}`} title={source.lastError || source.config.url}>{source.lastError ? `采集异常：${source.lastError}` : source.config.url}</p></div>
              <div className="text-xs text-slate-500"><p>{source.group || '未分组'}</p><p className="text-slate-400">{source.config.frequency || '按任务'}</p></div>
              <span className="truncate text-xs text-slate-500">{source.config.type || '适配器'}{source.lastFetched !== null ? ` · ${source.lastFetched}` : ''}</span>
              <button disabled={radarBusy !== ''} className={`inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs ${source.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`} onClick={() => void mutateRadar(`source-${source.id}`, () => apiPatch(`/operations/radar/sources/${source.id}`, { enabled: !source.enabled }), source.enabled ? `${source.name} 已停用` : `${source.name} 已启用`)}><Power className="h-3 w-3" />{source.enabled ? '启用' : '停用'}</button>
            </div>)}
            {!publicSources.length && <p className="p-8 text-center text-sm text-slate-400">公开源目录尚未继承；重启主服务后会从 Radar 内置目录自动引入 MySQL。</p>}
          </div>
          <p className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">另有 {inheritedSources.length} 个高校/公众号来源已纳入同一来源注册表；公众号账号标识缺失的来源不会被误报为可采集。</p>
        </div>
        <div>
          <div className="bg-slate-50 px-5 py-2 text-[11px] font-medium text-slate-400">统一调度任务</div>
          <div className="divide-y divide-slate-100">
            {(radarManagement?.jobs ?? []).map((job) => <div key={job.id} className="px-5 py-3">
              <div className="flex items-center gap-2"><p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{job.id}</p><Badge tone={job.running ? 'blue' : job.lastStatus === 'failed' || job.lastStatus === 'dead_letter' ? 'red' : job.enabled ? 'green' : 'slate'}>{job.running ? '运行中' : job.enabled ? '已启用' : '已停用'}</Badge></div>
              <p className="mt-1 text-[11px] text-slate-400">{job.scheduleKind === 'daily' ? `每天 ${String(job.dailyHour ?? 0).padStart(2, '0')}:${String(job.dailyMinute ?? 0).padStart(2, '0')}` : `每 ${Math.round((job.intervalSeconds ?? 0) / 60)} 分钟`} · 上次 {job.lastFinishedAt ? timestamp(job.lastFinishedAt) : '未运行'}</p>
              {job.lastError && <p className="mt-1 line-clamp-2 text-[11px] text-rose-500">{job.lastError}</p>}
              <div className="mt-2 flex gap-2"><Button size="sm" variant="secondary" disabled={radarBusy !== '' || !job.enabled || job.running} onClick={() => void mutateRadar(`run-${job.id}`, () => apiPost(`/operations/radar/jobs/${job.id}/run`), `${job.id} 已加入立即执行队列`)}><Play className="h-3.5 w-3.5" />立即执行</Button><Button size="sm" variant="ghost" disabled={radarBusy !== '' || job.running} onClick={() => void mutateRadar(`job-${job.id}`, () => apiPatch(`/operations/radar/jobs/${job.id}`, { enabled: !job.enabled }), job.enabled ? `${job.id} 已停用` : `${job.id} 已启用`)}>{job.enabled ? '停用' : '启用'}</Button></div>
            </div>)}
          </div>
        </div>
      </div>
    </Card>

    <div className="grid grid-cols-2 gap-5">
      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2"><Activity className="h-4 w-4 text-brand-600" /><h3 className="font-medium text-slate-800">CDC 与 Radar 游标</h3></div>
        <dl className="space-y-3 text-sm">
          {[
            ['CDC 最大延迟', `${cdc.maxReplicationLagMs} ms`],
            ['删除 / 级联删除', `${cdc.deleteEvents} / ${cdc.cascadeDeleteEvents}`],
            ['Radar 最新游标', radar.latestCursorTimestamp ? String(radar.latestCursorTimestamp) : '当前无候选'],
            ['Radar 同步状态 / 未完成回填', `${radar.syncStates} / ${radar.incompleteBackfills}`],
            ['Radar 调度任务 / 失败', `${radar.runtimeJobs} / ${radar.failedRuntimeJobs}`],
          ].map(([label, value]) => <div key={label} className="flex justify-between border-b border-slate-100 pb-2"><dt className="text-slate-500">{label}</dt><dd className="font-medium text-slate-700">{value}</dd></div>)}
        </dl>
      </Card>

      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2"><SearchCheck className="h-4 w-4 text-brand-600" /><h3 className="font-medium text-slate-800">线索来源完整性</h3></div>
        <dl className="space-y-3 text-sm">
          {[
            ['最大 36氪 seq', leadReserve.maxSequence],
            ['原始事件缺失', leadReserve.rawEventMissing],
            ['详情缺失隔离', leadReserve.sourceMissing],
            ['历史 imported 时间未知', leadReserve.importedTimestampMissing],
          ].map(([label, value]) => <div key={label} className="flex justify-between border-b border-slate-100 pb-2"><dt className="text-slate-500">{label}</dt><dd className="font-medium text-slate-700">{value}</dd></div>)}
        </dl>
      </Card>
    </div>

    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 px-5 py-4"><h3 className="font-medium text-slate-800">迁移证据状态</h3><p className="mt-1 text-xs text-slate-400">仅展示计数、布尔结论和生成时间，不返回路径、文件名、业务正文、审批人或凭据。</p></div>
      <div className="divide-y divide-slate-100">
        {[
          ['目标 MySQL 结构', migration?.reconciliation.targetStructuralIntegrityReady === true, timestamp(migration?.reconciliation.generatedAt), `源对账 ${migration?.reconciliation.sourceReconciliationReady ? '已就绪' : '未就绪'}`],
          ['文件 manifest 技术核对', migration?.fileManifest.technicalReady === true, timestamp(migration?.fileManifest.generatedAt), `${migration?.fileManifest.blockingIssues ?? 0} 个阻断 · 批准 ${migration?.fileManifest.approvalRecorded ? '已记录' : '未记录'}`],
          ['生产数据源盘点', migration?.productionSources.approved === true, timestamp(migration?.productionSources.generatedAt), migration?.productionSources.available ? '报告存在' : '未提供批准报告'],
          ['Radar 生产原资产', migration?.radarAssets.productionAssetReady === true, timestamp(migration?.radarAssets.generatedAt), `本地技术核对 ${migration?.radarAssets.localTechnicalReady ? '通过' : '未通过'}`],
        ].map(([label, ready, generatedAt, note]) => <div key={String(label)} className="grid grid-cols-[1fr_auto_180px_220px] items-center gap-4 px-5 py-3 text-sm"><span className="font-medium text-slate-700">{String(label)}</span>{readinessBadge(Boolean(ready))}<span className="text-xs text-slate-400">{String(generatedAt)}</span><span className="text-xs text-slate-500">{String(note)}</span></div>)}
      </div>
    </Card>

    <Card className="p-5">
      <div className="flex items-center justify-between"><h3 className="font-medium text-slate-800">当前运维告警</h3><Badge tone={snapshot.status === 'critical' ? 'red' : snapshot.status === 'warning' ? 'amber' : 'green'}>{snapshot.status}</Badge></div>
      {snapshot.alerts.length ? <div className="mt-3 flex flex-wrap gap-2">{snapshot.alerts.map((alert) => <Badge key={`${alert.code}:${alert.metric}`} tone={alert.severity === 'critical' ? 'red' : 'amber'}>{alert.code}</Badge>)}</div> : <p className="mt-3 text-sm text-slate-400">当前没有阈值告警。</p>}
    </Card>
  </div>
}
