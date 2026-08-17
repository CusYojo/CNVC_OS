import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareHistoricalWechatImport } from '../src/services/radarHistoricalWechatImportService.js'

test('历史公众号资料映射、筛选并按来源身份去重', () => {
  const source = {
    id: 'article-1',
    title: '具身智能公司完成亿元A轮融资',
    url: 'https://mp.weixin.qq.com/s?__biz=MzTest&mid=1',
    summary: '该未上市公司完成亿元A轮融资，产品已进入量产。',
    content_text: '投资方表示将支持机器人产品研发和商业化。',
    account_name: '清华大学机器人研究院',
    published_at: '2026-05-26 10:00:00',
  }
  const result = prepareHistoricalWechatImport([source, { ...source }])
  assert.equal(result.input, 2)
  assert.equal(result.retained, 2)
  assert.equal(result.duplicatesInInput, 1)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].source_group, '高校公众号')
  assert.equal(result.rows[0].account_biz, 'MzTest')
  assert.equal(result.rows[0].import_provenance, 'offline_historical_wechat_json')
})

test('历史公众号导入默认过滤没有项目或投资信号的资讯', () => {
  const result = prepareHistoricalWechatImport([{ id: 'noise-1', title: '本周活动通知', summary: '欢迎报名参加。' }])
  assert.equal(result.mapped, 1)
  assert.equal(result.retained, 0)
  assert.equal(result.filtered, 1)
  assert.deepEqual(result.rows, [])
})

test('历史公众号导入拒绝非数组输入', () => {
  assert.throws(() => prepareHistoricalWechatImport({}), /必须是 JSON 数组/)
})
