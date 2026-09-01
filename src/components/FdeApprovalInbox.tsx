import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { approvalCenterDetailPath, approvalNoticeReadPath, type ApprovalCenterResult, type ApprovalCenterRow } from '../../server/src/contracts/fdeApprovalCenterContract'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { Badge, Button, Card } from './ui'

export function useApprovalInbox() {
  const userId = useAuthStore(state => state.user?.id ?? '')
  const [page, setPage] = useState(1), [reloadKey, setReloadKey] = useState(0)
  const [snapshot, setSnapshot] = useState<{ userId: string; data: ApprovalCenterResult } | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [reading, setReading] = useState('')
  const generation = useRef(0), readOperation = useRef(0), readingRef = useRef(false)
  const reload = useCallback(() => setReloadKey(value => value + 1), [])
  useEffect(() => { ++readOperation.current; setPage(1); setSnapshot(null); setError(''); setReading(''); readingRef.current = false }, [userId])
  useEffect(() => { window.addEventListener('focus', reload); return () => window.removeEventListener('focus', reload) }, [reload])
  useEffect(() => {
    const token = ++generation.current
    setSnapshot(null); setLoading(true); setError('')
    if (userId) void apiGet<ApprovalCenterResult>(`/oa/center?view=pending&page=${page}&pageSize=5`).then(data => {
      if (generation.current === token) setSnapshot({ userId, data })
    }).catch(cause => { if (generation.current === token) setError((cause as Error).message) })
      .finally(() => { if (generation.current === token) setLoading(false) })
    else setLoading(false)
    return () => { ++generation.current }
  }, [userId, page, reloadKey])
  const markRead = async (row: ApprovalCenterRow) => {
    const id = row.notice?.id
    if (!id) return
    if (readingRef.current) return
    readingRef.current = true; setReading(id); setError('')
    const token = generation.current, operation = ++readOperation.current
    try { await apiPost(approvalNoticeReadPath(row, id), {}); if (generation.current === token) reload() }
    catch (cause) { if (generation.current === token) { setSnapshot(null); setError(`${(cause as Error).message}；请刷新核对，已读不会完成审批。`) } }
    finally { if (readOperation.current === operation) { readingRef.current = false; setReading('') } }
  }
  // Never show another account's rows, including the render before effects run.
  return { data: snapshot?.userId === userId ? snapshot.data : null, error, loading, reading, markRead, reload, setPage }
}

export function FdeApprovalInbox({ inbox }: { inbox: ReturnType<typeof useApprovalInbox> }) {
  const { data, error, loading, reading, markRead, reload, setPage } = inbox
  return <Card className="mb-5 overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
      <h2 className="font-semibold">待我审批</h2>
      <div className="flex items-center gap-3"><Link className="text-sm text-[#315f68]" to="/workflow?view=pending">全部审批</Link><Button variant="secondary" disabled={loading || Boolean(reading)} onClick={reload}>刷新审批待办</Button></div>
    </div>
    {error && <p role="alert" className="p-4 text-sm text-red-700">{error}</p>}
    {loading ? <p className="p-4 text-sm text-slate-500">正在核对当前审批节点…</p> : data && <>
      <div className="divide-y divide-slate-100">{data.list.map(row => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
        <Link className="min-w-0 flex-1 text-sm hover:text-[#315f68]" to={approvalCenterDetailPath(row)}>
          <span className="break-all font-medium">{row.title}</span><span className="mt-1 block text-xs text-slate-500">{row.kind} · {row.applicantName} · {row.currentNodeName}</span>
        </Link>
        {row.notice ? row.notice.readAt ? <Badge>已读待审批</Badge> : <Button variant="secondary" disabled={Boolean(reading)} onClick={() => void markRead(row)}>标为已读</Button> : <Badge>待处理</Badge>}
      </div>)}</div>
      {!data.total && <p className="p-4 text-sm text-slate-500">暂无当前需要你审批的事项。</p>}
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 p-3 text-xs text-slate-500"><span>共 {data.total} 项 · 第 {data.page} 页</span><div className="flex gap-3"><button disabled={data.page <= 1 || Boolean(reading)} onClick={() => setPage(data.page - 1)}>上页审批</button><button disabled={data.page * data.pageSize >= data.total || Boolean(reading)} onClick={() => setPage(data.page + 1)}>下页审批</button></div></div>
    </>}
  </Card>
}
