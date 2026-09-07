import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  isRadarSyncContentionError,
  radarCandidateWriteCount,
  radarPipelineItemReviewable,
} from '../src/services/radarSyncRuntimePolicy.js'

test('公众号候选写入数量可从所有采集结果契约读取', () => {
  assert.equal(radarCandidateWriteCount({ written: 12 }), 12)
  assert.equal(radarCandidateWriteCount({ imported: 8 }), 8)
  assert.equal(radarCandidateWriteCount({ retained: 3 }), 3)
  assert.equal(radarCandidateWriteCount({ written: 0, imported: 0 }), 0)
  assert.equal(radarCandidateWriteCount({ written: 'invalid' }), 0)
})

test('雷达同步并发折叠仅识别明确的同轮运行冲突', () => {
  assert.equal(isRadarSyncContentionError(Object.assign(new Error('conflict'), {
    name: 'RadarSyncAlreadyRunningError',
  })), true)
  assert.equal(isRadarSyncContentionError(Object.assign(new Error('conflict'), {
    code: 'RADAR_SYNC_ALREADY_RUNNING',
  })), true)
  assert.equal(isRadarSyncContentionError(new Error('上一轮雷达同步仍在运行，请稍后重试')), true)
  assert.equal(isRadarSyncContentionError(new Error('database unavailable')), false)
})

test('雷达管道只重试时间边界内且未超上限的条目', () => {
  const env = {
    RADAR_PIPELINE_MAX_ATTEMPTS: '3',
    RADAR_PIPELINE_RETRY_AFTER: '2026-09-01T00:00:00+08:00',
  }
  assert.equal(radarPipelineItemReviewable({
    status: 'discovered', processingAttempts: 0, ingestedAt: '2026-09-01T00:00:00+08:00',
  }, env), true)
  assert.equal(radarPipelineItemReviewable({
    status: 'failed', processingAttempts: 2, ingestedAt: '2026-09-07T09:00:00+08:00',
  }, env), true)
  assert.equal(radarPipelineItemReviewable({
    status: 'failed', processingAttempts: 3, ingestedAt: '2026-09-07T09:00:00+08:00',
  }, env), false)
  assert.equal(radarPipelineItemReviewable({
    status: 'failed', processingAttempts: 1, ingestedAt: '2026-08-31T23:59:59+08:00',
  }, env), false)
  assert.equal(radarPipelineItemReviewable({
    status: 'ready', processingAttempts: 0, ingestedAt: '2026-09-07T09:00:00+08:00',
  }, env), false)
  assert.throws(
    () => radarPipelineItemReviewable({ status: 'failed' }, { RADAR_PIPELINE_RETRY_AFTER: 'not-a-date' }),
    /must be a valid date/,
  )
})

test('所有公众号采集入口都把候选写入交接给统一同步任务', async () => {
  const [scheduler, routes, historicalImport] = await Promise.all([
    readFile(new URL('../src/services/runtimeJobScheduler.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/radar.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/scripts/importRadarWechatHistory.ts', import.meta.url), 'utf8'),
  ])
  for (const action of ['wechat-daily', 'wechat-retry', 'wechat-institution']) {
    assert.match(scheduler, new RegExp(`runWechatCollectorWithSyncHandoff\\('${action}'`))
  }
  assert.match(scheduler, /consumeRadarSyncHandoff\(\)/)
  assert.match(scheduler, /reason: 'wechat_candidate_handoff'/)
  assert.match(scheduler, /'\$\.syncOnly',TRUE/)
  assert.match(scheduler, /recoverBenignRadarSyncDeadLetter\(\)/)
  assert.match(scheduler, /ok:\s*deadLetter === 0/)
  assert.equal((routes.match(/queueRadarSyncAfterCollection\(result\)/g) || []).length, 3)
  assert.match(historicalImport, /syncHandoff = await queueRadarSyncAfterCollection\(\{ written \}\)/)
})
