import { useState, type ReactNode } from 'react'
import { Modal } from '../ui'
import { AiEvolutionPanel } from './AiEvolutionPanel'

export function AiEvolutionSidebar({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const [tab, setTab] = useState<'artifacts' | 'evolution'>('artifacts')
  const [mobileOpen, setMobileOpen] = useState(false)
  return <>
    <button className="absolute right-3 top-3 z-10 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-brand-700 xl:hidden" onClick={() => setMobileOpen(true)}>自进化</button>
    <aside className="hidden w-[300px] shrink-0 flex-col border-l border-slate-200 bg-slate-50/60 xl:flex">
      <div className="flex border-b border-slate-200 p-2" role="tablist" aria-label="助手侧栏">
        {(['artifacts', 'evolution'] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)} className={`flex-1 rounded p-2 text-sm ${tab === item ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-slate-500'}`}>{item === 'artifacts' ? '交付物' : '自进化'}</button>)}
      </div>
      <div className={tab === 'artifacts' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>{children}</div>
      {tab === 'evolution' && <AiEvolutionPanel key={conversationId} conversationId={conversationId} />}
    </aside>
    <Modal open={mobileOpen} onClose={() => setMobileOpen(false)} title="自进化工作台">
      {mobileOpen && <AiEvolutionPanel key={conversationId} conversationId={conversationId} />}
    </Modal>
  </>
}
