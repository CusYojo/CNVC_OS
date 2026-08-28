import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { responsibilityOverview, type ResponsibilityOverview } from '../../server/src/contracts/fdeResponsibilityViewContract'

export function FdeResponsibilityInbox() {
  const uid = useAuthStore(state => state.user?.id ?? '')
  const [result, setResult] = useState<{ uid: string; data: ResponsibilityOverview | null; error: string } | null>(null)
  useEffect(() => {
    let active = true, sequence = 0
    const load = async () => {
      const request = ++sequence; setResult(null)
      try { const data = responsibilityOverview.parse(await apiGet<unknown>('/responsibility/overview')); if (active && request === sequence && useAuthStore.getState().user?.id === uid) setResult({ uid, data, error: '' }) }
      catch (cause) { if (active && request === sequence && useAuthStore.getState().user?.id === uid) setResult({ uid, data: null, error: (cause as Error).message }) }
    }
    void load(); window.addEventListener('focus', load)
    return () => { active = false; window.removeEventListener('focus', load) }
  }, [uid])
  const data = result?.uid === uid ? result.data : null
  return <div className="mb-5 flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
    <Link className="text-[#315f68] underline" to="/responsibility?view=mine">我的责任记录</Link>
    <Link className="text-[#315f68] underline" to="/responsibility?view=review">待我确认与复核{data ? `（${data.review}）` : ''}</Link>
    {data?.assignmentAccess && <Link className={data.assignment > 0 ? 'text-amber-800 underline' : 'text-[#315f68] underline'} to="/responsibility?view=assignment">待协调分配（{data.assignment}）</Link>}
    {data && data.assignment > 0 && <span role="status" className="text-xs text-amber-700">有权范围内存在未分配或原处理人失效的记录</span>}
    {data && data.unread > 0 && <span className="text-xs text-amber-700">有 {data.unread} 条未读办理通知</span>}
    {result?.uid === uid && result.error && <span role="alert" className="text-xs text-red-600">通知暂未读取，请进入记录页重新核验。</span>}
  </div>
}
