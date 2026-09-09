import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceContainsText } from '../src/contracts/sourceTextMatch.js'
const normalize = (text: string) => text.replace(/\s/g, '').toLowerCase()
test('manual review matches original multiline and quoted article text', () => {
  assert.equal(sourceContainsText({ article_text: '公司宣布\n完成“融资”，产品\\技术上线。' }, '宣布\n完成“融资”，产品\\技术', normalize), true)
})
test('reject fabricated quotations, cross-field joins and empty evidence', () => {
  const source = { title: '公司宣布', article_text: '完成投资' }
  for (const quote of ['虚构的融资', '公司宣布完成投资', '  ']) assert.equal(sourceContainsText(source, quote, normalize), false)
})
