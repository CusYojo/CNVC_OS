import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (name: string) => readFile(new URL(`../src/services/${name}`, import.meta.url), 'utf8')

test('enabled system administrators receive file-domain access only', async () => {
  const [implementation, systemAdminAccess] = await Promise.all([
    source('projectFileAccessService.ts'),
    source('systemAdminAccessService.ts'),
  ])
  assert.match(implementation, /import \{ enabledSystemAdminCondition \} from '\.\/systemAdminAccessService\.js'/)
  assert.match(systemAdminAccess, /system_admin_actor\.status='启用'/)
  assert.match(systemAdminAccess, /system_admin_actor\.role='系统管理员'/)
  assert.match(systemAdminAccess, /system_admin_role\.fde_category='system_admin'/)

  const businessStart = implementation.indexOf('function businessRole')
  const businessEnd = implementation.indexOf('function manager', businessStart)
  assert.match(implementation.slice(businessStart, businessEnd), /NOT IN \('system_admin','coordinator'\)/)
  assert.match(implementation, /or\(enabledSystemAdminCondition\(userId\), projectScope\)/)
  assert.match(implementation, /or\(enabledSystemAdminCondition\(userId\), standardWorkspaceScope\)/)
})
