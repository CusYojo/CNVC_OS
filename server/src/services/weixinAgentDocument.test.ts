import assert from 'node:assert/strict'
import test from 'node:test'

import { weixinAgentDocumentText } from './weixinAgentDocument.js'

test('renders Markdown as a plain text block for Chat Completions compatible models', async () => {
  const rendered = await weixinAgentDocumentText({
    kind: 'text',
    fileName: 'notes.md',
    mediaType: 'text/markdown',
    text: '# 项目结论\n\n建议继续尽调',
    byteSize: 35,
    sha256: 'a'.repeat(64),
  })

  assert.equal(rendered, '【微信文件：notes.md】\n# 项目结论\n\n建议继续尽调\n【文件结束】')
  assert.equal(rendered.includes('document'), false)
})

test('rejects an empty extracted document before it reaches the model API', async () => {
  await assert.rejects(() => weixinAgentDocumentText({
    kind: 'text',
    fileName: 'empty.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    text: '  ',
    byteSize: 10,
    sha256: 'b'.repeat(64),
  }), /没有可读取的文字内容/)
})
