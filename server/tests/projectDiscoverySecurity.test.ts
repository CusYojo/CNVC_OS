import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('global radar discovery requires an administrator and writes an audit record', async () => {
  const routes = await read('server/src/routes/meta.ts')
  assert.match(routes, /metaRouter\.post\('\/leads\/sync-radar', requireSystemAdmin,/)
  assert.match(routes, /action: '手动同步项目发现雷达'/)
})
