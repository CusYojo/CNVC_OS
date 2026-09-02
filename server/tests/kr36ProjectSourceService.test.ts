import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchKr36ProjectDetail, fetchKr36ProjectListPage } from '../src/services/kr36ProjectSourceService.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('36氪列表适配器固定页面大小并解析分页', async () => {
  let requestBody: Record<string, any> = {}
  const fetchImpl: typeof fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body))
    return jsonResponse({ code: 0, data: { projectList: [{ id: 7, name: '芯片项目' }], page: { totalCount: 21 } } })
  }
  const page = await fetchKr36ProjectListPage({ pageNo: 1, year: 2025, fetchImpl })
  assert.equal(requestBody.param.pageSize, 20)
  assert.deepEqual(requestBody.param.establishYearList, [2025])
  assert.deepEqual(requestBody.param.tradeIdList, [])
  assert.equal(page.items.length, 1)
  assert.equal(page.total, 21)
  assert.equal(page.hasMore, true)
})

test('36氪列表适配器允许显式行业筛选但默认采集全行业', async () => {
  let requestBody: Record<string, any> = {}
  const fetchImpl: typeof fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body))
    return jsonResponse({ code: 0, data: { projectList: [], page: { totalCount: 0 } } })
  }
  await fetchKr36ProjectListPage({ pageNo: 1, year: 2025, tradeIds: [6, 7], fetchImpl })
  assert.deepEqual(requestBody.param.tradeIdList, [6, 7])
})

test('36氪详情适配器解析项目主体', async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse({ code: 0, data: { project: { id: 7, name: '具身项目' } } })
  const detail = await fetchKr36ProjectDetail({ projectId: 7, fetchImpl })
  assert.equal(detail.name, '具身项目')
})

test('36氪详情适配器兼容历史详情接口', async () => {
  const urls: string[] = []
  const fetchImpl: typeof fetch = async (url, init) => {
    urls.push(String(url))
    if (urls.length === 1) return jsonResponse({ message: 'not found' }, 404)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.param.id, '7')
    return jsonResponse({ code: 0, data: { id: 7, name: '历史详情项目' } })
  }
  const detail = await fetchKr36ProjectDetail({ projectId: 7, fetchImpl })
  assert.equal(detail.name, '历史详情项目')
  assert.match(urls[1], /\/api\/pms\/project\/detail$/)
})

test('36氪HTML拦截页会失败关闭', async () => {
  const fetchImpl: typeof fetch = async () => new Response('<html>blocked</html>', {
    status: 403, headers: { 'content-type': 'text/html' },
  })
  await assert.rejects(fetchKr36ProjectListPage({ pageNo: 1, year: 2025, fetchImpl }), /接口异常 403/)
})
