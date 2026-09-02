import assert from 'node:assert/strict'
import test from 'node:test'
import { previewKr36ProjectSupply } from '../src/services/kr36ProjectSyncService.js'

test('36氪预览只读地汇总范围结果', async () => {
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { param: Record<string, unknown> }
    if (String(url).endsWith('/api/pms/project/list')) {
      return new Response(JSON.stringify({ code: 0, data: {
        items: [{ projectId: 1, name: 'AI项目' }], total: 1,
      } }), { headers: { 'content-type': 'application/json' } })
    }
    assert.equal(body.param.projectId, '1')
    return new Response(JSON.stringify({ code: 0, data: { project: {
      name: 'AI项目', setupDate: '2025-02-01', intro: '大模型智能体',
    } } }), { headers: { 'content-type': 'application/json' } })
  }
  const preview = await previewKr36ProjectSupply({ minimumYear: 2025, pagesPerYear: 1, fetchImpl })
  assert.equal(preview.writeMode, 'read_only_preview')
  assert.equal(preview.byStatus.eligible, 1)
  assert.equal(preview.failed, 0)
})
