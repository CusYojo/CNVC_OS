import assert from 'node:assert/strict'
import test from 'node:test'
import { leadSourceSupportsSubject } from '../src/services/leadSourceSubjectMatchService.js'

test('entity-specific facts require the confirmed name or alias in the original source', () => {
  assert.equal(leadSourceSupportsSubject({
    topicKey: 'financing', sourceText: '星河科技有限公司宣布完成A轮融资。',
    subjectAliases: ['星河科技有限公司', '星河科技'],
  }), true)
  assert.equal(leadSourceSupportsSubject({
    topicKey: 'financing', sourceText: '另一家公司宣布完成A轮融资。',
    subjectAliases: ['星河科技有限公司', '星河科技'],
  }), false)
})

test('subject matching normalizes punctuation and market policy permits industry-wide originals', () => {
  assert.equal(leadSourceSupportsSubject({
    topicKey: 'technology_ip', sourceText: '申请（专利权）人：星 河 科 技', subjectAliases: ['星河科技'],
  }), true)
  assert.equal(leadSourceSupportsSubject({
    topicKey: 'market_policy', sourceText: '本政策适用于人工智能产业。', subjectAliases: ['星河科技'],
  }), true)
})
