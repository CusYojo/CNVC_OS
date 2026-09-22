import React, { useEffect, useState } from 'react'
import { Pause, Play, RefreshCw } from 'lucide-react'
import { WORKBENCH_QUOTES, QUOTE_INTERVAL_MS, createQuoteRotation, advanceQuoteRotation } from '../lib/workbenchQuotes'

const motionPreference = '(prefers-reduced-motion: reduce)'

export function WorkbenchQuote() {
  const [rotation, setRotation] = useState(() => createQuoteRotation())
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia(motionPreference).matches)

  useEffect(() => {
    const media = window.matchMedia(motionPreference)
    const updateMotion = () => setReducedMotion(media.matches)
    const updateVisibility = () => setHidden(document.hidden)
    updateMotion(); updateVisibility()
    media.addEventListener('change', updateMotion)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      media.removeEventListener('change', updateMotion)
      document.removeEventListener('visibilitychange', updateVisibility)
    }
  }, [])

  useEffect(() => {
    if (paused || hovered || focused || hidden || reducedMotion) return
    const timer = window.setInterval(() => setRotation(current => advanceQuoteRotation(current)), QUOTE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [paused, hovered, focused, hidden, reducedMotion, rotation])

  const quote = WORKBENCH_QUOTES[rotation.order[rotation.cursor]]
  const previous = rotation.previous === null ? null : WORKBENCH_QUOTES[rotation.previous]
  const controlLabel = paused ? '播放寄语轮播' : '暂停寄语轮播'

  return <div className="fde-workbench-quote" role="group" aria-label="工作寄语"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
    <div className="fde-quote-viewport" aria-live="off" title={quote.text}>
      {previous && <p key={`${previous.id}-out`} className="fde-quote-content is-leaving" aria-hidden="true"><span>{previous.text}</span></p>}
      <p key={quote.id} className={`fde-quote-content${previous ? ' is-entering' : ''}`}><span>{quote.text}</span></p>
    </div>
    <div className="fde-quote-controls">
      {!reducedMotion && <button type="button" className="fde-quote-control" aria-label={controlLabel} title={controlLabel}
        aria-pressed={paused} onClick={() => setPaused(value => !value)}>
        {paused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
      </button>}
      <button type="button" className="fde-quote-control fde-quote-next" aria-label="换一句工作寄语" title="立即换一句"
        onClick={() => setRotation(current => advanceQuoteRotation(current))}>
        <RefreshCw size={13} aria-hidden="true" /><span>换一句</span>
      </button>
    </div>
  </div>
}
