import assert from 'node:assert/strict'
import test from 'node:test'

import { buildUtf8SafeFileName } from '../src/services/utf8SafeFileName.js'

test('UTF-8 safe file names stay within the filesystem 255-byte component limit', () => {
  const fileName = buildUtf8SafeFileName({
    prefix: '001-',
    stem: '大衍科技尽职调查资料'.repeat(20),
    fallback: 'source',
    suffix: '.md',
  })

  assert.ok(Buffer.byteLength(fileName, 'utf8') <= 255)
  assert.match(fileName, /^001-大衍科技/)
  assert.match(fileName, /\.md$/)
})

test('UTF-8 safe file names reserve bytes for a Chinese output suffix', () => {
  const fileName = buildUtf8SafeFileName({
    stem: '大衍科技'.repeat(80),
    fallback: '项目',
    suffix: '_投资提案.docx',
  })

  assert.ok(Buffer.byteLength(fileName, 'utf8') <= 255)
  assert.match(fileName, /_投资提案\.docx$/)
})

test('UTF-8 safe file names sanitize illegal characters without splitting emoji', () => {
  const fileName = buildUtf8SafeFileName({
    stem: '项目<>:"/\\|?*\u0000🚀'.repeat(40),
    fallback: '项目',
    suffix: '.docx',
  })

  assert.ok(Buffer.byteLength(fileName, 'utf8') <= 255)
  assert.doesNotMatch(fileName, /[\\/:*?"<>|\u0000-\u001f]/)
  assert.equal(fileName.includes('\uFFFD'), false)
})

test('UTF-8 safe file names use the fallback when the sanitized stem is empty', () => {
  assert.equal(buildUtf8SafeFileName({ stem: '   ', fallback: '项目', suffix: '.docx' }), '项目.docx')
})
