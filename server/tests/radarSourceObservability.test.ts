import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeRadarSourceRun } from '../src/services/radarSourceRunSummary.js'

test('数据源监控将正常采集结果转换成业务可读摘要', () => {
  const summary = summarizeRadarSourceRun('paper-daily', {
    fetched: 28,
    retained: 20,
    written: 20,
    source_results: [{ key: 'arxiv-ai' }, { key: 'arxiv-cv' }],
    error_samples: [],
  })
  assert.equal(summary.status, 'succeeded')
  assert.deepEqual(summary.metrics, {
    fetched: 28, retained: 20, written: 20, sources: 2, errors: 0, skipped: false,
  })
  assert.match(summary.message, /论文数据源采集成功/)
  assert.match(summary.message, /抓取 28 条，保留 20 条，写入 20 条/)
})

test('数据源监控区分部分成功和完全失败', () => {
  const partial = summarizeRadarSourceRun('auto', {
    fetched: 10,
    retained: 6,
    written: 6,
    source_results: [{ key: 'one' }, { key: 'two' }],
    error_samples: [{ source: 'two', error: 'timeout' }],
  })
  assert.equal(partial.status, 'partial')
  assert.match(partial.message, /部分成功/)

  const failed = summarizeRadarSourceRun('wechat-daily', undefined, new Error('credential=very-secret'))
  assert.equal(failed.status, 'failed')
  assert.match(failed.message, /公众号日采集失败/)
  assert.doesNotMatch(failed.message, /very-secret/)
})
