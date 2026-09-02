import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyKr36Project, normalizeKr36FoundedAt } from '../src/services/kr36ProjectClassifier.js'

test('36氪范围规则接受2025年后人工智能项目', () => {
  const decision = classifyKr36Project({
    detail: { name: '多模态智能体', business: { estiblishTime: '2025-03-18' }, intro: '大模型智能体平台' },
  })
  assert.equal(decision.status, 'eligible')
  assert.equal(decision.foundedAt, '2025-03-18')
  assert.deepEqual(decision.sectorLabels, ['artificial_intelligence'])
})

test('36氪范围规则拒绝2025年以前项目', () => {
  const decision = classifyKr36Project({
    detail: { name: '机器人企业', setupDate: '2024-12-31', intro: '人形机器人' },
  })
  assert.equal(decision.status, 'founded_before_2025')
  assert.equal(decision.eligible, false)
})

test('成立时间缺失时进入待核验而不是猜测', () => {
  const decision = classifyKr36Project({ detail: { name: '芯片项目', intro: '半导体芯片' } })
  assert.equal(decision.status, 'founded_at_pending')
})

test('注销主体不会进入每日准入队列', () => {
  const decision = classifyKr36Project({ detail: {
    name: '注销芯片项目', setupDate: '2025-01-01', intro: '半导体芯片',
    business: { registrationStatus: '注销' },
  } })
  assert.equal(decision.status, 'registration_ineligible')
  assert.equal(decision.eligible, false)
})

test('未命中重点赛道标签的行业仍可按全行业规则准入', () => {
  const decision = classifyKr36Project({ detail: { name: '智能家居', setupDate: '2026-01-01' } })
  assert.equal(decision.status, 'eligible')
  assert.equal(decision.eligible, true)
  assert.deepEqual(decision.sectorLabels, [])
  assert.equal(decision.rulesVersion, 'kr36-all-industries-v2')
})

test('时间戳成立日期可规范化', () => {
  assert.equal(normalizeKr36FoundedAt({ business: { estiblishTime: Date.UTC(2025, 2, 18) } }), '2025-03-18')
  assert.equal(normalizeKr36FoundedAt({ setupDate: Date.parse('2024-12-31T16:00:00Z') }), '2025-01-01')
})
