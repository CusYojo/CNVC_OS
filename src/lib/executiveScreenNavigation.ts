import type { ExecutiveView } from './executiveDashboard'
import { executiveScreenScrollLeft } from './executiveScreen'

export const EXECUTIVE_SCREEN_REVEAL = 'fde:executive-screen-reveal'

export function executiveScreenGap(track: HTMLElement) { return parseFloat(getComputedStyle(track).columnGap) || 0 }

export function scrollToExecutiveScreen(id: ExecutiveView, instant = false) {
  const track = document.querySelector<HTMLElement>('[data-executive-track]')
  if (!track) return
  const order = Array.from(track.querySelectorAll<HTMLElement>(':scope > [data-executive-screen]:not([hidden])')).map(section => section.dataset.executiveScreen as ExecutiveView)
  const gap = executiveScreenGap(track), left = executiveScreenScrollLeft(id, track.clientWidth, gap, order)
  if (left === null) {
    // Shortcuts/deep links may open an unselected module for this visit only.
    track.dispatchEvent(new CustomEvent(EXECUTIVE_SCREEN_REVEAL, { detail: id }))
    return
  }
  // Direct shortcuts should not fly through several unrelated screens.
  const distant = Math.abs(left - track.scrollLeft) > track.clientWidth + gap + 1
  track.scrollTo({ left, behavior: instant || distant || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
}
