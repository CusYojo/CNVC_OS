type AuthInvalidation =
  | { type: 'session'; sessionId: string }
  | { type: 'user'; userId: string }

const listeners = new Set<(event: AuthInvalidation) => void>()

export function emitAuthInvalidation(event: AuthInvalidation): void {
  for (const listener of listeners) listener(event)
}

export function subscribeAuthInvalidations(listener: (event: AuthInvalidation) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
