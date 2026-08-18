import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { pool } from '../db/client.js'
import { listRadarCandidates } from '../services/radarSyncService.js'

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] || 0
}

async function main() {
  const runs = 35
  const timings: number[] = []
  await listRadarCandidates({ limit: 200, sort: 'collected' })
  const startRss = process.memoryUsage().rss
  let peakRss = startRss
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now()
    await listRadarCandidates(index % 3 === 0
      ? { q: '融资', limit: 200, sort: 'score' }
      : index % 3 === 1
        ? { source: 'wechat_api', attentionOnly: true, minScore: 35, limit: 200, sort: 'collected' }
        : { limit: 200, sort: 'collected' })
    timings.push(performance.now() - started)
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  const p95Ms = percentile(timings, 0.95)
  const maxMs = Math.max(...timings)
  const rssDeltaMb = Math.max(0, peakRss - startRss) / 1024 / 1024
  const p95LimitMs = Number(process.env.RADAR_CANDIDATE_P95_LIMIT_MS || 1_000)
  const rssDeltaLimitMb = Number(process.env.RADAR_CANDIDATE_RSS_DELTA_LIMIT_MB || 128)
  assert.ok(p95Ms <= p95LimitMs, `candidate query p95 ${p95Ms.toFixed(1)}ms exceeds ${p95LimitMs}ms`)
  assert.ok(rssDeltaMb <= rssDeltaLimitMb, `candidate query RSS delta ${rssDeltaMb.toFixed(1)}MB exceeds ${rssDeltaLimitMb}MB`)
  console.log(JSON.stringify({
    ok: true, runs, p95Ms: Number(p95Ms.toFixed(1)), maxMs: Number(maxMs.toFixed(1)),
    p95LimitMs, rssDeltaMb: Number(rssDeltaMb.toFixed(1)), rssDeltaLimitMb,
  }))
}

await main().finally(async () => pool.end())
