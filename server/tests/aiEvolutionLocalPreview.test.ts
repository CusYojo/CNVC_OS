import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startEvolutionLocalPreview } from '../src/runtime/evolution/evolutionLocalPreview.js'

test('local preview authenticates before artifacts, uses fixture APIs and observes access revocation', async () => {
  let authorized = true, reads = 0, revokeDuringRead = false
  const preview = await startEvolutionLocalPreview({ runId: 'run',
    files: [{ path: 'dist/index.html', storageKey: 'hash.bin', sha256: 'a'.repeat(64), bytes: 26, kind: 'web' }],
    scenario: { path: '/sample', viewport: { width: 390, height: 844 }, fixtures: { '/api/sample': { synthetic: true } }, actions: [] },
    store: { read: async () => { reads++; if (revokeDuringRead) authorized = false; return Buffer.from('<html><body></body></html>') } },
    authorize: async () => { if (!authorized) throw Error('access revoked') },
  })
  try {
    const origin = new URL(preview.url).origin
    assert.equal(new URL(origin).hostname, '127.0.0.2')
    assert.equal((await fetch(`${origin}/sample`)).status, 403)
    assert.equal(reads, 0)
    const entry = await fetch(preview.url, { redirect: 'manual' })
    assert.equal(entry.status, 303)
    assert.match(entry.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/)
    assert.equal(entry.headers.get('referrer-policy'), 'no-referrer')
    const headers = { cookie: entry.headers.get('set-cookie')!.split(';')[0] }
    const page = await fetch(`${origin}/sample`, { headers })
    assert.match(await page.text(), /隔离候选预览/)
    assert.match(page.headers.get('content-security-policy')!, /connect-src 'self'/)
    assert.deepEqual(await (await fetch(`${origin}/api/sample`, { headers })).json(), { synthetic: true })
    assert.equal((await fetch(`${origin}/api/business`, { headers })).status, 404)
    assert.equal((await fetch(`${origin}/api/sample`, { method: 'POST', headers })).status, 403)
    revokeDuringRead = true
    const raced = await fetch(`${origin}/sample`, { headers })
    assert.equal(raced.status, 403)
    assert.doesNotMatch(await raced.text(), /隔离候选预览/)
    assert.equal((await fetch(`${origin}/sample`, { headers })).status, 403)
    assert.equal(reads, 2)
  } finally { await preview.close() }
})
