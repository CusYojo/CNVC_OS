import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeWeixinKnowledge, WEIXIN_SUMMARY_MODEL } from '../src/services/weixinKnowledgeAiSummaryService.js'

test('uses Doubao mini for WeChat knowledge summaries', async () => {
  let requestedModel = ''
  const summary = await summarizeWeixinKnowledge('原文：项目已完成三个工厂试点。', '测试公众号', {
    resolveModel: async () => ({ baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: WEIXIN_SUMMARY_MODEL, timeoutMs: 30_000 }),
    requestText: async input => {
      requestedModel = input.model
      return '摘要：该项目已经完成三个工厂试点，正在验证规模化交付能力。'
    },
  })
  assert.equal(requestedModel, 'Doubao-seed-2-0-mini')
  assert.equal(summary, '微信收录 · 测试公众号\n该项目已经完成三个工厂试点，正在验证规模化交付能力。')
})

test('falls back to local extraction when Doubao mini is unavailable', async () => {
  let requested = false
  const summary = await summarizeWeixinKnowledge('项目面向制造企业提供软件。项目已完成三个试点。主要风险是销售周期较长。', '微信文件', {
    resolveModel: async () => null,
    requestText: async () => {
      requested = true
      return '不应调用'
    },
  })
  assert.equal(requested, false)
  assert.match(summary, /^微信收录 · 微信文件/)
  assert.match(summary, /项目面向制造企业提供软件/)
  assert.match(summary, /主要风险是销售周期较长/)
})
