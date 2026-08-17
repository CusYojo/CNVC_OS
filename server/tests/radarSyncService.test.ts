import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

test('reads paginated legacy candidates without Python or port 8121', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'radar-job-test-'))
  const previousDataDir = process.env.RADAR_DATA_DIR
  process.env.RADAR_DATA_DIR = directory
  try {
    const rows = [
      { source: 'investment', source_id: 'new', title: '新候选', published_at: '2026-08-08T08:00:00+08:00', attention_score: 80 },
      { source: 'investment', source_id: 'old', title: '旧候选', published_at: '2026-08-07T08:00:00+08:00', attention_score: 70 },
    ]
    await writeFile(path.join(directory, 'investment_candidates.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const result = await fetchRadarWindow({ pageSize: 1, maxPages: 2, readMode: 'files' })
    assert.equal(result.total, 2)
    assert.equal(result.pages, 2)
    assert.deepEqual(result.items.map((item) => item.source_id), ['new', 'old'])
    assert.equal(result.hasMore, false)
  } finally {
    if (previousDataDir == null) delete process.env.RADAR_DATA_DIR
    else process.env.RADAR_DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
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
