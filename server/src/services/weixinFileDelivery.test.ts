import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  sanitizeWeixinFileName,
  uploadAndSendWeixinFile,
  weixinArtifactIdsFromMessages,
} from './weixinFileDelivery.js'

test('collects only new authorized artifact references from agent messages', () => {
  const oldId = '11111111-1111-4111-8111-111111111111'
  const firstId = '22222222-2222-4222-8222-222222222222'
  const secondId = '33333333-3333-4333-8333-333333333333'
  const unrelatedId = '44444444-4444-4444-8444-444444444444'
  const messages = [
    { id: 'old', parts: [{ type: 'text', text: `/api/ai/artifacts/${oldId}/download` }] },
    {
      id: 'tool',
      parts: [{
        type: 'dynamic-tool',
        output: [{
          type: 'text',
          text: JSON.stringify({
            task: { artifacts: [{ id: firstId, fileName: '报告.docx' }] },
            projectId: unrelatedId,
          }),
        }],
      }],
    },
    { id: 'reply', parts: [{ type: 'text', text: `[下载](/api/ai/artifacts/${secondId}/download)` }] },
  ]
  assert.deepEqual(
    weixinArtifactIdsFromMessages(messages, new Set(['old'])),
    [firstId, secondId],
  )
})

test('sanitizes Weixin filenames without losing the extension', () => {
  assert.equal(sanitizeWeixinFileName('../目录/投\r\n资"报告.docx'), '投资_报告.docx')
})

test('uploads encrypted bytes and sends a type-4 Weixin file item', async () => {
  const content = Buffer.from('investment-report-content')
  const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = []
  let uploaded = Buffer.alloc(0)
  const postWeixin = async <T>(endpoint: string, payload: unknown): Promise<T> => {
    calls.push({ endpoint, payload: payload as Record<string, unknown> })
    if (endpoint.endsWith('getuploadurl')) {
      return { upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?ticket=test' } as T
    }
    return {} as T
  }
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    uploaded = Buffer.from(init?.body as Uint8Array)
    return new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-token' } })
  }) as typeof fetch

  const result = await uploadAndSendWeixinFile({
    postWeixin,
    targetUserId: 'wx-user',
    contextToken: 'context-token',
    fileName: '投资报告.docx',
    content,
    channelVersion: 'test-version',
    fetchImpl,
  })

  assert.equal(result.fileName, '投资报告.docx')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].endpoint, 'ilink/bot/getuploadurl')
  assert.equal(calls[0].payload.media_type, 3)
  assert.equal(calls[0].payload.rawsize, content.length)
  assert.equal(calls[0].payload.rawfilemd5, createHash('md5').update(content).digest('hex'))
  assert.notDeepEqual(uploaded, content)
  assert.equal(uploaded.length % 16, 0)

  const message = calls[1].payload.msg as Record<string, unknown>
  const item = (message.item_list as Array<Record<string, unknown>>)[0]
  const file = item.file_item as Record<string, unknown>
  const media = file.media as Record<string, unknown>
  assert.equal(item.type, 4)
  assert.equal(file.file_name, '投资报告.docx')
  assert.equal(file.len, String(content.length))
  assert.equal(media.encrypt_query_param, 'download-token')
  assert.match(Buffer.from(String(media.aes_key), 'base64').toString('utf8'), /^[0-9a-f]{32}$/)
})
