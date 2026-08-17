type HttpEvent = { at: number; status: number; durationMs: number }

const startedAt = Date.now()
const maxEvents = 20_000
const events: HttpEvent[] = []
const statusClasses = { success: 0, redirect: 0, clientError: 0, serverError: 0 }
let total = 0
let inFlight = 0

function percentile(values: number[], fraction: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function windowSnapshot(windowMs: number, now: number) {
  const selected = events.filter((event) => event.at >= now - windowMs)
  const durations = selected.map((event) => event.durationMs)
  const serverErrors = selected.filter((event) => event.status >= 500).length
  const clientErrors = selected.filter((event) => event.status >= 400 && event.status < 500).length
  return {
    requests: selected.length,
    requestsPerMinute: Number((selected.length / Math.max(1, windowMs / 60_000)).toFixed(2)),
    clientErrors,
    serverErrors,
    serverErrorRate: selected.length ? Number((serverErrors / selected.length).toFixed(6)) : 0,
    p50Ms: percentile(durations, 0.50),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: durations.length ? Math.max(...durations) : 0,
  }
}

export function beginHttpTelemetry() {
  const requestStartedAt = Date.now()
  inFlight += 1
  let finished = false
  return (status: number) => {
    if (finished) return
    finished = true
    inFlight = Math.max(0, inFlight - 1)
    const durationMs = Math.max(0, Date.now() - requestStartedAt)
    total += 1
    if (status >= 500) statusClasses.serverError += 1
    else if (status >= 400) statusClasses.clientError += 1
    else if (status >= 300) statusClasses.redirect += 1
    else statusClasses.success += 1
    events.push({ at: Date.now(), status, durationMs })
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents)
  }
}

export function recordHttpTelemetryForAcceptance(status: number, durationMs: number, at = Date.now()) {
  const normalizedDuration = Math.max(0, Math.round(durationMs))
  total += 1
  if (status >= 500) statusClasses.serverError += 1
  else if (status >= 400) statusClasses.clientError += 1
  else if (status >= 300) statusClasses.redirect += 1
  else statusClasses.success += 1
  events.push({ at, status, durationMs: normalizedDuration })
  if (events.length > maxEvents) events.splice(0, events.length - maxEvents)
}

export function httpTelemetrySnapshot(now = Date.now()) {
  const cutoff = now - 15 * 60_000
  while (events[0] && events[0].at < cutoff) events.shift()
  return {
    processStartedAt: new Date(startedAt).toISOString(),
    total,
    inFlight,
    statusClasses: { ...statusClasses },
    last5m: windowSnapshot(5 * 60_000, now),
    last15m: windowSnapshot(15 * 60_000, now),
    retainedEvents: events.length,
    pathLabelsExcluded: true,
  }
}
