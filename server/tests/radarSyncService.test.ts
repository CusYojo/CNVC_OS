import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchRadarWindow } from '../src/services/radarSyncService.js'

test('follows Radar cursors until max pages or exhaustion', async () => {
  const originalFetch = globalThis.fetch
  const requestedCursors: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const cursor = url.searchParams.get('cursor') ?? ''
    requestedCursors.push(cursor)
    const payload = cursor === ''
      ? { items: [{ source_id: 'a' }, { source_id: 'b' }], total: 5, has_more: true, next_cursor: 'cursor-1' }
      : cursor === 'cursor-1'
        ? { items: [{ source_id: 'c' }, { source_id: 'd' }], total: 5, has_more: true, next_cursor: 'cursor-2' }
        : { items: [{ source_id: 'e' }], total: 5, has_more: false, next_cursor: '' }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const result = await fetchRadarWindow({
      baseUrl: 'http://radar.test',
      pageSize: 2,
      maxPages: 3,
    })
    assert.deepEqual(requestedCursors, ['', 'cursor-1', 'cursor-2'])
    assert.equal(result.items.length, 5)
    assert.equal(result.pages, 3)
    assert.equal(result.hasMore, false)
    assert.equal(result.nextCursor, '')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('passes a dedicated paper group to Radar candidate queries', async () => {
  const originalFetch = globalThis.fetch
  let requestedGroup = ''
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedGroup = new URL(String(input)).searchParams.get('group') ?? ''
    return new Response(JSON.stringify({ items: [], total: 0, has_more: false, next_cursor: '' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await fetchRadarWindow({
      baseUrl: 'http://radar.test',
      pageSize: 50,
      maxPages: 1,
      group: '论文',
    })
    assert.equal(requestedGroup, '论文')
  } finally {
    globalThis.fetch = originalFetch
  }
})
