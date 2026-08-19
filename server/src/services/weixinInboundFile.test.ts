import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import test from 'node:test'
import JSZip from 'jszip'
import {
  downloadWeixinInboundFiles,
  WeixinInboundFileError,
  weixinInboundFileCount,
  weixinInboundFileReferenceHash,
} from './weixinInboundFile.js'

const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

function encryptedFetch(content: Buffer) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()])
  return (async () => new Response(ciphertext, {
    status: 200,
    headers: { 'content-length': String(ciphertext.length) },
  })) as typeof fetch
}

function message(fileName: string, content: Buffer) {
  return {
    item_list: [{
      type: 4,
      file_item: {
        file_name: fileName,
        len: String(content.length),
        media: {
          aes_key: key.toString('base64'),
          full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?ticket=test',
        },
      },
    }],
  }
}

test('downloads and decrypts a Weixin PDF document', async () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF')
  const input = message('投资报告.pdf', pdf)
  const documents = await downloadWeixinInboundFiles(input, encryptedFetch(pdf))

  assert.equal(documents.length, 1)
  assert.equal(documents[0].kind, 'pdf')
  assert.equal(documents[0].mediaType, 'application/pdf')
  assert.equal(documents[0].dataBase64, pdf.toString('base64'))
  assert.equal(documents[0].sha256, createHash('sha256').update(pdf).digest('hex'))
  assert.equal(weixinInboundFileCount(input), 1)
  assert.equal(weixinInboundFileReferenceHash(input).length, 64)
})

test('extracts text from a decrypted Weixin DOCX document', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>项目结论</w:t></w:r></w:p><w:p><w:r><w:t>建议继续尽调</w:t></w:r></w:p></w:body>
    </w:document>`)
  const docx = await zip.generateAsync({ type: 'nodebuffer' })
  const documents = await downloadWeixinInboundFiles(message('项目.docx', docx), encryptedFetch(docx))

  assert.equal(documents[0].kind, 'text')
  assert.equal(documents[0].mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.match(documents[0].text || '', /项目结论/)
  assert.match(documents[0].text || '', /建议继续尽调/)
})

test('decodes a decrypted UTF-8 Markdown document', async () => {
  const markdown = Buffer.from('# 结论\n\n- 继续跟进\n', 'utf8')
  const documents = await downloadWeixinInboundFiles(message('notes.md', markdown), encryptedFetch(markdown))

  assert.equal(documents[0].kind, 'text')
  assert.equal(documents[0].mediaType, 'text/markdown')
  assert.equal(documents[0].text, '# 结论\n\n- 继续跟进')
})

test('returns a user-safe explanation for legacy DOC files', async () => {
  const legacy = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  await assert.rejects(
    downloadWeixinInboundFiles(message('legacy.doc', legacy), encryptedFetch(legacy)),
    (error: unknown) => error instanceof WeixinInboundFileError
      && error.publicMessage.includes('另存为 .docx'),
  )
})

test('rejects file download URLs outside the Weixin HTTPS allowlist', async () => {
  await assert.rejects(
    downloadWeixinInboundFiles({
      item_list: [{
        type: 4,
        file_item: {
          file_name: 'report.pdf',
          media: { aes_key: key.toString('base64'), full_url: 'https://example.com/report.pdf' },
        },
      }],
    }, async () => new Response('not-called') as never),
    /不在允许列表/,
  )
})
