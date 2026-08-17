import { EventEmitter } from 'node:events'

type JwAgentChangeListener = (conversationId: string) => void

const emitter = new EventEmitter()
const pending = new Map<string, NodeJS.Timeout>()

export function publishJwAgentChange(conversationId: string, immediate = false): void {
  if (immediate) {
    const timer = pending.get(conversationId)
    if (timer) clearTimeout(timer)
    pending.delete(conversationId)
    emitter.emit('change', conversationId)
    return
  }
  if (pending.has(conversationId)) return
  const timer = setTimeout(() => {
    pending.delete(conversationId)
    emitter.emit('change', conversationId)
  }, 80)
  timer.unref()
  pending.set(conversationId, timer)
}

export function subscribeJwAgentChanges(listener: JwAgentChangeListener): () => void {
  emitter.on('change', listener)
  return () => emitter.off('change', listener)
}

export function clearJwAgentChangeTimers(): void {
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
}
