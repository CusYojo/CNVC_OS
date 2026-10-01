import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createPromptLibraryRouter } from '../src/routes/promptLibrary.js'
import { createPromptLibraryService, type PromptLibraryRecord, type PromptLibraryRepository } from '../src/services/promptLibraryService.js'

function mockService() {
  const records = new Map<string, PromptLibraryRecord>()
  const repository: PromptLibraryRepository = {
    async listVisible(userId, kind) { return [...records.values()].filter(item => item.kind === kind && (item.visibility === 'organization' || item.ownerUserId === userId)) },
    async findById(id) { return records.get(id) ?? null },
    async create(item) { records.set(item.id, item); return item },
    async update() { return false },
    async delete() { return false },
  }
  return createPromptLibraryService(repository, [], async () => undefined)
}

test('prompt library API requires login and serves only authorized Markdown as attachment', async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const uid = req.header('x-test-user')
    if (uid) (req as express.Request & { user: object }).user = { uid, name: uid, role: '投资经理' }
    next()
  })
  app.use('/api/ai/prompt-library', createPromptLibraryRouter(mockService()))
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ code: 'TEST_ERROR' })
  })
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}/api/ai/prompt-library`
    assert.equal((await fetch(`${url}?kind=skill`)).status, 401)
    const created = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'author' },
      body: JSON.stringify({ kind: 'skill', name: '研究助手', markdown: '# 研究助手\n\n只引用资料。', fileName: '研究助手.md' }),
    })
    assert.equal(created.status, 201)
    const item = await created.json() as { id: string }
    assert.equal((await fetch(`${url}/${item.id}/download`, { headers: { 'x-test-user': 'colleague' } })).status, 403)
    const downloaded = await fetch(`${url}/${item.id}/download`, { headers: { 'x-test-user': 'author' } })
    assert.equal(downloaded.status, 200)
    assert.match(downloaded.headers.get('content-type') || '', /^text\/markdown/)
    assert.match(downloaded.headers.get('content-disposition') || '', /^attachment;/)
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(await downloaded.text(), '# 研究助手\n\n只引用资料。')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
