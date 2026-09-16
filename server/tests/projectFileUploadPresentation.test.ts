import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { summarizeProjectFileUpload } from '../../src/lib/projectFileUploadPresentation.js'

test('upload batches expose accurate tone and title', () => {
  assert.equal(summarizeProjectFileUpload([{ fileName: 'a.pdf', kind: 'success', message: '上传成功' }]).tone, 'success')
  assert.equal(summarizeProjectFileUpload([{ fileName: 'a.pdf', kind: 'error', message: '没有上传权限' }]).title, '上传失败')
  assert.equal(summarizeProjectFileUpload([{ fileName: 'a.pdf', kind: 'parse_warning', message: '文件已保存，内容解析失败' }]).tone, 'warning')
  assert.equal(summarizeProjectFileUpload([
    { fileName: 'a.pdf', kind: 'success', message: '上传成功' },
    { fileName: 'b.pdf', kind: 'error', message: '服务不可用' },
  ]).title, '部分文件处理异常')
  assert.equal(summarizeProjectFileUpload([{ fileName: 'a.pdf', kind: 'duplicate', message: '文件已存在' }]).title, '未上传新文件')
  assert.match(summarizeProjectFileUpload([{ fileName: 'a.pdf', kind: 'error', message: '没有上传权限' }]).details[0], /没有上传权限/)
})

test('project detail renders structured upload summaries without fixed success styling', async () => {
  const page = await readFile(new URL('../../src/pages/ProjectDetailPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /summarizeProjectFileUpload/)
  assert.match(page, /err instanceof ApiError \? err\.message/)
  assert.match(page, /summary\.title/)
  assert.doesNotMatch(page, />已完成上传，窗口将保持打开</)
})
