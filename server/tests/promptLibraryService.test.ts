import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPromptLibraryService,
  parsePromptLibraryInput,
  safePromptDownloadFileName,
  type PromptLibraryRecord,
  type PromptLibraryRepository,
} from '../src/services/promptLibraryService.js'

const author = { userId: 'author', role: '投资经理', userName: '作者' }
const colleague = { userId: 'colleague', role: '投资经理', userName: '同事' }
const admin = { userId: 'admin', role: '系统管理员', userName: '管理员' }
const builtin = {
  slug: 'research-brief', kind: 'skill' as const, name: '研究简报',
  description: '按证据写简报', markdown: '# 研究简报\n\n只引用可核查来源。',
  sourceUrl: 'https://example.org/research', license: '原创',
}

function memoryRepository() {
  const records = new Map<string, PromptLibraryRecord>()
  const repository: PromptLibraryRepository = {
    async listVisible(userId, kind) {
      return [...records.values()].filter(item => item.kind === kind && (item.visibility === 'organization' || item.ownerUserId === userId))
    },
    async findById(id) { return records.get(id) ?? null },
    async create(item) { records.set(item.id, item); return item },
    async update(id, expectedVersion, patch) {
      const existing = records.get(id)
      if (!existing || existing.version !== expectedVersion) return false
      records.set(id, { ...existing, ...patch, version: expectedVersion + 1, updatedAt: new Date() })
      return true
    },
    async delete(id, expectedVersion) {
      const existing = records.get(id)
      if (!existing || existing.version !== expectedVersion) return false
      records.delete(id)
      return true
    },
  }
  return { repository, records }
}

test('validates a UTF-8 Markdown document without accepting paths or oversized content', () => {
  const parsed = parsePromptLibraryInput({
    kind: 'skill', name: '  研究技能  ', description: '  描述  ',
    markdown: '# 标题\n\n执行研究。', fileName: '研究技能.md', visibility: 'private',
  })
  assert.equal(parsed.name, '研究技能')
  assert.equal(parsed.markdown, '# 标题\n\n执行研究。')
  assert.throws(() => parsePromptLibraryInput({ ...parsed, fileName: '../secret.md' }))
  assert.throws(() => parsePromptLibraryInput({ ...parsed, markdown: 'x'.repeat(128 * 1024 + 1) }))
  assert.throws(() => parsePromptLibraryInput({ ...parsed, markdown: 'bad\u0000text' }))
  assert.throws(() => parsePromptLibraryInput({ ...parsed, kind: 'plugin' }))
})

test('download filename cannot inject separators or response headers', () => {
  assert.equal(safePromptDownloadFileName('财务研究/../../\r\nX-Test: yes', 'agent'), 'agent.md')
  assert.equal(safePromptDownloadFileName('market-research', 'skill'), 'market-research.md')
})

test('builtin templates are readable but immutable', async () => {
  const { repository } = memoryRepository()
  const service = createPromptLibraryService(repository, [builtin], async () => undefined)
  const items = await service.list(colleague, 'skill')
  assert.equal(items[0]?.id, 'builtin:research-brief')
  assert.equal((await service.get(colleague, 'builtin:research-brief')).markdown, builtin.markdown)
  await assert.rejects(service.update(admin, 'builtin:research-brief', { expectedVersion: 1, name: '替换' }), { status: 403 })
  await assert.rejects(service.remove(admin, 'builtin:research-brief', 1), { status: 403 })
})

test('private draft is visible only to its author and admins can edit but not bypass stale versions', async () => {
  const { repository } = memoryRepository()
  const events: string[] = []
  const service = createPromptLibraryService(repository, [], async (_actor, action) => { events.push(action) })
  const created = await service.create(author, {
    kind: 'agent', name: '尽调助理', description: '', markdown: '# 尽调助理\n\n仅依据材料。',
    fileName: 'diligence.md', visibility: 'private',
  })
  assert.equal(created.ownerUserId, author.userId)
  assert.deepEqual(await service.list(colleague, 'agent'), [])
  await assert.rejects(service.get(colleague, created.id), { status: 403 })
  await assert.rejects(service.update(colleague, created.id, { expectedVersion: 1, name: '篡改' }), { status: 403 })
  const changed = await service.update(admin, created.id, { expectedVersion: 1, visibility: 'organization' })
  assert.equal(changed.version, 2)
  assert.equal((await service.list(colleague, 'agent')).length, 1)
  await assert.rejects(service.update(author, created.id, { expectedVersion: 1, name: '旧版本' }), { status: 409 })
  await service.remove(author, created.id, 2)
  assert.equal((await service.list(colleague, 'agent')).length, 0)
  assert.deepEqual(events, ['创建提示词', '修改提示词', '删除提示词'])
})
