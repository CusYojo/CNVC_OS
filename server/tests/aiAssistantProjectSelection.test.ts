import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Project } from '../../src/types'
import {
  fetchAiAssistantProjects,
  type ProjectListQuery,
  type ProjectListResponse,
} from '../../src/services/projectListApi'

function project(
  id: string,
  classification: 'normal' | 'key' = 'normal',
  pinned = false,
  updatedAt = '2026-09-01T00:00:00.000Z',
) {
  return { id, name: id, classification, lifecycle: 'active', pinned, updatedAt } as Project
}

function response(list: Project[], total: number, page: number): ProjectListResponse {
  return { list, total, page, pageSize: 100, counts: { normal: 0, key: 0 } }
}

test('AI assistant fetches every authorized normal/key page', async () => {
  const calls: ProjectListQuery[] = []
  const fetchPage = async (query: ProjectListQuery): Promise<ProjectListResponse> => {
    calls.push(query)
    if (query.classification === 'normal' && query.page === 1) return response([project('n1')], 101, 1)
    if (query.classification === 'normal') return response([project('n2')], 101, 2)
    return response([project('k1', 'key', true)], 1, 1)
  }

  const rows = await fetchAiAssistantProjects(fetchPage)

  assert.deepEqual(rows.map((row) => row.id), ['k1', 'n2', 'n1'])
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map((call) => `${call.classification}:${call.page}`).sort(), ['key:1', 'normal:1', 'normal:2'])
  assert.ok(calls.every((call) => call.scope === 'mine' && call.lifecycle === 'active' && call.pageSize === 100))
})

test('AI assistant project merge de-duplicates rows and fails closed on a partial request', async () => {
  const duplicateFetcher = async (query: ProjectListQuery) => response([
    project('same', query.classification === 'key' ? 'key' : 'normal'),
  ], 1, 1)
  assert.equal((await fetchAiAssistantProjects(duplicateFetcher)).length, 1)

  await assert.rejects(() => fetchAiAssistantProjects(async (query) => {
    if (query.classification === 'key') throw new Error('重点项目加载失败')
    return response([project('normal-only')], 1, 1)
  }), /重点项目加载失败/)
})

test('new AI project conversations enforce accessible active normal/key projects', async () => {
  const access = await readFile(new URL('../src/services/projectAccessService.ts', import.meta.url), 'utf8')
  const conversations = await readFile(new URL('../src/services/conversationService.ts', import.meta.url), 'utf8')

  assert.match(access, /export async function requireAiAssistantProject/)
  assert.match(access, /requireAccessibleProject\(userId, projectId\)/)
  assert.match(access, /project\.lifecycle !== 'active'/)
  assert.match(access, /project\.classification !== 'normal'/)
  assert.match(access, /project\.classification !== 'key'/)
  assert.match(access, /eq\(projectMembers\.userId, userId\)/)
  assert.match(conversations, /requireAiAssistantProject\(userId, input\.projectId\)/)
})

test('AI assistant project pickers use the separately loaded authorized candidates', async () => {
  const page = await readFile(new URL('../../src/pages/AIAssistantPage.tsx', import.meta.url), 'utf8')

  assert.match(page, /import \{ fetchAiAssistantProjects \} from '\.\.\/services\/projectListApi'/)
  assert.match(page, /const \[selectableProjects, setSelectableProjects\] = useState<Project\[\]>\(\[\]\)/)
  assert.match(page, /const \[projectsLoading, setProjectsLoading\] = useState\(true\)/)
  assert.match(page, /const \[projectsLoadError, setProjectsLoadError\] = useState\(''\)/)
  assert.match(page, /fetchAiAssistantProjects\(\)/)
  assert.match(page, /projects=\{selectableProjects\}/)
  assert.match(page, /selectableProjects\.find\(\(project\) => project\.id === newSessionProjectId\)/)
})
