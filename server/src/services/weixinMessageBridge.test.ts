import assert from 'node:assert/strict'
import test from 'node:test'
import { isWeixinMessageBridgeEnabled, routePersonalWeixinSender, weixinExternalMessageId, weixinMessageText } from './weixinMessageBridge.js'

test('Weixin bridge can be disabled for a local service instance', () => {
  assert.equal(isWeixinMessageBridgeEnabled('false'), false)
  assert.equal(isWeixinMessageBridgeEnabled('0'), false)
  assert.equal(isWeixinMessageBridgeEnabled('off'), false)
  assert.equal(isWeixinMessageBridgeEnabled('true'), true)
  assert.equal(isWeixinMessageBridgeEnabled(undefined), true)
})

test('extracts Weixin text items and ignores unsupported items', () => {
  assert.equal(weixinMessageText({
    item_list: [
      { type: 1, text_item: { text: '  第一段 ' } },
      { type: 2 },
      { type: 1, text_item: { text: '第二段' } },
    ],
  }), '第一段\n第二段')
})

test('uses explicit message id and creates stable fallback id', () => {
  assert.equal(weixinExternalMessageId('account', { msg_id: 'message-1' }), 'message-1')
  const message = {
    from_user_id: 'user', create_time_ms: 123,
    context_token: 'context', item_list: [{ type: 1, text_item: { text: '测试' } }],
  }
  assert.equal(weixinExternalMessageId('account', message), weixinExternalMessageId('account', message))
  assert.equal(weixinExternalMessageId('account', message).length, 64)
})

test('personal bot accepts only its bound Weixin identity', () => {
  const bot = { ownershipMode: 'personal', accountUserId: 'wx-owner' }
  assert.equal(routePersonalWeixinSender(bot, 'wx-owner'), 'allowed')
  assert.equal(routePersonalWeixinSender(bot, 'wx-other'), 'owner_mismatch')
  assert.equal(routePersonalWeixinSender({ ownershipMode: 'shared', accountUserId: '' }, 'wx-other'), 'shared')
})
