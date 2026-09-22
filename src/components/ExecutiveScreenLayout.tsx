import { Children, cloneElement, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, MoveHorizontal, SlidersHorizontal } from 'lucide-react'
import { executiveScreens, executiveScreenAtPosition, executiveScreenProgress, executiveNavigationLens } from '../lib/executiveScreen'
import { EXECUTIVE_SCREEN_REVEAL, executiveScreenGap, scrollToExecutiveScreen } from '../lib/executiveScreenNavigation'
import { readExecutiveScreenPreferences, resolveExecutiveScreen, saveExecutiveScreenPreferences, visibleExecutiveScreenIds } from '../lib/executiveScreenPreferences'
import type { ExecutiveView } from '../lib/executiveDashboard'
import { Button } from './ui'
import { ExecutiveScreenSettings } from './ExecutiveScreenSettings'

export function ExecutiveScreenLayout({ children, initialScreen, locationKey, actions, userId }: { children: ReactNode; initialScreen?: ExecutiveView; locationKey: string; actions?: ReactNode; userId: string }) {
  const track = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLElement>(null), lens = useRef<HTMLSpanElement>(null)
  const [preferences, setPreferences] = useState(() => readExecutiveScreenPreferences(userId))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [temporary, setTemporary] = useState<ExecutiveView | null>(() => initialScreen && preferences.hidden.includes(initialScreen) ? initialScreen : null)
  const order = useMemo(() => visibleExecutiveScreenIds(preferences, temporary), [preferences, temporary])
  const screens = order.map(id => executiveScreens.find(screen => screen.id === id)!)
  const [active, setActive] = useState<ExecutiveView>(() => resolveExecutiveScreen(initialScreen, order))
  const activeRef = useRef(active)
  const index = Math.max(0, order.indexOf(active))
  const sections = Children.toArray(children).filter(isValidElement<{ id: ExecutiveView; hidden?: boolean }>)
  // Reorder keyed, mounted sections instead of recreating their forms or losing drafts.
  const panels = preferences.order.map(id => {
    const section = sections.find(section => section.props.id === id)
    return section && cloneElement(section, { key: id, hidden: !order.includes(id) })
  })
  useLayoutEffect(() => {
    const next = resolveExecutiveScreen(activeRef.current, order)
    activeRef.current = next; setActive(next)
    scrollToExecutiveScreen(next, true)
  }, [order])
  useEffect(() => {
    const element = track.current
    const nav = navigation.current, indicator = lens.current
    if (!element || !nav || !indicator) return
    let frame = 0, previousWidth = element.clientWidth
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let bounds: { left: number; top: number; width: number; height: number }[] = []
    const measure = () => {
      bounds = Array.from(nav.querySelectorAll('button')).map(button => ({ left: button.offsetLeft, top: button.offsetTop, width: button.offsetWidth, height: button.offsetHeight }))
    }
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const gap = executiveScreenGap(element)
        const id = executiveScreenAtPosition(element.scrollLeft, element.clientWidth, gap, order)
        activeRef.current = id; setActive(id)
        const geometry = executiveNavigationLens(executiveScreenProgress(element.scrollLeft, element.clientWidth, gap, order.length), bounds, motion.matches)
        if (geometry) {
          // Only the decorative layer moves per frame; forms and lists stay mounted.
          indicator.style.transform = `translate3d(${geometry.left}px, ${geometry.top}px, 0)`
          indicator.style.width = `${geometry.width}px`
          indicator.style.height = `${geometry.height}px`
          indicator.style.opacity = '1'
        }
      })
    }
    // Resizing keeps the same screen instead of stranding the user between modules.
    const observer = new ResizeObserver(() => {
      measure()
      if (element.clientWidth !== previousWidth) {
        previousWidth = element.clientWidth
        scrollToExecutiveScreen(activeRef.current, true)
      }
      update()
    })
    observer.observe(element)
    observer.observe(nav)
    element.addEventListener('scroll', update, { passive: true })
    motion.addEventListener('change', update)
    measure(); update()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); element.removeEventListener('scroll', update); motion.removeEventListener('change', update) }
  }, [order])
  useEffect(() => {
    const element = track.current
    const reveal = (event: Event) => {
      const id = (event as CustomEvent<ExecutiveView>).detail
      if (!executiveScreens.some(screen => screen.id === id)) return
      activeRef.current = id
      setTemporary(id)
    }
    element?.addEventListener(EXECUTIVE_SCREEN_REVEAL, reveal)
    return () => element?.removeEventListener(EXECUTIVE_SCREEN_REVEAL, reveal)
  }, [])
  useEffect(() => {
    const next = initialScreen ?? visibleExecutiveScreenIds(preferences)[0]
    activeRef.current = next
    setTemporary(preferences.hidden.includes(next) ? next : null)
    setActive(next)
    const frame = requestAnimationFrame(() => scrollToExecutiveScreen(next, true))
    return () => cancelAnimationFrame(frame)
    // A route request chooses a screen; preference edits must not reapply an old route.
  }, [initialScreen, locationKey])
  return <div className="executive-screen-layout">
    <div className="executive-screen-commandbar">
    <nav ref={navigation} data-executive-navigation data-count={order.length} aria-label="工作台模块定位" className="executive-screen-navigation">
      <span ref={lens} className="executive-navigation-lens" aria-hidden="true" />
      {screens.map(section => <button key={section.id} type="button" aria-current={active === section.id ? 'location' : undefined} aria-controls={`executive-${section.id}`} title={preferences.hidden.includes(section.id) ? `${section.label} · 本次临时显示` : undefined} onClick={() => scrollToExecutiveScreen(section.id)}>{section.label}{preferences.hidden.includes(section.id) && <span className="executive-temporary-marker" aria-label="本次临时显示"> · 临时</span>}</button>)}
    </nav>
    <div className="executive-screen-tools">{actions}<Button variant="ghost" size="sm" aria-label="模块设置" title="模块设置" onClick={() => setSettingsOpen(true)}><SlidersHorizontal size={16} /></Button></div>
    </div>
    <div ref={track} data-executive-track className="executive-screen-track" role="region" aria-label="横向工作屏" tabIndex={0} onKeyDown={event => {
      if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      const next = order[index + (event.key === 'ArrowRight' ? 1 : -1)]
      if (next) scrollToExecutiveScreen(next)
    }}>{panels}</div>
    <div className="executive-screen-footer">
      <span className="executive-screen-position"><strong>{String(index + 1).padStart(2, '0')}</strong><span>/ {String(order.length).padStart(2, '0')}</span><span className="executive-screen-current">{screens[index].label}</span></span>
      {order.length > 1 && <span className="executive-scroll-hint"><MoveHorizontal size={16} aria-hidden="true" />左右滑动浏览</span>}
      <div className="executive-screen-arrows"><Button variant="secondary" size="sm" aria-label="上一屏" disabled={index === 0} onClick={() => scrollToExecutiveScreen(order[index - 1])}><ArrowLeft size={17} /></Button><Button variant="secondary" size="sm" aria-label="下一屏" disabled={index === order.length - 1} onClick={() => scrollToExecutiveScreen(order[index + 1])}><ArrowRight size={17} /></Button></div>
    </div>
    {settingsOpen && <ExecutiveScreenSettings preferences={preferences} onClose={() => setSettingsOpen(false)} onSave={next => {
      if (!saveExecutiveScreenPreferences(userId, next)) return false
      setTemporary(null); setPreferences(next); setSettingsOpen(false)
      return true
    }} />}
  </div>
}

