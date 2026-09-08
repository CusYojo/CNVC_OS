import type { EvolutionRuntimeIdentity } from '../../services/aiEvolutionRuntimeIdentity.js'

/** Target URL and expected identity come from host release registration, not candidate input. */
export async function probeEvolutionReleaseHealth(input: {
  url: string; expected: EvolutionRuntimeIdentity; signal?: AbortSignal; fetchImpl?: typeof fetch;
}) {
  const keys = ['schemaVersion', 'baseCommit', 'patchHash', 'lockHash', 'serverEntrySha256', 'webEntrySha256'] as const
  if (input.expected.schemaVersion !== 1 || keys.some((key) => input.expected[key] === undefined)) throw Error('Incomplete expected release identity')
  if (input.signal?.aborted) return false
  const url = new URL(input.url)
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) throw Error('Invalid release health URL')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Remote release health requires HTTPS')
  try {
    const response = await (input.fetchImpl ?? fetch)(url, { redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' } })
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); return false }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > 64 * 1024) { await reader.cancel(); return false } chunks.push(item.value) }
    } finally { reader.releaseLock() }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return body.ok === true && body.status === 'ready' && body.service === 'cybernaut-app'
      && !input.signal?.aborted && keys.every((key) => body.deploymentIdentity?.[key] === input.expected[key])
  } catch { return false }
}

export async function waitForEvolutionReleaseHealth(input: Parameters<typeof probeEvolutionReleaseHealth>[0] & {
  timeoutMs?: number; intervalMs?: number; stillExpected?: () => Promise<boolean>
}) {
  const timeoutMs = input.timeoutMs ?? 120_000, intervalMs = input.intervalMs ?? 1_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 10_000) throw Error('Invalid health wait bounds')
  const deadline = Date.now() + timeoutMs
  do {
    input.signal?.throwIfAborted()
    if (input.stillExpected && !await input.stillExpected()) return false
    if (await probeEvolutionReleaseHealth(input)) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise<void>((resolve, reject) => {
      const done = () => { input.signal?.removeEventListener('abort', abort); resolve() }
      const timer = setTimeout(done, Math.min(intervalMs, remaining))
      const abort = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); reject(input.signal?.reason ?? Error('Health wait aborted')) }
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) abort()
    })
  } while (Date.now() <= deadline)
  return false
}
