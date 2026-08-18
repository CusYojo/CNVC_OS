import { summarizeRadarSourceRun, type RadarRunAction } from './radarSourceRunSummary.js'
import { sendRadarDingTalkAlert } from './radarDingTalkService.js'

export { summarizeRadarSourceRun, type RadarRunAction } from './radarSourceRunSummary.js'

export async function reportRadarSourceRun(
  action: RadarRunAction,
  input: { result?: Record<string, unknown>; error?: unknown; observedAt?: Date },
) {
  const summary = summarizeRadarSourceRun(action, input.result, input.error)
  const observedAt = (input.observedAt ?? new Date()).toISOString()
  const log = { event: 'radar.source_run', observedAt, ...summary }
  if (summary.status === 'failed') console.error(JSON.stringify(log))
  else if (summary.status === 'partial') console.warn(JSON.stringify(log))
  else console.log(JSON.stringify(log))

  const delivery = await sendRadarDingTalkAlert({ message: summary.message, status: summary.status })
  return { ...summary, ...delivery }
}
