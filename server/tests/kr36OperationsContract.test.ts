import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('36氪运维端点要求系统管理员且启停会写审计', () => {
  const source = readFileSync(new URL('../src/routes/operations.ts', import.meta.url), 'utf8')
  for (const route of [
    "get('/kr36'",
    "get('/kr36/preview'",
    "patch('/kr36/jobs/:id'",
    "post('/kr36/jobs/:id/run'",
  ]) {
    const offset = source.indexOf(route)
    assert.ok(offset >= 0, `missing route ${route}`)
    assert.match(source.slice(offset, offset + 140), /requireSystemAdmin/)
  }
  assert.match(source, /module: '36氪项目源'/)
  assert.match(source, /writeAudit/)
})
