import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readVerifiedUploadedTemplate, materializeUploadedTemplate } from '../src/services/aiUploadedTemplateSnapshot.js'

test('uploaded template execution retains verified bytes and rejects a replaced source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uploaded-template-test-'))
  const source = path.join(root, 'template.docx')
  const original = Buffer.from('registered template bytes')
  const hash = createHash('sha256').update(original).digest('hex')
  try {
    await writeFile(source, original)
    const frozen = await materializeUploadedTemplate(source, hash)
    try {
      await writeFile(source, 'replaced bytes')
      assert.deepEqual(await readFile(frozen.referencePath), original)
      await assert.rejects(readVerifiedUploadedTemplate(source, hash), { code: 'CUSTOM_TEMPLATE_CONTENT_CHANGED' })
      await assert.rejects(materializeUploadedTemplate(source, hash), { code: 'CUSTOM_TEMPLATE_CONTENT_CHANGED' })
      await assert.rejects(readVerifiedUploadedTemplate(source, ''), { code: 'CUSTOM_TEMPLATE_CONTENT_CHANGED' })
    } finally { await frozen.dispose() }
    await assert.rejects(stat(frozen.referencePath), { code: 'ENOENT' })
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('uploaded-template-test-'))
    await rm(root, { recursive: true, force: true })
  }
})
