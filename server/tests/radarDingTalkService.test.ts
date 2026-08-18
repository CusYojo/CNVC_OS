import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  createDingTalkSignedWebhookUrl,
  sendDingTalkWebhook,
  validateRadarDingTalkWebhook,
} from '../src/services/radarDingTalkService.js'

const webhook = 'https://oapi.dingtalk.com/robot/send?access_token=test-token'
const secret = 'SEC-test-signing-secret'

test('Radar 钉钉 Webhook 只允许官方自定义机器人地址', () => {
  assert.equal(validateRadarDingTalkWebhook(webhook), webhook)
  assert.throws(
    () => validateRadarDingTalkWebhook('https://example.com/robot/send?access_token=test-token'),
    (error: Error & { code?: string }) => error.code === 'RADAR_DINGTALK_WEBHOOK_FORBIDDEN',
  )
  assert.throws(
    () => validateRadarDingTalkWebhook('https://oapi.dingtalk.com/robot/send'),
    (error: Error & { code?: string }) => error.code === 'RADAR_DINGTALK_ACCESS_TOKEN_MISSING',
  )
})

test('Radar 钉钉加签使用 timestamp 换行 secret 的 HMAC-SHA256', () => {
  const timestamp = 1_700_000_000_123
  const signed = new URL(createDingTalkSignedWebhookUrl(webhook, secret, timestamp))
  const expected = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
  assert.equal(signed.searchParams.get('access_token'), 'test-token')
  assert.equal(signed.searchParams.get('timestamp'), String(timestamp))
  assert.equal(signed.searchParams.get('sign'), expected)
})

test('Radar 钉钉发送器使用 text 消息且不跟随重定向', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url)
    capturedInit = init
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
  }) as typeof fetch
  const result = await sendDingTalkWebhook(
    { webhookUrl: webhook, signingSecret: secret },
    '[数据源监控] 采集成功',
    { fetchImpl, now: () => 1_700_000_000_123 },
  )
  assert.equal(result.ok, true)
  assert.equal(capturedInit?.method, 'POST')
  assert.equal(capturedInit?.redirect, 'error')
  assert.match(capturedUrl, /timestamp=1700000000123/)
  const body = JSON.parse(String(capturedInit?.body))
  assert.deepEqual(body, {
    msgtype: 'text',
    text: { content: '[数据源监控] 采集成功' },
    at: { isAtAll: false },
  })
})

test('Radar 钉钉返回业务错误时按失败处理', async () => {
  const fetchImpl = (async () => new Response(
    JSON.stringify({ errcode: 310000, errmsg: 'sign not match' }),
    { status: 200 },
  )) as typeof fetch
  await assert.rejects(
    sendDingTalkWebhook({ webhookUrl: webhook, signingSecret: secret }, 'test', { fetchImpl }),
    (error: Error & { code?: string }) => error.code === 'RADAR_DINGTALK_DELIVERY_FAILED'
      && !error.message.includes('test-token'),
  )
})