export function ExecutiveScreenSection({ id, children, summary, action, hidden }: { id: ExecutiveView; children: ReactNode; summary?: ReactNode; action?: ReactNode; hidden?: boolean }) {
  const section = executiveScreens.find(section => section.id === id)!
  return <section id={`executive-${id}`} data-executive-screen={id} hidden={hidden} aria-labelledby={`executive-heading-${id}`} className="executive-screen-section">
    <header className="executive-section-heading"><div className="executive-section-caption"><h2 id={`executive-heading-${id}`}>{section.label}</h2>{summary && <div className="executive-section-summary">{summary}</div>}</div>{action}</header>
    {children}
  </section>
}

export function ExecutiveExpand({ total, expanded, onExpand }: { total: number; expanded: boolean; onExpand: () => void }) {
  if (expanded || total <= 6) return null
  return <div className="executive-expand"><Button variant="ghost" size="sm" onClick={onExpand}>展开其余 {total - 6} 项<ChevronDown size={14} /></Button></div>
}

// Load personal tools on approach, and keep forms mounted afterwards.
export function ExecutiveDeferredSection({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null), [ready, setReady] = useState(false)
  useEffect(() => {
    if (ready) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setReady(true); observer.disconnect() } }, { root: document.querySelector('[data-executive-track]'), rootMargin: '0px 300px' })
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [ready])
  return <div ref={root} className="executive-personal-tools">{ready ? children : <div className="rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-500" role="status">日历与个人待办</div>}</div>
}
