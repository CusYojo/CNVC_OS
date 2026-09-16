import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = () => readFile(new URL('../src/services/projectFileAccessService.ts', import.meta.url), 'utf8')

test('enabled system administrators receive file-domain access only', async () => {
  const implementation = await source()
  const adminStart = implementation.indexOf('function enabledSystemAdmin')
  const adminEnd = implementation.indexOf('function currentProjectScope', adminStart)
  const adminScope = implementation.slice(adminStart, adminEnd)
  assert.match(adminScope, /status='启用'/)
  assert.match(adminScope, /role='系统管理员'/)
  assert.match(adminScope, /fde_category='system_admin'/)

  const businessStart = implementation.indexOf('function businessRole')
  const businessEnd = implementation.indexOf('function manager', businessStart)
  assert.match(implementation.slice(businessStart, businessEnd), /NOT IN \('system_admin','coordinator'\)/)
  assert.match(implementation, /or\(enabledSystemAdmin\(userId\), projectScope\)/)
  assert.match(implementation, /or\(enabledSystemAdmin\(userId\), standardWorkspaceScope\)/)
})
