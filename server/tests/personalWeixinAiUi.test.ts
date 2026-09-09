import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('profile menu exposes personal WeChat AI and page uses only self endpoints', async () => {
  const [layout, app, page] = await Promise.all([
    readFile(new URL('../../src/layout/AppLayout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages/PersonalWeixinAiPage.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(layout, /微信 AI/)
  assert.match(layout, /\/settings\/weixin-ai/)
  assert.match(app, /path="\/settings\/weixin-ai"/)
  assert.match(page, /\/integrations\/im\/weixin\/self/)
  assert.doesNotMatch(page, /\/integrations\/im\/weixin\/login\/start/)
  assert.match(page, /请使用本人微信扫码/)
  assert.match(page, /独立 AI 会话/)
  assert.match(page, /不会增加项目或知识库权限/)
})
