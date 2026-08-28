import { useEffect, useRef, useState } from 'react'
import { apiGet } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { Button } from './ui'
import { committeeActionLabels } from '../../server/src/contracts/fdeCommitteeContract'
import { committeeFormError } from '../lib/fdeCommitteeEditor'

export type CommitteePageInfo = { total: number; page: number; pageSize: number; hasMore: boolean }
export type CommitteeCandidateKind = 'people' | 'files' | 'approvals'
export type CommitteeOptionsPage = {
  projectId: string; people: Array<{ id: string; name: string }>;
  files: Array<{ fileId: string; version: number; name: string; sha256: string | null }>;
  approvals: Array<{ id: string; title: string; requestNo: string }>;
  pagination: Partial<Record<CommitteeCandidateKind, CommitteePageInfo>>;
}
export function CommitteeCandidatePaging({ projectId, kind, label, onPage, onFailure }: {
  projectId: string; kind: CommitteeCandidateKind; label: string; onPage: (value: CommitteeOptionsPage) => void; onFailure: (error: unknown) => void;
}) {
  const uid = useAuthStore(state => state.user?.id ?? '')
  const [q, setQ] = useState(''), [page, setPage] = useState(1), [info, setInfo] = useState<CommitteePageInfo | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [reload, setReload] = useState(0)
  const receive = useRef(onPage), failed = useRef(onFailure); receive.current = onPage; failed.current = onFailure
  useEffect(() => {
    let valid = true; setInfo(null); setLoading(true); setError('')
    receive.current({ projectId, people: [], files: [], approvals: [], pagination: {} })
    apiGet<CommitteeOptionsPage>(`/committee/options?${new URLSearchParams({ projectId, kind, q, page: String(page), pageSize: '20' })}`)
      .then(value => { if (valid && useAuthStore.getState().user?.id === uid) { if (value.projectId !== projectId) throw new Error('候选回执不属于当前项目，请重新核对'); setInfo(value.pagination[kind] ?? null); receive.current(value) } })
      .catch(e => { if (valid && useAuthStore.getState().user?.id === uid) { setError(committeeFormError(e)); failed.current(e) } })
      .finally(() => { if (valid && useAuthStore.getState().user?.id === uid) setLoading(false) })
    return () => { valid = false }
  }, [uid, projectId, kind, q, page, reload])
  return <div className="space-y-2 rounded-lg border border-slate-100 p-2">
    <label className="block text-xs">搜索{label}<input className="input mt-1 w-full" value={q} onChange={e => { setQ(e.target.value); setPage(1) }} /></label>
    {error && <p role="alert" className="text-xs text-rose-700">{error}<button type="button" className="ml-2 underline" onClick={() => setReload(n => n + 1)}>重试</button></p>}
    <div className="flex items-center justify-between gap-2 text-xs text-slate-500"><span>{loading ? '读取当前有权候选…' : info ? `共 ${info.total} 项 · 第 ${info.page} 页` : '未读取候选'}</span><div className="flex gap-1"><Button size="sm" variant="ghost" disabled={loading || !info || info.page <= 1} onClick={() => setPage(info!.page - 1)}>上页{label}</Button><Button size="sm" variant="ghost" disabled={loading || !info?.hasMore} onClick={() => setPage(info!.page + 1)}>下页{label}</Button></div></div>
  </div>
}

type HistoryRow = { id: string; action: keyof typeof committeeActionLabels; version: number; reason: string; createdAt: string }
export function CommitteeHistoryPanel({ meetingId, version }: { meetingId: string; version: number }) {
  const uid = useAuthStore(state => state.user?.id ?? '')
  const [q, setQ] = useState(''), [page, setPage] = useState(1), [reload, setReload] = useState(0)
  const [data, setData] = useState<(CommitteePageInfo & { rows: HistoryRow[] }) | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let valid = true; setData(null); setError('')
    apiGet<CommitteePageInfo & { rows: HistoryRow[] }>(`/committee/${meetingId}/history?${new URLSearchParams({ q, page: String(page), pageSize: '20' })}`)
      .then(value => { if (valid && useAuthStore.getState().user?.id === uid) setData(value) })
      .catch(e => { if (valid && useAuthStore.getState().user?.id === uid) setError(committeeFormError(e)) })
    return () => { valid = false }
  }, [uid, meetingId, version, q, page, reload])
  return <div className="space-y-3"><label className="block text-xs">搜索办理原因<input className="input mt-1 w-full" value={q} onChange={e => { setQ(e.target.value); setPage(1) }} /></label>
    {error && <p role="alert" className="text-xs text-rose-700">{error}<button type="button" className="ml-2 underline" onClick={() => setReload(n => n + 1)}>重试</button></p>}
    {data?.rows.map(row => <div key={row.id} className="border-l-2 border-slate-200 pl-3 text-xs"><strong>v{row.version} · {committeeActionLabels[row.action]}</strong><p className="mt-1 break-words text-slate-500">{row.reason}</p><p className="mt-1 text-slate-400">{new Date(row.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</p></div>)}
    <p className="text-xs text-slate-500">{data ? `共 ${data.total} 条 · 第 ${data.page} 页` : error ? '未展示历史内容。' : '正在读取有权历史…'}</p><div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!data || data.page <= 1} onClick={() => setPage(data!.page - 1)}>上一页历史</Button><Button size="sm" variant="ghost" disabled={!data?.hasMore} onClick={() => setPage(data!.page + 1)}>下一页历史</Button></div>
  </div>
}
