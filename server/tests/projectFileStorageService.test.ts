import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('项目原始文件只能保存在专用目录并可重新读取', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cybernaut-project-files-'))
  process.env.PROJECT_FILE_ROOT = root
  const storage = await import(`../src/services/projectFileStorageService.js?test=${Date.now()}`)

  try {
    const content = Buffer.from('project-file-content')
    const storagePath = await storage.saveProjectFile('project-id', 'file-id', content)
    assert.equal(storagePath, path.join('project-id', 'file-id'))
    assert.deepEqual(await readFile(path.join(root, storagePath)), content)

    const opened = await storage.openProjectFile(storagePath)
    const chunks: Buffer[] = []
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk))
    assert.equal(opened.size, content.length)
    assert.deepEqual(Buffer.concat(chunks), content)
    assert.deepEqual(await storage.readProjectFileBuffer(storagePath), content)

    await storage.removeProjectFile(storagePath)
    await assert.rejects(storage.openProjectFile(storagePath), (error: { code?: string; status?: number }) => {
      assert.equal(error.code, 'FILE_CONTENT_NOT_FOUND')
      assert.equal(error.status, 404)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('拒绝读取专用目录之外的存储路径', async () => {
  const storage = await import('../src/services/projectFileStorageService.js')
  await assert.rejects(storage.openProjectFile('../outside'), (error: { code?: string }) => {
    assert.equal(error.code, 'INVALID_STORAGE_PATH')
    return true
  })
})
