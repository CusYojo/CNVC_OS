import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildConversationPptInstructions,
  detectConversationPptGenerationIntent,
  extractRequestedPptPageCount,
} from '../src/services/aiConversationPptIntentService.js'

test('recognizes an explicit investment PPT generation command', () => {
  assert.equal(detectConversationPptGenerationIntent('请根据当前项目生成投资建议书 PPT'), true)
  assert.equal(detectConversationPptGenerationIntent('生成PPT'), true)
})

test('does not turn questions, negations or meta examples into generation tasks', () => {
  assert.equal(detectConversationPptGenerationIntent('你能生成 PPT 吗？'), false)
  assert.equal(detectConversationPptGenerationIntent('暂时不要生成投资建议书'), false)
  assert.equal(detectConversationPptGenerationIntent('如果我说生成PPT的话，就调用技能'), false)
  assert.equal(detectConversationPptGenerationIntent('为什么我说了生成PPT却没有反应？'), false)
})

test('uses recent conversation to understand a contextual start command', () => {
  assert.equal(detectConversationPptGenerationIntent('就按以上内容生成吧', [
    { role: 'user', content: '投资建议书 PPT 里重点写团队和交易方案。' },
    { role: 'assistant', content: '已经整理好页面结构。' },
  ]), true)
})

test('conversation instructions retain project discussion within the task limit', () => {
  const instructions = buildConversationPptInstructions('现在生成 PPT，重点说明估值', [
    { role: 'user', content: '公司今年收入预计 5000 万，但需要标为预测数据。' },
    { role: 'assistant', content: '融资方案建议分两期交割。' },
  ], ['最新财务预测.xlsx', '管理层访谈纪要.pdf'])
  assert.match(instructions, /估值/)
  assert.match(instructions, /5000 万/)
  assert.match(instructions, /两期交割/)
  assert.match(instructions, /最新财务预测\.xlsx/)
  assert.match(instructions, /系统内置的投资建议书版式/)
  assert.ok(instructions.length <= 2_000)
})

test('extracts explicit Arabic and Chinese PPT page counts without treating slide ordinals as deck size', () => {
  assert.equal(extractRequestedPptPageCount('生成一个五页的ppt'), 5)
  assert.equal(extractRequestedPptPageCount('请制作 12 页版投资建议书'), 12)
  assert.equal(extractRequestedPptPageCount('按上述要求生成', [
    { role: 'user', content: '最终控制在八页' },
  ]), 8)
  assert.equal(extractRequestedPptPageCount('第5页重点说明交易方案'), undefined)
})
