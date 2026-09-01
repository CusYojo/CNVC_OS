import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { apiGet } from '../lib/api'
import { formatShanghaiDateTime } from '../lib/dateTime'
import { useAuthStore } from '../store/useAuthStore'
import { Badge, Button, Card } from './ui'

type Summary = {
  checkedAt: string; database: { provider: string; reachable: boolean }; storage: { accessible: boolean; probe: string };
  providers: Array<{ id: string; name: string; enabled: boolean; lastTestStatus: string | null; lastTestAt: string | null; version: number }>;
  bots: Array<{ id: string; name: string; platform: string; enabled: boolean; connectionStatus: string; lastConnectedAt: string | null; version: number }>;
  outbox: Array<{ status: string; total: number }>;
  revisions: Array<{ id: string; domain: string; resourceType: string; operation: string; sourceVersion: number; createdAt: string }>;
}
const time = (value: string | null) => value ? formatShanghaiDateTime(value) : '未检测'

export function FdeIntegrationsPanel() {
  const user = useAuthStore((state) => state.user)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try { setSummary(await apiGet<Summary>('/system-administration/integrations-summary')); setError('') }
    catch (cause) { setError((cause as Error).message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  return <div className="space-y-4">
    <div className="flex justify-end"><Button variant="secondary" loading={loading} onClick={() => void load()}><RefreshCw className="h-4 w-4" />刷新状态</Button></div>
    {error && <Card className="p-4 text-sm text-red-600">当前检测失败：{error}。下方若有历史结果，不代表当前连接正常。</Card>}
    {summary && <>
      <p className="text-xs text-slate-400">摘要读取时间：{time(summary.checkedAt)}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="fde-panel p-5"><h2 className="font-semibold">MySQL 与项目文件</h2><div className="mt-4 flex flex-wrap gap-3"><Badge tone={error ? 'amber' : 'green'}>MySQL：{error ? '当前状态未知' : '连接可达'}</Badge><Badge tone={summary.storage.accessible && !error ? 'green' : 'amber'}>项目文件目录：{error ? '当前状态未知' : summary.storage.accessible ? '可读写' : '不可访问'}</Badge></div></Card>
        <Card className="fde-panel p-5"><h2 className="font-semibold">通知投递队列</h2><div className="mt-4 flex flex-wrap gap-2">{summary.outbox.length ? summary.outbox.map((item) => <Badge key={item.status}>{item.status}：{item.total}</Badge>) : <p className="text-sm text-slate-500">暂无投递记录</p>}</div></Card>
        <Card className="fde-panel p-5"><div className="flex items-center justify-between"><h2 className="font-semibold">IM 与通知连接</h2>{user?.permissionCodes?.includes('im.manage') && <Link className="text-xs text-brand-600" to="/system/integrations/im-bots">配置与历史</Link>}</div><div className="mt-4 space-y-3">{summary.bots.map((bot) => <div className="rounded-lg bg-slate-50 p-3" key={bot.id}><p className="text-sm font-medium">{bot.name} <Badge>{bot.platform}</Badge></p><p className="mt-2 text-xs text-slate-500">{bot.enabled ? '启用' : '停用'} · 记录状态 {bot.connectionStatus} · V{bot.version}</p><p className="mt-1 text-xs text-slate-400">最近连接：{time(bot.lastConnectedAt)}</p></div>)}{!summary.bots.length && <p className="text-sm text-slate-500">未配置 IM 连接</p>}</div></Card>
        <Card className="fde-panel p-5"><div className="flex items-center justify-between"><h2 className="font-semibold">模型与 AI 配置</h2>{user?.permissionCodes?.includes('ai.configure') && <Link className="text-xs text-brand-600" to="/system/ai/models">配置与历史</Link>}</div><div className="mt-4 space-y-3">{summary.providers.map((provider) => <div className="rounded-lg bg-slate-50 p-3" key={provider.id}><p className="text-sm font-medium">{provider.name} <Badge>{provider.enabled ? '启用' : '停用'}</Badge></p><p className="mt-2 text-xs text-slate-500">最近检测结果：{provider.lastTestStatus ?? '未检测'} · V{provider.version}</p><p className="mt-1 text-xs text-slate-400">检测时间：{time(provider.lastTestAt)}</p></div>)}{!summary.providers.length && <p className="text-sm text-slate-500">未配置模型提供商</p>}</div></Card>
      </div>
      <Card className="fde-panel p-5"><div className="flex items-center justify-between"><h2 className="font-semibold">最近配置修订</h2><Link className="text-xs text-brand-600" to="/system?tab=audit">查看操作审计</Link></div><div className="mt-4 space-y-2">{summary.revisions.map((revision) => <p key={revision.id} className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{time(revision.createdAt)} · {revision.domain}/{revision.resourceType} · {revision.operation} · 原版本 V{revision.sourceVersion}</p>)}{!summary.revisions.length && <p className="text-sm text-slate-500">暂无配置修订</p>}</div></Card>
    </>}
  </div>
}
