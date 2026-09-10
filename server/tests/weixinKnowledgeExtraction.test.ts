import assert from 'node:assert/strict'
import test from 'node:test'
import { extractWeixinKnowledgeSummary, weixinPublicSourceLink } from '../src/services/weixinKnowledgeExtractionService.js'

test('extracts concise distinct knowledge points instead of copying a fixed prefix', () => {
  const summary = extractWeixinKnowledgeSummary(`# 项目概况

澄海智算面向制造企业提供能耗分析软件。
澄海智算面向制造企业提供能耗分析软件。

## 业务进展

项目已完成三个工厂试点，正在验证交付效率。

## 风险

销售周期较长，现场数据质量仍需持续核验。`, '微信文件')
  assert.match(summary, /^微信收录 · 微信文件/)
  assert.match(summary, /三个工厂试点/)
  assert.match(summary, /销售周期较长/)
  assert.equal(summary.match(/面向制造企业提供能耗分析软件/g)?.length, 1)
  assert.ok(summary.length <= 500)
})

test('retains a public source URL and rejects internal file identities', () => {
  const source = 'https://mp.weixin.qq.com/s/example?scene=1'
  assert.equal(weixinPublicSourceLink(source), source)
  assert.equal(weixinPublicSourceLink('weixin-file://abc123'), '')
})
