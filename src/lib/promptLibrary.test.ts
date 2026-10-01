import assert from 'node:assert/strict'
import test from 'node:test'
import { readPromptMarkdownFile } from './promptLibrary.js'

test('accepts a small UTF-8 Markdown file and keeps the prompt body', async () => {
  const file = new File(['# 研究助手\n\n按证据分析。'], '研究助手.md', { type: 'text/markdown' })
  assert.deepEqual(await readPromptMarkdownFile(file), {
    fileName: '研究助手.md', markdown: '# 研究助手\n\n按证据分析。', name: '研究助手',
  })
})

test('rejects unsafe filenames, oversized files and malformed UTF-8', async () => {
  await assert.rejects(readPromptMarkdownFile(new File(['# x'], '../outside.md')))
  await assert.rejects(readPromptMarkdownFile(new File(['x'], 'prompt.txt')))
  await assert.rejects(readPromptMarkdownFile(new File(['x'.repeat(128 * 1024 + 1)], 'huge.md')))
  await assert.rejects(readPromptMarkdownFile(new File([new Uint8Array([0xff, 0xfe])], 'broken.md')))
})
