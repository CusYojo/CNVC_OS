import React, { type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Link } from 'react-router-dom'

export function PersonalScheduleSidebar({ today, future, futureCount, tools }: {
  today: ReactNode
  future: ReactNode
  futureCount: number
  tools: ReactNode
}) {
  return <aside className="dashboard-personal-sidebar" aria-label="今日待办与计划">
    {today}
    <details className="dashboard-future-optional">
      <summary><span>未来三天</span><span className="dashboard-future-count">{futureCount > 0 ? `${futureCount} 项` : '按需查看'}</span><ChevronDown size={16} aria-hidden="true" /></summary>
      <div className="dashboard-future-body">{future}<Link className="button link" to="/collaboration">查看我的任务 →</Link></div>
    </details>
    {tools}
  </aside>
}
