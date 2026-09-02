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

type RadarCandidate = {
  candidate_id: string
  source?: string
  source_name?: string
  source_group?: string
  title?: string
  summary?: string
  article_text?: string
  attention_score?: number
  worth_attention?: boolean
  published_at?: string
  collected_at?: string
  link?: string
  signals?: Array<{ label?: string; detail?: string }>
}

type RadarCandidatePage = {
  items: RadarCandidate[]
  total: number
  has_more: boolean
  next_cursor: string
}

type RadarSummary = {
  total: number
  worth_attention: number
  avg_score: number
  sources: Record<string, number>
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
  return <Card className="p-4"><Icon className="h-4 w-4 text-brand-600" /><p className="mt-3 text-xs text-slate-400">{label}</p><p className="mt-1 text-xl font-semibold text-slate-800">{value}</p><p className="mt-1 text-xs text-slate-400">{note}</p></Card>
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
    <p className="mt-1 text-xs text-slate-400">{note}</p>
  </Card>
}

export function OperationsOverview() {
  const { showToast } = useToast()
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null)
  const [radarManagement, setRadarManagement] = useState<RadarManagement | null>(null)
  const [radarSummary, setRadarSummary] = useState<RadarSummary | null>(null)
  const [candidatePage, setCandidatePage] = useState<RadarCandidatePage | null>(null)
  const [candidateFilters, setCandidateFilters] = useState({ q: '', source: '', group: '', minScore: '0', attentionOnly: true })
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([])
  const [candidateBusy, setCandidateBusy] = useState(false)
  const [sourceEdit, setSourceEdit] = useState<{ id: string; group: string; frequency: string } | null>(null)
  const [accountQuery, setAccountQuery] = useState('')
  const [replaceAccounts, setReplaceAccounts] = useState(false)
  const [loading, setLoading] = useState(false)
  const [radarBusy, setRadarBusy] = useState('')
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextSnapshot, nextRadarManagement, nextRadarSummary, nextCandidatePage] = await Promise.all([
        apiGet<OperationsSnapshot>('/operations/metrics'),
        apiGet<RadarManagement>('/operations/radar'),
        apiGet<RadarSummary>('/radar/summary'),
        apiGet<RadarCandidatePage>('/radar/candidates?limit=50&sort=collected&attention_only=true'),
      ])
      setSnapshot(nextSnapshot)
      setRadarManagement(nextRadarManagement)
      setRadarSummary(nextRadarSummary)
      setCandidatePage(nextCandidatePage)
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
  const loadCandidates = useCallback(async (cursor = '', append = false) => {
    setCandidateBusy(true)
    try {
      const query = new URLSearchParams({
        limit: '50', sort: 'collected', attention_only: String(candidateFilters.attentionOnly),
        min_score: candidateFilters.minScore || '0',
      })
      if (candidateFilters.q.trim()) query.set('q', candidateFilters.q.trim())
      if (candidateFilters.source) query.set('source', candidateFilters.source)
      if (candidateFilters.group.trim()) query.set('group', candidateFilters.group.trim())
      if (cursor) query.set('cursor', cursor)
      const next = await apiGet<RadarCandidatePage>(`/radar/candidates?${query.toString()}`)
      setCandidatePage((current) => append && current ? {
        ...next,
        items: [...current.items, ...next.items.filter((item) => !current.items.some((existing) => existing.candidate_id === item.candidate_id))],
      } : next)
      if (!append) setSelectedCandidateIds([])
    } catch (reason) {
      showToast(`Radar 候选加载失败：${reason instanceof Error ? reason.message : '未知错误'}`, 'error')
    } finally {
      setCandidateBusy(false)
    }
  }, [candidateFilters, showToast])
  const syncSelectedCandidates = useCallback(async () => {
    if (!selectedCandidateIds.length) return
    setCandidateBusy(true)
    try {
      const result = await apiPost<{ created?: number; updated?: number; unchanged?: number; aiFailed?: number }>('/leads/sync-radar', {
        candidateIds: selectedCandidateIds,
      }, { signal: AbortSignal.timeout(10 * 60_000) })
      showToast(`候选批量处理完成：新增 ${result.created ?? 0}，更新 ${result.updated ?? 0}，无变化 ${result.unchanged ?? 0}${result.aiFailed ? `，AI 失败 ${result.aiFailed}` : ''}`)
      setSelectedCandidateIds([])
      await loadCandidates()
    } catch (reason) {
      showToast(`候选批量处理失败：${reason instanceof Error ? reason.message : '未知错误'}`, 'error')
    } finally {
      setCandidateBusy(false)
    }
  }, [loadCandidates, selectedCandidateIds, showToast])
  const importWechatAccounts = useCallback(async (file: File) => {
    if (!/\.(?:xlsx?|csv)$/i.test(file.name)) {
      showToast('公众号账号导入仅支持 XLS、XLSX 或 CSV', 'error')
      return
    }
    setRadarBusy('account-import')
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error || new Error('文件读取失败'))
        reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || '')
        reader.readAsDataURL(file)
      })
      const result = await apiPost<{ imported: number; duplicatesRemoved: number; total: number }>('/operations/radar/wechat-accounts/import', {
        name: file.name, dataBase64, replace: replaceAccounts,
      })
      setRadarManagement(await apiGet<RadarManagement>('/operations/radar'))
      showToast(`公众号账号导入完成：导入 ${result.imported}，去重 ${result.duplicatesRemoved}，当前启用 ${result.total}`)
    } catch (reason) {
      showToast(`公众号账号导入失败：${reason instanceof Error ? reason.message : '未知错误'}`, 'error')
    } finally {
      setRadarBusy('')
    }
  }, [replaceAccounts, showToast])
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
  const wechatAccounts = inheritedSources.filter((source) => source.kind === 'wechat-account')
  const visibleWechatAccounts = wechatAccounts.filter((source) => {
    const query = accountQuery.trim().toLocaleLowerCase('zh-CN')
    return !query || `${source.name}\n${source.externalKey}\n${source.group}`.toLocaleLowerCase('zh-CN').includes(query)
  }).slice(0, 100)
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
      <p className="mt-2 text-xs text-slate-400">任务历史 24 小时：失败 {jobHistory.failed24h} · 超时 {jobHistory.timeoutFailures24h} · 死信 {jobHistory.deadLetter24h} · 过期租约 {jobHistory.expiredLeases}；MySQL 慢查询累计 {mysqlServer.slowQueriesTotal}。</p>
    </div>

    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {metricCard(Activity, 'CDC watermark gap', cdc.watermarkGap, `${cdc.sources} 个源 · ${cdc.unhealthySources} 个异常`)}
      {metricCard(Gauge, 'Radar 候选 / 原始事件', `${radar.candidates} / ${radar.rawEvents}`, `${radar.sourceRegistry} 个来源 · ${radar.collectorStates} 份状态`)}
      {metricCard(Database, '储备池待处理', leadReserve.awaitingProcessing, `总计 ${leadReserve.total} · 已导入 ${leadReserve.imported}`)}
      {metricCard(FileCheck2, '文件 manifest', migration?.fileManifest.files ?? 0, `${migration?.fileManifest.rootsPresent ?? 0}/${migration?.fileManifest.roots ?? 0} 个根可见`)}
    </div>

    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <div><h3 className="font-medium text-slate-800">Radar 外部源统一管理</h3><p className="mt-1 text-xs text-slate-400">来源配置、TypeScript 采集和线索同步均由当前 4100 主服务及 MySQL 调度管理，不启动独立采集服务。</p></div>
        <Badge tone="blue">{publicSources.filter((source) => source.enabled).length}/{publicSources.length} 个公开源启用</Badge>
      </div>
      <div className="grid gap-0 xl:grid-cols-[1.3fr_1fr]">
        <div className="border-b border-slate-100 xl:border-b-0 xl:border-r">
          <div className="grid grid-cols-[1fr_110px_90px_80px] gap-3 bg-slate-50 px-5 py-2 text-xs font-medium text-slate-400"><span>来源</span><span>分组/频率</span><span>类型</span><span>状态</span></div>
          <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
            {publicSources.map((source) => <div key={source.id}>
              <div className="grid grid-cols-[1fr_110px_90px_110px] items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0"><p className="truncate font-medium text-slate-700">{source.name}</p><p className={`mt-0.5 truncate text-xs ${source.lastError ? 'text-rose-500' : 'text-slate-400'}`} title={source.lastError || source.config.url}>{source.lastError ? `采集异常：${source.lastError}` : source.config.url}</p></div>
                <div className="text-xs text-slate-500"><p>{source.group || '未分组'}</p><p className="text-slate-400">{source.config.frequency || '按任务'}</p></div>
                <span className="truncate text-xs text-slate-500">{source.config.type || '适配器'}{source.lastFetched !== null ? ` · ${source.lastFetched}` : ''}</span>
                <div className="flex gap-1"><button disabled={radarBusy !== ''} className={`inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs ${source.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`} onClick={() => void mutateRadar(`source-${source.id}`, () => apiPatch(`/operations/radar/sources/${source.id}`, { enabled: !source.enabled }), source.enabled ? `${source.name} 已停用` : `${source.name} 已启用`)}><Power className="h-3 w-3" />{source.enabled ? '启用' : '停用'}</button><button className="rounded-md px-2 py-1 text-xs text-brand-600 hover:bg-brand-50" onClick={() => setSourceEdit(sourceEdit?.id === source.id ? null : { id: source.id, group: source.group, frequency: source.config.frequency })}>编辑</button></div>
              </div>
              {sourceEdit?.id === source.id && <div className="grid grid-cols-[1fr_1fr_auto] gap-2 bg-brand-50/40 px-5 py-3"><input className="input" placeholder="来源分组" value={sourceEdit.group} onChange={(event) => setSourceEdit({ ...sourceEdit, group: event.target.value })} /><input className="input" placeholder="采集频率" value={sourceEdit.frequency} onChange={(event) => setSourceEdit({ ...sourceEdit, frequency: event.target.value })} /><Button size="sm" loading={radarBusy !== ''} onClick={() => void mutateRadar(`source-meta-${source.id}`, () => apiPatch(`/operations/radar/sources/${source.id}`, { group: sourceEdit.group, frequency: sourceEdit.frequency }), `${source.name} 配置已更新`).then(() => setSourceEdit(null))}>保存</Button></div>}
            </div>)}
            {!publicSources.length && <p className="p-8 text-center text-sm text-slate-400">公开源目录尚未继承；重启主服务后会从 Radar 内置目录自动引入 MySQL。</p>}
          </div>
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">另有 {inheritedSources.length} 个高校/公众号来源已纳入同一来源注册表；公众号账号标识缺失的来源不会被误报为可采集。</p>
        </div>
        <div>
          <div className="bg-slate-50 px-5 py-2 text-xs font-medium text-slate-400">统一调度任务</div>
          <div className="divide-y divide-slate-100">
            {(radarManagement?.jobs ?? []).map((job) => <div key={job.id} className="px-5 py-3">
              <div className="flex items-center gap-2"><p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{job.id}</p><Badge tone={job.running ? 'blue' : job.lastStatus === 'failed' || job.lastStatus === 'dead_letter' ? 'red' : job.enabled ? 'green' : 'slate'}>{job.running ? '运行中' : job.enabled ? '已启用' : '已停用'}</Badge></div>
              <p className="mt-1 text-xs text-slate-400">{job.scheduleKind === 'daily' ? `每天 ${String(job.dailyHour ?? 0).padStart(2, '0')}:${String(job.dailyMinute ?? 0).padStart(2, '0')}` : `每 ${Math.round((job.intervalSeconds ?? 0) / 60)} 分钟`} · 上次 {job.lastFinishedAt ? timestamp(job.lastFinishedAt) : '未运行'}</p>
              {job.lastError && <p className="mt-1 line-clamp-2 text-xs text-rose-500">{job.lastError}</p>}
              <div className="mt-2 flex gap-2"><Button size="sm" variant="secondary" disabled={radarBusy !== '' || !job.enabled || job.running} onClick={() => void mutateRadar(`run-${job.id}`, () => apiPost(`/operations/radar/jobs/${job.id}/run`), `${job.id} 已加入立即执行队列`)}><Play className="h-3.5 w-3.5" />立即执行</Button><Button size="sm" variant="ghost" disabled={radarBusy !== '' || job.running} onClick={() => void mutateRadar(`job-${job.id}`, () => apiPatch(`/operations/radar/jobs/${job.id}`, { enabled: !job.enabled }), job.enabled ? `${job.id} 已停用` : `${job.id} 已启用`)}>{job.enabled ? '停用' : '启用'}</Button></div>
            </div>)}
          </div>
        </div>
      </div>
      <div className="border-t border-slate-100">
        <div className="flex flex-wrap items-center gap-3 bg-slate-50 px-5 py-3">
          <div><p className="text-sm font-medium text-slate-700">公众号账号</p><p className="text-xs text-slate-400">{wechatAccounts.filter((source) => source.enabled).length}/{wechatAccounts.length} 个账号启用；工作簿表头使用“公众号、帐号名”，工作表名可区分高校/机构。</p></div>
          <input className="input ml-auto w-64" placeholder="搜索公众号、微信号或分组" value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} />
          <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={replaceAccounts} onChange={(event) => setReplaceAccounts(event.target.checked)} />导入时停用文件外账号</label>
          <label className="inline-flex cursor-pointer items-center rounded-lg bg-brand-600 px-3 py-2 text-xs font-medium text-white hover:bg-brand-700">
            {radarBusy === 'account-import' ? '导入中…' : '导入 Excel'}
            <input className="hidden" type="file" accept=".xls,.xlsx,.csv" disabled={radarBusy !== ''} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importWechatAccounts(file) }} />
          </label>
        </div>
        <div className="grid grid-cols-[1fr_180px_110px_90px] gap-3 border-t border-slate-100 px-5 py-2 text-xs font-medium text-slate-400"><span>公众号</span><span>微信号</span><span>分组</span><span>状态</span></div>
        <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
          {visibleWechatAccounts.map((source) => <div key={source.id} className="grid grid-cols-[1fr_180px_110px_90px] items-center gap-3 px-5 py-2 text-xs">
            <span className="truncate font-medium text-slate-700" title={source.name}>{source.name}</span>
            <span className="truncate font-mono text-slate-500" title={source.externalKey}>{source.externalKey}</span>
            <select className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs" value={source.group} disabled={radarBusy !== ''} onChange={(event) => void mutateRadar(`account-group-${source.id}`, () => apiPatch(`/operations/radar/sources/${source.id}`, { group: event.target.value }), `${source.name} 分组已更新`)}><option value="高校">高校</option><option value="机构">机构</option><option value="其他">其他</option></select>
            <button disabled={radarBusy !== ''} className={`rounded-md px-2 py-1 ${source.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`} onClick={() => void mutateRadar(`account-${source.id}`, () => apiPatch(`/operations/radar/sources/${source.id}`, { enabled: !source.enabled }), source.enabled ? `${source.name} 已停用` : `${source.name} 已启用`)}>{source.enabled ? '已启用' : '已停用'}</button>
          </div>)}
          {!visibleWechatAccounts.length && <p className="p-6 text-center text-sm text-slate-400">没有匹配的公众号账号。</p>}
        </div>
        {wechatAccounts.length > visibleWechatAccounts.length && <p className="border-t border-slate-100 px-5 py-2 text-xs text-slate-400">为保证页面性能最多展示前 100 条，请使用搜索框缩小范围。</p>}
      </div>
    </Card>

    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <div><h3 className="font-medium text-slate-800">Radar 候选管理</h3><p className="mt-1 text-xs text-slate-400">直接查询 MySQL 候选投影，可筛选、查看原文并批量送入公共线索处理链路。</p></div>
          <div className="ml-auto flex gap-2 text-xs"><Badge tone="blue">总计 {radarSummary?.total ?? candidatePage?.total ?? 0}</Badge><Badge tone="green">保留 {radarSummary?.worth_attention ?? 0}</Badge><Badge tone="slate">均分 {radarSummary?.avg_score ?? 0}</Badge></div>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-[minmax(220px,1fr)_150px_150px_100px_auto_auto]">
          <input className="input" placeholder="搜索标题、摘要、作者、院校或信号" value={candidateFilters.q} onChange={(event) => setCandidateFilters((value) => ({ ...value, q: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') void loadCandidates() }} />
          <select className="input" value={candidateFilters.source} onChange={(event) => setCandidateFilters((value) => ({ ...value, source: event.target.value }))}>
            <option value="">全部来源</option>
            {Object.keys(radarSummary?.sources ?? {}).map((source) => <option key={source} value={source}>{source}（{radarSummary?.sources[source]}）</option>)}
          </select>
          <input className="input" placeholder="来源分组" value={candidateFilters.group} onChange={(event) => setCandidateFilters((value) => ({ ...value, group: event.target.value }))} />
          <input className="input" type="number" min="0" max="100" aria-label="最低分" value={candidateFilters.minScore} onChange={(event) => setCandidateFilters((value) => ({ ...value, minScore: event.target.value }))} />
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs text-slate-600"><input type="checkbox" checked={candidateFilters.attentionOnly} onChange={(event) => setCandidateFilters((value) => ({ ...value, attentionOnly: event.target.checked }))} />只看保留</label>
          <Button size="sm" variant="secondary" loading={candidateBusy} onClick={() => void loadCandidates()}>应用筛选</Button>
        </div>
      </div>
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-5 py-3">
        <button className="text-xs text-brand-600" onClick={() => setSelectedCandidateIds(candidatePage?.items.map((item) => item.candidate_id).filter(Boolean) ?? [])}>选择当前结果</button>
        <button className="text-xs text-slate-500" onClick={() => setSelectedCandidateIds([])}>清空选择</button>
        <span className="text-xs text-slate-400">已选 {selectedCandidateIds.length} 条</span>
        <Button className="ml-auto" size="sm" disabled={!selectedCandidateIds.length} loading={candidateBusy} onClick={() => void syncSelectedCandidates()}>批量处理至公共线索池</Button>
      </div>
      <div className="max-h-[620px] divide-y divide-slate-100 overflow-y-auto">
        {(candidatePage?.items ?? []).map((candidate) => {
          const checked = selectedCandidateIds.includes(candidate.candidate_id)
          return <div key={candidate.candidate_id} className="px-5 py-3">
            <div className="flex items-start gap-3">
              <input className="mt-1" type="checkbox" checked={checked} onChange={() => setSelectedCandidateIds((ids) => checked ? ids.filter((id) => id !== candidate.candidate_id) : [...ids, candidate.candidate_id])} />
              <div className="min-w-0 flex-1"><p className="font-medium text-slate-700">{candidate.title || '未命名候选'}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{candidate.summary || '暂无摘要'}</p><div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400"><Badge tone={candidate.worth_attention ? 'green' : 'slate'}>{Number(candidate.attention_score ?? 0)} 分</Badge><span>{candidate.source_group || candidate.source || '未知来源'}</span><span>{candidate.source_name || '—'}</span><span>{timestamp(candidate.published_at || candidate.collected_at)}</span></div></div>
            </div>
            <details className="ml-7 mt-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"><summary className="cursor-pointer text-xs text-brand-600">查看原文与信号</summary><div className="mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-600">{candidate.article_text || candidate.summary || '暂无原文'}</div>{candidate.link && <a className="mt-2 inline-block text-xs text-brand-600" href={candidate.link} target="_blank" rel="noreferrer">打开原始来源</a>}</details>
          </div>
        })}
        {!candidatePage?.items.length && <p className="p-8 text-center text-sm text-slate-400">当前筛选没有候选记录。</p>}
      </div>
      {candidatePage?.has_more && <div className="border-t border-slate-100 p-3 text-center"><Button size="sm" variant="secondary" loading={candidateBusy} onClick={() => void loadCandidates(candidatePage.next_cursor, true)}>加载更多</Button></div>}
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
