import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { EvolutionEvent } from '../../../server/src/contracts/aiEvolutionContract'

const labels: Record<string, string> = { queued: '任务已入队', preparing: '正在准备环境', execution_profile_bound: '执行配置已冻结',
  resume_requested: '已申请继续中断任务，沿用原预算',
  release_claimed: '发布批准已领取，等待目标状态确认', release_completed: '发布结果已记录',
  executing: '正在开发', evaluating: '正在验证', checkpoint: '已保存执行检查点', candidate_ready: '候选已生成，等待验收',
  cancel_requested: '已请求取消', lease_revoked: '执行权已撤销，等待清理', cancelled: '已取消并确认环境停止',
  interrupted: '执行中断，环境已停止', failed: '执行失败', succeeded: '执行完成' }

export function AiEvolutionEvents({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<EvolutionEvent[]>([])
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open) return
    let disposed = false, pending = false
    // Reopening replays persisted events, so a missed final poll cannot lose the terminal event.
    let cursor = 0
    const collected: EvolutionEvent[] = []
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const result = await api<{ list: EvolutionEvent[] }>(`/ai/evolution/runs/${runId}/events?afterSequence=${cursor}`)
        if (disposed) return
        let expected = cursor + 1
        for (const event of result.list) {
          if (event.runId !== runId || event.sequence !== expected++) throw Error('进度记录不连续，请重试读取')
        }
        collected.push(...result.list)
        if (result.list.length) cursor = result.list[result.list.length - 1].sequence
        if (collected.length > 500) collected.splice(0, collected.length - 500)
        setEvents([...collected]); setError('')
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : '进度连接中断，正在等待重试') }
      finally { pending = false }
    }
    setEvents([]); setError('')
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 3000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [runId, open, retry])
  return <details className="mt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-brand-600">执行记录</summary>
    {open && <>
      {error && <p role="alert" className="text-rose-700">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>重新连接</button></p>}
      {!events.length && !error && <p role="status">正在读取执行记录…</p>}
      {events.length >= 500 && <p className="text-slate-500">显示最近 500 条记录</p>}
      <ol aria-label="任务执行记录" className="mt-1 space-y-1">{events.map((event) => <li key={event.id} className="break-words">
        <span className="text-slate-400">#{event.sequence} </span>{labels[event.eventType] || '任务状态更新'}
        {event.eventType === 'checkpoint' && typeof event.payload.repairRounds === 'number' && <span>（修复轮次 {event.payload.repairRounds}）</span>}
        {event.eventType === 'release_completed' && typeof event.payload.outcome === 'string' && <span>：{({ active: '已发布并确认健康', failed: '发布失败', rolled_back: '已回退并确认旧版本健康' } as Record<string, string>)[event.payload.outcome] || '待核对'}</span>}
      </li>)}</ol>
    </>}
  </details>
}
