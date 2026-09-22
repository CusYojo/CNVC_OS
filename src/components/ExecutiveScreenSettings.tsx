import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react'
import { executiveScreens } from '../lib/executiveScreen'
import { defaultExecutiveScreenPreferences, moveExecutiveScreen, toggleExecutiveScreen, visibleExecutiveScreenIds, type ExecutiveScreenPreferences } from '../lib/executiveScreenPreferences'
import { Button, Modal } from './ui'

export function ExecutiveScreenSettings({ preferences, onSave, onClose }: {
  preferences: ExecutiveScreenPreferences; onSave: (next: ExecutiveScreenPreferences) => boolean; onClose: () => void
}) {
  const [draft, setDraft] = useState(preferences), [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const count = visibleExecutiveScreenIds(draft).length
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    root.current?.querySelector<HTMLInputElement>('input')?.focus()
    return () => previous?.focus({ preventScroll: true })
  }, [])
  return <div ref={root} className="executive-screen-settings" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    if (event.key !== 'Tab') return
    const focusable = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])
    const first = focusable[0], last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <Modal open title="模块设置" onClose={onClose} width="max-w-lg" footer={<>
      <Button variant="ghost" onClick={() => { setDraft(defaultExecutiveScreenPreferences()); setError('') }}><RotateCcw size={15} />恢复默认</Button>
      <Button variant="secondary" onClick={onClose}>取消</Button>
      <Button onClick={() => { if (!onSave(draft)) setError('无法保存设置，请检查浏览器是否允许本地存储后重试。') }}>保存设置</Button>
    </>}>
      <div className="executive-settings-intro"><span>勾选要显示的模块，使用箭头调整顺序。</span><strong>已选 {count} 项</strong></div>
      <ol className="executive-settings-list">{draft.order.map((id, index) => {
        const label = executiveScreens.find(screen => screen.id === id)!.label
        const checked = !draft.hidden.includes(id)
        return <li key={id} data-selected={checked}>
          <label><input type="checkbox" checked={checked} disabled={checked && count === 1} onChange={() => setDraft(current => toggleExecutiveScreen(current, id))} /><span>{label}</span></label>
          <div className="executive-settings-move"><Button variant="ghost" size="sm" aria-label={`上移${label}`} title="上移" disabled={index === 0} onClick={() => setDraft(current => moveExecutiveScreen(current, id, -1))}><ArrowUp size={16} /></Button><Button variant="ghost" size="sm" aria-label={`下移${label}`} title="下移" disabled={index === draft.order.length - 1} onClick={() => setDraft(current => moveExecutiveScreen(current, id, 1))}><ArrowDown size={16} /></Button></div>
        </li>
      })}</ol>
      <p className="executive-settings-note">至少保留一个模块。设置仅用于当前账号在此浏览器的工作台。</p>
      {error && <p role="alert" className="executive-settings-error">{error}</p>}
    </Modal>
  </div>
}
