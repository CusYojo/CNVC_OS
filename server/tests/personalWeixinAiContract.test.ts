import assert from 'node:assert/strict'
import test from 'node:test'

import {
  personalWeixinSenderAllowed,
  publicPersonalWeixinConfig,
} from '../src/contracts/personalWeixinAiContract.js'
import { personalWeixinSessionId } from '../src/services/personalWeixinSession.js'

test('personal bot accepts only its owner identity and hides upstream identifiers', () => {
  const config = {
    ownershipMode: 'personal',
    accountId: 'bot-secret',
    accountUserId: 'wx-owner',
    connectedAt: '2026-09-08T00:00:00.000Z',
  }

  assert.equal(personalWeixinSenderAllowed(config, 'wx-owner'), true)
  assert.equal(personalWeixinSenderAllowed(config, 'wx-other'), false)
  assert.deepEqual(publicPersonalWeixinConfig(config), {
    ownershipMode: 'personal',
    connectedAt: '2026-09-08T00:00:00.000Z',
    accountHint: '***wner',
  })
})

test('malformed personal bot configuration denies every sender', () => {
  assert.equal(personalWeixinSenderAllowed({}, 'wx-owner'), false)
  assert.equal(personalWeixinSenderAllowed({ ownershipMode: 'shared', accountUserId: 'wx-owner' }, 'wx-owner'), false)
  assert.equal(personalWeixinSenderAllowed({ ownershipMode: 'personal', accountUserId: '' }, ''), false)
})

test('personal WeChat runtime session id is stable and fits the chat agent id column', () => {
  const externalConversationId = `${'a'.repeat(80)}:${'b'.repeat(80)}`
  const first = personalWeixinSessionId(externalConversationId)
  assert.equal(first, personalWeixinSessionId(externalConversationId))
  assert.notEqual(first, personalWeixinSessionId(`${externalConversationId}:other`))
  assert.match(first, /^weixin-personal:[0-9a-f]{48}$/)
  assert.equal(first.length, 64)
})
